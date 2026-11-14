'use strict';
//
// liveadjust.js — LIVE engine adjustments (exhaust flap, tuner map / max cooling).
//
// This is NOT flashing and NOT map calibration. It uses UDS
// InputOutputControlByIdentifier (0x2F) to override an actuator on the running
// engine. Two things follow from that, and the whole module is built around them:
//
//   * It is a WRITE. So it is off unless "Engine config" is ARMED in Settings,
//     every change is two-step (select, then confirm), preconditions are checked
//     against LIVE data, and it is carried on a link that permits 0x2F only to
//     the engine controller (see vehiclelink.js LIVE_SERVICES).
//   * It is temporary and reversible. "Return control to the ECU" (0x2F .. 0x00)
//     hands the actuator back, and an ignition cycle does the same. Nothing here
//     changes the tune, and nothing survives a restart.
//
// Honesty about identifiers — this matters, because a wrong 0x2F can move the
// wrong actuator:
//   * EXHAUST FLAP uses the standard 0x2F form on DID 0x60FD. This is the value
//     the community uses on B58/S58 and it is corroborated inside this very
//     repo: kit/runtime/diag.js's reply-echo table documents "2F: 6F 60FD 03 .."
//     as a known positive answer. Treated as likely-correct but still UNVERIFIED
//     on your car until you see it work.
//   * ENGINE MAP (live 1-4) and MAX COOLING are TUNER features, not BMW ones. A
//     stock DME has no such control. They are sent as a tuner-style short 0x2F
//     payload and are UNVERIFIED: they only do anything on a calibration that
//     implements them, and the group bytes differ between tunes. Supply your
//     own via config.liveAdjust rather than trusting the defaults.
//
// Everything is overridable from app.json "config": { "liveAdjust": { ... } }.
//
var uds = require('./uds');
var seedkey = require('./seedkey');
var F = require('./format');

// ---- defaults (overridable via config.liveAdjust) --------------------------
var FLAP_DID = 0x60FD;          // exhaust-flap actuator
var FLAP_OPEN = [0x03, 0xE8];   // shortTermAdjustment state: open
var FLAP_CLOSE = [0x23, 0x28];  // shortTermAdjustment state: closed
var TUNER_MAP_GROUP = 0x01;     // tuner map select  (UNVERIFIED, tune-specific)
var TUNER_COOL_GROUP = 0x03;    // tuner max cooling (UNVERIFIED, tune-specific)

var IO_RETURN = 0x00;           // returnControlToECU
var IO_SHORT_TERM = 0x03;       // shortTermAdjustment

function LiveAdjust(opts) {
  opts = opts || {};
  var cfg = opts.config || {};
  this.enabled = !!opts.enabled;
  this.tuner = cfg.tuner || opts.tuner || 'off';   // 'off' | 'mhd' — gates the tuner-only controls
  this.flapDid = cfg.flapDid != null ? cfg.flapDid : FLAP_DID;
  this.flapOpen = cfg.flapOpen || FLAP_OPEN;
  this.flapClose = cfg.flapClose || FLAP_CLOSE;
  this.mapGroup = cfg.mapGroup != null ? cfg.mapGroup : TUNER_MAP_GROUP;
  this.coolGroup = cfg.coolGroup != null ? cfg.coolGroup : TUNER_COOL_GROUP;
  this.mapSlots = cfg.mapSlots || 4;
  this.session = cfg.session || opts.session || null;  // null = stay in the current session
  // true only once the owner configured real identifiers for their own ECU
  this.flapProven = !!(cfg.flapDid != null);
  this.tunerProven = !!(cfg.mapGroup != null || cfg.coolGroup != null);
  this.state = {};        // key -> last value we SENT (never assumed active)
  this.confirmed = {};    // key -> true once the ECU answered positively
}

// ---- the control catalogue -------------------------------------------------
// Each control is { key, label, note, tunerOnly, options: [{ value, label }] }.
LiveAdjust.prototype.controls = function () {
  var maps = [{ value: 'auto', label: 'Release' }];
  for (var i = 1; i <= this.mapSlots; i++) maps.push({ value: 'map' + i, label: 'Map ' + i });
  return [
    {
      key: 'flap', label: 'EXHAUST FLAP', tunerOnly: false,
      note: this.flapProven ? 'Configured for this ECU.'
        : 'Actuator control on DID 0x' + this.flapDid.toString(16).toUpperCase() + ' — unverified on your car.',
      options: [
        { value: 'auto', label: 'Auto (ECU)' },
        { value: 'open', label: 'Open' },
        { value: 'closed', label: 'Closed' }
      ]
    },
    {
      key: 'map', label: 'ENGINE MAP', tunerOnly: true,
      note: 'Tuner feature — only works on a calibration that implements it.',
      options: maps
    },
    {
      key: 'cooling', label: 'MAX COOLING', tunerOnly: true,
      note: 'Tuner feature — commands maximum cooling while running.',
      options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]
    }
  ];
};

