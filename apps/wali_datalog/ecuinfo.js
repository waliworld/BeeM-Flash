'use strict';
//
// ecuinfo.js — read-only ECU identification / calibration info over UDS 0x22.
//
// Reads the standard ISO 14229 identification Data Identifiers (0xF1xx): VIN,
// hardware/software numbers, serial, manufacturing date, and the calibration /
// program identification. Read-only — it only issues ReadDataByIdentifier; it
// never writes. Your DME may expose only a subset; unknown DIDs show as "not
// available". The DID list is configurable (config.infoDids) per vehicle.
//
// The default DID list follows the common BMW/ISO identification set; the
// 22 F1xx identification roadmap was cross-checked against the MIT-licensed
// openbimmer project's docs/bmw-control-units.md (see data/SOURCES.md).
//
var uds = require('./uds');
var seedkey = require('./seedkey');

var DEFAULT_DIDS = [
  { did: 0xF190, label: 'VIN', kind: 'ascii' },
  // BMW's SVK (Software-Verbau-Kenndaten): the software-unit list. On a Bosch
  // MG1/MD1 this - not the generic F1xx identification DIDs - is where the
  // calibration identity actually lives, which is why a B58 answers VIN / serial
  // / build date / SGBD index but refuses Software number and Calibration ID.
  // The SWFL entry is the 7-byte "00 00 5D 55 <3-byte version>" form that the
  // bundled stock-calibration tables are keyed on.
  { did: 0xF101, label: 'Software units (SVK)', kind: 'svk' },
  // BMW *manufacturer* software number/version. BMW populates these where the
  // Bosch *supplier* pair (F194/F195) is left blank, so they are tried first.
  { did: 0xF188, label: 'BMW software number', kind: 'ascii' },
  { did: 0xF189, label: 'BMW software version', kind: 'ascii' },
  { did: 0xF187, label: 'Part number', kind: 'ascii' },
  { did: 0xF191, label: 'Hardware number', kind: 'ascii' },
  { did: 0xF193, label: 'Hardware version', kind: 'ascii' },
  { did: 0xF194, label: 'Software number', kind: 'ascii' },
  { did: 0xF195, label: 'Software version', kind: 'ascii' },
  { did: 0xF18C, label: 'ECU serial', kind: 'ascii' },
  { did: 0xF18B, label: 'Manufacturing date', kind: 'date' },
  { did: 0xF199, label: 'Programming date', kind: 'date' },
  { did: 0xF17C, label: 'Calibration ID', kind: 'ascii' },
  { did: 0xF150, label: 'SGBD index', kind: 'hex' },
  // Not F1xx: standard OBD service 09 identifiers. On MG1 the generic F194/F17C
  // are not answered, but 09 04 (calibration ID) and 09 0A (ECU name) are, and
  // the cal ID is what the stock/tune match keys on. did 0x09NN is a pseudo-id
  // meaning "OBD service 09, PID NN".
  { did: 0x0904, label: 'Calibration ID (09)', kind: 'ascii', obd9: 0x04 },
  { did: 0x090A, label: 'ECU name (09)', kind: 'ascii', obd9: 0x0A }
];

function printableAscii(bytes) {
  var s = '', printable = 0;
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    if (b >= 0x20 && b <= 0x7e) { s += String.fromCharCode(b); printable++; }
    else if (b === 0x00) { /* pad */ }
    else s += '.';
  }
  return { text: s.replace(/\s+$/, ''), ratio: bytes.length ? printable / bytes.length : 0 };
}
function toHex(bytes) {
  var o = [];
  for (var i = 0; i < bytes.length; i++) { var h = (bytes[i] & 0xff).toString(16); o.push(h.length === 1 ? '0' + h : h); }
  return o.join(' ');
}
// Known SGBD indexes (BMW engine DME variant). 0F26B4 = DME8FF_R (G-series B58/
// B48/B38). Keyed by the 6-hex F150 value, uppercase.
var SGBD_NAMES = { '0F26B4': 'DME8FF_R' };

