'use strict';
//
// diag.js — diagnostic (UDS) provider for performance channels + routine control.
//
// Reads DME measured values by DID (ReadDataByIdentifier 0x22) on a poll loop
// and caches engineering values; also exposes routineControl() for the map and
// cooling jobs used by mapcontrol.js.
//
// Transport contract (injected). The MGU diagnostic channel binding is completed
// on the unit; see docs/SIGNALS-AND-DIDS.md. The transport is:
//     transport.supported : boolean
//     transport.send(bytes, cb)   // cb(errOrNull, responseByteArray)
// A Promise-returning send(bytes) is also accepted.
//
// Safety/honesty: when the DME profile is not marked verified, strict mode
// (default) suppresses output so no mis-scaled number is ever logged. Calibrate
// the profile (dme_profiles.js) and set verified:true to enable live reads.
//
var uds = require('./uds');
var dme = require('./dme_profiles');
var doipMod = require('./doip');
var seedkey = require('./seedkey');

function promisifySend(transport) {
  return function (bytes) {
    return new Promise(function (resolve, reject) {
      try {
        var r = transport.send(bytes, function (err, resp) {
          if (err) reject(err); else resolve(resp);
        });
        // Promise-style transport
        if (r && typeof r.then === 'function') r.then(resolve, reject);
      } catch (e) { reject(e); }
    });
  };
}

// Best-effort adapter over ctx. Real MGU diagnostic access is wired here on the
// unit; absent that, it reports unsupported and the provider falls back.
// Transport over the head unit's OWN SOME/IP diagnostic gateway (BMW "Tasu"),
// using the kit's read-only diagnostic link (kit/readonly-diag). This is how an
// on-car app reads the DME with no ENET adapter: the request rides the bus the
// head unit is already on. The kit sits beside the app in the built package
// (javascript/kit/); in the sim/tests it is absent, so the require is guarded
// and this returns null and the provider falls back. Read-only by construction:
// ReadOnlyDiag refuses every service except 0x22 / OBD 0x01 / 0x09.
function signalsTransport(ctx, ecu) {
  if (!ctx || !ctx.signals) return null;
  var mod;
  try { mod = require('./kit/' + 'readonly-diag'); } catch (e) { return null; }
  if (!mod || !mod.ReadOnlyDiag) return null;
  var link;
  try { link = new mod.ReadOnlyDiag(ctx.signals, ctx.log); } catch (e) { return null; }
  var ready = link.init().then(function () { return true; }, function () { return false; });
  return {
    supported: true, // optimistic: reads return null until the DME answers
    kind: 'signals',
    link: link,      // so the app can show the real link state and gate polling on it
    send: function (bytes, cb) {
      ready.then(function (ok) {
        if (!ok) { cb && cb(new Error('diag link not ready')); return; }
        var data = Array.prototype.slice.call(bytes, 1);
        // Only accept the reply that answers THIS request. Without a predicate the
        // first frame the ECU emits resolves the request, so a reply to the previous
        // DID is scaled as if it were this one. A negative response for the same
        // service is also ours (so it fails fast instead of timing out).
        var sid = bytes[0], accept;
        if (sid === 0x22) {
          var did = ((bytes[1] << 8) | bytes[2]) & 0xffff;
          accept = function (u) {
            return (u && u[0] === 0x62 && (((u[1] << 8) | u[2]) & 0xffff) === did) ||
                   (u && u[0] === 0x7f && u[1] === 0x22);
          };
        } else if (sid === 0x01) {
          var pid = bytes[1] & 0xff;
          accept = function (u) {
            return (u && u[0] === 0x41 && u[1] === pid) || (u && u[0] === 0x7f && u[1] === 0x01);
          };
        } else {
          accept = function (u) {
            return (u && u[0] === (sid + 0x40)) || (u && u[0] === 0x7f && u[1] === sid);
          };
        }
        // 4000 ms: a cold DME can take seconds to answer the first read. The default
        // was 1500, which timed out before the car replied.
        link.physical(ecu, sid, data, 4000, accept).then(function (resp) { cb && cb(null, resp || null); },
          function (e) { cb && cb(e); });
      }, function (e) { cb && cb(e); });
    }
  };
}

