'use strict';
//
// seedkey.js — UDS SecurityAccess (service 0x27) seed/key flow: an OPEN framework.
//
// The key-derivation algorithm is PLUGGABLE and supplied by the caller — the
// vehicle owner or the community — never bundled here. No manufacturer key is
// shipped in this repository. This mirrors python-udsoncan's `security_algo`
// model: this module drives the request-seed / send-key exchange; the caller
// provides the function that turns a seed into a key for their own ECU.
//
//   algo(seed, level, params) -> keyBytes
//
// SecurityAccess is a standard diagnostic service used on a vehicle you own,
// over its diagnostic port. This module only requests a seed, calls the caller's
// algorithm, and sends the resulting key; it performs no writes itself. What a
// caller does once a level is unlocked is their responsibility.
//
// Transport contract: `send(bytes) -> Promise<respBytes>` (plain byte arrays),
// the same shape diag.js uses, so any transport (DoIP/ENET, the head unit's
// own diagnostic gateway, or the test ECU in test/ecusim.js) works.
//
var uds = require('./uds');

function allZero(a) {
  if (!a || !a.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== 0) return false;
  return true;
}

function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Send one UDS request and resolve with the parsed FINAL reply, transparently
// waiting out responsePending (NRC 0x78) up to pendingMax times.
function sendAwait(send, bytes, reqSid, opts) {
  opts = opts || {};
  var pendingMs = opts.pendingMs || 100, pendingMax = opts.pendingMax || 20, tries = 0;
  function once() {
    return Promise.resolve(send(bytes)).then(function (resp) {
      var p = uds.parseResponse(reqSid, resp || []);
      if (p.pending && tries++ < pendingMax) return delay(pendingMs).then(once);
      return p;
    });
  }
  return once();
}

// Enter a diagnostic session (0x10 <type>). Returns { ok, nrcName, error }.
function session(send, type, opts) {
  return sendAwait(send, uds.buildSessionControl(type), uds.SID.SESSION, opts)
    .then(function (p) { return { ok: !!p.positive, nrcName: p.nrcName, error: p.error }; });
}

// Keep the session alive (0x3E). Returns { ok }.
function testerPresent(send, opts) {
  return sendAwait(send, uds.buildTesterPresent(), uds.SID.TESTER_PRESENT, opts)
    .then(function (p) { return { ok: !!p.positive }; });
}

// Unlock a SecurityAccess level. `level` is the odd requestSeed level; the key is
// sent at level+1. `algo(seed, level, params) -> keyBytes` is supplied by the
// caller. Returns { unlocked, already, seed, nrcName, error }.
function unlock(send, level, algo, opts) {
  opts = opts || {};
  if (typeof algo !== 'function') {
    return Promise.resolve({ unlocked: false, error: 'no security algorithm supplied' });
  }
  return sendAwait(send, uds.buildSecurityRequestSeed(level), uds.SID.SECURITY, opts).then(function (p) {
    if (!p.positive) return { unlocked: false, seed: null, nrcName: p.nrcName, error: p.error || 'request seed failed' };
    var seed = (p.data || []).slice(1);        // data = [levelEcho, seed...]
    if (allZero(seed)) return { unlocked: true, already: true, seed: seed }; // level already open
    var key;
    try { key = algo(seed, level, opts.params); } catch (e) { return { unlocked: false, seed: seed, error: 'algorithm threw: ' + (e && e.message) }; }
    if (!key || !key.length) return { unlocked: false, seed: seed, error: 'algorithm returned no key' };
    return sendAwait(send, uds.buildSecuritySendKey(level, key), uds.SID.SECURITY, opts).then(function (q) {
      if (q.positive) return { unlocked: true, seed: seed };
      return { unlocked: false, seed: seed, nrcName: q.nrcName, error: q.error || 'send key rejected' };
    });
  });
}

// Build a key algorithm from a declarative spec, so a seed/key scheme can be
// CONFIGURED without writing code — the community/vehicle owner supplies the spec
// for their own ECU. These are generic byte transforms only; no manufacturer
// algorithm is bundled. A function spec is passed through unchanged.
//   { type: 'identity' }
//   { type: 'add'|'sub'|'xor'|'and'|'or', value: n }   per-byte with a constant
//   { type: 'xorkey', key: [..] }                       per-byte xor with a repeating key
//   { type: 'not' } | { type: 'reverse' } | { type: 'const', key: [..] }
//   { type: 'pipe', steps: [spec, ...] }                apply the steps in sequence
function makeAlgo(spec) {
  if (typeof spec === 'function') return spec;
  if (!spec || typeof spec !== 'object') return null;
  function perByte(fn) {
    return function (seed) { return seed.map(function (b, i) { return fn(b & 0xff, i) & 0xff; }); };
  }
  switch (spec.type) {
    case 'identity': return function (seed) { return seed.slice(); };
    case 'add': return perByte(function (b) { return b + (spec.value | 0); });
    case 'sub': return perByte(function (b) { return b - (spec.value | 0); });
    case 'and': return perByte(function (b) { return b & (spec.value | 0); });
    case 'or':  return perByte(function (b) { return b | (spec.value | 0); });
    case 'xor': return perByte(function (b) { return b ^ (spec.value | 0); });
    case 'not': return perByte(function (b) { return ~b; });
    case 'xorkey': var k = (spec.key && spec.key.length) ? spec.key : [0]; return perByte(function (b, i) { return b ^ (k[i % k.length] & 0xff); });
    case 'reverse': return function (seed) { return seed.slice().reverse(); };
    case 'const': return function () { return (spec.key || []).slice(); };
    case 'pipe': var steps = (spec.steps || []).map(makeAlgo).filter(Boolean);
      return function (seed, level, params) { return steps.reduce(function (s, fn) { return fn(s, level, params); }, seed.slice()); };
    default: return null;
  }
}

module.exports = {
  unlock: unlock,
  session: session,
  testerPresent: testerPresent,
  sendAwait: sendAwait,
  allZero: allZero,
  makeAlgo: makeAlgo
};
