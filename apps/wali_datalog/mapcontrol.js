'use strict';
//
// mapcontrol.js — gated tune map switching via a DME routine.
//
// This is the ONLY module that writes to the engine controller. It is:
//   * off unless map control is ARMED in Settings (safe default: off),
//   * two-step: prepare() validates and returns a warning; commit() runs only
//     after the user confirms on screen,
//   * precondition-guarded: refuses unless the data is LIVE (not demo/stale) and
//     the car is stationary and the engine is at idle,
//   * HONEST: it never claims a map is active unless it reads the active map
//     back from the DME and it matches. Otherwise it reports the switch as
//     "requested, unconfirmed".
//
// The map-switch routine identifier and the read-back DID are ECU/tune specific.
// The built-in defaults are an UNVERIFIED community placeholder (RID 0x611E);
// set config.mapControl ({ rid, statusDid, statusOff, session, securityLevel })
// in app.json for your own ECU before trusting a live switch. If the ECU gates
// the routine behind SecurityAccess, supply a key algorithm (seedkey.makeAlgo /
// a function) — no manufacturer algorithm is bundled.
//
var uds = require('./uds');
var F = require('./format');

var RID_MAP = 0x611E;     // UNVERIFIED community placeholder for the map-select routine

function MapControl(opts) {
  opts = opts || {};
  var cfg = opts.config || {};
  this.enabled = !!opts.enabled;
  this.rid = cfg.rid || opts.rid || RID_MAP;
  this.statusDid = cfg.statusDid || opts.statusDid || null;   // DID that reports the active map (read-back)
  this.statusOff = (cfg.statusOff != null ? cfg.statusOff : (opts.statusOff != null ? opts.statusOff : 0));
  this.extendedSession = cfg.session || opts.extendedSession || 0x03;
  this.securityLevel = cfg.securityLevel || opts.securityLevel || null;
  this.keyFn = opts.keyFn || null;                            // seed->key, caller-supplied
  this.ridProven = !!(cfg.rid || opts.rid);                   // true only once the user configured a real RID
  this.maps = cfg.maps || opts.maps || defaultMaps();
  this.selected = null;      // last CONFIRMED active index (null = unknown, never assumed)
  this.requested = 0;        // index highlighted in the UI
  this.lastRequested = null; // last index we sent (confirmed or not)
}

function defaultMaps() {
  return [
    { index: 0, label: 'Stock' }, { index: 1, label: 'Map 1' }, { index: 2, label: 'Map 2' },
    { index: 3, label: 'Map 3' }, { index: 4, label: 'Map 4' }, { index: 5, label: 'Map 5' },
    { index: 6, label: 'Map 6' }, { index: 7, label: 'Map 7' }
  ];
}

MapControl.prototype.setMaps = function (maps) { if (maps && maps.length) this.maps = maps; };
MapControl.prototype.setEnabled = function (on) { this.enabled = !!on; };
MapControl.prototype.labelFor = function (index) {
  for (var i = 0; i < this.maps.length; i++) if (this.maps[i].index === index) return this.maps[i].label;
  return 'Map ' + index;
};

// Validate a requested switch without executing.
MapControl.prototype.prepare = function (index, sample, live) {
  var reasons = [];
  if (!this.enabled) reasons.push('Map control is off (arm it in Settings).');

  var target = null;
  for (var i = 0; i < this.maps.length; i++) if (this.maps[i].index === index) target = this.maps[i];
  if (!target) reasons.push('Unknown map slot.');

  sample = sample || {};
  // Require LIVE data — never act on demo or a stalled feed.
  if (live === false) reasons.push('Live vehicle data is required (the feed is demo or stale).');

  var speed = sample.speed, rpm = sample.rpm;
  var speedOk = false, idleOk = false;
  if (!F.isNum(speed)) reasons.push('Vehicle speed unknown — cannot confirm the car is stationary.');
  else if (speed > 3) reasons.push('Vehicle must be stationary (speed ' + F.fixed(speed, 0) + ' km/h).');
  else speedOk = true;
  if (!F.isNum(rpm)) reasons.push('Engine state unknown.');
  else if (rpm > 1500) reasons.push('Engine must be at idle (rpm ' + F.fixed(rpm, 0) + ').');
  else idleOk = true;

  var blocked = reasons.length > 0;
  var warn = target ? ('Switch tune to "' + target.label + '"? This writes to the engine controller. ' +
    'Reversible: switch back to Stock afterwards.' +
    (this.ridProven ? '' : ' NOTE: the switch routine is an unverified placeholder for this ECU.')) : null;
  return { ok: !blocked, blocked: blocked, reasons: reasons, target: target, speedOk: speedOk, idleOk: idleOk, warning: warn };
};

// Execute a validated switch. `diag` is a DiagProvider. Resolves:
//   { ok, confirmed, message }
// ok=true means the DME accepted the routine; confirmed=true means the active
// map was READ BACK and matches. Never claims "active" without confirmation.
MapControl.prototype.commit = function (index, sample, diag, live) {
  var self = this;
  var check = this.prepare(index, sample, live);
  if (!check.ok) return Promise.resolve({ ok: false, confirmed: false, message: check.reasons.join(' ') });
  if (!diag || typeof diag.routineControl !== 'function') {
    return Promise.resolve({ ok: false, confirmed: false, message: 'No diagnostic transport available.' });
  }

  return Promise.resolve(diag.sessionControl(this.extendedSession)).then(function (s) {
    if (!s || !s.positive) throw new Error('Diagnostic session denied: ' + ((s && (s.nrcName || s.error)) || 'no reply'));
    if (!self.securityLevel) return null;
    return diag.security(self.securityLevel, self.keyFn).then(function (sec) {
      if (!sec.ok) throw new Error('SecurityAccess denied: ' + (sec.nrc || 'locked') + ' (supply the key algorithm for this ECU).');
    });
  }).then(function () {
    return diag.routineControl(uds.ROUTINE_SUB.START, self.rid, [index & 0xff]);
  }).then(function (r) {
    if (!r || !r.positive) throw new Error('The DME rejected the map routine: ' + ((r && (r.nrcName || r.error)) || 'no reply'));
    self.lastRequested = index;
    // Read-back verification: only claim the map is active if the DME confirms it.
    if (self.statusDid && typeof diag.readDid === 'function') {
      return diag.readDid(self.statusDid).then(function (rb) {
        var activeIndex = (rb && rb.positive && rb.data && rb.data.length > self.statusOff) ? rb.data[self.statusOff] : null;
        if (activeIndex === index) {
          self.selected = index;
          return { ok: true, confirmed: true, message: 'Map confirmed active: "' + self.labelFor(index) + '" (read back from the DME).' };
        }
        return { ok: true, confirmed: false, message: 'Map "' + self.labelFor(index) + '" requested and accepted, but the read-back reported ' +
          (activeIndex == null ? 'no active map' : '"' + self.labelFor(activeIndex) + '"') + ' — verify on the car.' };
      });
    }
    // No read-back configured: honest about not being able to confirm.
    return { ok: true, confirmed: false, message: 'Map "' + self.labelFor(index) + '" requested — the DME accepted it, but the app cannot read back the active map to confirm. ' +
      'Verify on the car, and set config.mapControl.statusDid for your ECU to confirm automatically.' };
  }).catch(function (e) {
    return { ok: false, confirmed: false, message: e && e.message ? e.message : String(e) };
  });
};

MapControl.RID_MAP = RID_MAP;
module.exports = MapControl;