function makeCtxTransport(ctx, ecu) {
  if (ctx && ctx.diag && typeof ctx.diag.send === 'function') {
    return { supported: true, send: ctx.diag.send.bind(ctx.diag) };
  }
  // The head unit's own diagnostic gateway (preferred on-car).
  var st = signalsTransport(ctx, ecu || 0x12);
  if (st) return st;
  // Read-only DoIP transport over the vehicle's diagnostic Ethernet, when the
  // host provides a DoIP config ({host,port,targetAddr,...} or {socket}).
  if (ctx && ctx.doip) {
    return doipMod.makeDoipTransport(ctx.doip);
  }
  return { supported: false, send: function (_b, cb) { cb && cb(new Error('no diag transport')); } };
}

function DiagProvider(ctx, opts) {
  opts = opts || {};
  this.ctx = ctx || {};
  this.profile = opts.profile || dme.get(opts.profileName || 'generic_template');
  this.transport = opts.transport || makeCtxTransport(ctx, this.profile.ecu);
  this.send = promisifySend(this.transport);
  this.strict = opts.strict !== false;
  // 400 ms (the reference app's on-screen cadence), not 50: these reads are
  // serialized over one diagnostic link shared with the OBD poller, and a 50 ms
  // tick simply queued requests faster than the DME could answer them.
  this.pollMs = opts.pollMs || 400;
  this._fails = {};    // did -> consecutive failures
  this._failAt = {};   // did -> time of the last failure
  this._why = {};      // did -> why it last failed (shown instead of a bare '--')
  this.blocks = dme.byDid(this.profile); // packed measurement blocks (one read per DID)
  this.cache = {};
  this.lastUpdate = 0;
  this.timer = null;
  this.busy = false;
  this.supported = !!this.transport.supported;
  this.sessionOk = false;
}

// Remember why a DID read failed, so the car can tell you instead of showing '--'.
DiagProvider.prototype._note = function (block, why) {
  this._fails[block.did] = (this._fails[block.did] || 0) + 1;
  this._failAt[block.did] = Date.now();
  this._why[block.did] = why;
  if (this._fails[block.did] === 3 && this.ctx && this.ctx.log && this.ctx.log.warn) {
    try {
      this.ctx.log.warn('[wali] DID 0x' + block.did.toString(16).toUpperCase() +
        ' (' + block.fields.map(function (f) { return f.key; }).join(',') + '): ' + why);
    } catch (e) { /* logging must never break the poll */ }
  }
};

// Why a channel has no value, for the Diagnostics page.
DiagProvider.prototype.why = function (key) {
  for (var i = 0; i < this.blocks.length; i++) {
    var b = this.blocks[i];
    for (var f = 0; f < b.fields.length; f++) {
      if (b.fields[f].key === key) return this._why[b.did] || null;
    }
  }
  return 'not available on this DME';
};

