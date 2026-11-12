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
    send: function (bytes, cb) {
      ready.then(function (ok) {
        if (!ok) { cb && cb(new Error('diag link not ready')); return; }
        var data = Array.prototype.slice.call(bytes, 1);
        link.physical(ecu, bytes[0], data).then(function (resp) { cb && cb(null, resp || null); },
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
  this.pollMs = opts.pollMs || 50;
  this.blocks = dme.byDid(this.profile); // packed measurement blocks (one read per DID)
  this.cache = {};
  this.lastUpdate = 0;
  this.timer = null;
  this.busy = false;
  this.supported = !!this.transport.supported;
  this.sessionOk = false;
}

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
    var block = blocks[i % blocks.length]; i++;
    self.busy = true;
    self.send(uds.buildReadDataByIdentifier(block.did)).then(function (resp) {
      var p = uds.parseResponse(uds.SID.READ_DID, resp);
      if (p.positive) {
        for (var f = 0; f < block.fields.length; f++) {
          var spec = block.fields[f];
          var v = uds.scaleFromSpec(p.data, spec);
          if (typeof v === 'number' && isFinite(v)) self.cache[spec.key] = v;
        }
        self.lastUpdate = Date.now();
      }
      self.busy = false;
    }, function () { self.busy = false; });
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
module.exports = DiagProvider;
