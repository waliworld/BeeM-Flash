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

// ---- Bosch MG1 block scheme (auto-detecting) --------------------------------
// Ported from the MIT-licensed NetworkDir/moto-ecu-checksum (see data/SOURCES.md).
// CONFIRMED for motorcycle MG1 (MG1CA094) and Bosch MSE8.0. It is NOT the scheme
// BMW automotive MG1CS201/049/003 use — our tests find none of these blocks in
// BMW stock images — so do not select it for a BMW DME. Selected with
// scheme.preset === 'bosch-mg1'.
var CRC32_TABLE = (function () { var t = [], n, c, k; for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = (c & 1) ? ((0xEDB88320 ^ (c >>> 1)) >>> 0) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32Seed(bytes, start, end, seed) { var c = (seed ^ 0xFFFFFFFF) >>> 0; for (var i = start; i < end; i++) c = (CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)) >>> 0; return (c ^ 0xFFFFFFFF) >>> 0; }
function readU32BE(b, o) { return (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0); }
function writeU32BE(b, o, v) { b[o] = (v >>> 24) & 0xff; b[o + 1] = (v >>> 16) & 0xff; b[o + 2] = (v >>> 8) & 0xff; b[o + 3] = v & 0xff; }
function idxOf(b, pat, from) { for (var i = from || 0; i + pat.length <= b.length; i++) { var ok = true; for (var j = 0; j < pat.length; j++) if (b[i + j] !== pat[j]) { ok = false; break; } if (ok) return i; } return -1; }
var MG1 = { SEED: 0x533F71C8, STEP: 0x40000, FILL_LEN: 0x15C, HEAD: [0xDE, 0xAD, 0xBE, 0xEF], FILL: [0x12, 0x34, 0x56, 0x78], MSE8: [0x12, 0x34, 0x10, 0x08] };
function mg1Blocks(bin) {
  var out = [], p = idxOf(bin, MG1.FILL, 0);
  function isFill(i) { return bin[i] === 0x12 && bin[i + 1] === 0x34 && bin[i + 2] === 0x56 && bin[i + 3] === 0x78; }
  while (p >= 0) {
    var e = p; while (e + 4 <= bin.length && isFill(e)) e += 4;
    if (e - p === MG1.FILL_LEN && e + 4 <= bin.length && !(bin[e] === 0x12 && bin[e + 1] === 0x34 && bin[e + 2] === 0x10 && bin[e + 3] === 0x08)) {
      var s = Math.floor(p / MG1.STEP) * MG1.STEP;
      while (s >= 0 && !(bin[s] === 0xDE && bin[s + 1] === 0xAD && bin[s + 2] === 0xBE && bin[s + 3] === 0xEF)) s -= MG1.STEP;
      if (s >= 0) out.push({ start: s, crc: e });
    }
    p = idxOf(bin, MG1.FILL, e > p ? e : p + 1);
  }
  return out;
}
function mg1Check(bin) {
  var blocks = mg1Blocks(bin), res = [], allOk = true;
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i], computed = crc32Seed(bin, b.start, b.crc, MG1.SEED), stored = readU32BE(bin, b.crc), ok = computed === stored;
    if (!ok) allOk = false;
    res.push({ name: 'blk@0x' + b.start.toString(16), computed: computed, stored: stored, ok: ok });
  }
  return { ok: allOk && blocks.length > 0, blocks: res, count: blocks.length };
}
function mg1Correct(bin) {
  var copy = bin.slice(), blocks = mg1Blocks(copy), changed = [];
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i], computed = crc32Seed(copy, b.start, b.crc, MG1.SEED), stored = readU32BE(copy, b.crc);
    if (computed !== stored) { writeU32BE(copy, b.crc, computed); changed.push({ name: 'blk@0x' + b.start.toString(16), from: stored, to: computed }); }
  }
  return { bin: copy, changed: changed, check: mg1Check(copy) };
}

// Allow a named preset scheme (e.g. { preset: 'bosch-mg1' }) via check/correct.
var _check = check, _correct = correct;
check = function (bin, scheme) { return (scheme && scheme.preset === 'bosch-mg1') ? mg1Check(bin) : _check(bin, scheme); };
correct = function (bin, scheme) { return (scheme && scheme.preset === 'bosch-mg1') ? mg1Correct(bin) : _correct(bin, scheme); };

module.exports = {
  crc: crc, crcWith: crcWith, PRESETS: PRESETS, compute: compute,
  check: function (b, s) { return check(b, s); }, correct: function (b, s) { return correct(b, s); },
  readStore: readStore, writeStore: writeStore,
  crc32Seed: crc32Seed, mg1Check: mg1Check, mg1Correct: mg1Correct, mg1Blocks: mg1Blocks, MG1: MG1
};
