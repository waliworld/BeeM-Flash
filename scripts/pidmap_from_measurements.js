'use strict';
//
// pidmap_from_measurements.js — build a Wali Datalog pidmap.json from a
// LEGITIMATELY-OBTAINED measurement-definition table.
//
// Input: a CSV (or JSON array) where each row describes one DME measured value:
//   name/parameter/result , did/identifier/pid , off/offset , len/length ,
//   scale/factor/m , bias/offsetval/b , signed , le/endian , unit
// (Column names are matched case-insensitively; missing numeric fields default
//  to off=0, len=2, m=1, b=0, signed=false, le=false.)
//
// Source the table yourself from your own licensed ISTA/INPA export, your tuner,
// or your own on-car readout. This script copies NO proprietary files or data —
// it only reformats a table you provide, and maps measurement names to our
// channel keys. Rows whose name doesn't match a channel are reported, not
// guessed.
//
// Usage: node scripts/pidmap_from_measurements.js <table.csv|json> [out.json] [--label "B58 gen2"]
//
var fs = require('fs');
var path = require('path');
var Channels = require('../apps/wali_datalog/channels');
var mhd = require('./preset_from_mhd_csv'); // reuse its MHD name map

function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function lc(s) { return norm(s).toLowerCase(); }

// Channel key aliases: MHD names (reused) + common BMW/ISTA (EN + DE) names.
var ALIAS = {};
Object.keys(mhd.NAME_MAP).forEach(function (k) { ALIAS[lc(k)] = mhd.NAME_MAP[k]; });
var BMW = {
  'engine speed': 'rpm', 'drehzahl': 'rpm', 'motordrehzahl': 'rpm', 'rpm': 'rpm',
  'vehicle speed': 'speed', 'geschwindigkeit': 'speed', 'speed': 'speed',
  'gear': 'gear', 'gang': 'gear',
  'accelerator pedal': 'pedal', 'pedalwertgeber': 'pedal', 'fahrpedal': 'pedal',
  'throttle valve': 'throttle', 'drosselklappe': 'throttle', 'throttle position': 'throttle',
  'charge air pressure': 'boostAbs', 'ladedruck': 'boostAbs', 'boost pressure': 'boost',
  'charge air pressure setpoint': 'boostTarget', 'ladedruck sollwert': 'boostTarget',
  'ambient pressure': 'baro', 'umgebungsdruck': 'baro',
  'intake air temperature': 'iat', 'ansauglufttemperatur': 'iat', 'charge air temperature': 'chargeAirTemp', 'ladelufttemperatur': 'chargeAirTemp',
  'ambient temperature': 'ambientT', 'aussentemperatur': 'ambientT',
  'coolant temperature': 'coolant', 'kuehlmitteltemperatur': 'coolant', 'motortemperatur': 'coolant',
  'oil temperature': 'oil', 'oeltemperatur': 'oil', 'oil pressure': 'oilPressure', 'oeldruck': 'oilPressure',
  'air mass': 'maf', 'luftmasse': 'maf', 'maf': 'maf',
  'lambda': 'lambda', 'lambda bank 1': 'lambda', 'lambda integrator': 'lambda', 'lambda target': 'lambdaTarget', 'lambda sollwert': 'lambdaTarget',
  'ignition angle': 'timing', 'zuendwinkel': 'timing', 'ignition timing': 'timing',
  'rail pressure': 'railPressure', 'raildruck': 'railPressure', 'rail pressure setpoint': 'railTarget',
  'wastegate': 'wastegate', 'wastegate position': 'wastegatePos', 'ladedrucksteller': 'wastegatePos',
  'battery voltage': 'battery', 'batteriespannung': 'battery',
  'engine load': 'load', 'last': 'load', 'relative load': 'load',
  'exhaust gas temperature': 'egt', 'abgastemperatur': 'egt',
  'ethanol': 'ethanol', 'ethanolgehalt': 'ethanol',
  'intake camshaft': 'vanosIn', 'vanos intake': 'vanosIn', 'exhaust camshaft': 'vanosEx', 'vanos exhaust': 'vanosEx'
};
Object.keys(BMW).forEach(function (k) { if (!ALIAS[k]) ALIAS[k] = BMW[k]; });

function keyFor(name) {
  var n = lc(name);
  if (ALIAS[n]) return ALIAS[n];
  // direct channel key or label match
  if (Channels.get(norm(name))) return norm(name);
  var all = Channels.all();
  for (var i = 0; i < all.length; i++) if (lc(all[i].label) === n) return all[i].key;
  return null;
}

