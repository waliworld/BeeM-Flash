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

// Stock calibration database (generated from the mgflasher-map-packs A2Ls).
var stockdb = null; try { stockdb = require('./stockdb'); } catch (e) { stockdb = null; }
function buildStockIndex(db) {
  if (!db || !db.ecus) return null;
  var all = {}, byEcu = {}, ecuTypes = [];
  for (var ecu in db.ecus) {
    if (!db.ecus.hasOwnProperty(ecu)) continue;
    ecuTypes.push(ecu);
    var set = {}, e = db.ecus[ecu], list = (e.versions || []).concat(e.fileTokens || []);
    for (var i = 0; i < list.length; i++) { var u = String(list[i]).toUpperCase(); if (u.length >= 5) { set[u] = true; all[u] = true; } }
    byEcu[ecu] = set;
  }
  return { all: all, byEcu: byEcu, ecuTypes: ecuTypes };
}
var STOCK = buildStockIndex(stockdb);

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
  var calId = val(0xF17C), sw = val(0xF194), hw = val(0xF191), prog = val(0xF199);
  var reported = [calId, sw, hw].filter(Boolean).map(function (s) { return String(s).toUpperCase(); });
  var hay = reported.join(' ');

  // ECU type (e.g. MG1CS049) from the reported strings
  var ecuType = null, mm = hay.match(/MG1CS\d{3}/);
  if (mm) ecuType = mm[0];

  // vendor signature (a strong positive for a tune)
  var sigs = opts.tuneSignatures || { 'MHD': 'MHD', 'BOOTMOD': 'bootmod3', 'BM3': 'bootmod3', 'XHP': 'xHP', 'MG FLASHER': 'MG Flasher', 'MGFLASHER': 'MG Flasher' };
  var detected = null;
  for (var k in sigs) { if (sigs.hasOwnProperty(k) && sigs[k] && hay.indexOf(k) >= 0) { detected = sigs[k]; break; } }

  // match the reported identifier against the known-stock set
  var idx = opts.stockDb ? buildStockIndex(opts.stockDb) : STOCK;
  var matchedStock = null;
  if (idx) {
    var pool = (ecuType && idx.byEcu[ecuType]) ? idx.byEcu[ecuType] : idx.all;
    for (var r = 0; r < reported.length && !matchedStock; r++) {
      var v = reported[r];
      for (var key in pool) { if (pool.hasOwnProperty(key) && (v === key || v.indexOf(key) >= 0)) { matchedStock = key; break; } }
    }
  }
  var knownEcu = !!(idx && ecuType && idx.byEcu[ecuType]);

  // owner-configured stock list (augments the DB)
  var cfgStock = null;
  if (opts.stockCalIds && opts.stockCalIds.length && calId) cfgStock = (opts.stockCalIds.map(String).indexOf(String(calId)) >= 0);

  var modified;
  if (detected) modified = true;
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
  return { calId: calId, swNumber: sw, programmingDate: prog, ecuType: ecuType, detected: detected, modified: modified, matchedStock: matchedStock, note: note };
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
