'use strict';
//
// flash.js — open UDS calibration-section flashing.
//
// For a vehicle the OWNER has ALREADY flashed (its bootloader / unlock is in
// place) and now needs only the CALIBRATION section rewritten. This is the
// open-source equivalent of a tuner tool's "write calibration" step, built from
// the standard UDS download services.
//
// !!! SAFETY — read this !!!
//   Writing to the engine controller can damage the engine or permanently brick
//   the ECU. Use this ONLY on YOUR OWN vehicle, with YOUR OWN calibration data,
//   at YOUR OWN risk. Flash with a charged battery / a stable supply, on a stable
//   connection, and NEVER interrupt it. The calibration you write is yours — this
//   tool does not create, validate, or bundle any calibration, ECU address, or
//   security key; the caller supplies them all. Emissions and road-legality are
//   the owner's responsibility.
//
// The flow (standard UDS, ISO 14229):
//   programming session (0x10) -> SecurityAccess (0x27, the caller's key
//   algorithm) -> erase the calibration region (RoutineControl 0x31) ->
//   RequestDownload (0x34) -> TransferData (0x36) in blocks -> RequestTransferExit
//   (0x37) -> verify (a check routine and/or read-back) -> ECU reset (0x11).
//
// Transport contract: send(bytes) -> Promise<respBytes> (the DoIP gateway, etc).
//
var uds = require('./uds');
var seedkey = require('./seedkey');
var checksum = require('./checksum');

