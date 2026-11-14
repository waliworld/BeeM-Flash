'use strict';
//
// vehiclelink.js — the head unit's OWN diagnostic link to the car (UDS over the
// InternalTasu SOME/IP service), presented with the same surface as the DoIP
// gateway so nothing downstream needs to know which transport it got.
//
// Why this exists: the fault-code scanner and the calibration flasher were built
// on DoIP only, and DoIP cannot be established from inside the head unit's app
// sandbox (no network capability is declared anywhere in the app model, and no
// app in the proven on-car corpus has ever opened an IP socket). So both features
// were unreachable on a real car. This link uses the transport the head unit
// already has — and that our app.json already declares and is permitted for —
// so CODES, INFO and FLASH work with no connect step.
//
// Read-only by default: a LOCAL allow-list gates every request. The live
// datalogging pages keep using kit/readonly-diag (0x22/0x01/0x09 only); that file
// is deliberately NOT widened. Writing services are refused unless the caller
// explicitly opts in with { flashing: true }, which only the gated flash path does.
//
var DME = 0x12;

// Services this link will carry. Anything else is refused before it reaches the car.
var READ_SERVICES = {
  0x19: 'readDTC',
  0x14: 'clearDTC',
  0x22: 'readDataByIdentifier',
  0x23: 'readMemoryByAddress',
  // SecurityAccess is a challenge/response handshake: on its own it cannot change
  // anything, and a protected region legitimately needs it to be READ. The services
  // that actually write stay behind the flash allow-list below.
  0x27: 'securityAccess',
  0x10: 'diagnosticSessionControl',
  // TesterPresent is a no-op keepalive (it changes nothing); allow it on any link
  // so a held live-control override can keep its diagnostic session alive.
  0x3E: 'testerPresent'
};
var FLASH_SERVICES = {
  0x34: 'requestDownload',
  0x36: 'transferData',
  0x37: 'requestTransferExit',
  0x31: 'routineControl',
  0x11: 'ecuReset'
};
// Live engine adjustments (exhaust flap, tuner map/cooling controls) use
// InputOutputControlByIdentifier. It is a WRITE - it overrides an actuator on a
// running engine - so it gets its own tier, separately armed from flashing, and
// it is permitted ONLY to the engine controller. Nothing here touches
// calibration, and returning control to the ECU (0x2F .. 0x00) undoes it.
var LIVE_SERVICES = {
  0x2F: 'inputOutputControlByIdentifier'
};
// Only the default (0x01) and extended (0x03) sessions. A programming session
// (0x02) belongs to the flashing allow-list.
var READ_SESSIONS = { 0x01: true, 0x03: true };

function hex2(n) { return (n < 16 ? '0' : '') + (n & 0xff).toString(16).toUpperCase(); }

function VehicleLink(mod, link, opts) {
  this.mod = mod;
  this.link = link;
  this.tgt = (opts && opts.target) || DME;
  this.flashing = !!(opts && opts.flashing);
  this.liveControl = !!(opts && opts.liveControl);
  this.passthrough = !!(opts && opts.passthrough);
  this.kind = 'tasu';
  this.supported = true;
  var self = this;
  this.ready = link.init().then(function () { return true; }, function () { return false; });
  this._onAvail = function (a) { self.available = a; };
  this.available = link.available;
  try { link.on('available', this._onAvail); } catch (e) { /* older kit */ }
}

// Refuse a service this link is not allowed to carry, before anything is sent.
// addr is the ECU the request is addressed to (undefined for a functional /
// all-ECU request), which the live-control tier requires.
VehicleLink.prototype._check = function (bytes, addr) {
  if (!bytes || !bytes.length) throw new Error('empty request');
  // FULL GATEWAY pass-through: this link carries anything to any ECU. It exists
  // ONLY on a link the app builds for the explicitly-armed bridge pass-through;
  // the ordinary read link, the flash link and the live link never set it.
  if (this.passthrough) return;
  var sid = bytes[0];
  if (READ_SERVICES[sid]) {
    if (sid === 0x10 && !READ_SESSIONS[bytes[1]] && !this.flashing) {
      throw new Error('session 0x' + hex2(bytes[1]) + ' needs the flash path');
    }
    return;
  }
  if (LIVE_SERVICES[sid]) {
    // Never broadcast an actuator override, and never aim one at a module other
    // than the engine controller, whatever the caller asked for.
    if (!this.liveControl) throw new Error('service 0x' + hex2(sid) + ' needs the live-control path');
    if (addr !== DME) throw new Error('live control is only permitted to the engine controller');
    return;
  }
  if (this.flashing && FLASH_SERVICES[sid]) return;
  throw new Error('service 0x' + hex2(sid) + ' is not permitted on this link');
};

