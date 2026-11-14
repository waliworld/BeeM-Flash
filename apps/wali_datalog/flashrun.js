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
var binverify = require('./binverify');
var checksum = require('./checksum');

function parseHex(s) {
  var h = String(s).replace(/[^0-9a-fA-F]/g, ''), out = [];
  for (var i = 0; i + 1 < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16));
  return out;
}
function readJson(storage, name) {
  try { var txt = storage && storage.read && storage.read(name); return txt ? JSON.parse(txt) : null; } catch (e) { return null; }
}

// The tunes an owner has placed on the unit: every *.json under flash/ that
// parses and names a calibration (data / dataHex / binHex). This is how a tune
// gets onto the head unit without a file picker - drop the files in, then pick
// one on the Flash tab.
function listTunes(storage) {
  var names = [];
  try { names = (storage && storage.listDir) ? storage.listDir('flash') : []; } catch (e) { names = []; }
  var out = [];
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    if (!/\.json$/i.test(n)) continue;
    var d = readJson(storage, n);
    if (!d) { out.push({ name: n, label: n.replace(/^flash\//, ''), ok: false, why: 'not valid JSON' }); continue; }
    var hasData = (Array.isArray(d.data) && d.data.length) || !!d.dataHex || !!d.binHex;
    out.push({
      name: n,
      label: d.name || d.label || n.replace(/^flash\//, '').replace(/\.json$/i, ''),
      ok: !!hasData && d.address != null,
      why: !hasData ? 'no calibration data' : (d.address == null ? 'no address' : null),
      ecu: d.ecu || d.ecuType || null,
      note: d.note || d.description || null
    });
  }
  return out;
}

// loadDescriptor(storage, name?) - name defaults to flash/descriptor.json
// (legacy flash.json) so existing setups keep working; the Flash tab passes the
// tune the owner picked.
function loadDescriptor(storage, name) {
  var desc = name ? readJson(storage, name)
    : (readJson(storage, 'flash/descriptor.json') || readJson(storage, 'flash.json'));
  if (!desc) return { ok: false, error: 'no descriptor', status: name ? ('Could not read ' + name + '.') : 'No flash/descriptor.json found in the app data dir.' };
  var data = null;
  if (Array.isArray(desc.data) && desc.data.length) data = desc.data.slice();
  else if (desc.dataHex) data = parseHex(desc.dataHex);
  else if (desc.binHex) { try { var txt = storage && storage.read && storage.read(desc.binHex); if (txt) data = parseHex(txt); } catch (e) {} }
  if (!data || !data.length) return { ok: false, error: 'no calibration bytes', status: 'Descriptor has no calibration data (data / dataHex / binHex).' };

  var norm = flash.normalizeDescriptor(desc, data);
  if (norm.error) return { ok: false, error: norm.error, status: norm.error };
  var o = norm.opts;
  // Checksum scheme (owner-supplied) — verify now so the UI can show status, and
  // carry it + the correct-on-flash flag into the flash options.
  var csInfo = null;
  if (desc.checksum && desc.checksum.blocks && desc.checksum.blocks.length) {
    o.checksum = desc.checksum;
    o.correctChecksums = (desc.correctChecksums !== false); // default: correct on flash
    try {
      var chk = checksum.check(data, desc.checksum);
      var bad = chk.blocks.filter(function (b) { return !b.ok; }).length;
      csInfo = { ok: chk.ok, count: chk.count, bad: bad, correct: o.correctChecksums };
    } catch (e) { csInfo = { ok: false, error: 'checksum scheme invalid' }; }
  }
  // Fingerprint the calibration being loaded, so the UI can say whether you are
  // about to flash a known STOCK image, a known MHD+ base, or an unknown/custom
  // calibration. (Most useful when the data is a full DME image.)
  var fp = null; try { fp = binverify.verify(data); } catch (e) { fp = null; }
  var info = {
    addressHex: '0x' + Math.floor(o.address).toString(16).toUpperCase(),
    size: o.size || data.length,
    security: (o.securityLevel != null) ? ('level 0x' + o.securityLevel.toString(16) + (o.keyFn ? ' + key' : '')) : 'none',
    erase: (o.eraseRid != null) ? ('routine 0x' + o.eraseRid.toString(16)) : 'none',
    verify: (o.checkRid != null) ? ('routine 0x' + o.checkRid.toString(16)) : 'none',
    fingerprint: fp ? { kind: fp.kind, id: fp.id, match: fp.match, text: binverify.describe(fp) } : null,
    checksum: csInfo
  };
  info.source = name || 'flash/descriptor.json';
  return { ok: true, descriptor: info, opts: o };
}

module.exports = { loadDescriptor: loadDescriptor, listTunes: listTunes, parseHex: parseHex };
