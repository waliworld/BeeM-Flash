'use strict';
//
// mapcontrol.js — gated tune map switching (and cooling) via DME routines.
//
// This is the ONLY module that writes to the engine controller. It is:
//   * off unless the "Enable map control" setting is on,
//   * two-step: prepare() validates and returns a warning; commit() executes
//     only after the user confirms on screen,
//   * precondition-guarded: refuses unless the car is stationary and the engine
//     state is known and stable.
//
// The map and cooling jobs are addressed by the DME diagnostic identifiers that
// the MGU community apps use for this purpose (map 0x611E, cooling 0x60FD),
// driven here as UDS RoutineControl. The exact job encoding is DME/tune
// specific; keep it in this one place and confirm it against the target DME
// before trusting a live switch. Nothing here runs unless map control is on.
//
var uds = require('./uds');
var F = require('./format');

var RID_MAP = 0x611E;     // tune map select job
var RID_COOLING = 0x60FD; // cooling / fan strategy job

function MapControl(opts) {
  opts = opts || {};
  this.enabled = !!opts.enabled;
  this.ridMap = opts.ridMap || RID_MAP;
  this.ridCooling = opts.ridCooling || RID_COOLING;
  this.extendedSession = opts.extendedSession || 0x03; // extendedDiagnosticSession
  this.securityLevel = opts.securityLevel || null;      // e.g. 0x11, if required
  this.keyFn = opts.keyFn || null;                      // seed->key, injected
  this.maps = opts.maps || defaultMaps();
  this.selected = 0;         // last confirmed index (optimistic until read-back)
  this.requested = 0;        // index highlighted in the UI
}

function defaultMaps() {
  // Generic slots. Real labels are tune-specific; relabel via setMaps().
  return [
    { index: 0, label: 'Stock' },
    { index: 1, label: 'Map 1' },
    { index: 2, label: 'Map 2' },
    { index: 3, label: 'Map 3' },
    { index: 4, label: 'Map 4' },
    { index: 5, label: 'Map 5' },
    { index: 6, label: 'Map 6' },
    { index: 7, label: 'Map 7' }
  ];
}

MapControl.prototype.setMaps = function (maps) { if (maps && maps.length) this.maps = maps; };
MapControl.prototype.setEnabled = function (on) { this.enabled = !!on; };

// Validate a requested switch without executing. Returns:
//   { ok, blocked, reasons:[...], warning, target }
MapControl.prototype.prepare = function (index, sample) {
  var reasons = [];
  if (!this.enabled) reasons.push('Map control is off (enable it in Settings).');

  var target = null;
  for (var i = 0; i < this.maps.length; i++) if (this.maps[i].index === index) target = this.maps[i];
  if (!target) reasons.push('Unknown map slot.');

  sample = sample || {};
  var speed = sample.speed;
  var rpm = sample.rpm;

  var speedOk = false, idleOk = false;
  if (!F.isNum(speed)) reasons.push('Vehicle speed unknown — cannot confirm the car is stationary.');
  else if (speed > 3) reasons.push('Vehicle must be stationary (speed ' + F.fixed(speed, 0) + ' km/h).');
  else speedOk = true;

  if (!F.isNum(rpm)) reasons.push('Engine state unknown.');
  else if (rpm > 1500) reasons.push('Engine must be at idle (rpm ' + F.fixed(rpm, 0) + ').');
  else idleOk = true;

  var blocked = reasons.length > 0 || !this.enabled || !target;
  return {
    ok: !blocked,
    blocked: blocked,
    reasons: reasons,
    target: target,
    speedOk: speedOk,
    idleOk: idleOk,
    warning: target ? ('Switch tune to "' + target.label + '"? This writes to the engine controller.') : null
  };
};

// Execute a validated switch. `diag` is a DiagProvider. Resolves:
//   { ok, message }
MapControl.prototype.commit = function (index, sample, diag) {
  var self = this;
  var check = this.prepare(index, sample);
  if (!check.ok) return Promise.resolve({ ok: false, message: check.reasons.join(' ') });
  if (!diag || typeof diag.routineControl !== 'function') {
    return Promise.resolve({ ok: false, message: 'No diagnostic transport available.' });
  }

  // 1) extended session, 2) optional security, 3) routine, 4) verify.
  return diag.sessionControl(this.extendedSession).then(function (s) {
    if (!s.positive) throw new Error('Session denied: ' + (s.nrcName || s.error));
    if (self.securityLevel) {
      return diag.security(self.securityLevel, self.keyFn).then(function (sec) {
        if (!sec.ok) throw new Error('Security denied: ' + (sec.nrc || 'locked'));
      });
    }
  }).then(function () {
    return diag.routineControl(uds.ROUTINE_SUB.START, self.ridMap, [index & 0xff]);
  }).then(function (r) {
    if (!r.positive) throw new Error('Map job rejected: ' + (r.nrcName || r.error));
    self.selected = index;
    self.requested = index;
    return { ok: true, message: 'Map switched to "' + self.labelFor(index) + '".' };
  }).catch(function (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  });
};

// Cooling strategy helper (same gating as map control).
MapControl.prototype.setCooling = function (level, sample, diag) {
  if (!this.enabled) return Promise.resolve({ ok: false, message: 'Map control is off.' });
  if (!diag || typeof diag.routineControl !== 'function') {
    return Promise.resolve({ ok: false, message: 'No diagnostic transport available.' });
  }
  var self = this;
  return diag.sessionControl(this.extendedSession).then(function () {
    return diag.routineControl(uds.ROUTINE_SUB.START, self.ridCooling, [level & 0xff]);
  }).then(function (r) {
    return { ok: !!r.positive, message: r.positive ? 'Cooling set.' : ('Rejected: ' + (r.nrcName || r.error)) };
  }).catch(function (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  });
};

MapControl.prototype.labelFor = function (index) {
  for (var i = 0; i < this.maps.length; i++) if (this.maps[i].index === index) return this.maps[i].label;
  return 'Map ' + index;
};

MapControl.RID_MAP = RID_MAP;
MapControl.RID_COOLING = RID_COOLING;
module.exports = MapControl;
