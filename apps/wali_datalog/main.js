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
var SomeipProvider = require('./someip');
var DiagProvider = require('./diag');
var Provider = require('./provider');
var FastLog = require('./fastlog');
var LogEngine = require('./logengine');
var MapControl = require('./mapcontrol');
var EnetGate = require('./enetgate');
var doip = require('./doip');
var Channels = require('./channels');
var storageMod = require('./storage');
var dme = require('./dme_profiles');
var theme = require('./theme');
var screens = require('./screens');
var surface = require('./surface');
var F = require('./format');

var SCREEN_ORDER = ['live', 'datalog', 'channels', 'maps', 'connect'];
var DEFAULTS = { demo: 'auto', source: 'auto', platform: 'B58', rate: 10, units: 'metric', style: 'tiles', maxtiles: 8, autostart: false, mapcontrol: false };
var DISPLAY_DEFAULT = ['rpm', 'boost', 'iat', 'coolant', 'oil', 'timing', 'knock', 'speed'];

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

  // ---- vehicle connection safety gate -------------------------------------
  // No socket is ever opened and no packet is ever sent to the vehicle until
  // the user has acknowledged the safety disclosure on the Connect screen AND
  // explicitly enabled the connection THIS session (enabling is never
  // persisted — every app launch starts fully disconnected). See enetgate.js.
  this.enet = new EnetGate({ storage: this.storage });

  // ---- data sources -----------------------------------------------------
  this.someip = new SomeipProvider(this.ctx);
  trySafe(function () { self.someip.start(); });
  // Constructs this.diag / this.monitor from the current (initially
  // disabled) connection state, so both start in demo-only mode.
  this._applyEnetState();
  this.provider = new Provider(this.ctx, {
    someip: this.someip, diag: this.diag, monitor: this.monitor, getSetting: this.getSetting
  });

  // ---- log engine -------------------------------------------------------
  this.engine = new LogEngine({
    storage: this.storage,
    onError: function (msg) { if (self.ctx.log && self.ctx.log.error) self.ctx.log.error(msg); }
  });
  this.enabled = this._loadEnabled();
  this.displayed = this._loadDisplayed();
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
    this.ctx.settings.onChange(function () {
      try { self._applySettings(); } catch (e) { self._fail('settings', e); }
    });
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
  // 2) an imported preset, e.g. converted from a channel-list CSV
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

App.prototype._loadDisplayed = function () {
  var d = this._readKeyList('display.json');
  if (d) return d.slice(0, this.maxTiles());
  return DISPLAY_DEFAULT.filter(function (k) { return !!Channels.get(k); }).slice(0, this.maxTiles());
};
App.prototype._saveDisplayed = function () {
  try {
    if (this.storage && this.storage.open) {
      var h = this.storage.open('display.json');
      this.storage.append(h, JSON.stringify(this.displayed));
      this.storage.close(h);
    }
  } catch (e) {}
};
App.prototype.maxTiles = function () { return Number(this.getSetting('maxtiles')) || 8; };
App.prototype.style = function () { return this.getSetting('style') || 'tiles'; };

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

// ---- vehicle connection (ENET/DoIP), gated by enetgate.js ---------------
//
// Rebuilds this.diag / this.monitor from the current connection state. While
// disabled (the default, every session) or no vehicle has been found, this
// constructs them with NO transport, so they stay in demo-only mode exactly
// as before this feature existed — nothing here changes default behavior.
// Only once the user has acknowledged + enabled + a vehicle has been found
// (via _enetScan) does a real DoIP transport get built and handed to them.
App.prototype._applyEnetState = function () {
  var self = this;
  if (this.diag) trySafe(function () { self.diag.stop(); });
  if (this.monitor) trySafe(function () { self.monitor.stop(); });

  var status = this.enet.status();
  var transport = null;
  if (status.connected && status.vehicle && status.vehicle.host) {
    transport = doip.makeDoipTransport({
      host: status.vehicle.host,
      port: 13400,
      targetAddr: status.vehicle.logicalAddress || 0
    });
  }

  var profile = this._loadPidProfile();
  var diagOpts = {};
  if (profile) diagOpts.profile = profile;
  if (transport) diagOpts.transport = transport;
  this.diag = new DiagProvider(this.ctx, diagOpts);
  if (this.diag.supported) trySafe(function () { self.diag.start(); });

  var monOpts = { platform: this.getSetting('platform') };
  if (transport) monOpts.transport = transport;
  this.monitor = new FastLog(this.ctx, monOpts);
  if (this.monitor.supported) trySafe(function () { self.monitor.start(); });

  if (this.provider) { this.provider.diag = this.diag; this.provider.monitor = this.monitor; }
};