// Pull the software-unit identifiers out of an SVK (0xF101) reply.
//
// BMW packs each unit as a 4-byte process-class/base id followed by a 3-byte
// version, e.g. 00 00 5D 55 | 28 96 06. We do NOT assume the surrounding record
// layout (entry width and the process-class byte codes vary by ECU generation
// and are not verified here) - instead we scan for the 7-byte shape and return
// every distinct id. That is deliberately defensive: a wrong structural guess
// would silently produce a wrong calibration id, and a wrong cal id is worse
// than none when it decides whether the car reads as stock or tuned.
function svkIds(bytes) {
  var out = [], seen = {};
  if (!bytes) return out;
  function h2(n) { var s = (n & 0xff).toString(16).toUpperCase(); return s.length === 1 ? '0' + s : s; }
  for (var i = 0; i + 7 <= bytes.length;) {
    // A unit id is 00 00 <base-hi> <base-lo> <3-byte version>, e.g.
    // 00 00 5D 55 28 96 06. Requiring a NON-ZERO base high byte keeps the scan
    // from locking onto a window shifted one byte into a run of zeros.
    if (bytes[i] !== 0x00 || bytes[i + 1] !== 0x00 || bytes[i + 2] === 0x00) { i++; continue; }
    var id = '';
    for (var k = 0; k < 7; k++) id += h2(bytes[i + k]);
    if (!seen[id]) { seen[id] = true; out.push(id); }
    i += 7;                               // never report overlapping windows
  }
  return out;
}

function decode(kind, bytes) {
  if (!bytes || !bytes.length) return '';
  if (kind === 'svk') {
    var ids = svkIds(bytes);
    return ids.length ? ids.join('  ') : toHex(bytes);
  }
  if (kind === 'hex') return toHex(bytes);
  if (kind === 'date' && bytes.length >= 3) {
    // BMW/ISO identification date is commonly BCD yy mm dd (or yyyy mm dd).
    function bcd(b) { return ((b >> 4) & 0xf).toString() + (b & 0xf).toString(); }
    if (bytes.length >= 4) return '20' + bcd(bytes[1]) + '-' + bcd(bytes[2]) + '-' + bcd(bytes[3]);
    return '20' + bcd(bytes[0]) + '-' + bcd(bytes[1]) + '-' + bcd(bytes[2]);
  }
  var a = printableAscii(bytes);
  return a.ratio >= 0.5 ? a.text : toHex(bytes);
}

// Stock calibration database (generated from the mgflasher-map-packs A2Ls).
var stockdb = null; try { stockdb = require('./stockdb'); } catch (e) { stockdb = null; }
// Identifiers are compared in a single canonical form. The DME reports its
// software number as spaced lowercase hex ("00 00 5d 55 28 96 06") while the
// bundled stock sets hold "00005D55289606" - without this, a byte-for-byte STOCK
// car failed every lookup and was reported as undetermined or modified.
function norm(s) { return String(s).toUpperCase().replace(/[^0-9A-Z]/g, ''); }

