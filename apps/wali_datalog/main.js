'use strict';
//
// main.js — Wali Datalog application controller.
//
// Runs on the MGU head unit via the app runtime (mgu.run) and, unchanged, in
// the PC simulator (scripts/run-sim.js) which injects a compatible ctx. All app
// logic — sampling, logging, input, view building, map-control gating — is
// exercised by the simulator and the test suite. The handful of genuinely
// device-specific calls (canvas surface, image present, screen show, media dir)
// are probed on ctx with safe fallbacks and marked DEVICE below.
//
var SomeipProvider = require('./src/someip');
var DiagProvider = require('./src/diag');
var Provider = require('./src/provider');
var MhdMonitor = require('./src/mhdmonitor');
var LogEngine = require('./src/logengine');
var MapControl = require('./src/mapcontrol');
var Channels = require('./src/channels');
var storageMod = require('./src/storage');
var dme = require('./src/dme_profiles');
var theme = require('./src/ui/theme');
var screens = require('./src/ui/screens');
var surface = require('./src/ui/surface');
var F = require('./src/format');

var SCREEN_ORDER = ['live', 'datalog', 'channels', 'maps', 'mhd'];
var DEFAULTS = { demo: 'auto', source: 'auto', platform: 'B58', rate: 10, units: 'metric', autostart: false, mapcontrol: false };

function App() {}

App.prototype.start = function (ctx) {
  var self = this;
  this.ctx = ctx || {};
  this.t = mergeTheme(theme.DARK, this.ctx.theme ? safe(this.ctx.theme) : null);

  // ---- settings ---------------------------------------------------------
  this.getSetting = function (k) {
    var v;
    if (self.ctx.settings && self.ctx.settings.get) v = self.ctx.settings.get(k);
    return v === undefined || v === null ? DEFAULTS[k] : v;
  };

  // ---- storage (needed before loading the PID profile) ------------------
  var dataDir = this.ctx.dataDir || './data';
  this.storage = this.ctx._storage ? this.ctx._storage : storageMod.fsStorage(dataDir); // sim injects _storage

  // ---- data sources -----------------------------------------------------
  this.someip = new SomeipProvider(this.ctx);
  trySafe(function () { self.someip.start(); });
  var profile = this._loadPidProfile();
  this.diag = new DiagProvider(this.ctx, profile ? { profile: profile } : {});
  if (this.diag.supported) trySafe(function () { self.diag.start(); });
  // MHD live monitor (2C 88 01) over the same diagnostic transport; preferred
  // source for an MHD-flashed MG1 car. Read-only.
  this.monitor = new MhdMonitor(this.ctx, { transport: this.diag.transport, platform: this.getSetting('platform') });
  if (this.monitor.supported) trySafe(function () { self.monitor.start(); });
  this.provider = new Provider(this.ctx, {
    someip: this.someip, diag: this.diag, mhd: this.monitor, getSetting: this.getSetting
  });

  // ---- log engine -------------------------------------------------------
  this.engine = new LogEngine({
    storage: this.storage,
    onError: function (msg) { if (self.ctx.log && self.ctx.log.error) self.ctx.log.error(msg); }
  });
  this.enabled = this._loadEnabled();
  this.engine.configure({
    channels: this.enabled, rate: Number(this.getSetting('rate')), units: this.getSetting('units')
  });

  // ---- map control ------------------------------------------------------
  this.map = new MapControl({ enabled: !!this.getSetting('mapcontrol') });

  // ---- ui state ---------------------------------------------------------
  this.screen = 'live';
  this.selection = 0;
  this.latest = { values: {}, demo: false, live: false };
  this.confirm = false;

  // react to settings changes live
  if (this.ctx.settings && this.ctx.settings.onChange) {
    this.ctx.settings.onChange(function () { self._applySettings(); });
  }

  this._surface = this._makeSurface();
  this._bindButtons();
  this._startRuntime();
  return this;
};