// One request to one ECU. Resolves the UDS reply bytes; REJECTS on no reply —
// the kit resolves null on timeout, and flash.js/seedkey.js must never read a
// timeout as if it were an answer.
VehicleLink.prototype.sendTo = function (addr, bytes, timeoutMs) {
  var self = this;
  var arr = Array.prototype.slice.call(bytes);
  try { this._check(arr, addr); } catch (e) { return Promise.reject(e); }
  var sid = arr[0], data = arr.slice(1);
  return this.ready.then(function (ok) {
    if (!ok) throw new Error('head unit diagnostic link not ready' + (self.link.error ? ': ' + self.link.error : ''));
    return self.link.physical(addr, sid, data, timeoutMs || 4000, self.mod.replyTo(sid, data));
  }).then(function (uds) {
    if (!uds) throw new Error('no reply from 0x' + hex2(addr));
    return uds;
  });
};

VehicleLink.prototype.send = function (bytes, timeoutMs) { return this.sendTo(this.tgt, bytes, timeoutMs); };

// dtc.js binds per-module senders through this, so scanModules/clearModules work
// over either transport unchanged.
VehicleLink.prototype.sendFor = function (timeoutMs) {
  var self = this;
  return function (m) {
    var addr = (m && (m.address !== undefined ? m.address : m)) | 0;
    return function (bytes) { return self.sendTo(addr, bytes, timeoutMs); };
  };
};

// One request answered by every module that is awake — a whole-car scan without
// guessing an address list.
VehicleLink.prototype.functional = function (sid, data, opts) {
  var self = this;
  try { this._check([sid].concat(data || [])); } catch (e) { return Promise.reject(e); }
  return this.ready.then(function (ok) {
    if (!ok) throw new Error('head unit diagnostic link not ready');
    return self.link.functional(sid, data, opts);
  });
};

// Which control units are present: 22 F1 50 to all of them at once.
VehicleLink.prototype.discover = function (opts) {
  return this.functional(0x22, [0xF1, 0x50], { idleMs: (opts && opts.idleMs) || 3000, maxMs: (opts && opts.maxMs) || 15000 })
    .then(function (replies) {
      var out = new Map();
      replies.forEach(function (uds, addr) {
        if (uds && uds[0] === 0x62 && uds[1] === 0xF1 && uds[2] === 0x50) {
          var s = '';
          for (var i = 3; i < uds.length; i++) s += hex2(uds[i]);
          out.set(addr, s.slice(0, 6));
        } else {
          out.set(addr, '');   // answered, but refused to identify itself
        }
      });
      return out;
    });
};

// DoIP gateways need an activation handshake; this link does not, so resolving
// once the proxy is up keeps the two interchangeable.
VehicleLink.prototype.activate = function () {
  var self = this;
  return this.ready.then(function (ok) {
    if (!ok) throw new Error('head unit diagnostic link not ready' + (self.link.error ? ': ' + self.link.error : ''));
    return true;
  });
};

VehicleLink.prototype.status = function () {
  return { kind: 'tasu', ready: !!this.link.p, available: !!this.link.available, error: this.link.error || null };
};

VehicleLink.prototype.close = function () {
  try { this.link.removeListener('available', this._onAvail); } catch (e) { /* ignore */ }
};

/**
 * Build the link, or null when this host has no SOME/IP (the simulator, tests and
 * the browser preview all take that path and fall back to DoIP/demo).
 */
function make(ctx, opts) {
  if (!ctx || !ctx.signals) return null;
  var mod;
  // Concatenated so a bundler cannot try to resolve it off-car.
  try { mod = require('./kit/' + 'diag'); } catch (e) { return null; }
  if (!mod || !mod.Diag) return null;
  var link;
  try { link = new mod.Diag(ctx.signals, ctx.log); } catch (e) { return null; }
  try { link.quiet = true; } catch (e) { /* ignore */ }
  return new VehicleLink(mod, link, opts);
}

module.exports = { make: make, VehicleLink: VehicleLink, DME: DME, READ_SERVICES: READ_SERVICES, FLASH_SERVICES: FLASH_SERVICES, LIVE_SERVICES: LIVE_SERVICES };
