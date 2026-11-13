'use strict';
//
// dtc.js — fault-code reading and clearing over UDS (ISO 14229).
//
// Reading codes (ReadDTCInformation, 0x19) is READ-ONLY. Clearing codes
// (ClearDiagnosticInformation, 0x14) erases the ECU's stored fault memory — it
// is a write, so the UI gates it behind a confirmation. Neither touches the
// tune or any calibration; this is standard diagnostics an owner runs on their
// own car. Works module-by-module across the whole vehicle.
//
// Transport contract: send(bytes) -> Promise<respBytes> (the DoIP gateway, the
// head unit's own diagnostic channel, or the test ECU).
//
var uds = require('./uds');
var seedkey = require('./seedkey');

// ---- DTC status byte (ISO 14229 Table) ------------------------------------
var STATUS_BITS = [
  { bit: 0x01, key: 'testFailed', label: 'failed now' },
  { bit: 0x02, key: 'testFailedThisCycle', label: 'failed this cycle' },
  { bit: 0x04, key: 'pending', label: 'pending' },
  { bit: 0x08, key: 'confirmed', label: 'confirmed' },
  { bit: 0x10, key: 'testNotCompletedSinceClear', label: 'not tested since clear' },
  { bit: 0x20, key: 'testFailedSinceClear', label: 'failed since clear' },
  { bit: 0x40, key: 'testNotCompletedThisCycle', label: 'not tested this cycle' },
  { bit: 0x80, key: 'warningIndicator', label: 'warning lamp' }
];

function decodeStatus(b) {
  var out = { raw: b & 0xff, active: [] };
  for (var i = 0; i < STATUS_BITS.length; i++) {
    var s = STATUS_BITS[i], on = (b & s.bit) !== 0;
    out[s.key] = on;
    if (on) out.active.push(s.label);
  }
  return out;
}

// Decode a 3-byte UDS DTC into the SAE J2012 string (P/C/B/U + 4 digits) plus
// the failure-type byte. e.g. [0x12,0x34,0x68] -> "P1234" (type 0x68).
var DTC_LETTER = ['P', 'C', 'B', 'U'];
function hexDigit(n) { return (n & 0xf).toString(16).toUpperCase(); }
function dtcCode(b1, b2) {
  return DTC_LETTER[(b1 >> 6) & 0x3] + ((b1 >> 4) & 0x3).toString() + hexDigit(b1) + hexDigit(b2 >> 4) + hexDigit(b2);
}
function dtcHex(b1, b2, b3) {
  function h(n) { var s = (n & 0xff).toString(16).toUpperCase(); return s.length === 1 ? '0' + s : s; }
  return h(b1) + h(b2) + h(b3);
}

// Parse the DTC records from a 0x19/0x02 (or 0x0A) reply body: groups of
// [dtcHi, dtcMid, dtcLo, statusByte]. Returns an array of decoded records.
function parseRecords(data) {
  var out = [];
  if (!data) return out;
  for (var i = 0; i + 4 <= data.length; i += 4) {
    var b1 = data[i], b2 = data[i + 1], b3 = data[i + 2], st = data[i + 3];
    out.push({
      // BMW's own 6-hex code is the canonical label - it is what BMW tools show
      // and what the fault-text databases are keyed on. The SAE/J2012 form below
      // is derived from only the FIRST TWO bytes, so it drops the failure type:
      // real code 102A5A rendered as "P102A", which no BMW tool displays and
      // which collides across genuinely different faults.
      bmw: dtcHex(b1, b2, b3),
      code: dtcCode(b1, b2),     // J2012 form; only meaningful for generic OBD-II
      failureType: b3,
      hex: '0x' + dtcHex(b1, b2, b3),
      bytes: [b1, b2, b3],
      statusByte: st,
      status: decodeStatus(st)
    });
  }
  return out;
}

// ---- single-module read / clear -------------------------------------------

// readDtcs(send, opts) -> Promise<{ ok, dtcs, availabilityMask, message, error }>
//   opts.sub (default 0x02 reportDTCByStatusMask), opts.statusMask (default 0xFF),
//   opts.session (enter this session first, optional).
function readDtcs(send, opts) {
  opts = opts || {};
  if (typeof send !== 'function') return Promise.resolve({ ok: false, dtcs: [], error: 'no diagnostic transport' });
  // Default to confirmed|pending (0x08|0x04 = 0x0C), like BMW's own tools and the
  // reference scanner. Mask 0xFF returns every DTC with ANY status bit set -
  // including "test not completed this cycle" - which is hundreds of meaningless
  // entries per module, not actual faults. 'all' scope opts back into 0xFF.
  var mask = (opts.statusMask != null) ? opts.statusMask : (opts.scope === 'all' ? 0xFF : 0x0C);
  function doRead() {
    return seedkey.sendAwait(send, uds.buildReadDtc(opts.sub, mask), uds.SID.READ_DTC, opts).then(function (p) {
      if (!p.positive) return { ok: false, dtcs: [], error: p.nrcName || p.error, nrcName: p.nrcName };
      var dtcs = parseRecords(p.data);
      // Some modules ignore the request mask and return their whole table; keep
      // only DTCs whose status actually intersects the mask we asked for.
      if (mask !== 0xFF) dtcs = dtcs.filter(function (d) { return (d.statusByte & mask) !== 0; });
      return { ok: true, dtcs: dtcs, availabilityMask: p.statusAvailabilityMask,
        message: dtcs.length ? (dtcs.length + ' code' + (dtcs.length === 1 ? '' : 's')) : 'no stored codes' };
    });
  }
  if (opts.session != null) {
    return seedkey.session(send, opts.session, opts).then(function () { return doRead(); });
  }
  return doRead();
}

