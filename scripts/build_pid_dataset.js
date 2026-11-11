'use strict';
//
// build_pid_dataset.js — assemble a unified, source-attributed BMW enhanced-PID
// dataset from open community CSVs (e.g. github.com/Shooooooooo/bmw_pid_data,
// itself sourced from thesecretingredient.neocities.org/bmw/).
//
// Output schema (as requested):
//   platform,ecu_variant,software_id,measurement_name,identifier_type,
//   identifier,address,data_type,endianness,scale,offset,unit,source,verified
//
// These are BMW "enhanced PIDs" read with UDS ReadDataByIdentifier (service
// 0x22): the identifier IS the 2-byte DID (e.g. 0x4205), the value is returned
// big-endian, and engineering = raw * (Multiply/Divide) + Add. No BMW SGBD/
// EDIABAS binaries are read; this only reformats open community CSVs. Every row
// carries its source and verified:false (confirm scaling on-car before trusting).
//
// Usage: node scripts/build_pid_dataset.js <dir-with-*_pid_data.csv> [out.csv]
//
var fs = require('fs');
var path = require('path');

var SOURCE = 'thesecretingredient.neocities.org/bmw via github.com/Shooooooooo/bmw_pid_data';
var PLATFORM = { b48: 'B48', b58: 'B58', n55: 'N55', n63: 'N63', s55: 'S55', s63: 'S63' };

// Fix common mojibake from double-encoded UTF-8 in the source CSVs.
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/Ã\u0082Â°/g, '°')
    .replace(/Â°/g, '°')
    .replace(/Ã©/g, 'é')
    .replace(/Â/g, '')
    .replace(/Ã\u0082/g, '')
    .trim();
}

// Minimal RFC-4180-ish CSV line parser (handles quoted fields with commas).
function parseCsvLine(line) {
  var out = [], cur = '', q = false;
  for (var i = 0; i < line.length; i++) {
    var c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// BMW "Data Type" -> { bytes, signed }
function dtype(s) {
  s = String(s).toLowerCase();
  var signed = s.indexOf('signed') >= 0 && s.indexOf('unsigned') < 0;
  var bytes = 2;
  if (s.indexOf('char') >= 0) bytes = 1;
  else if (s.indexOf('long') >= 0) bytes = 4;
  else bytes = 2; // "int" is 16-bit in this dataset
  return { bytes: bytes, signed: signed };
}

function platformFor(file) {
  var m = path.basename(file).toLowerCase().match(/^([a-z0-9]+)_pid_data\.csv$/);
  return m ? (PLATFORM[m[1]] || m[1].toUpperCase()) : null;
}

function rowsFromFile(file) {
  var platform = platformFor(file);
  if (!platform) return [];
  var text = fs.readFileSync(file, 'utf8');
  var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
  var rows = [];
  for (var i = 1; i < lines.length; i++) { // skip header
    var f = parseCsvLine(lines[i]);
    if (f.length < 7) continue;
    var pid = clean(f[0]);
    if (!/^0x[0-9A-Fa-f]+$/.test(pid)) continue;
    var desc = clean(f[1]);
    var unit = clean(f[2]);
    var dt = dtype(f[3]);
    var mul = parseFloat(f[4]), div = parseFloat(f[5]), add = parseFloat(f[6]);
    if (!isFinite(mul)) mul = 1; if (!isFinite(div) || div === 0) div = 1; if (!isFinite(add)) add = 0;
    var scale = mul / div;
    rows.push({
      platform: platform, ecu_variant: '', software_id: '',
      measurement_name: desc, identifier_type: 'enhanced_pid', identifier: pid.toLowerCase(),
      address: '', data_type: (dt.signed ? 'i' : 'u') + (dt.bytes * 8), endianness: 'big',
      scale: scale, offset: add, unit: unit, source: SOURCE, verified: 'false'
    });
  }
  return rows;
}

var COLS = ['platform', 'ecu_variant', 'software_id', 'measurement_name', 'identifier_type',
  'identifier', 'address', 'data_type', 'endianness', 'scale', 'offset', 'unit', 'source', 'verified'];

function esc(v) {
  v = String(v == null ? '' : v);
  return (v.indexOf(',') >= 0 || v.indexOf('"') >= 0 || v.indexOf('\n') >= 0) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

if (require.main === module) {
  var dir = process.argv[2];
  var out = process.argv[3] || path.join('data', 'bmw_enhanced_pids.csv');
  if (!dir) { console.error('usage: node scripts/build_pid_dataset.js <dir> [out.csv]'); process.exit(2); }
  var files = fs.readdirSync(dir).filter(function (f) { return /_pid_data\.csv$/i.test(f); });
  var all = [];
  files.forEach(function (f) { all = all.concat(rowsFromFile(path.join(dir, f))); });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  var lines = [COLS.join(',')];
  all.forEach(function (r) { lines.push(COLS.map(function (c) { return esc(r[c]); }).join(',')); });
  fs.writeFileSync(out, lines.join('\n') + '\n');
  var byPlat = {};
  all.forEach(function (r) { byPlat[r.platform] = (byPlat[r.platform] || 0) + 1; });
  console.log('wrote ' + all.length + ' rows -> ' + out);
  console.log('by platform: ' + Object.keys(byPlat).map(function (p) { return p + '=' + byPlat[p]; }).join(', '));
}

module.exports = { rowsFromFile: rowsFromFile, dtype: dtype, clean: clean, parseCsvLine: parseCsvLine, COLS: COLS };