App.prototype._enetAck = function () {
  this.enet.acknowledge();
};

App.prototype._enetToggleEnable = function () {
  var res = this.enet.setEnabled(!this.enet.enabled);
  if (!res.ok) { this._flash(res.reason); return; }
  this._applyEnetState();
};

App.prototype._enetScan = function () {
  var self = this;
  if (!this.enet.enabled) { this._flash('Enable the connection first.'); return; }
  this.enet.scan(function () { return self._makeDiscoverySocket(); }, { stopOnFirst: true }).then(function (found) {
    if (found && found.length) {
      self.enet.setVehicle({ host: found[0].host, logicalAddress: found[0].logicalAddress, vin: found[0].vin });
      self._flash('Found vehicle at ' + found[0].host);
    } else {
      self._flash('No vehicle found.');
    }
    self._applyEnetState();
  });
};

// DEVICE: a real scan needs a UDP socket on the vehicle's diagnostic network.
// ctx.doipSocket lets a host/sim inject one for testing; the Node UDP adapter
// is the default on the head unit / a desktop Node host.
App.prototype._makeDiscoverySocket = function () {
  if (this.ctx.doipSocket) return this.ctx.doipSocket();
  return doip.nodeUdpSocket();
};

// ---- runtime loops ------------------------------------------------------
App.prototype._startRuntime = function () {
  var self = this;
  // Sampling at the configured rate, independent of display refresh.
  var rate = Number(this.getSetting('rate')) || 10;
  var periodMs = Math.max(10, Math.round(1000 / rate));
  if (typeof setInterval === 'function' && !this.ctx._noTimers) {
    // Guard the sampler: an unhandled throw in a timer callback crashes the
    // whole Node process (the app goes permanently blank). Never let it.
    this._sampler = setInterval(function () {
      try { self.tick(); } catch (e) { self._fail('sample', e); }
    }, periodMs);
  }
  // Rendering: one ctx.loop per screen if available.
  if (this.ctx.loop) {
    SCREEN_ORDER.forEach(function (name) {
      self.ctx.loop(name, 30, function () {
        // Yield while the kit draws an overlay sheet (e.g. the settings sheet):
        // drawing our own frame would fight it and blank the screen.
        var d = self.ctx.display;
        if (d && d.sheet) return null;
        try {
          self.render(self._surface, name);
        } catch (e) {
          self._fail('render ' + name, e);
          try { self._errorCard(self._surface, self._lastError); } catch (e2) { return null; }
        }
        return self._present(name);
      });
    });
  }
};

// Record a failure without crashing, and surface it on screen so it is
// diagnosable on the car instead of a silent blank.
App.prototype._fail = function (where, err) {
  var msg = (err && err.message) ? err.message : String(err);
  this._lastError = where + ': ' + msg;
  if (this.ctx.log && this.ctx.log.error) { try { this.ctx.log.error('[wali] ' + this._lastError); } catch (e) {} }
};