// clearDtcs(send, opts) -> Promise<{ ok, confirmed, message, error }>.
//   This ERASES fault memory. opts.acknowledged MUST be true. opts.group
//   (default 0xFFFFFF all), opts.session, opts.verify (re-read after, default true).
function clearDtcs(send, opts) {
  opts = opts || {};
  if (opts.acknowledged !== true) return Promise.resolve({ ok: false, confirmed: false, message: 'Clearing refused: confirmation required.' });
  if (typeof send !== 'function') return Promise.resolve({ ok: false, confirmed: false, message: 'No diagnostic transport available.' });
  function doClear() {
    return seedkey.sendAwait(send, uds.buildClearDtc(opts.group), uds.SID.CLEAR_DTC, opts).then(function (p) {
      if (!p.positive) return { ok: false, confirmed: false, message: 'Clear rejected: ' + (p.nrcName || p.error), nrcName: p.nrcName };
      if (opts.verify === false) return { ok: true, confirmed: false, message: 'Clear requested (not re-read).' };
      return readDtcs(send, { sub: 0x02, statusMask: 0xFF }).then(function (r) {
        var remaining = (r.ok && r.dtcs) ? r.dtcs.filter(function (d) { return d.status.confirmed || d.status.testFailed; }).length : null;
        if (remaining === 0) return { ok: true, confirmed: true, message: 'Codes cleared.' };
        if (remaining == null) return { ok: true, confirmed: false, message: 'Clear accepted (could not re-read to confirm).' };
        return { ok: true, confirmed: false, message: 'Clear accepted, but ' + remaining + ' code' + (remaining === 1 ? '' : 's') + ' returned immediately (active fault present).' };
      });
    });
  }
  if (opts.session != null) return seedkey.session(send, opts.session, opts).then(function () { return doClear(); });
  return doClear();
}

// ---- whole-vehicle scan / clear across modules ----------------------------
//
// sendFor(module) -> a send(bytes)->Promise transport for that module, or null
// if it can't be reached. (For DoIP: bytes -> gateway.sendTo(module.address, bytes).)
// modules: [{ key, name, address, ... }] — see modules.js.

function scanModules(sendFor, modules, opts, onProgress) {
  opts = opts || {};
  modules = modules || [];
  var results = [], i = 0;
  function step() {
    if (i >= modules.length) {
      var total = results.reduce(function (n, r) { return n + (r.ok ? r.dtcs.length : 0); }, 0);
      return Promise.resolve({ modules: results, totalDtcs: total,
        reached: results.filter(function (r) { return r.ok; }).length, scanned: results.length });
    }
    var m = modules[i++];
    if (typeof onProgress === 'function') { try { onProgress(m, i, modules.length); } catch (e) {} }
    var send = sendFor(m);
    if (typeof send !== 'function') { results.push({ module: m, ok: false, dtcs: [], error: 'unreachable' }); return step(); }
    return readDtcs(send, opts).then(function (r) {
      results.push({ module: m, ok: r.ok, dtcs: r.dtcs || [], error: r.error, availabilityMask: r.availabilityMask });
      return step();
    }).catch(function (e) {
      results.push({ module: m, ok: false, dtcs: [], error: (e && e.message) || String(e) });
      return step();
    });
  }
  return step();
}

function clearModules(sendFor, modules, opts, onProgress) {
  opts = opts || {};
  if (opts.acknowledged !== true) return Promise.resolve({ error: 'Clearing refused: confirmation required.', modules: [] });
  modules = modules || [];
  var results = [], i = 0;
  function step() {
    if (i >= modules.length) {
      return Promise.resolve({ modules: results,
        cleared: results.filter(function (r) { return r.ok; }).length, attempted: results.length });
    }
    var m = modules[i++];
    if (typeof onProgress === 'function') { try { onProgress(m, i, modules.length); } catch (e) {} }
    var send = sendFor(m);
    if (typeof send !== 'function') { results.push({ module: m, ok: false, error: 'unreachable' }); return step(); }
    return clearDtcs(send, opts).then(function (r) {
      results.push({ module: m, ok: r.ok, confirmed: r.confirmed, message: r.message });
      return step();
    }).catch(function (e) {
      results.push({ module: m, ok: false, error: (e && e.message) || String(e) });
      return step();
    });
  }
  return step();
}

module.exports = {
  STATUS_BITS: STATUS_BITS,
  decodeStatus: decodeStatus,
  dtcCode: dtcCode,
  dtcHex: dtcHex,
  parseRecords: parseRecords,
  readDtcs: readDtcs,
  clearDtcs: clearDtcs,
  scanModules: scanModules,
  clearModules: clearModules
};