function buildStockIndex(db) {
  if (!db || !db.ecus) return null;
  var all = {}, byEcu = {}, ecuTypes = [];
  for (var ecu in db.ecus) {
    if (!db.ecus.hasOwnProperty(ecu)) continue;
    ecuTypes.push(ecu);
    var set = {}, e = db.ecus[ecu], list = (e.versions || []).concat(e.fileTokens || []);
    // >= 9 characters: with no ECU type reported the pool is every family's
    // versions at once, where a short token from an unrelated engine can produce
    // a false "stock" match. Every shipped key is >= 9 chars, so none is lost.
    for (var i = 0; i < list.length; i++) { var u = norm(list[i]); if (u.length >= 9) { set[u] = true; all[u] = true; } }
    byEcu[ecu] = set;
  }
  return { all: all, byEcu: byEcu, ecuTypes: ecuTypes };
}
var STOCK = buildStockIndex(stockdb);
// Augment the ID set with the numeric stock calibration IDs parsed from the
// stock bin fingerprints (the "00005D55…" software form the DME often reports).
(function () {
  var sb = null; try { sb = require('./stockbins'); } catch (e) { sb = null; }
  if (!STOCK || !sb || !sb.stockIds) return;
  for (var ecu in sb.stockIds) {
    if (!sb.stockIds.hasOwnProperty(ecu)) continue;
    var set = STOCK.byEcu[ecu] || (STOCK.byEcu[ecu] = {});
    if (STOCK.ecuTypes.indexOf(ecu) < 0) STOCK.ecuTypes.push(ecu);
    var ids = sb.stockIds[ecu];
    for (var i = 0; i < ids.length; i++) { var u = norm(ids[i]); set[u] = true; STOCK.all[u] = true; }
  }
})();