LiveAdjust.prototype.control = function (key) {
  var all = this.controls();
  for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i];
  return null;
};

LiveAdjust.prototype.setEnabled = function (on) { this.enabled = !!on; };
LiveAdjust.prototype.setTuner = function (t) { this.tuner = t || 'off'; };

// The "released" value for a control (handing the actuator back to the ECU).
LiveAdjust.prototype.releaseValueFor = function (key) { return key === 'cooling' ? 'off' : 'auto'; };
// A control is HELD when an override other than its release value is active.
LiveAdjust.prototype.isHeld = function (key) {
  var v = this.state[key];
  return v != null && v !== this.releaseValueFor(key);
};
LiveAdjust.prototype.heldKeys = function () {
  var out = [];
  for (var k in this.state) if (this.state.hasOwnProperty(k) && this.isHeld(k)) out.push(k);
  return out;
};
// Keepalive requests for every held override: a TesterPresent to keep the
// diagnostic session alive, then a re-assert of each held IO control. Without
// this the ECU drops a shortTermAdjustment after its session timer (~5 s) and
// the actuator snaps back to the ECU's own strategy - which is why a flap
// commanded OPEN did not hold (the DME re-closes it at idle) while CLOSED
// appeared to (the DME also wants it closed at idle).
LiveAdjust.prototype.keepAlive = function () {
  var reqs = [uds.buildTesterPresent()];
  var held = this.heldKeys();
  for (var i = 0; i < held.length; i++) {
    var b = this.build(held[i], this.state[held[i]]);
    if (b) reqs.push(b);
  }
  return reqs;
};

// The request bytes for a control+value, or null if the pair is unknown.
LiveAdjust.prototype.build = function (key, value) {
  if (key === 'flap') {
    if (value === 'auto') return uds.buildIoControl(this.flapDid, IO_RETURN);
    if (value === 'open') return uds.buildIoControl(this.flapDid, IO_SHORT_TERM, this.flapOpen);
    if (value === 'closed') return uds.buildIoControl(this.flapDid, IO_SHORT_TERM, this.flapClose);
    return null;
  }
  if (key === 'map') {
    if (value === 'auto') return uds.buildIoControlRaw(this.mapGroup, 0x00);
    var m = /^map(\d+)$/.exec(String(value));
    if (!m) return null;
    var slot = parseInt(m[1], 10);
    if (!(slot >= 1 && slot <= this.mapSlots)) return null;
    // tuner slots are 0-based on the wire
    return uds.buildIoControlRaw(this.mapGroup, slot - 1);
  }
  if (key === 'cooling') {
    if (value !== 'on' && value !== 'off') return null;
    return uds.buildIoControlRaw(this.coolGroup, value === 'on' ? 0x01 : 0x00);
  }
  return null;
};

// ---- preconditions ---------------------------------------------------------
// prepare(key, value, sample, live) -> { ok, blocked, reasons, warning, control }
LiveAdjust.prototype.prepare = function (key, value, sample, live) {
  var reasons = [];
  var ctl = this.control(key);

  if (!this.enabled) reasons.push('Engine config is off (arm it in Settings).');
  if (!ctl) reasons.push('Unknown control.');
  if (ctl && this.build(key, value) == null) reasons.push('Unknown setting for this control.');
  if (ctl && ctl.tunerOnly && this.tuner === 'off') {
    reasons.push('This is a tuner feature — set "Tuner" in Settings to enable it.');
  }

  sample = sample || {};
  // Never act on demo or a stalled feed: an override on a car we are not
  // actually reading is exactly how you move an actuator you cannot see.
  if (live === false) reasons.push('Live vehicle data is required (the feed is demo or stale).');

  var rpm = sample.rpm, speed = sample.speed;
  // Releasing control back to the ECU is always safe - never block it.
  var releasing = (value === 'auto' || (key === 'cooling' && value === 'off'));
  if (!releasing) {
    if (key === 'map') {
      // A live map change is a torque change: only at a standstill, at idle.
      if (!F.isNum(speed)) reasons.push('Vehicle speed unknown — cannot confirm the car is stationary.');
      else if (speed > 3) reasons.push('Vehicle must be stationary (speed ' + F.fixed(speed, 0) + ' km/h).');
      if (!F.isNum(rpm)) reasons.push('Engine state unknown.');
      else if (rpm > 1500) reasons.push('Engine must be at idle (rpm ' + F.fixed(rpm, 0) + ').');
    } else if (F.isNum(rpm) && rpm < 200) {
      reasons.push('Engine is not running — start it first.');
    }
  }

  var blocked = reasons.length > 0;
  var warn = null;
  if (ctl && !blocked) {
    warn = 'Set ' + ctl.label + ' to "' + labelOf(ctl, value) + '"? This commands the engine controller live. ' +
      'Reversible: choose "' + (key === 'cooling' ? 'Off' : 'Auto (ECU)') + '" or cycle the ignition.' +
      ((ctl.tunerOnly && !this.tunerProven) || (!ctl.tunerOnly && !this.flapProven)
        ? ' NOTE: this identifier is unverified for your ECU.' : '');
  }
  return { ok: !blocked, blocked: blocked, reasons: reasons, warning: warn, control: ctl, releasing: releasing };
};

