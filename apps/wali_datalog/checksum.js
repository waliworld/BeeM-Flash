'use strict';
//
// checksum.js — pluggable calibration checksum CHECK and CORRECTION.
//
// A modified calibration must have its internal checksums recomputed, or the DME
// rejects it (or won't run). This engine provides the standard algorithms
// (CRC-32, CRC-16 variants, additive sums, XOR, and additive-complement) and
// runs them over a DECLARATIVE scheme the owner supplies for their DME —
// addresses + algorithm — exactly like keys and cal data. Nothing is bundled:
// the exact MG1 checksum layout is DME-specific and the owner provides it (from
// their tuning tool / A2L / community). The engine is standard and verifiable.
//
// A scheme is: { blocks: [ Block, … ] }, where each Block is:
//   { name, algo: 'crc32'|'crc16'|'sum16'|'sum32'|'xor8'|'sumcomp',
//     ranges: [[start,end], …]          // byte ranges (end exclusive) covered
//     store:  { at, size, endian },     // where/how the checksum is stored
//     params: { … } }                   // algo params (crc poly/init…, or target)
// `ranges` must NOT include the `store` bytes (a checksum never covers itself).
//

// ---- generic CRC (configurable, so CRC-32 and the CRC-16 family share code) --
function reflect(v, n) { var r = 0; for (var i = 0; i < n; i++) { if (v & (1 << i)) r |= (1 << (n - 1 - i)); } return r >>> 0; }
function crc(bytes, width, poly, init, refin, refout, xorout) {
  var msb = (width === 32) ? 0x80000000 : (1 << (width - 1));
  var mask = (width === 32) ? 0xFFFFFFFF : ((1 << width) - 1);
  var v = init >>> 0;
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    if (refin) b = reflect(b, 8);
    v = (v ^ (b * (width === 32 ? 0x1000000 : 0x100))) >>> 0; // b << (width-8)
    v = v & mask;
    for (var k = 0; k < 8; k++) {
      if (v & msb) v = ((v * 2) ^ poly) >>> 0; else v = (v * 2) >>> 0;
      v = v & mask;
    }
  }
  if (refout) v = reflect(v, width);
  return ((v ^ xorout) >>> 0) & mask;
}

var PRESETS = {
  crc32: { width: 32, poly: 0x04C11DB7, init: 0xFFFFFFFF, refin: true, refout: true, xorout: 0xFFFFFFFF },
  crc16: { width: 16, poly: 0x1021, init: 0xFFFF, refin: false, refout: false, xorout: 0x0000 }, // CCITT-FALSE default
  crc16ccitt: { width: 16, poly: 0x1021, init: 0x0000, refin: false, refout: false, xorout: 0x0000 }, // XMODEM
  crc16modbus: { width: 16, poly: 0x8005, init: 0xFFFF, refin: true, refout: true, xorout: 0x0000 }
};
function crcWith(bytes, preset, params) {
  var p = {}; var i; for (i in preset) p[i] = preset[i];
  if (params) for (i in params) if (params.hasOwnProperty(i)) p[i] = params[i];
  return crc(bytes, p.width, p.poly >>> 0, p.init >>> 0, !!p.refin, !!p.refout, p.xorout >>> 0);
}

// Gather the bytes a block covers.
function gather(bin, ranges) {
  var out = [];
  for (var r = 0; r < ranges.length; r++) {
    var a = ranges[r][0], b = ranges[r][1];
    for (var i = a; i < b; i++) out.push(bin[i] & 0xff);
  }
  return out;
}

function sumOf(bytes) { var s = 0; for (var i = 0; i < bytes.length; i++) s = (s + (bytes[i] & 0xff)) >>> 0; return s >>> 0; }
function xorOf(bytes) { var x = 0; for (var i = 0; i < bytes.length; i++) x ^= (bytes[i] & 0xff); return x & 0xff; }
function maskOf(size) { return size >= 4 ? 0xFFFFFFFF : ((1 << (size * 8)) - 1) >>> 0; }

// Compute a block's checksum value (the value that should be stored).
function compute(bin, block) {
  var bytes = gather(bin, block.ranges || []), p = block.params || {};
  switch (block.algo) {
    case 'crc32': return crcWith(bytes, PRESETS.crc32, p) >>> 0;
    case 'crc16': return crcWith(bytes, PRESETS[p.preset || 'crc16'] || PRESETS.crc16, p) & 0xffff;
    case 'sum16': return sumOf(bytes) & 0xffff;
    case 'sum32': return sumOf(bytes) >>> 0;
    case 'xor8': return xorOf(bytes) & 0xff;
    case 'sumcomp': { // stored so that (sum(ranges) + stored) & mask === target
      var size = (block.store && block.store.size) || 4, mask = maskOf(size);
      var target = (p.target != null ? p.target : 0) >>> 0;
      return ((target - sumOf(bytes)) & mask) >>> 0;
    }
    default: return null;
  }
}

function readStore(bin, store) {
  var at = store.at, size = store.size || 4, le = (store.endian || 'le') === 'le', v = 0;
  for (var i = 0; i < size; i++) { var byte = bin[at + (le ? i : (size - 1 - i))] & 0xff; v = (v + byte * Math.pow(256, i)) ; }
  return v >>> 0;
}
function writeStore(bin, store, value) {
  var at = store.at, size = store.size || 4, le = (store.endian || 'le') === 'le';
  for (var i = 0; i < size; i++) { var byte = Math.floor(value / Math.pow(256, i)) & 0xff; bin[at + (le ? i : (size - 1 - i))] = byte; }
}

// check(bin, scheme) -> { ok, blocks:[{name, computed, stored, ok}] }
function check(bin, scheme) {
  var blocks = (scheme && scheme.blocks) || [], out = [], allOk = true;
  for (var i = 0; i < blocks.length; i++) {
    var bl = blocks[i], computed = compute(bin, bl);
    if (computed == null) { out.push({ name: bl.name, ok: false, error: 'unknown algo ' + bl.algo }); allOk = false; continue; }
    var stored = readStore(bin, bl.store), ok = (computed >>> 0) === (stored >>> 0);
    if (bl.algo === 'sumcomp') {
      var mask = maskOf((bl.store && bl.store.size) || 4);
      var target = ((bl.params && bl.params.target) || 0) >>> 0;
      ok = (((sumOf(gather(bin, bl.ranges)) + stored) & mask) >>> 0) === target;
    }
    if (!ok) allOk = false;
    out.push({ name: bl.name, computed: computed >>> 0, stored: stored >>> 0, ok: ok });
  }
  return { ok: allOk, blocks: out, count: blocks.length };
}

// correct(bin, scheme) -> { bin(new copy), changed:[{name, from, to}], blocks }
function correct(bin, scheme) {
  var copy = bin.slice(), blocks = (scheme && scheme.blocks) || [], changed = [];
  for (var i = 0; i < blocks.length; i++) {
    var bl = blocks[i], value = compute(copy, bl);
    if (value == null) continue;
    var before = readStore(copy, bl.store);
    writeStore(copy, bl.store, value >>> 0);
    if ((before >>> 0) !== (value >>> 0)) changed.push({ name: bl.name, from: before >>> 0, to: value >>> 0 });
  }
  return { bin: copy, changed: changed, check: check(copy, scheme) };
}

module.exports = { crc: crc, crcWith: crcWith, PRESETS: PRESETS, compute: compute, check: check, correct: correct, readStore: readStore, writeStore: writeStore };
