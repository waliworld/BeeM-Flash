'use strict';
//
// a2l_to_dataset.js — extract MEASUREMENT definitions from an ASAM A2L file into
// the unified dataset schema (address-based rows).
//
// A2L (ASAM MCD-2 MC) is the open standard that describes a DME's measurements
// and calibration. Each MEASUREMENT gives a name, data type, a COMPU_METHOD
// (scaling) and an ECU_ADDRESS. These are *memory addresses* (read via XCP or
// UDS ReadMemoryByAddress 0x23) — a different transport from enhanced PIDs, and
// they are specific to one software id. Rows are emitted with
// identifier_type=address and verified=false.
//
// Source A2Ls: github.com/mgflasher-team/mgflasher-map-packs (Apache-2.0).
//
// Usage: node scripts/a2l_to_dataset.js <file.a2l> [platform] [out.csv]
//
var fs = require('fs');
var path = require('path');

var DT = {
  UBYTE: { t: 'u8' }, SBYTE: { t: 'i8' }, UWORD: { t: 'u16' }, SWORD: { t: 'i16' },
  ULONG: { t: 'u32' }, SLONG: { t: 'i32' }, A_UINT64: { t: 'u64' }, FLOAT32_IEEE: { t: 'f32' }
};

function qstr(line) { var m = line.match(/"((?:[^"\\]|\\.)*)"/); return m ? m[1] : ''; }
function allq(line) { var out = [], re = /"((?:[^"\\]|\\.)*)"/g, m; while ((m = re.exec(line))) out.push(m[1]); return out; }

// Parse COMPU_METHOD blocks -> name: { type, unit, coeffs:[6] }
function parseCompu(lines) {
  var cm = {};
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/\/begin\s+COMPU_METHOD\s+(\S+)/);
    if (!m) continue;
    var name = m[1], type = '', unit = '', coeffs = null;
    for (var j = i + 1; j < lines.length && !/\/end\s+COMPU_METHOD/.test(lines[j]); j++) {
      var l = lines[j].trim();
      if (/^(RAT_FUNC|LINEAR|IDENTICAL|TAB_INTP|TAB_NOINTP|FORM)/.test(l)) type = l.split(/\s+/)[0];
      if (!unit) { var qs = allq(l); if (qs.length >= 2) unit = qs[1]; }
      var cf = l.match(/^COEFFS\s+(.+)/); if (cf) coeffs = cf[1].trim().split(/\s+/).map(Number);
      var cl = l.match(/^COEFFS_LINEAR\s+(.+)/); if (cl) { var ab = cl[1].trim().split(/\s+/).map(Number); coeffs = [0, 0, 0, 0, 0, 0]; coeffs.lin = ab; }
    }
    cm[name] = { type: type, unit: unit, coeffs: coeffs };
  }
  return cm;
}

// raw -> physical scaling (m,b) from a COMPU_METHOD (linear cases only).
function scaleOf(cm) {
  if (!cm) return { m: 1, b: 0 };
  if (cm.coeffs && cm.coeffs.lin) return { m: cm.coeffs.lin[0], b: cm.coeffs.lin[1] }; // PHYS=a*raw+b
  if (cm.type === 'IDENTICAL' || !cm.coeffs) return { m: 1, b: 0 };
  if (cm.type === 'RAT_FUNC') {
    var c = cm.coeffs; // INT=(a*P^2+b*P+c)/(d*P^2+e*P+f); linear when a=d=e=0 -> P=(INT*f-c)/b
    if (c.length >= 6 && c[0] === 0 && c[3] === 0 && c[4] === 0 && c[1] !== 0) {
      return { m: c[5] / c[1], b: -c[2] / c[1] };
    }
  }
  return null; // non-linear / unsupported
}

function parseMeasurements(lines, cm) {
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/\/begin\s+MEASUREMENT\s+(\S+)/);
    if (!m) continue;
    var name = m[1], desc = '', dtype = '', compu = '', addr = '', order = '';
    var fieldIdx = 0;
    for (var j = i + 1; j < lines.length && !/\/end\s+MEASUREMENT/.test(lines[j]); j++) {
      var l = lines[j].trim();
      if (!l) continue;
      if (fieldIdx === 0 && l.charAt(0) === '"') { desc = qstr(l); fieldIdx = 1; continue; }
      if (fieldIdx === 1 && DT[l.split(/\s+/)[0]]) { dtype = l.split(/\s+/)[0]; fieldIdx = 2; continue; }
      if (fieldIdx === 2 && /^[A-Za-z0-9_.]+$/.test(l.split(/\s+/)[0])) { compu = l.split(/\s+/)[0]; fieldIdx = 3; continue; }
      var a = l.match(/ECU_ADDRESS\s+(0x[0-9A-Fa-f]+)/); if (a) addr = a[1];
      var bo = l.match(/BYTE_ORDER\s+(\S+)/); if (bo) order = bo[1];
    }
    if (!addr || !DT[dtype]) continue;
    var sc = scaleOf(cm[compu]);
    if (!sc) continue; // skip non-linear scaling
    out.push({
      name: name, desc: desc, data_type: DT[dtype].t,
      endianness: /MSB_LAST/.test(order) ? 'little' : 'big',
      identifier: addr, address: addr, scale: sc.m, offset: sc.b,
      unit: (cm[compu] && cm[compu].unit) || ''
    });
  }
  return out;
}

var COLS = ['platform', 'ecu_variant', 'software_id', 'measurement_name', 'identifier_type',
  'identifier', 'address', 'data_type', 'endianness', 'scale', 'offset', 'unit', 'source', 'verified'];
function esc(v) { v = String(v == null ? '' : v); return (v.indexOf(',') >= 0 || v.indexOf('"') >= 0) ? '"' + v.replace(/"/g, '""') + '"' : v; }

function parse(text) {
  var lines = text.split(/\r?\n/);
  var cm = parseCompu(lines);
  return parseMeasurements(lines, cm);
}

if (require.main === module) {
  var file = process.argv[2];
  var platform = process.argv[3] || '';
  var out = process.argv[4] || path.join('data', 'a2l_measurements.csv');
  if (!file) { console.error('usage: node scripts/a2l_to_dataset.js <file.a2l> [platform] [out.csv]'); process.exit(2); }
  var swid = path.basename(file).replace(/\.a2l$/i, '').split('_')[0];
  // A2L files are latin1/windows-1252 (degree sign etc.), not UTF-8.
  var rows = parse(fs.readFileSync(file, 'latin1'));
  var src = 'A2L ' + path.basename(file) + ' via github.com/mgflasher-team/mgflasher-map-packs (Apache-2.0)';
  var lines = [COLS.join(',')];
  rows.forEach(function (r) {
    lines.push([platform, '', swid, r.desc || r.name, 'address', r.identifier, r.address, r.data_type, r.endianness, r.scale, r.offset, r.unit, src, 'false'].map(esc).join(','));
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log('A2L ' + path.basename(file) + ': ' + rows.length + ' measurements -> ' + out + ' (software_id ' + swid + ')');
}

module.exports = { parse: parse, parseCompu: parseCompu, scaleOf: scaleOf, COLS: COLS };