// Reconfigure from settings without dropping an active recording.
App.prototype._applySettings = function () {
  this.map.setEnabled(!!this.getSetting('mapcontrol'));
  if (this.engine.state !== LogEngine.STATE.LOGGING) {
    this.engine.configure({
      channels: this.enabled, rate: Number(this.getSetting('rate')), units: this.getSetting('units')
    });
  }
};

// ---- channel-enable persistence ----------------------------------------
App.prototype._loadEnabled = function () {
  // 1) the user's live channel edits
  var edits = this._readKeyList('channels.json');
  if (edits) return edits;
  // 2) an imported preset, e.g. converted from an MHD LogPresets.csv
  var preset = this._readKeyList('preset.json');
  if (preset) return preset;
  // 3) catalogue defaults
  return Channels.defaults();
};

// Read a channel-key list from storage. Accepts a bare array or { enabled:[...] }.
App.prototype._readKeyList = function (name) {
  try {
    if (!(this.storage && this.storage.read)) return null;
    var txt = this.storage.read(name);
    if (!txt) return null;
    var data = JSON.parse(txt);
    var arr = Array.isArray(data) ? data : (data && data.enabled);
    if (arr && arr.length) {
      var filtered = arr.filter(function (k) { return !!Channels.get(k); });
      if (filtered.length) return filtered;
    }
  } catch (e) {}
  return null;
};
App.prototype._saveEnabled = function () {
  try {
    if (this.storage && this.storage.open) {
      var h = this.storage.open('channels.json');
      this.storage.append(h, JSON.stringify(this.enabled));
      this.storage.close(h);
    }
  } catch (e) {}
};

// Load an imported per-tune PID profile (pidmap.json) if the user supplied one.
// Returns a normalised profile or null (then DiagProvider uses the template).
App.prototype._loadPidProfile = function () {
  try {
    if (this.storage && this.storage.read) {
      var txt = this.storage.read('pidmap.json');
      if (txt && txt.length) {
        var prof = dme.fromJson(JSON.parse(txt));
        if (this.ctx.log && this.ctx.log.info) this.ctx.log.info('Loaded PID profile: ' + prof.label);
        return prof;
      }
    }
  } catch (e) {
    if (this.ctx.log && this.ctx.log.warn) this.ctx.log.warn('pidmap.json ignored: ' + (e && e.message ? e.message : e));
  }
  return null;
};

// ---- runtime loops ------------------------------------------------------
App.prototype._startRuntime = function () {
  var self = this;
  // Sampling at the configured rate, independent of display refresh.
  var rate = Number(this.getSetting('rate')) || 10;
  var periodMs = Math.max(10, Math.round(1000 / rate));
  if (typeof setInterval === 'function' && !this.ctx._noTimers) {
    this._sampler = setInterval(function () { self.tick(); }, periodMs);
  }
  // Rendering: one ctx.loop per screen if available.
  if (this.ctx.loop) {
    SCREEN_ORDER.forEach(function (name) {
      self.ctx.loop(name, 30, function () {
        self.render(self._surface, name);
        return self._present(name);
      });
    });
  }
};

// One data tick: read provider, feed the logger, handle auto-start.
App.prototype.tick = function (now) {
  var sample = this.provider.read(now);
  this.latest = sample;
  if (this.engine.state === LogEngine.STATE.LOGGING) {
    this.engine.sample(sample.values);
  } else if (this.getSetting('autostart') && sample.live && !sample.demo) {
    var sp = sample.values.speed, rpm = sample.values.rpm;
    if (F.isNum(sp) && sp > 5 && F.isNum(rpm) && rpm > 1200) this._startLog();
  }
  return sample;
};

// ---- input --------------------------------------------------------------
App.prototype._bindButtons = function () {
  var self = this;
  if (!(this.ctx.ui && this.ctx.ui.onClick)) return;
  ['BTN_A', 'BTN_B', 'BTN_C', 'BTN_D'].forEach(function (b) {
    self.ctx.ui.onClick(b, function () { self.onButton(b); });
  });
};