DiagProvider.prototype.start = function (scheduler) {
  if (!this.supported) return false;
  var self = this;
  var setI = scheduler || (typeof setInterval === 'function' ? setInterval : null);
  if (!setI) return false;
  // Round-robin one packed block (DID) per tick; unpack all its fields at once.
  var blocks = this.blocks;
  var i = 0;
  this.timer = setI(function () {
    if (self.busy || blocks.length === 0) return;
    // Don't hammer a link that isn't up yet: every request would just time out.
    var link = self.transport && self.transport.link;
    if (link && (link.ready === false || link.available === false)) return;
    var block = blocks[i % blocks.length]; i++;
    // Skip a DID this DME has refused repeatedly, retrying only every 30 s. A B58
    // that answers NRC 0x31 (requestOutOfRange) to an identifier will keep doing so.
    var fail = self._fails[block.did] || 0;
    if (fail >= 3 && (Date.now() - (self._failAt[block.did] || 0)) < 30000) return;
    // The link latches an ECU as "silent" after a few missed replies and then drops
    // every request to it without sending. Nothing in this app ever cleared that, so
    // one bad patch (e.g. replies lost to the old short timeout) muted the DME for
    // the rest of the session. Our own 30 s backoff above is the rate limit now.
    var ecu = self.profile.ecu;
    if (link && link.silent && link.wake && link.silent(ecu)) {
      try { link.wake(ecu); } catch (e) { /* non-fatal */ }
    }
    self.busy = true;
    self.send(uds.buildReadDataByIdentifier(block.did)).then(function (resp) {
      var p = uds.parseResponse(uds.SID.READ_DID, resp);
      // The reply must echo the DID we asked for.
      if (p.positive && (p.did === undefined || p.did === block.did)) {
        for (var f = 0; f < block.fields.length; f++) {
          var spec = block.fields[f];
          var v = uds.scaleFromSpec(p.data, spec);
          if (typeof v === 'number' && isFinite(v)) self.cache[spec.key] = v;
        }
        self.lastUpdate = Date.now();
        self._fails[block.did] = 0;
        delete self._why[block.did];
      } else {
        self._note(block, p && p.nrcName ? ('NRC ' + p.nrcName) : 'unexpected reply');
      }
      self.busy = false;
    }, function (e) {
      // Record WHY, instead of discarding every failure reason and showing '--'.
      self._note(block, (e && e.message) ? e.message : String(e));
      self.busy = false;
    });
  }, this.pollMs);
  return true;
};

// profile key -> engineering value; empty while uncalibrated in strict mode.
DiagProvider.prototype.read = function () {
  if (this.strict && !this.profile.verified) return {};
  var out = {};
  for (var k in this.cache) if (this.cache.hasOwnProperty(k)) out[k] = this.cache[k];
  return out;
};

DiagProvider.prototype.health = function () {
  return {
    supported: this.supported,
    calibrated: !!this.profile.verified,
    profile: this.profile.label,
    fresh: this.supported && (Date.now() - this.lastUpdate) < 1000,
    lastUpdate: this.lastUpdate
  };
};

// ---- control plane (used by mapcontrol.js) --------------------------------

// All control-plane requests go through seedkey.sendAwait, which waits out
// responsePending (0x78) and parses the final reply — so a DME that answers
// "busy" mid-operation is handled, not mistaken for the final answer.
DiagProvider.prototype.sessionControl = function (session) {
  return seedkey.sendAwait(this.send, uds.buildSessionControl(session), uds.SID.SESSION);
};

DiagProvider.prototype.testerPresent = function () {
  return seedkey.sendAwait(this.send, uds.buildTesterPresent(), uds.SID.TESTER_PRESENT);
};

// Read one DID (for read-back verification). Resolves the parsed 0x22 reply.
DiagProvider.prototype.readDid = function (did) {
  return seedkey.sendAwait(this.send, uds.buildReadDataByIdentifier(did), uds.SID.READ_DID);
};

// Optional SecurityAccess. keyFn(seed, level) -> key is the caller's algorithm;
// no manufacturer algorithm is bundled. Delegates to the seedkey framework
// (request-seed / algo / send-key, with the already-unlocked shortcut and 0x78
// handling). Resolves { ok, nrc }.
DiagProvider.prototype.security = function (level, keyFn) {
  return seedkey.unlock(this.send, level, keyFn).then(function (r) {
    return { ok: !!r.unlocked, nrc: r.unlocked ? null : (r.nrcName || r.error) };
  });
};

DiagProvider.prototype.routineControl = function (sub, rid, data) {
  return seedkey.sendAwait(this.send, uds.buildRoutineControl(sub, rid, data), uds.SID.ROUTINE);
};

DiagProvider.prototype.stop = function () {
  if (this.timer && typeof clearInterval === 'function') clearInterval(this.timer);
  this.timer = null;
};

DiagProvider.makeCtxTransport = makeCtxTransport;
// The head unit's own diagnostic link, so the app can build ONE shared transport
// instead of each provider (and each CONNECT tap) creating its own SOME/IP proxy.
DiagProvider.makeCtxTransport = makeCtxTransport;

module.exports = DiagProvider;