function labelOf(ctl, value) {
  for (var i = 0; i < ctl.options.length; i++) if (ctl.options[i].value === value) return ctl.options[i].label;
  return String(value);
}

// ---- commit ----------------------------------------------------------------
// commit(send, key, value, sample, live, opts) -> { ok, confirmed, message }
//   send(bytes) -> Promise<respBytes>, carried on the live-control link.
// ok=true means the ECU accepted the control. confirmed=true means it answered
// positively (0x6F). Never claims a setting is active without that answer.
LiveAdjust.prototype.commit = function (send, key, value, sample, live, opts) {
  var self = this;
  opts = opts || {};
  var check = this.prepare(key, value, sample, live);
  if (!check.ok) return Promise.resolve({ ok: false, confirmed: false, message: check.reasons.join(' ') });
  if (typeof send !== 'function') return Promise.resolve({ ok: false, confirmed: false, message: 'No diagnostic transport available.' });

  var bytes = this.build(key, value);
  var ctl = check.control;

  function doSend() {
    return seedkey.sendAwait(send, bytes, uds.SID.IO_CONTROL, opts).then(function (p) {
      if (!p.positive) {
        var why = p.nrcName || p.error || 'no reply';
        var hint = '';
        if (/requestOutOfRange|subFunctionNotSupported|serviceNotSupported/i.test(String(why))) {
          hint = ctl && ctl.tunerOnly
            ? ' — this calibration does not implement that tuner control.'
            : ' — this ECU does not accept that actuator control.';
        }
        return { ok: false, confirmed: false, message: ctl.label + ' rejected: ' + why + hint, nrcName: p.nrcName };
      }
      self.state[key] = value;
      self.confirmed[key] = true;
      return {
        ok: true, confirmed: true,
        message: ctl.label + ' set to "' + labelOf(ctl, value) + '" — the engine controller accepted it.'
      };
    }).catch(function (e) {
      return { ok: false, confirmed: false, message: (e && e.message) ? e.message : String(e) };
    });
  }

  if (this.session != null) {
    return seedkey.session(send, this.session, opts).then(doSend, function (e) {
      return { ok: false, confirmed: false, message: 'Diagnostic session denied: ' + ((e && e.message) || e) };
    });
  }
  return doSend();
};

// Hand every actuator we touched back to the ECU. Used by the RELEASE ALL action
// and worth calling before leaving the page.
LiveAdjust.prototype.releaseAll = function (send, opts) {
  var self = this;
  var keys = Object.keys(this.state);
  if (!keys.length) return Promise.resolve({ ok: true, released: 0, message: 'Nothing to release.' });
  var i = 0, released = 0, failed = [];
  function step() {
    if (i >= keys.length) {
      return Promise.resolve(failed.length
        ? { ok: false, released: released, message: 'Released ' + released + ', failed: ' + failed.join(', ') }
        : { ok: true, released: released, message: 'Returned ' + released + ' control' + (released === 1 ? '' : 's') + ' to the ECU.' });
    }
    var key = keys[i++];
    var value = (key === 'cooling') ? 'off' : 'auto';
    var bytes = self.build(key, value);
    if (!bytes) return step();
    return seedkey.sendAwait(send, bytes, uds.SID.IO_CONTROL, opts).then(function (p) {
      if (p.positive) { released++; delete self.state[key]; delete self.confirmed[key]; }
      else failed.push(key);
      return step();
    }).catch(function () { failed.push(key); return step(); });
  }
  return step();
};

LiveAdjust.FLAP_DID = FLAP_DID;
LiveAdjust.FLAP_OPEN = FLAP_OPEN;
LiveAdjust.FLAP_CLOSE = FLAP_CLOSE;
module.exports = LiveAdjust;