// flashCalibration(send, opts, onProgress) -> Promise<{ ok, confirmed, message, steps }>
//   opts (all caller-supplied; nothing defaulted to a real ECU):
//     acknowledged : MUST be true — explicit risk acknowledgment (hard gate)
//     data         : the calibration bytes to write (array)
//     address      : start address of the calibration section
//     size         : bytes to write (default data.length)
//     session      : programming session subfunction (default 0x02)
//     securityLevel, keyFn : SecurityAccess level + key algorithm (if required)
//     eraseRid, eraseData  : erase routine id + data (optional)
//     checkRid, checkData  : verify routine id + data (optional; confirms the write)
//     blockSize    : cap the TransferData block size (else the DME's max is used)
//     reset        : ECU reset type after flashing (default 0x01; false to skip)
//     abort()      : return true to stop between blocks
function flashCalibration(send, opts, onProgress) {
  opts = opts || {};
  var steps = [];
  function note(s) { steps.push(s); if (typeof onProgress === 'function') { try { onProgress(s, steps); } catch (e) {} } }
  function fail(msg) { return { ok: false, confirmed: false, message: msg, steps: steps }; }

  // Hard gates — refuse without explicit acknowledgment and the caller's data.
  if (opts.acknowledged !== true) return Promise.resolve(fail('Flashing refused: explicit risk acknowledgment required.'));
  if (!Array.isArray(opts.data) || !opts.data.length) return Promise.resolve(fail('Flashing refused: no calibration data supplied.'));
  if (typeof opts.address !== 'number') return Promise.resolve(fail('Flashing refused: no calibration section address supplied.'));
  if (typeof send !== 'function') return Promise.resolve(fail('No diagnostic transport available.'));

  var data = opts.data;
  // Checksum safety: a modified calibration must have valid internal checksums or
  // the DME rejects it. If a checksum scheme is supplied, verify them first; if
  // they are wrong, correct them (when allowed) or REFUSE to flash.
  var csResult = null;
  if (opts.checksum && opts.checksum.blocks && opts.checksum.blocks.length) {
    var chk = checksum.check(data, opts.checksum);
    if (chk.ok) { csResult = { ok: true, corrected: false }; note('checksum ok'); }
    else if (opts.correctChecksums) {
      var cor = checksum.correct(data, opts.checksum);
      if (!cor.check.ok) return Promise.resolve(fail('Checksum correction failed to produce a valid calibration — check the scheme (config.checksum).'));
      data = cor.bin; csResult = { ok: true, corrected: true, changed: cor.changed.length };
      note('checksum corrected (' + cor.changed.length + ')');
    } else {
      return Promise.resolve(fail('Calibration checksums are INVALID (' + chk.blocks.filter(function (b) { return !b.ok; }).length + ' of ' + chk.count + '). Enable checksum correction or fix the file before flashing.'));
    }
  }
  var size = opts.size || data.length;
  var session = opts.session || 0x02;          // programmingSession
  var addrBytes = opts.addrBytes || 4, sizeBytes = opts.sizeBytes || 4;
  var abort = (typeof opts.abort === 'function') ? opts.abort : function () { return false; };
  function sa(bytes, sid) { return seedkey.sendAwait(send, bytes, sid, opts); }

  function transferAll(chunk) {
    var counter = 1, off = 0;
    function next() {
      if (abort()) return Promise.reject(new Error('aborted by user'));
      if (off >= data.length) return Promise.resolve();
      var block = data.slice(off, off + chunk);
      return sa(uds.buildTransferData(counter, block), uds.SID.TRANSFER_DATA).then(function (p) {
        if (!p.positive) throw new Error('TransferData block ' + counter + ' rejected: ' + (p.nrcName || p.error));
        off += block.length;
        counter = (counter + 1) & 0xff;
        note('transfer ' + Math.min(100, Math.round(off / data.length * 100)) + '%');
        return next();
      });
    }
    return next();
  }

  note('session');
  return sa(uds.buildSessionControl(session), uds.SID.SESSION).then(function (p) {
    if (!p.positive) throw new Error('programming session denied: ' + (p.nrcName || p.error));
    if (!opts.securityLevel) return null;
    note('security');
    return seedkey.unlock(send, opts.securityLevel, opts.keyFn, opts).then(function (u) {
      if (!u.unlocked) throw new Error('SecurityAccess denied: ' + (u.nrcName || u.error) + ' (supply the key algorithm for this ECU).');
    });
  }).then(function () {
    if (opts.eraseRid == null) return null;
    note('erase');
    var eraseData = opts.eraseData || uds.bytesOf(opts.address, addrBytes).concat(uds.bytesOf(size, sizeBytes));
    return sa(uds.buildRoutineControl(uds.ROUTINE_SUB.START, opts.eraseRid, eraseData), uds.SID.ROUTINE).then(function (p) {
      if (!p.positive) throw new Error('erase rejected: ' + (p.nrcName || p.error));
    });
  }).then(function () {
    note('requestDownload');
    return sa(uds.buildRequestDownload(opts.address, size, { dataFormat: opts.dataFormat, addrBytes: addrBytes, sizeBytes: sizeBytes }), uds.SID.REQUEST_DOWNLOAD);
  }).then(function (p) {
    if (!p.positive) throw new Error('RequestDownload rejected: ' + (p.nrcName || p.error));
    var lenFmt = (p.data[0] >> 4) & 0x0f, maxBlock = 0;
    for (var i = 0; i < lenFmt && 1 + i < p.data.length; i++) maxBlock = maxBlock * 256 + p.data[1 + i];
    var chunk = (maxBlock > 2) ? (maxBlock - 2) : (opts.blockSize || 0x400);  // minus the 0x36 SID + counter; 0x400 = MG1 convention when the DME reports no max
    if (opts.blockSize) chunk = Math.min(chunk, opts.blockSize);
    if (chunk < 1) chunk = 1;
    return transferAll(chunk);
  }).then(function () {
    note('transferExit');
    return sa(uds.buildRequestTransferExit(), uds.SID.TRANSFER_EXIT);
  }).then(function (p) {
    if (!p.positive) throw new Error('RequestTransferExit rejected: ' + (p.nrcName || p.error));
    if (opts.checkRid == null) return { confirmed: false };
    note('verify');
    return sa(uds.buildRoutineControl(uds.ROUTINE_SUB.START, opts.checkRid, opts.checkData || []), uds.SID.ROUTINE).then(function (v) {
      return { confirmed: !!v.positive, checkMsg: v.positive ? null : (v.nrcName || v.error) };
    });
  }).then(function (verify) {
    if (opts.reset === false) return verify;
    note('reset');
    return sa(uds.buildEcuReset(opts.reset || 0x01), uds.SID.ECU_RESET).then(function () { return verify; });
  }).then(function (verify) {
    var confirmed = !!verify.confirmed;
    var csNote = csResult && csResult.corrected ? ' (checksums corrected)' : (csResult ? ' (checksums ok)' : '');
    return {
      ok: true, confirmed: confirmed, steps: steps, checksum: csResult,
      message: (confirmed
        ? ('Calibration flashed and verified (' + size + ' bytes)' + csNote + '.')
        : ('Calibration flashed (' + size + ' bytes)' + csNote + ', but ' + (opts.checkRid == null ? 'no verify routine was configured' : ('the DME did not confirm it' + (verify.checkMsg ? ': ' + verify.checkMsg : ''))) + ' — confirm the car starts and runs correctly before driving.'))
    };
  }).catch(function (e) {
    var where = steps.length ? steps[steps.length - 1] : 'start';
    return fail('Flash failed at "' + where + '": ' + (e && e.message ? e.message : String(e)) +
      '. The ECU may be in an incomplete state — do NOT drive; re-flash or recover before use.');
  });
}