// Decide whether the DME is running a stock calibration, from its reported
// calibration ID / software / hardware numbers. This is DEFINITIVE where the
// reported identifier matches the known-stock set (from BMW MG1 A2Ls): a match
// means a recognised stock calibration; a known ECU type reporting a version NOT
// in the set is not a known stock calibration (a tune, or newer SW than the
// dataset). Honest caveat: a tune that keeps the stock ID and changes only the
// map data cannot be told apart by the ID alone — compare the programming date.
//   opts.stockCalIds    : [ "…" ] extra stock IDs the owner knows (override)
//   opts.stockDb        : a replacement stock DB (same shape as stockdb.js)
//   opts.tuneSignatures : { SUBSTR: name } substrings that mark a known tune
function computeTune(items, opts) {
  opts = opts || {};
  function val(did) { for (var i = 0; i < items.length; i++) if (items[i].did === did && items[i].ok) return items[i].value; return null; }
  // Ordered by what actually answers on a Bosch MG1: the SVK software-unit list
  // first, then BMW's manufacturer software number, then the generic/supplier
  // DIDs and the OBD service-09 cal id as best-effort fallbacks.
  var svk = val(0xF101);
  var svkList = svk ? String(svk).split(/\s+/).filter(Boolean) : [];
  var calId = val(0xF17C) || val(0x0904) || svkList[0] || null;
  var sw = val(0xF188) || val(0xF194) || val(0x0904) || svkList[0] || null;
  var hw = val(0xF191), prog = val(0xF199);
  var raw = [calId, sw, hw].concat(svkList).filter(Boolean).map(function (s) { return String(s).toUpperCase(); });
  var reported = raw.map(norm);           // canonical form for identifier matching
  var hay = raw.join(' ');                // readable form for the ECU type / signatures

  // ECU type (e.g. MG1CS049) from the reported strings
  var ecuType = null, mm = hay.match(/MG1CS\d{3}/);
  if (mm) ecuType = mm[0];

  // vendor signature (a strong positive for a tune)
  var sigs = opts.tuneSignatures || { 'MHD': 'MHD', 'BOOTMOD': 'bootmod3', 'BM3': 'bootmod3', 'XHP': 'xHP', 'MG FLASHER': 'MG Flasher', 'MGFLASHER': 'MG Flasher' };
  var detected = null, signatureConfidence = null;
  for (var k in sigs) {
    if (!sigs.hasOwnProperty(k) || !sigs[k]) continue;
    var at = hay.indexOf(k);
    if (at < 0) continue;
    // A short token like "MHD" can appear inside an unrelated part number, so
    // require it to stand as its own word before trusting it.
    var before = at > 0 ? hay.charAt(at - 1) : ' ';
    var after = (at + k.length) < hay.length ? hay.charAt(at + k.length) : ' ';
    var bounded = !/[0-9A-Z]/.test(before) && !/[0-9A-Z]/.test(after);
    detected = sigs[k];
    signatureConfidence = (bounded || k.length >= 6) ? 'high' : 'low';
    if (signatureConfidence === 'high') break;   // keep looking for a stronger one
  }

  // match the reported identifier against the known-stock set
  var idx = opts.stockDb ? buildStockIndex(opts.stockDb) : STOCK;
  var matchedStock = null, matchQuality = null, matchedEcu = null;
  if (idx) {
    // Prefer the reported ECU's own pool; fall back to every family only when the
    // DME did not say which it is.
    var pools = [];
    if (ecuType && idx.byEcu[ecuType]) pools.push([ecuType, idx.byEcu[ecuType]]);
    else for (var et in idx.byEcu) if (idx.byEcu.hasOwnProperty(et)) pools.push([et, idx.byEcu[et]]);
    for (var pi = 0; pi < pools.length && !matchedStock; pi++) {
      var pool = pools[pi][1];
      for (var r = 0; r < reported.length && !matchedStock; r++) {
        var v = reported[r];
        if (!v) continue;
        if (pool.hasOwnProperty(v)) { matchedStock = v; matchQuality = 'exact'; matchedEcu = pools[pi][0]; break; }
      }
    }
    // Only if nothing matched exactly, allow a contained match - but demand the
    // whole key, not a 5-character fragment, and record that it was weaker.
    for (var pj = 0; pj < pools.length && !matchedStock; pj++) {
      var pool2 = pools[pj][1];
      for (var r2 = 0; r2 < reported.length && !matchedStock; r2++) {
        var v2 = reported[r2];
        if (!v2) continue;
        for (var key in pool2) {
          if (pool2.hasOwnProperty(key) && key.length >= 9 && v2.indexOf(key) >= 0) {
            matchedStock = key; matchQuality = 'substring'; matchedEcu = pools[pj][0]; break;
          }
        }
      }
    }
  }
  var knownEcu = !!(idx && ecuType && idx.byEcu[ecuType]);

  // owner-configured stock list (augments the DB)
  var cfgStock = null;
  if (opts.stockCalIds && opts.stockCalIds.length && calId) cfgStock = (opts.stockCalIds.map(String).indexOf(String(calId)) >= 0);

  var modified;
  if (detected && signatureConfidence === 'high') modified = true;
  else if (detected && matchedStock) modified = false;   // a weak hit against a known-stock ID is noise
  else if (detected) modified = true;
  else if (matchedStock) modified = false;
  else if (cfgStock === true) modified = false;
  else if (cfgStock === false) modified = true;
  else if (knownEcu) modified = true; // recognised DME, calibration not in the stock set
  else modified = null;

  var note;
  if (detected) note = 'Signature match — looks like ' + detected + '. Verify against your own records.';
  else if (matchedStock) note = 'Matches a known stock ' + (ecuType || 'DME') + ' calibration (' + matchedStock + ') — looks stock. (A tune that keeps the stock ID and only changes maps cannot be told apart by ID alone; compare the programming date.)';
  else if (cfgStock === false) note = 'Calibration ID is not in your configured stock list — looks modified.';
  else if (knownEcu) note = 'ECU ' + ecuType + ' is reporting a calibration not in the known-stock set — looks modified (a tune, or newer software than this dataset).';
  else note = 'Compare the calibration ID / programming date to your stock reference to tell if the car is tuned.';
  // Programmed after the car was built? F18B is the manufacturing date, F199 the
  // last programming date. A later programming date is a strong hint the DME has
  // been written since the factory.
  var built = val(0xF18B), reflashedAfterBuild = null;
  if (built && prog) {
    var b = norm(built).slice(0, 8), g = norm(prog).slice(0, 8);
    if (b.length >= 6 && g.length >= 6) reflashedAfterBuild = g > b;
  }
  return { calId: calId, swNumber: sw, programmingDate: prog, buildDate: built, reflashedAfterBuild: reflashedAfterBuild,
    ecuType: ecuType, detected: detected, signatureConfidence: signatureConfidence, modified: modified,
    matchedStock: matchedStock, matchQuality: matchQuality, matchedEcu: matchedEcu, note: note };
}

