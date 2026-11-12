'use strict';
//
// pidmap_from_dataset.js — compose a pidmap.json from the unified enhanced-PID
// dataset (data/bmw_enhanced_pids.csv) and a curated channel->PID selection
// (profiles/select.<platform>.json).
//
// For each selected channel it looks up the PID row for the platform, converts
// the PID's native unit to the channel's unit (uscale/uoffset), and emits
// { did, off:0, len, signed, le:false, m, b }. Enhanced PIDs are read one per
// UDS 0x22 request (did = the 2-byte PID), so off is 0 and len comes from the
// data type.
//
// eng_channel = (raw*pid_scale + pid_offset)*uscale + uoffset
//             = raw*(pid_scale*uscale) + (pid_offset*uscale + uoffset)
//
// Output is verified:false — the scaling is community-sourced; confirm on-car.
//
// Usage: node scripts/pidmap_from_dataset.js <dataset.csv> <select.json> [out.json]
//
var fs = require('fs');
var path = require('path');
var Channels = require('../apps/wali_datalog/channels');
var ds = require('./build_pid_dataset'); // reuse CSV line parser + COLS

function lenOf(dt) { var n = parseInt(String(dt).replace(/[^0-9]/g, ''), 10) || 16; return Math.max(1, n / 8) | 0; }
function signedOf(dt) { return String(dt).charAt(0).toLowerCase() === 'i'; }

function indexDataset(csvText, platform) {
  var lines = csvText.split(/\r?\n/).filter(function (l) { return l.trim(); });
  var header = ds.parseCsvLine(lines[0]);
  var col = {}; header.forEach(function (h, i) { col[h.trim()] = i; });
  var idx = {};
  for (var i = 1; i < lines.length; i++) {
    var f = ds.parseCsvLine(lines[i]);
    if (f[col.platform] !== platform) continue;
    idx[String(f[col.identifier]).toLowerCase()] = {
      name: f[col.measurement_name], data_type: f[col.data_type],
      scale: parseFloat(f[col.scale]), offset: parseFloat(f[col.offset]),
      unit: f[col.unit], source: f[col.source]
    };
  }
  return idx;
}

function build(csvText, selDoc) {
  var platform = selDoc.platform;
  var lookupPlatform = selDoc.datasetPlatform || platform; // S58 reuses B58/MG1 rows
  var idx = indexDataset(csvText, lookupPlatform);
  var sel = selDoc.select || {};
  var reads = {}, missing = [], badChannel = [], mapped = 0, source = '';
  Object.keys(sel).forEach(function (key) {
    if (!Channels.get(key)) { badChannel.push(key); return; }
    var pid = String(sel[key].pid).toLowerCase();
    var row = idx[pid];
    if (!row) { missing.push(key + ' (' + pid + ')'); return; }
    var us = typeof sel[key].uscale === 'number' ? sel[key].uscale : 1;
    var uo = typeof sel[key].uoffset === 'number' ? sel[key].uoffset : 0;
    reads[key] = {
      did: parseInt(pid, 16), off: 0, len: lenOf(row.data_type), signed: signedOf(row.data_type),
      le: false, m: row.scale * us, b: row.offset * us + uo
    };
    source = row.source;
    mapped++;
  });
  return { reads: reads, missing: missing, badChannel: badChannel, mapped: mapped, platform: platform, source: source };
}

if (require.main === module) {
  var dsPath = process.argv[2], selPath = process.argv[3];
  if (!dsPath || !selPath) { console.error('usage: node scripts/pidmap_from_dataset.js <dataset.csv> <select.json> [out.json]'); process.exit(2); }
  var selDoc = JSON.parse(fs.readFileSync(selPath, 'utf8'));
  var res = build(fs.readFileSync(dsPath, 'utf8'), selDoc);
  var out = process.argv[4] || path.join('profiles', 'pidmap.' + selDoc.platform.toLowerCase() + '.json');
  var derived = selDoc.datasetPlatform && selDoc.datasetPlatform !== selDoc.platform;
  var doc = {
    label: selDoc.platform + ' enhanced-PID map (community-sourced, unverified'
      + (derived ? '; derived from ' + selDoc.datasetPlatform + '/MG1 — verify on an ' + selDoc.platform : '') + ')',
    platform: selDoc.platform, verified: false, source: res.source, reads: res.reads
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
  console.log(selDoc.platform + ': mapped ' + res.mapped + ' channels -> ' + out);
  if (res.missing.length) console.log('  PID not in dataset: ' + res.missing.join(', '));
  if (res.badChannel.length) console.log('  unknown channel keys: ' + res.badChannel.join(', '));
}

module.exports = { build: build, indexDataset: indexDataset };