App.prototype.onButton = function (btn) {
  var s = this.screen;
  if (s === 'live') {
    if (btn === 'BTN_A') return this._show('datalog');
    if (btn === 'BTN_B') return this._show('maps');
    if (btn === 'BTN_C') return this._show('channels');
  } else if (s === 'datalog') {
    if (btn === 'BTN_A') return this._startLog();
    if (btn === 'BTN_B') return this._stopLog();
    if (btn === 'BTN_C') return this._export();
    if (btn === 'BTN_D') return this._show('live');
  } else if (s === 'channels') {
    if (btn === 'BTN_A') return this._toggleChannel();
    if (btn === 'BTN_B') return this._allChannels(true);
    if (btn === 'BTN_C') return this._allChannels(false);
    if (btn === 'BTN_D') { this._saveEnabled(); return this._show('live'); }
  } else if (s === 'maps') {
    if (btn === 'BTN_A') return this._mapStep(-1);
    if (btn === 'BTN_B') return this._mapStep(1);
    if (btn === 'BTN_C') return this._mapApply();
    if (btn === 'BTN_D') { if (this.confirm) { this.confirm = false; return; } return this._show('live'); }
  } else if (s === 'mhd') {
    if (btn === 'BTN_A') return this._openMhd();
    if (btn === 'BTN_D') return this._show('live');
  }
};

// Rotary selection on the channels screen (optional controller support).
App.prototype.onRotate = function (delta) {
  if (this.screen !== 'channels') return;
  var n = Channels.all().length;
  this.selection = ((this.selection + delta) % n + n) % n;
};

// ---- actions ------------------------------------------------------------
App.prototype._startLog = function () {
  this.engine.configure({
    channels: this.enabled, rate: Number(this.getSetting('rate')), units: this.getSetting('units')
  });
  this.engine.start();
};
App.prototype._stopLog = function () { this.engine.stop(); };
App.prototype.marker = function (label) { this.engine.marker(label || 'mark'); };

App.prototype._export = function () {
  var sess = this.engine.sessions();
  if (!sess.length) { this._flash('No logs to export'); return; }
  try {
    var dest = this._mediaDir();
    var out = this.engine.exportTo(sess[0], dest);
    this._flash('Exported to ' + out);
  } catch (e) {
    this._flash(e && e.message ? e.message : 'Export failed');
  }
};

App.prototype._toggleChannel = function () {
  var key = Channels.all()[this.selection].key;
  var i = this.enabled.indexOf(key);
  if (i >= 0) this.enabled.splice(i, 1); else this.enabled.push(key);
  this._saveEnabled();
};
App.prototype._allChannels = function (on) {
  this.enabled = on ? Channels.all().map(function (c) { return c.key; }) : [];
  this._saveEnabled();
};

App.prototype._mapStep = function (dir) {
  var slots = this.map.maps;
  var idx = 0;
  for (var i = 0; i < slots.length; i++) if (slots[i].index === this.map.requested) idx = i;
  idx = (idx + dir + slots.length) % slots.length;
  this.map.requested = slots[idx].index;
  this.confirm = false;
};
App.prototype._mapApply = function () {
  var self = this;
  var prep = this.map.prepare(this.map.requested, this.latest.values);
  if (!prep.ok) { this._flash(prep.reasons[0] || 'Cannot switch'); return; }
  if (!this.confirm) { this.confirm = true; return; }
  this.confirm = false;
  this.map.commit(this.map.requested, this.latest.values, this.diag).then(function (res) {
    self._mapMsg = res.message; self._mapOk = res.ok;
  });
};

App.prototype._openMhd = function () {
  var url = 'https://www.mhdtuning.com';
  // DEVICE: open the unit's browser/uplink if available.
  if (this.ctx.openUrl) trySafe(function () { this.ctx.openUrl(url); }.bind(this));
  else this._flash('Open ' + url + ' in a connected browser');
};