// read(send, opts) -> Promise<{ ok, items:[{did,label,value,ok,raw}], tune }>.
//   opts.dids (default DEFAULT_DIDS), opts.session (enter first, optional),
//   onProgress(item, i, n).
// Read a standard OBD service-09 identifier (e.g. 09 04 calibration ID). Reply is
// [0x49, pid, count?, data...]. Returns { ok, data } with the count byte stripped.
function readObd9(send, pid, opts) {
  return seedkey.sendAwait(send, [0x09, pid & 0xff], 0x09, opts).then(function (p) {
    if (!p.positive) return { ok: false, nrcName: p.nrcName };
    // p.data is the bytes after the 0x49 SID: [pid, count?, data...]
    var d = (p.data || []);
    if (d.length && d[0] === (pid & 0xff)) d = d.slice(1);          // drop echoed pid
    if (d.length && d[0] <= 0x08 && ((d.length - 1) % 4 === 0)) d = d.slice(1); // drop item-count byte
    return { ok: true, data: d };
  }, function (e) { return { ok: false, error: (e && e.message) || String(e) }; });
}

function read(send, opts, onProgress) {
  opts = opts || {};
  if (typeof send !== 'function') return Promise.resolve({ ok: false, items: [], error: 'no diagnostic transport' });
  var allDids = opts.dids || DEFAULT_DIDS, items = [], i = 0;
  var dids = allDids.filter(function (d) { return !d.obd9; });
  var obd9s = allDids.filter(function (d) { return d.obd9; });
  function finish() {
    // annotate the SGBD index with its variant name, if known
    for (var k = 0; k < items.length; k++) {
      if (items[k].did === 0xF150 && items[k].ok) {
        var key = String(items[k].value).toUpperCase().replace(/[^0-9A-F]/g, '');
        if (SGBD_NAMES[key]) items[k].value = key + ' (' + SGBD_NAMES[key] + ')';
      }
    }
    return { ok: true, items: items, tune: computeTune(items, opts) };
  }
  function doObd9(j) {
    if (j >= obd9s.length) return Promise.resolve(finish());
    var d = obd9s[j];
    if (typeof onProgress === 'function') { try { onProgress(d, dids.length + j + 1, allDids.length); } catch (e) {} }
    return readObd9(send, d.obd9, opts).then(function (r) {
      if (r.ok) items.push({ did: d.did, label: d.label, value: decode(d.kind, r.data), raw: r.data, ok: true });
      else items.push({ did: d.did, label: d.label, value: 'not available', ok: false, nrcName: r.nrcName });
      return doObd9(j + 1);
    });
  }
  function step() {
    if (i >= dids.length) return doObd9(0);
    var d = dids[i++];
    if (typeof onProgress === 'function') { try { onProgress(d, i, allDids.length); } catch (e) {} }
    return seedkey.sendAwait(send, uds.buildReadDataByIdentifier(d.did), uds.SID.READ_DID, opts).then(function (p) {
      if (p.positive) items.push({ did: d.did, label: d.label, value: decode(d.kind, p.data), raw: p.data, ok: true });
      else items.push({ did: d.did, label: d.label, value: 'not available', ok: false, nrcName: p.nrcName });
      return step();
    }).catch(function (e) {
      items.push({ did: d.did, label: d.label, value: 'error', ok: false, error: (e && e.message) || String(e) });
      return step();
    });
  }
  function go() { return step(); }
  if (opts.session != null) return seedkey.session(send, opts.session, opts).then(go);
  return go();
}

module.exports = { DEFAULT_DIDS: DEFAULT_DIDS, decode: decode, printableAscii: printableAscii, toHex: toHex, read: read, computeTune: computeTune };