// normalizeDescriptor(desc, bin) -> { opts } | { error }
//   Turn a declarative, USER-SUPPLIED calibration descriptor into flashCalibration
//   opts. Nothing here is bundled — the owner provides the descriptor and the BIN
//   for their own ECU. A descriptor looks like:
//     {
//       "address": "0xA0010000",         // calibration section start
//       "session": 2,                     // programming session (optional, default 2)
//       "security": { "level": 17, "algo": { "type": "xorkey", "key": [1,2,3] } },
//       "eraseRoutine": "0xFF00",         // optional erase routine id
//       "checkRoutine": "0xFF01",         // optional verify routine id
//       "blockSize": 256                   // optional cap
//     }
//   The security algorithm is built with seedkey.makeAlgo from the owner's spec;
//   no manufacturer algorithm is included. `bin` is the calibration bytes (array).
function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { var s = v.trim(); return s.slice(0, 2).toLowerCase() === '0x' ? parseInt(s, 16) : parseInt(s, 10); }
  return NaN;
}
function normalizeDescriptor(desc, bin) {
  desc = desc || {};
  if (!Array.isArray(bin) || !bin.length) return { error: 'no calibration BIN bytes supplied' };
  var addr = num(desc.address);
  if (!isFinite(addr)) return { error: 'descriptor is missing a valid calibration "address"' };
  var opts = { acknowledged: false, data: bin.slice(), address: addr };
  if (desc.size != null) opts.size = num(desc.size);
  if (desc.session != null) opts.session = num(desc.session);
  if (desc.blockSize != null) opts.blockSize = num(desc.blockSize);
  if (desc.addrBytes != null) opts.addrBytes = num(desc.addrBytes);
  if (desc.sizeBytes != null) opts.sizeBytes = num(desc.sizeBytes);
  if (desc.reset === false) opts.reset = false; else if (desc.reset != null) opts.reset = num(desc.reset);
  if (desc.eraseRoutine != null) opts.eraseRid = num(desc.eraseRoutine);
  if (desc.checkRoutine != null) opts.checkRid = num(desc.checkRoutine);
  if (desc.security && desc.security.level != null) {
    opts.securityLevel = num(desc.security.level);
    var algo = seedkey.makeAlgo(desc.security.algo);
    if (!algo) return { error: 'descriptor security.algo is missing or not a supported spec' };
    opts.keyFn = algo;
  }
  return { opts: opts };
}

module.exports = { flashCalibration: flashCalibration, normalizeDescriptor: normalizeDescriptor };
