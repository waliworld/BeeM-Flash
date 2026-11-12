'use strict';
//
// someip.js — live vehicle signals over the MGU SOME/IP bus.
//
// Subscribes (via ctx.signals.watch) to the interfaces named in signalmap.js,
// scales each raw value to engineering units, and keeps the latest sample.
//
// Only *verified* bindings are reported; an unverified placeholder returns no
// value (so the provider falls back to diagnostics or clearly-labelled demo
// data instead of emitting a wrong number). Flip verified:true in signalmap.js
// once a binding is confirmed on the unit.
//
var signalmap = require('./signalmap');

function SomeipProvider(ctx) {
  this.ctx = ctx || {};
  this.values = {};       // sig -> engineering value (verified only)
  this.lastUpdate = 0;
  this.supported = false;
  this.subs = [];
  this.counts = { total: 0, verified: 0 };
}

SomeipProvider.prototype.start = function () {
  var self = this;
  var sig = this.ctx.signals;
  var groups = signalmap.watchGroups();

  var total = 0, verified = 0;
  for (var sName in signalmap.MAP) {
    if (signalmap.MAP.hasOwnProperty(sName)) {
      total++;
      if (signalmap.MAP[sName].verified) verified++;
    }
  }
  this.counts = { total: total, verified: verified };

  if (!sig || typeof sig.watch !== 'function') {
    this.supported = false;
    return false;
  }
  this.supported = true;

  // One watch per interface, one handler per field. The kit hands the handler
  // the whole field STRUCT; we read each verified signal's named member out of
  // it (so coolant + oil, which share statusEngineTemperature, come from one
  // handler). Unverified bindings stay dormant.
  Object.keys(groups).forEach(function (iface) {
    var g = groups[iface];
    var handlers = {};
    Object.keys(g.fields).forEach(function (field) {
      var sigs = g.fields[field].filter(function (s) {
        var b = signalmap.get(s);
        return b && b.verified;
      });
      if (!sigs.length) return;
      handlers[field] = function (struct) {
        var changed = false;
        sigs.forEach(function (s) {
          var v = signalmap.readValue(s, struct);
          if (typeof v === 'number' && isFinite(v)) { self.values[s] = v; changed = true; }
        });
        if (changed) self.lastUpdate = Date.now();
      };
    });
    if (Object.keys(handlers).length === 0) return;
    try {
      // Instance '1' (string) — BMW publishes the vehicle interfaces on instance 1.
      var h = sig.watch(iface, '1', handlers, self.ctx.log);
      if (h) self.subs.push(h);
    } catch (e) {
      if (self.ctx.log && self.ctx.log.warn) self.ctx.log.warn('someip watch failed (' + iface + '): ' + e);
    }
  });
  return true;
};

// sig -> engineering value, for the channels whose read.kind === 'someip'.
SomeipProvider.prototype.read = function () {
  var out = {};
  for (var k in this.values) if (this.values.hasOwnProperty(k)) out[k] = this.values[k];
  return out;
};

SomeipProvider.prototype.health = function () {
  return {
    supported: this.supported,
    total: this.counts.total,
    verified: this.counts.verified,
    fresh: this.supported && this.counts.verified > 0 && (Date.now() - this.lastUpdate) < 2000,
    lastUpdate: this.lastUpdate
  };
};

SomeipProvider.prototype.stop = function () {
  this.subs.forEach(function (s) { try { if (s && s.stop) s.stop(); } catch (e) {} });
  this.subs = [];
};

module.exports = SomeipProvider;