// Draw a visible error card (used when a frame throws) so the app never shows a
// blank screen: the user can read the message and report it.
App.prototype._errorCard = function (cv, msg) {
  if (!cv) return;
  var t = this.t || {};
  cv.clear(t.bg || '#0b0f14');
  cv.text('Wali Datalog hit an error', 40, 60, 30, t.text || '#dde', { weight: 'bold' });
  cv.text('The app kept running; please screenshot this.', 40, 104, 22, t.dim || '#9ab');
  var lines = String(msg || 'unknown').match(/.{1,70}/g) || [''];
  for (var i = 0; i < lines.length && i < 8; i++) {
    cv.text(lines[i], 40, 150 + i * 30, 22, t.warn || '#f2a33c');
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
    if (btn === 'BTN_D') return this._show('connect');
  } else if (s === 'datalog') {
    if (btn === 'BTN_A') return this._toggleRecord();
    if (btn === 'BTN_B') return this.marker('mark');
    if (btn === 'BTN_C') return this._export();
    if (btn === 'BTN_D') return this._show('live');
  } else if (s === 'channels') {
    if (btn === 'BTN_A') return this._toggleLog();
    if (btn === 'BTN_B') return this._toggleShow();
    if (btn === 'BTN_C') return this._clearShown();
    if (btn === 'BTN_D') { this._saveEnabled(); this._saveDisplayed(); return this._show('live'); }
  } else if (s === 'maps') {
    if (btn === 'BTN_A') return this._mapStep(-1);
    if (btn === 'BTN_B') return this._mapStep(1);
    if (btn === 'BTN_C') return this._mapApply();
    if (btn === 'BTN_D') { if (this.confirm) { this.confirm = false; return; } return this._show('live'); }
  } else if (s === 'connect') {
    if (btn === 'BTN_A') return this._enetAck();
    if (btn === 'BTN_B') return this._enetToggleEnable();
    if (btn === 'BTN_C') return this._enetScan();
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

// One-tap start/stop: start a new session when idle/done, stop while logging.
App.prototype._toggleRecord = function () {
  if (this.engine.state === LogEngine.STATE.LOGGING) { this._stopLog(); return; }
  if (this.engine.state === LogEngine.STATE.DONE || this.engine.state === LogEngine.STATE.ERROR) this.engine.reset();
  this._startLog();
};

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

App.prototype._toggleLog = function () {
  var key = Channels.all()[this.selection].key;
  var i = this.enabled.indexOf(key);
  if (i >= 0) this.enabled.splice(i, 1); else this.enabled.push(key);
  this._saveEnabled();
};
App.prototype._toggleShow = function () {
  var key = Channels.all()[this.selection].key;
  var i = this.displayed.indexOf(key);
  if (i >= 0) { this.displayed.splice(i, 1); }
  else if (this.displayed.length >= this.maxTiles()) { this._flash('Display limit reached (' + this.maxTiles() + ') — remove one first'); return; }
  else { this.displayed.push(key); }
  this._saveDisplayed();
};
App.prototype._clearShown = function () { this.displayed = []; this._saveDisplayed(); };

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
    displayed: this.displayed,
    maxtiles: this.maxTiles(),
    style: this.style(),
    selection: this.selection,
    maps: maps,
    enet: this.enet.status()
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
  // DEVICE: hand the drawn canvas to this screen's graphic cell. The kit's
  // build.py names a canvas screen's image widget "<screen>_GFX" (e.g.
  // live_GFX, datalog_GFX), and ctx.ui.image(cell, canvas) pushes the frame.
  if (this.ctx.ui && this.ctx.ui.image && this._surface && this._surface.handle) {
    return this.ctx.ui.image((name || this.screen) + '_GFX', this._surface.handle);
  }
  return null;
};
App.prototype._show = function (name) {
  this.screen = name;
  this.confirm = false;
  // DEVICE: switch the HMI to this screen's RHMI state. The kit's screen switch
  // is ui.open(stateName) (kit/runtime/mgu.js) — there is no ctx.show. Without
  // this, a button press changed only internal state and the head unit never
  // navigated. The sim/preview render the current screen directly, so ui.open
  // is simply absent there.
  var ui = this.ctx.ui;
  if (ui && typeof ui.open === 'function') trySafe(function () { ui.open(name); });
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
//
// On the head unit the kit links this file as the app entry and provides the
// runtime as a sibling module (javascript/kit/mgu.js), exactly as every kit app
// does: `require('./kit/mgu')`. In the PC simulator, the test suite and the web
// preview there is no kit beside this file, so the require is guarded and the
// harness drives the exported App directly. The split name keeps naive bundlers
// from trying to resolve the kit path off-car.
var app = new App();
var mgu = null;
try { mgu = require('./kit/' + 'mgu'); } catch (e) { mgu = null; }
if (mgu && mgu.run) {
  // Last-resort safety net: a stray throw/rejection must not kill the app
  // process on the head unit (which leaves a permanently blank screen). Keep it
  // alive and record the error so the next frame shows it.
  if (typeof process !== 'undefined' && process.on) {
    try {
      process.on('uncaughtException', function (e) { try { app._fail('uncaught', e); } catch (x) {} });
      process.on('unhandledRejection', function (e) { try { app._fail('rejection', e); } catch (x) {} });
    } catch (e) { /* ignore */ }
  }
  mgu.run({ start: function (ctx) { return app.start(ctx); } });
}
module.exports = { App: App, app: app, SCREEN_ORDER: SCREEN_ORDER };
