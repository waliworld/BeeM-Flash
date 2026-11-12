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

  Object.keys(groups).forEach(function (gk) {
    var g = groups[gk];
    var handlers = {};
    Object.keys(g.fields).forEach(function (field) {
      var logical = g.fields[field];
      var binding = signalmap.get(logical);
      // Only wire verified bindings; leave guesses dormant.
      if (!binding || !binding.verified) return;
      handlers[field] = function (raw) {
        var v = signalmap.scale(logical, raw);
        if (typeof v === 'number' && isFinite(v)) {
          self.values[logical] = v;
          self.lastUpdate = Date.now();
        }
      };
    });
    if (Object.keys(handlers).length === 0) return;
    try {
      var h = sig.watch(g.iface, g.instance, handlers);
      if (h) self.subs.push(h);
    } catch (e) {
      if (self.ctx.log && self.ctx.log.warn) self.ctx.log.warn('someip watch failed: ' + e);
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
