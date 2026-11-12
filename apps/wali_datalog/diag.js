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
function makeCtxTransport(ctx) {
  if (ctx && ctx.diag && typeof ctx.diag.send === 'function') {
    return { supported: true, send: ctx.diag.send.bind(ctx.diag) };
  }
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
  this.transport = opts.transport || makeCtxTransport(ctx);
  this.send = promisifySend(this.transport);
  this.profile = opts.profile || dme.get(opts.profileName || 'generic_template');
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

DiagProvider.prototype.sessionControl = function (session) {
  return this.send(uds.buildSessionControl(session)).then(function (resp) {
    return uds.parseResponse(uds.SID.SESSION, resp);
  });
};

DiagProvider.prototype.testerPresent = function () {
  return this.send(uds.buildTesterPresent()).then(function (resp) {
    return uds.parseResponse(uds.SID.TESTER_PRESENT, resp);
  });
};

// Optional seed/key. keyFn(seedBytes, level) -> keyBytes. The algorithm is
// vehicle-specific and intentionally NOT bundled; inject it if your access
// level requires security. Resolves { ok, nrc } .
DiagProvider.prototype.security = function (level, keyFn) {
  var self = this;
  return this.send(uds.buildSecurityRequestSeed(level)).then(function (resp) {
    var seedResp = uds.parseResponse(uds.SID.SECURITY, resp);
    if (!seedResp.positive) return { ok: false, nrc: seedResp.nrcName || seedResp.error };
    var seed = seedResp.data;
    // All-zero seed => already unlocked.
    var allZero = seed.every(function (b) { return b === 0; });
    if (allZero) return { ok: true };
    if (typeof keyFn !== 'function') return { ok: false, nrc: 'no key provider' };
    var key = keyFn(seed, level);
    return self.send(uds.buildSecuritySendKey(level, key)).then(function (r2) {
      var keyResp = uds.parseResponse(uds.SID.SECURITY, r2);
      return { ok: keyResp.positive, nrc: keyResp.positive ? null : (keyResp.nrcName || keyResp.error) };
    });
  });
};

DiagProvider.prototype.routineControl = function (sub, rid, data) {
  return this.send(uds.buildRoutineControl(sub, rid, data)).then(function (resp) {
    return uds.parseResponse(uds.SID.ROUTINE, resp);
  });
};

DiagProvider.prototype.stop = function () {
  if (this.timer && typeof clearInterval === 'function') clearInterval(this.timer);
  this.timer = null;
};

DiagProvider.makeCtxTransport = makeCtxTransport;
module.exports = DiagProvider;
