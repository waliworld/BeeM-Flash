'use strict';
//
// flashrun.js — load a user-supplied calibration descriptor for the Flash tab.
//
// Nothing here is bundled. The owner places their own files under the app data
// dir (read via storage):
//   flash/descriptor.json   (or flash.json)   — the declarative descriptor
//       (see docs/FLASHING.md: address, security.algo, erase/check routines…)
//   and the calibration bytes, supplied one of three ways:
//     "data":   [ .. ]            inline byte array
//     "dataHex": "deadbeef…"      inline hex string
//     "binHex":  "flash/cal.hex"  a hex-text file read from storage
//
// loadDescriptor() returns { ok, descriptor, opts, status, error }. `opts` feeds
// flash.flashCalibration (with acknowledged still false — the UI confirms).
//
var flash = require('./flash');

function parseHex(s) {
  var h = String(s).replace(/[^0-9a-fA-F]/g, ''), out = [];
  for (var i = 0; i + 1 < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16));
  return out;
}
function readJson(storage, name) {
  try { var txt = storage && storage.read && storage.read(name); return txt ? JSON.parse(txt) : null; } catch (e) { return null; }
}

function loadDescriptor(storage) {
  var desc = readJson(storage, 'flash/descriptor.json') || readJson(storage, 'flash.json');
  if (!desc) return { ok: false, error: 'no descriptor', status: 'No flash/descriptor.json found in the app data dir.' };
  var data = null;
  if (Array.isArray(desc.data) && desc.data.length) data = desc.data.slice();
  else if (desc.dataHex) data = parseHex(desc.dataHex);
  else if (desc.binHex) { try { var txt = storage && storage.read && storage.read(desc.binHex); if (txt) data = parseHex(txt); } catch (e) {} }
  if (!data || !data.length) return { ok: false, error: 'no calibration bytes', status: 'Descriptor has no calibration data (data / dataHex / binHex).' };

  var norm = flash.normalizeDescriptor(desc, data);
  if (norm.error) return { ok: false, error: norm.error, status: norm.error };
  var o = norm.opts;
  var info = {
    addressHex: '0x' + Math.floor(o.address).toString(16).toUpperCase(),
    size: o.size || data.length,
    security: (o.securityLevel != null) ? ('level 0x' + o.securityLevel.toString(16) + (o.keyFn ? ' + key' : '')) : 'none',
    erase: (o.eraseRid != null) ? ('routine 0x' + o.eraseRid.toString(16)) : 'none',
    verify: (o.checkRid != null) ? ('routine 0x' + o.checkRid.toString(16)) : 'none'
  };
  return { ok: true, descriptor: info, opts: o };
}

module.exports = { loadDescriptor: loadDescriptor, parseHex: parseHex };
