'use strict';
//
// provider.js — one vehicle-data source for the app.
//
// Merges live SOME/IP bus signals and diagnostic (UDS) reads into a single
// metric sample keyed by channel key, and falls back to demonstration data per
// the 'demo' setting ('on' always, 'auto' after a few seconds without live
// data, 'off' never). Derived channels are computed here too so the live UI and
// the logger see identical values.
//
var Channels = require('./channels');
var Demo = require('./demo');

function Provider(ctx, opts) {
  opts = opts || {};
  this.ctx = ctx || {};
  this.someip = opts.someip || null; // SomeipProvider | null
  this.diag = opts.diag || null;     // DiagProvider | null
  this.demo = new Demo();
  this.getSetting = opts.getSetting || function () { return undefined; };
  this.demoSince = 0;
  this.lastDemo = false;
}

Provider.prototype._demoMode = function () {
  var s = this.getSetting('demo');
  return s === undefined ? 'auto' : s;
};
Provider.prototype._sourcePref = function () {
  var s = this.getSetting('source');
  return s === undefined ? 'auto' : s;
};

// Returns { values:{channelKey:metric}, demo:bool, live:bool }
Provider.prototype.read = function (nowMs) {
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  var demoMode = this._demoMode();
  var pref = this._sourcePref();

  if (demoMode === 'on') {
    return this._pack(this.demo.sample(now), true, false);
  }

  // Gather live values.
  var sip = (this.someip && (pref === 'auto' || pref === 'someip')) ? this.someip.read() : {};
  var dia = (this.diag && (pref === 'auto' || pref === 'diag')) ? this.diag.read() : {};

  var values = {};
  var liveCount = 0;
  var chans = Channels.all();
  for (var i = 0; i < chans.length; i++) {
    var ch = chans[i];
    var v;
    if (ch.read.kind === 'someip') v = sip[ch.read.sig];
    else if (ch.read.kind === 'diag') v = dia[ch.read.key];
    else v = undefined; // derived filled below
    if (typeof v === 'number' && isFinite(v)) { values[ch.key] = v; liveCount++; }
    else values[ch.key] = NaN;
  }

  var live = liveCount > 0;

  // Demo fallback logic for 'auto'.
  if (!live && demoMode === 'auto') {
    if (!this.demoSince) this.demoSince = now;
    if (now - this.demoSince >= 5000) {
      return this._pack(this.demo.sample(now), true, false);
    }
  } else {
    this.demoSince = 0;
  }

  // Fill derived from whatever live values we have.
  this._derive(values);
  return { values: values, demo: false, live: live };
};

Provider.prototype._derive = function (values) {
  var chans = Channels.all();
  for (var i = 0; i < chans.length; i++) {
    var ch = chans[i];
    if (ch.read.kind === 'derived') values[ch.key] = ch.read.fn(values);
  }
  return values;
};

Provider.prototype._pack = function (demoSample, demo, live) {
  // demoSample already has channel-keyed metric values; ensure derived present.
  var values = {};
  var chans = Channels.all();
  for (var i = 0; i < chans.length; i++) {
    var ch = chans[i];
    if (ch.read.kind === 'derived') values[ch.key] = ch.read.fn(demoSample);
    else {
      var v = demoSample[ch.key];
      values[ch.key] = (typeof v === 'number' && isFinite(v)) ? v : NaN;
    }
  }
  return { values: values, demo: !!demo, live: !!live };
};

module.exports = Provider;