function num(v, d) { var x = parseFloat(v); return isFinite(x) ? x : d; }
function truthy(v) { var s = lc(v); return s === '1' || s === 'true' || s === 'yes' || s === 'y'; }
function parseDid(v) {
  var s = norm(v);
  if (/^0x/i.test(s)) return parseInt(s, 16);
  if (/^[0-9A-Fa-f]{3,4}$/.test(s) && /[A-Fa-f]/.test(s)) return parseInt(s, 16);
  var d = parseInt(s, 10); return isFinite(d) ? d : NaN;
}

function splitLine(line, delim) { return line.split(delim).map(function (c) { return c.replace(/^"|"$/g, ''); }); }

function parseCsv(text) {
  var lines = text.split(/\r?\n/).filter(function (l) { return l.trim() && l.charAt(0) !== '#'; });
  if (!lines.length) return [];
  var delim = (lines[0].indexOf(';') >= 0 && lines[0].indexOf(',') < 0) ? ';' : (lines[0].split(';').length > lines[0].split(',').length ? ';' : ',');
  var headers = splitLine(lines[0], delim).map(lc);
  function col(row, names) {
    for (var i = 0; i < names.length; i++) {
      var idx = headers.indexOf(names[i]);
      if (idx >= 0 && row[idx] !== undefined) return row[idx];
    }
    return '';
  }
  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    var r = splitLine(lines[i], delim);
    rows.push({
      name: col(r, ['name', 'parameter', 'result', 'messwert', 'label']),
      did: col(r, ['did', 'identifier', 'pid', 'id', 'address']),
      off: col(r, ['off', 'offset', 'byte']),
      len: col(r, ['len', 'length', 'bytes', 'size']),
      m: col(r, ['m', 'scale', 'factor', 'mult']),
      b: col(r, ['b', 'bias', 'offsetval', 'add']),
      signed: col(r, ['signed']),
      le: col(r, ['le', 'endian', 'littleendian']),
      unit: col(r, ['unit', 'einheit'])
    });
  }
  return rows;
}

function build(rows) {
  var reads = {}, unmapped = [], noDid = [], count = 0;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row.name) continue;
    var key = keyFor(row.name);
    if (!key) { unmapped.push(norm(row.name)); continue; }
    var did = parseDid(row.did);
    if (!isFinite(did)) { noDid.push(norm(row.name)); continue; }
    reads[key] = {
      did: did, off: num(row.off, 0) | 0, len: num(row.len, 2) | 0,
      signed: truthy(row.signed), le: truthy(row.le),
      m: num(row.m, 1), b: num(row.b, 0)
    };
    count++;
  }
  return { reads: reads, unmapped: unmapped, noDid: noDid, count: count };
}

if (require.main === module) {
  var inPath = process.argv[2];
  if (!inPath) { console.error('usage: node scripts/pidmap_from_measurements.js <table.csv|json> [out.json] [--label "..."]'); process.exit(2); }
  var labelArg = '';
  var li = process.argv.indexOf('--label'); if (li >= 0) labelArg = process.argv[li + 1] || '';
  var outPath = process.argv[3] && process.argv[3].charAt(0) !== '-' ? process.argv[3] : path.join('profiles', 'pidmap.json');

  var raw = fs.readFileSync(inPath, 'utf8');
  var rows = inPath.match(/\.json$/i) ? JSON.parse(raw) : parseCsv(raw);
  if (!Array.isArray(rows)) rows = rows.reads ? Object.keys(rows.reads).map(function (k) { var r = rows.reads[k]; r.name = k; return r; }) : [];
  var res = build(rows);
  var out = { label: labelArg || 'Imported measurement profile', verified: false, reads: res.reads };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log('mapped ' + res.count + ' channels -> ' + outPath + '  (verified:false until you confirm on-car)');
  if (res.unmapped.length) console.log('\nunmapped names (' + res.unmapped.length + '): ' + res.unmapped.slice(0, 40).join(', '));
  if (res.noDid.length) console.log('\nmatched but missing identifier (' + res.noDid.length + '): ' + res.noDid.slice(0, 40).join(', '));
}

module.exports = { build: build, parseCsv: parseCsv, keyFor: keyFor, ALIAS: ALIAS };
