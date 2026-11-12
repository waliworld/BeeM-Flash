'use strict';
//
// calreadout.js — read the DME's current calibration region out of the car.
//
// Reads a configured address range with UDS ReadMemoryByAddress (0x23) in chunks
// and assembles the bytes, so binverify.js can fingerprint what's ACTUALLY on the
// car right now — catching a map-only tune that keeps the stock calibration ID.
// Read-only (0x23 only). The region (address/size) and any session/security are
// supplied by the owner via config.calReadout. Reading a large region is slow;
// this is an explicit, on-demand action.
//
var uds = require('./uds');
var seedkey = require('./seedkey');

// readCalibration(send, opts, onProgress) -> Promise<{ ok, data, size, error }>
//   opts: { address, size, chunk?, addrBytes?, sizeBytes?, session?, securityLevel?, keyFn?, abort? }
function readCalibration(send, opts, onProgress) {
  opts = opts || {};
  if (typeof send !== 'function') return Promise.resolve({ ok: false, error: 'no diagnostic transport', data: [] });
  if (typeof opts.address !== 'number' || typeof opts.size !== 'number') {
    return Promise.resolve({ ok: false, error: 'no calibration region configured (config.calReadout.address/size)', data: [] });
  }
  var addr = opts.address, size = opts.size, chunk = opts.chunk || 0x400;
  var addrBytes = opts.addrBytes || 4, sizeBytes = opts.sizeBytes || 2;
  var abort = (typeof opts.abort === 'function') ? opts.abort : function () { return false; };
  var data = [];

  function session() { return (opts.session != null) ? seedkey.session(send, opts.session, opts) : Promise.resolve({ ok: true }); }
  function unlock() {
    if (opts.securityLevel == null) return Promise.resolve({ unlocked: true });
    return seedkey.unlock(send, opts.securityLevel, opts.keyFn, opts);
  }
  function next(off) {
    if (abort()) return Promise.reject(new Error('aborted'));
    if (off >= size) return Promise.resolve();
    var len = Math.min(chunk, size - off);
    return seedkey.sendAwait(send, uds.buildReadMemoryByAddress(addr + off, len, addrBytes, sizeBytes), uds.SID.READ_MEM, opts).then(function (p) {
      if (!p.positive) throw new Error('read at 0x' + (addr + off).toString(16) + ' rejected: ' + (p.nrcName || p.error));
      for (var i = 0; i < p.data.length; i++) data.push(p.data[i] & 0xff);
      if (typeof onProgress === 'function') { try { onProgress(Math.min(100, Math.round((off + len) / size * 100)), data.length); } catch (e) {} }
      return next(off + len);
    });
  }

  return session().then(unlock).then(function (u) {
    if (u && u.unlocked === false) throw new Error('SecurityAccess denied — supply the key for this ECU (config.calReadout.securityAlgo).');
    return next(0);
  }).then(function () {
    return { ok: true, data: data, size: data.length };
  }).catch(function (e) {
    return { ok: false, error: (e && e.message) || String(e), data: data };
  });
}

module.exports = { readCalibration: readCalibration };
