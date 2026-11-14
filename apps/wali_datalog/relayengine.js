'use strict';
//
// relayengine.js — the single place a relayed request is judged and carried.
//
// There are two ways a tool can reach the car through the head unit:
//
//   * DIRECT  — the app itself listens (bridgeserver.js). No helper, no PC.
//   * HELPER  — a root daemon listens and hands requests over (bridgelink.js).
//
// Both funnel through here, so the two paths cannot drift apart and quietly
// enforce different rules. The decision is always made by the APP, against the
// on-screen consent gate; a transport never gets a say in what it may carry.
//
var relaypolicy = require('./relaypolicy');

// handle(frame, opts) -> Promise<{ bytes, allowed, reason }>
//   frame = { target: <ecu addr>, uds: [sid, ...], peer: {ip,mac}? }
//   opts  = { gate, ecuAllow, sendTo(ecu, bytes) -> Promise<respBytes>, stats? }
// `bytes` is always something safe to hand back to the tool: the car's answer
// when allowed, otherwise the UDS negative response explaining the refusal.
function handle(frame, opts) {
  opts = opts || {};
  var gate = opts.gate, stats = opts.stats || null;
  var data = (frame && frame.uds) || [];

  function done(bytes, allowed, reason) {
    if (stats) {
      if (allowed) stats.relayed = (stats.relayed || 0) + 1;
      else { stats.refused = (stats.refused || 0) + 1; stats.lastRefusal = reason || 'refused'; }
      if (!stats.audit) stats.audit = [];
      stats.audit.unshift({
        ecu: frame ? frame.target : null,
        sid: data.length ? data[0] : null,
        allowed: !!allowed, note: reason || null,
        at: (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0
      });
      if (stats.audit.length > 12) stats.audit.length = 12;
    }
    return { bytes: bytes || [], allowed: !!allowed, reason: reason || null };
  }

  // With no consent gate at all there is nothing authorising this: refuse.
  var ctx = gate ? gate.policyCtx(opts.ecuAllow) : { armed: false, ecuAllow: opts.ecuAllow };

  // ONE device per session. peerAllowed() refuses everything while no device is
  // bound, and nothing else ever binds one - so without this the bridge would
  // refuse every request from every tool, forever. The device that connects
  // first inside an ARMED session claims it; any other device is then refused
  // until the lease is dropped (disable()/disarm() clear the binding, so each
  // new session starts fresh). Arming is the user's on-screen consent, so the
  // claim can only happen in a window they opened deliberately.
  if (gate && frame && frame.peer && typeof gate.peerAllowed === 'function') {
    if (ctx.armed && !gate.peer && typeof gate.setPeer === 'function') gate.setPeer(frame.peer);
    if (!gate.peerAllowed(frame.peer)) {
      return Promise.resolve(done(nackFor(data, 0x33), false, 'another device is already using the bridge'));
    }
  }

  // FULL GATEWAY: when the owner has armed pass-through, the policy allow-list is
  // bypassed entirely - every ECU and every service is relayed. The arm itself
  // is the consent (it only holds while the lease is valid, is never persisted,
  // and clears the moment the bridge is turned off). The gate must still be
  // armed, and the one approved device still owns the session.
  var passthrough = gate && typeof gate.passthroughArmed === 'function' && gate.passthroughArmed();
  if (passthrough) {
    if (!ctx.armed) return Promise.resolve(done(nackFor(data, 0x31), false, 'bridge not armed'));
    if (typeof opts.sendTo !== 'function') return Promise.resolve(done(nackFor(data, 0x31), false, 'no link to the car'));
    return Promise.resolve(opts.sendTo(frame.target, data)).then(function (resp) {
      return done(toBytes(resp), true, 'full-gateway');
    }, function (e) {
      return done(nackFor(data, 0x78), false, (e && e.message) || 'the car did not answer');
    });
  }

  var verdict = relaypolicy.evaluate({ target: frame ? frame.target : -1, uds: data }, ctx);
  if (!verdict.allow) {
    return Promise.resolve(done(verdict.nack || nackFor(data, 0x31), false, verdict.reason || 'refused'));
  }
  if (typeof opts.sendTo !== 'function') {
    return Promise.resolve(done(nackFor(data, 0x31), false, 'no link to the car'));
  }

  return Promise.resolve(opts.sendTo(frame.target, data)).then(function (resp) {
    return done(toBytes(resp), true, null);
  }, function (e) {
    return done(nackFor(data, 0x78), false, (e && e.message) || 'the car did not answer');
  });
}

function nackFor(data, nrc) { return [0x7F, (data && data.length ? data[0] : 0x00) & 0xff, nrc & 0xff]; }

function toBytes(v) {
  var out = [];
  if (!v) return out;
  if (typeof v === 'string') {
    var h = v.replace(/[^0-9a-fA-F]/g, '');
    for (var i = 0; i + 2 <= h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16));
    return out;
  }
  if (Object.prototype.toString.call(v) === '[object Array]') {
    for (var k = 0; k < v.length; k++) out.push(Number(v[k]) & 0xff);
  }
  return out;
}

module.exports = { handle: handle, toBytes: toBytes, nackFor: nackFor };