App.prototype._flash = function (msg) {
  this._mapMsg = msg; this._mapOk = false;
  if (this.ctx.log && this.ctx.log.info) this.ctx.log.info(msg);
};

// ---- view model + render ------------------------------------------------
App.prototype.buildView = function () {
  var eng = this.engine;
  var st = eng.state;
  var rec = {
    state: st,
    logging: st === LogEngine.STATE.LOGGING,
    durationMs: eng.stats.durationMs,
    samples: eng.stats.samples,
    rateActual: eng.stats.rate,
    bytes: eng.stats.bytes,
    markers: eng.stats.markers,
    file: eng.file,
    error: eng.errorMsg,
    enabledCount: this.enabled.length,
    rate: Number(this.getSetting('rate'))
  };
  var sessions = this.engine.sessions().map(function (n) {
    var size = 0;
    try { size = (this.storage.read(n) || '').length; } catch (e) {}
    return { name: n, size: size };
  }, this);

  var prep = this.map.prepare(this.map.requested, this.latest.values);
  var maps = {
    enabled: this.map.enabled,
    slots: this.map.maps,
    requested: this.map.requested,
    selected: this.map.selected,
    confirm: this.confirm,
    lastMsg: this._mapMsg,
    lastOk: this._mapOk,
    pre: { speedOk: prep.speedOk, idleOk: prep.idleOk, reasons: prep.reasons }
  };

  return {
    units: this.getSetting('units'),
    demo: this.latest.demo, live: this.latest.live,
    vals: this.latest.values,
    rec: rec,
    sessions: sessions,
    enabled: this.enabled,
    selection: this.selection,
    maps: maps,
    mhd: { internet: !!this.ctx.internet, url: 'https://www.mhdtuning.com' }
  };
};

App.prototype.render = function (cv, screenName) {
  var view = this.buildView();
  screens.byName(screenName || this.screen)(cv, this.t, view);
};

// ---- device shims -------------------------------------------------------
App.prototype._makeSurface = function () {
  if (this.ctx.surface) return this.ctx.surface(screens.W, screens.H);     // sim/injected
  if (this.ctx.canvas) return surface.fromCtxCanvas(this.ctx.canvas(screens.W, screens.H), screens.W, screens.H); // DEVICE
  return null;
};
App.prototype._present = function (name) {
  // DEVICE: hand the drawn canvas to the screen's image widget.
  if (this.ctx.ui && this.ctx.ui.image && this._surface && this._surface.handle) {
    return this.ctx.ui.image('canvas', this._surface.handle);
  }
  return null;
};
App.prototype._show = function (name) {
  this.screen = name;
  this.confirm = false;
  if (this.ctx.show) trySafe(function () { this.ctx.show(name); }.bind(this)); // DEVICE
};
App.prototype._mediaDir = function () {
  return this.ctx.mediaDir || '/media/usb'; // DEVICE: USB mount point
};

App.prototype.stop = function () {
  if (this._sampler) clearInterval(this._sampler);
  trySafe(function () { this.someip.stop(); }.bind(this));
  trySafe(function () { this.diag.stop(); }.bind(this));
  trySafe(function () { this.monitor.stop(); }.bind(this));
};

// ---- helpers ------------------------------------------------------------
function mergeTheme(base, over) {
  var out = {};
  for (var k in base) out[k] = base[k];
  if (over) for (var j in over) if (over[j]) out[j] = over[j];
  return out;
}
function safe(fn) { try { return fn(); } catch (e) { return null; } }
function trySafe(fn) { try { fn(); } catch (e) {} }

// Export for the simulator/tests, and self-register on the head unit runtime.
var app = new App();
if (typeof mgu !== 'undefined' && mgu && mgu.run) {
  mgu.run({ start: function (ctx) { return app.start(ctx); } });
}
module.exports = { App: App, app: app, SCREEN_ORDER: SCREEN_ORDER };
