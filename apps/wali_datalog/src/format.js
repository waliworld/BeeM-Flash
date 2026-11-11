'use strict';
//
// format.js — small, dependency-free formatting and unit helpers.
// Written to run on Node 8 (head unit) and modern Node (tooling/tests).
//

function pad(n, w) {
  var s = String(n);
  while (s.length < w) s = '0' + s;
  return s;
}

// "YYYYMMDD-HHMMSS" in local time, for file names.
function stamp(ms) {
  var d = new Date(ms);
  return (
    pad(d.getFullYear(), 4) +
    pad(d.getMonth() + 1, 2) +
    pad(d.getDate(), 2) +
    '-' +
    pad(d.getHours(), 2) +
    pad(d.getMinutes(), 2) +
    pad(d.getSeconds(), 2)
  );
}

// ISO-8601 without milliseconds, for a readable column in the log.
function iso(ms) {
  var d = new Date(ms);
  return (
    pad(d.getFullYear(), 4) + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2) +
    'T' +
    pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2)
  );
}

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

function fixed(v, dp) {
  if (!isNum(v)) return '';
  if (dp === 0) return String(Math.round(v));
  return v.toFixed(dp);
}

// A display string for a gauge: value + unit, or a placeholder when invalid.
function display(v, dp, unit) {
  if (!isNum(v)) return '--';
  var s = fixed(v, dp);
  return unit ? s + ' ' + unit : s;
}

function csvEscape(s) {
  s = String(s === undefined || s === null ? '' : s);
  if (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvRow(arr) {
  var out = [];
  for (var i = 0; i < arr.length; i++) out.push(csvEscape(arr[i]));
  return out.join(',');
}

function humanBytes(n) {
  if (!isNum(n)) return '--';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function mmss(ms) {
  if (!isNum(ms) || ms < 0) ms = 0;
  var s = Math.floor(ms / 1000);
  var m = Math.floor(s / 60);
  s = s % 60;
  return pad(m, 2) + ':' + pad(s, 2);
}

// Unit conversions (metric is the internal/base unit for every channel).
function cToF(c) { return isNum(c) ? c * 9 / 5 + 32 : c; }
function kmhToMph(k) { return isNum(k) ? k * 0.621371 : k; }
function barToPsi(b) { return isNum(b) ? b * 14.5038 : b; }
function nmToLbft(nm) { return isNum(nm) ? nm * 0.737562 : nm; }

module.exports = {
  pad: pad,
  stamp: stamp,
  iso: iso,
  isNum: isNum,
  fixed: fixed,
  display: display,
  csvEscape: csvEscape,
  csvRow: csvRow,
  humanBytes: humanBytes,
  mmss: mmss,
  cToF: cToF,
  kmhToMph: kmhToMph,
  barToPsi: barToPsi,
  nmToLbft: nmToLbft
};
