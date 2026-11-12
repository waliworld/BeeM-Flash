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
  { did: 0xF187, label: 'Part number', kind: 'ascii' },
  { did: 0xF191, label: 'Hardware number', kind: 'ascii' },
  { did: 0xF193, label: 'Hardware version', kind: 'ascii' },
  { did: 0xF194, label: 'Software number', kind: 'ascii' },
  { did: 0xF195, label: 'Software version', kind: 'ascii' },
  { did: 0xF18C, label: 'ECU serial', kind: 'ascii' },
  { did: 0xF18B, label: 'Manufacturing date', kind: 'date' },
  { did: 0xF199, label: 'Programming date', kind: 'date' },
  { did: 0xF17C, label: 'Calibration ID', kind: 'ascii' },
  { did: 0xF150, label: 'Identification', kind: 'hex' }
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
function decode(kind, bytes) {
  if (!bytes || !bytes.length) return '';
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

// Heuristically decide whether the DME looks tuned (and by what), from its
// calibration ID / software number / programming date. This can NOT be certain —
// it compares against the owner's configured stock IDs and known-tune signatures
// and otherwise just surfaces the values to compare by hand.
//   opts.stockCalIds : [ "…" ] calibration IDs the owner knows are stock
//   opts.tuneSignatures : { SUBSTR: name } substrings that mark a known tune
function computeTune(items, opts) {
  opts = opts || {};
  function val(did) { for (var i = 0; i < items.length; i++) if (items[i].did === did && items[i].ok) return items[i].value; return null; }
  var calId = val(0xF17C), sw = val(0xF194), prog = val(0xF199);
  var hay = ((calId || '') + ' ' + (sw || '')).toUpperCase();
  var sigs = opts.tuneSignatures || { 'MHD': 'MHD', 'BM3': 'bootmod3', 'BOOTMOD': 'bootmod3', 'XHP': 'xHP', 'MGFLASHER': 'MG Flasher', 'STG': 'a staged tune' };
  var detected = null;
  for (var k in sigs) { if (sigs.hasOwnProperty(k) && sigs[k] && hay.indexOf(k) >= 0) { detected = sigs[k]; break; } }
  var modified = null;
  if (opts.stockCalIds && opts.stockCalIds.length && calId) modified = opts.stockCalIds.map(String).indexOf(String(calId)) < 0;
  else if (detected) modified = true;
  var note;
  if (detected) note = 'Signature match — looks like ' + detected + '. Verify against your own records.';
  else if (modified === true) note = 'Calibration ID is not in your configured stock list — looks modified.';
  else if (modified === false) note = 'Calibration ID matches your configured stock list — looks stock.';
  else note = 'Compare the calibration ID / programming date to your stock reference to tell if the car is tuned.';
  return { calId: calId, swNumber: sw, programmingDate: prog, detected: detected, modified: modified, note: note };
}

// read(send, opts) -> Promise<{ ok, items:[{did,label,value,ok,raw}], tune }>.
//   opts.dids (default DEFAULT_DIDS), opts.session (enter first, optional),
//   onProgress(item, i, n).
function read(send, opts, onProgress) {
  opts = opts || {};
  if (typeof send !== 'function') return Promise.resolve({ ok: false, items: [], error: 'no diagnostic transport' });
  var dids = opts.dids || DEFAULT_DIDS, items = [], i = 0;
  function step() {
    if (i >= dids.length) return Promise.resolve({ ok: true, items: items, tune: computeTune(items, opts) });
    var d = dids[i++];
    if (typeof onProgress === 'function') { try { onProgress(d, i, dids.length); } catch (e) {} }
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
