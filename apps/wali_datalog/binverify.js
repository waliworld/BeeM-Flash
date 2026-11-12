'use strict';
//
// binverify.js — verify a DME calibration image against known fingerprints.
//
// Given the bytes of a full DME image, SHA-256 it and look it up in the bundled
// fingerprint set (stockbins.js, from dmacpro91/BMW-XDFs). This catches a tune
// that KEEPS the stock calibration ID but changes the map data: the ID matches
// stock, yet the bytes don't — so the ID-level check says "stock" while this
// says the image is not stock. A match to an MHD+ base fingerprint positively
// identifies an MHD+ custom-code base.
//
// Only fingerprints are bundled; no BMW firmware bytes are included.
//
var bins = null; try { bins = require('./stockbins'); } catch (e) { bins = null; }

// SHA-256 of a byte array (0..255) -> lowercase hex. Uses Node crypto when
// present (fast, on the Node 8 head unit), else a pure-JS fallback.
function sha256(bytes) {
  try {
    var crypto = require('crypto');
    if (crypto && crypto.createHash) {
      var buf = (typeof Buffer !== 'undefined') ? Buffer.from(bytes) : bytes;
      return crypto.createHash('sha256').update(buf).digest('hex');
    }
  } catch (e) { /* fall through to pure JS */ }
  return sha256js(bytes);
}

var K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];

function sha256js(data) {
  function rr(x, n) { return (x >>> n) | (x << (32 - n)); }
  var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var l = data.length, withOne = l + 1;
  var k = (56 - withOne % 64 + 64) % 64, total = withOne + k + 8;
  var msg = new Array(total), i;
  for (i = 0; i < l; i++) msg[i] = data[i] & 0xff;
  msg[l] = 0x80;
  for (i = l + 1; i < total - 8; i++) msg[i] = 0;
  var bits = l * 8, hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
  msg[total - 8] = (hi >>> 24) & 0xff; msg[total - 7] = (hi >>> 16) & 0xff; msg[total - 6] = (hi >>> 8) & 0xff; msg[total - 5] = hi & 0xff;
  msg[total - 4] = (lo >>> 24) & 0xff; msg[total - 3] = (lo >>> 16) & 0xff; msg[total - 2] = (lo >>> 8) & 0xff; msg[total - 1] = lo & 0xff;
  var w = new Array(64), off, t;
  for (off = 0; off < total; off += 64) {
    for (t = 0; t < 16; t++) w[t] = ((msg[off + t * 4] << 24) | (msg[off + t * 4 + 1] << 16) | (msg[off + t * 4 + 2] << 8) | (msg[off + t * 4 + 3])) >>> 0;
    for (t = 16; t < 64; t++) {
      var s0 = (rr(w[t - 15], 7) ^ rr(w[t - 15], 18) ^ (w[t - 15] >>> 3)) >>> 0;
      var s1 = (rr(w[t - 2], 17) ^ rr(w[t - 2], 19) ^ (w[t - 2] >>> 10)) >>> 0;
      w[t] = (((w[t - 16] + s0) >>> 0) + ((w[t - 7] + s1) >>> 0)) >>> 0;
    }
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (t = 0; t < 64; t++) {
      var S1 = (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) >>> 0;
      var ch = ((e & f) ^ ((~e) & g)) >>> 0;
      var t1 = (((h + S1) >>> 0) + ((ch + K[t]) >>> 0) + w[t]) >>> 0;
      var S0 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) >>> 0;
      var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      var t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  var hex = '';
  for (i = 0; i < 8; i++) hex += ('0000000' + (H[i] >>> 0).toString(16)).slice(-8);
  return hex;
}

// verifyHash(hex) -> { match, kind, id, ecu, engine, sha256 }: look up a hash.
function verifyHash(hex) {
  var hit = (bins && bins.bySha) ? bins.bySha[hex] : null;
  if (hit) return { match: true, kind: hit.k, id: hit.id, ecu: hit.ecu, engine: hit.e, sha256: hex };
  return { match: false, kind: null, sha256: hex };
}

// verify(bytes) -> same shape. kind: 'stock' | 'mhdplus' | null (unknown image).
function verify(bytes) { return verifyHash(sha256(bytes)); }

// Human-readable summary of a verify() result for the UI.
function describe(v) {
  if (!v) return 'not checked';
  if (v.match && v.kind === 'stock') return 'STOCK image (' + v.id + ')';
  if (v.match && v.kind === 'mhdplus') return 'MHD+ base (' + v.id + ')';
  return 'not a known stock / MHD+ image';
}

module.exports = { sha256: sha256, _sha256js: sha256js, verify: verify, verifyHash: verifyHash, describe: describe, stockIds: (bins && bins.stockIds) || {} };
