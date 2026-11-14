'use strict';
//
// bridgegate.js — consent state machine for the optional wireless bridge.
//
// Mirrors enetgate.js's rule (acknowledge-then-enable, enable never persisted) and
// adds the controls a network-facing relay needs. Three independent tiers, each a
// deliberate on-HU action, each failing CLOSED:
//
//   1. BRIDGE ON   — acknowledge() the disclosure (persisted), then enable() this
//                    session (never persisted; always starts off).
//   2. ARM (lease) — arm(ms) opens a time-boxed lease; the daemon may open its
//                    Wi-Fi listener only while a lease is valid, and must tear it
//                    down within a few seconds of the lease lapsing. renew() is the
//                    heartbeat. ANY disarm / loss closes the listener.
//   3. WRITE ARM   — armWrite(ecu) is a SEPARATE, stricter arm for flashing one
//                    named ECU, reusing the local flasher's "you must have read
//                    INFO + two-press confirm" discipline (enforced by the caller).
//
// Nothing here opens a socket; it only says what is permitted. The daemon and the
// relay read status()/leaseValid() and obey. Uses an injectable clock so it is
// deterministic in tests.
//
function BridgeGate(opts) {
  opts = opts || {};
  this.storage = opts.storage || null;
  this.now = opts.now || function () { return Date.now(); };
  this.defaultLeaseMs = opts.leaseMs || 30000;   // a lease lapses in 30s without a heartbeat
  this.writeLeaseMs = opts.writeLeaseMs || 120000;

  this.acknowledged = false;
  this.enabled = false;        // in-memory only; never persisted true
  this.leaseUntil = 0;         // 0 = no lease
  this.peer = null;            // { ip, mac } of the one approved tool, in-memory
  this.writeUntil = 0;         // 0 = write not armed
  this.writeEcu = undefined;
  this.allowClearDtc = false;  // separate opt-in for 0x14
  this.passthrough = false;    // FULL GATEWAY: relay EVERYTHING, every ECU + every service
  this._load();
}

BridgeGate.prototype._load = function () {
  try {
    if (this.storage && this.storage.read) {
      var t = this.storage.read('bridge.json');
      if (t) this.acknowledged = !!JSON.parse(t).acknowledged;
    }
  } catch (e) {}
};
BridgeGate.prototype._save = function () {
  try {
    if (this.storage && this.storage.open) {
      var h = this.storage.open('bridge.json');
      this.storage.append(h, JSON.stringify({ acknowledged: this.acknowledged }));
      this.storage.close(h);
    }
  } catch (e) {}
};

BridgeGate.prototype.acknowledge = function () { this.acknowledged = true; this._save(); };
BridgeGate.prototype.revoke = function () { this.acknowledged = false; this.disable(); this._save(); };

// Tier 1: permit the bridge this session. Refuses without acknowledgment.
BridgeGate.prototype.enable = function () {
  if (!this.acknowledged) return { ok: false, reason: 'Acknowledge the bridge safety warning first.' };
  this.enabled = true;
  return { ok: true };
};
BridgeGate.prototype.disable = function () {
  this.enabled = false;
  this.leaseUntil = 0; this.peer = null;
  this.writeUntil = 0; this.writeEcu = undefined; this.allowClearDtc = false;
  this.passthrough = false;
};

// Tier 2: open / renew / drop the lease that lets the daemon hold its listener.
BridgeGate.prototype.arm = function (ms) {
  if (!this.enabled) return { ok: false, reason: 'Turn the bridge ON first.' };
  this.leaseUntil = this.now() + (ms || this.defaultLeaseMs);
  return { ok: true, until: this.leaseUntil };
};
BridgeGate.prototype.renew = function (ms) {
  if (!this.enabled || !this.leaseValid()) return { ok: false, reason: 'No active lease to renew.' };
  this.leaseUntil = this.now() + (ms || this.defaultLeaseMs);
  return { ok: true, until: this.leaseUntil };
};
BridgeGate.prototype.disarm = function () {
  this.leaseUntil = 0; this.peer = null;
  this.writeUntil = 0; this.writeEcu = undefined; this.allowClearDtc = false;
  this.passthrough = false;
};

// FULL GATEWAY pass-through. When armed, the bridge hands a connected tool the
// WHOLE car - every module and every service, flashing included - instead of
// the read-only, DME/EGS-only default. It is a separate, explicit arm that only
// holds while the lease is valid and is NEVER persisted, so it cannot survive a
// restart and cannot be on by accident. This is the owner's deliberate choice.
BridgeGate.prototype.armPassthrough = function () {
  if (!this.leaseValid()) return { ok: false, reason: 'Turn the bridge ON first.' };
  this.passthrough = true;
  return { ok: true };
};
BridgeGate.prototype.disarmPassthrough = function () { this.passthrough = false; };
BridgeGate.prototype.passthroughArmed = function () { return this.passthrough && this.leaseValid(); };
BridgeGate.prototype.leaseValid = function () { return this.enabled && this.leaseUntil > this.now(); };

// Pin the single approved peer (shown on the HU before the first byte is relayed).
BridgeGate.prototype.setPeer = function (p) { this.peer = p || null; };
BridgeGate.prototype.peerAllowed = function (p) {
  if (!this.peer) return false;
  if (!p) return false;
  if (this.peer.ip && p.ip && this.peer.ip !== p.ip) return false;
  if (this.peer.mac && p.mac && this.peer.mac !== p.mac) return false;
  return true;
};

// Tier 3: arm writing/flashing for ONE ECU. Caller must have satisfied the local
// flasher's preconditions (INFO read + explicit confirm) before calling this.
BridgeGate.prototype.armWrite = function (ecu, ms) {
  if (!this.leaseValid()) return { ok: false, reason: 'Arm the bridge lease first.' };
  this.writeEcu = ecu & 0xff;
  this.writeUntil = this.now() + (ms || this.writeLeaseMs);
  return { ok: true, until: this.writeUntil };
};
BridgeGate.prototype.disarmWrite = function () { this.writeUntil = 0; this.writeEcu = undefined; };
BridgeGate.prototype.writeArmed = function () { return this.leaseValid() && this.writeUntil > this.now(); };

BridgeGate.prototype.setAllowClearDtc = function (on) { this.allowClearDtc = !!on && this.leaseValid(); };

// The context relaypolicy.evaluate() consumes.
BridgeGate.prototype.policyCtx = function (ecuAllow) {
  return {
    armed: this.leaseValid(),
    writeArmed: this.writeArmed(),
    writeEcu: this.writeArmed() ? this.writeEcu : undefined,
    ecuAllow: ecuAllow,
    allowClearDtc: this.allowClearDtc && this.leaseValid()
  };
};

BridgeGate.prototype.status = function () {
  return {
    acknowledged: this.acknowledged,
    enabled: this.enabled,
    armed: this.leaseValid(),
    leaseUntil: this.leaseUntil,
    peer: this.peer,
    writeArmed: this.writeArmed(),
    writeEcu: this.writeArmed() ? this.writeEcu : null,
    allowClearDtc: this.allowClearDtc && this.leaseValid(),
    passthrough: this.passthroughArmed()
  };
};

module.exports = BridgeGate;
