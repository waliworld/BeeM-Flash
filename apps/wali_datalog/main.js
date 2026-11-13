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
var ObdProvider = require('./obd').ObdProvider;
var Provider = require('./provider');
var FastLog = require('./fastlog');
var LogEngine = require('./logengine');
var MapControl = require('./mapcontrol');
var EnetGate = require('./enetgate');
var doip = require('./doip');
var Channels = require('./channels');
var storageMod = require('./storage');
var dme = require('./dme_profiles');
var dtc = require('./dtc');
var modules = require('./modules');
var ecuinfo = require('./ecuinfo');
var calreadout = require('./calreadout');
var binverify = require('./binverify');
var flash = require('./flash');
var flashrun = require('./flashrun');
var theme = require('./theme');
var screens = require('./screens');
var surface = require('./surface');
var F = require('./format');

// The tabs shown along the top, in order. `key` is the page; `label` is the tab.
var TABS = [
  { key: 'live', label: 'LIVE' }, { key: 'log', label: 'LOG' },
  { key: 'channels', label: 'CHANNELS' }, { key: 'maps', label: 'MAPS' },
  { key: 'connect', label: 'CONNECT' }, { key: 'codes', label: 'CODES' },
  { key: 'info', label: 'INFO' }, { key: 'flash', label: 'FLASH' }, { key: 'setup', label: 'SETUP' }
];
var SCREEN_ORDER = ['live', 'log', 'channels', 'maps', 'connect', 'codes', 'info', 'flash', 'setup'];
var DEFAULTS = { demo: 'auto', source: 'auto', platform: 'B58', rate: 10, units: 'metric', style: 'tiles', maxtiles: 8, autostart: false, mapcontrol: 'off' };
// 'knock' is deliberately NOT a default tile: knock retard has no standard DID on
// the MG1 DME, so it can only ever read '--' out of the box (it stays available in
// CHANNELS for anyone who supplies a pidmap). 'load' is shown instead - it is in the
// verified profile and actually reads.
var DISPLAY_DEFAULT = ['rpm', 'boost', 'iat', 'coolant', 'oil', 'timing', 'load', 'speed'];

// Settings schema for the in-app SETUP tab (mirrors app.json "settings"). Each
// entry cycles through its options (bool toggles) via ctx.settings.set.
var SETTINGS_SCHEMA = [
  { key: 'units', label: 'Units', hint: 'metric / imperial', options: ['metric', 'imperial'] },
  { key: 'style', label: 'Live display', hint: 'gauge style', options: ['tiles', 'bars', 'dials'] },
  { key: 'maxtiles', label: 'Max live gauges', options: [6, 8, 10, 12] },
  { key: 'rate', label: 'Sample rate', hint: 'Hz', options: [5, 10, 20, 50] },
  { key: 'demo', label: 'Demo data', options: ['auto', 'on', 'off'] },
  { key: 'source', label: 'Data source', hint: 'auto / fast / bus / UDS / OBD-II', options: ['auto', 'fast', 'someip', 'diag', 'obd'] },
  { key: 'platform', label: 'Engine platform', options: ['B58', 'S58'] },
  { key: 'autostart', label: 'Auto-start on drive', bool: true },
  { key: 'mapcontrol', label: 'Map control', hint: 'writes to the DME', options: ['off', 'armed'], danger: true }
];

function App() {}

App.prototype.start = function (ctx) {
  var self = this;
  this.ctx = ctx || {};
  // LAMBO (black / yellow / red) is authoritative for our canvas: start from whatever the kit
  // theme provides (so we inherit any extra keys) but let LAMBO's palette win, so the look is the
  // Lambo one on the car regardless of the unit's default kit theme (which was overriding it to
  // M Tricolour orange/white). The app also ships a 'lambo' kit theme and defaults to it.
  this.t = mergeTheme(this.ctx.theme ? safe(this.ctx.theme) : {}, theme.LAMBO);

  // ---- settings ---------------------------------------------------------
  this.getSetting = function (k) {
    var v;
    if (self._localSettings && self._localSettings[k] !== undefined) return self._localSettings[k]; // units without ctx.settings.set
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
    someip: this.someip, diag: this.diag, monitor: this.monitor, obd: this.obd, getSetting: this.getSetting
  });

  // ---- log engine -------------------------------------------------------
  this.engine = new LogEngine({
    storage: this.storage,
    appId: 'beem_flash', // log filenames: beem_flash_<stamp>.csv
    vehicle: this._config().vehicle || {}, // { massKg, cda, crr, drivetrain } for pull power estimates
    onError: function (msg) { if (self.ctx.log && self.ctx.log.error) self.ctx.log.error(msg); }
  });
  this.enabled = this._loadEnabled();
  this.displayed = this._loadDisplayed();
  this.engine.configure({
    channels: this.enabled, rate: Number(this.getSetting('rate')), units: this.getSetting('units')
  });

  // ---- map control ------------------------------------------------------
  this.map = new MapControl({
    enabled: this._armed(),
    config: this._config().mapControl,
    keyFn: this._mapKeyFn()
  });

  // ---- ui state ---------------------------------------------------------
  this.tab = 'live';
  this.selection = 0;
  this.setupSel = 0;
  this.latest = { values: {}, demo: false, live: false };
  this.confirm = false;
  // Fault-code (DTC) page state.
  this.codes = { scope: 'all', scanning: false, result: null, msg: '', confirmClear: false, clearing: false, lastClear: null, tune: null };
  // Calibration-flash page state. The engine is OFF by default; nothing can be
  // written until the user turns it ON and then confirms a flash.
  this.flash = { armed: false, descriptor: null, opts: null, status: '', confirm: false, running: false, progress: 0, step: '', result: null };
  // Read-only ECU identification / calibration info page. A successful read is a
  // prerequisite for flashing (you must see what's on the car first).
  this.info = { reading: false, items: null, tune: null, done: false, msg: '', binVerify: null };

  // react to settings changes live
  if (this.ctx.settings && this.ctx.settings.onChange) {
    this.ctx.settings.onChange(function () {
      try { self._applySettings(); } catch (e) { self._fail('settings', e); }
    });
  }

  this._surface = this._makeSurface();
  this._bindButtons();
  // Hide the confusing A/B/C/D hardware button bar where the kit can: the
  // controls live on-screen now (the bottom action bar). The hardware buttons
  // still fire the same actions as a fallback on units that keep the bar.
  if (this.ctx.hideButton) {
    ['BTN_A', 'BTN_B', 'BTN_C', 'BTN_D'].forEach(function (b) { trySafe(function () { self.ctx.hideButton(b, true); }); });
  }
  this._relabel();
  // DEVICE: touch — tabs (top) + action bar (bottom) + in-page taps.
  if (this.ctx.onTap) {
    trySafe(function () { self.ctx.onTap(function (x, y) { try { self._onTap(x, y); } catch (e) { self._fail('tap', e); } }); });
  }
  // DEVICE: a sideways finger drag switches tabs.
  if (this.ctx.onSwipe) {
    trySafe(function () { self.ctx.onSwipe(function (dx) { try { self._onSwipe(dx); return true; } catch (e) { self._fail('swipe', e); return false; } }); });
  }
  this._startRuntime();
  return this;
};

// Reconfigure from settings without dropping an active recording.
App.prototype._applySettings = function () {
  this.map.setEnabled(this._armed());
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
    Channels.unregisterCustom(); // drop any custom PIDs from a previous load
    if (this.storage && this.storage.read) {
      var txt = this.storage.read('pidmap.json');
      if (txt && txt.length) {
        var prof = dme.fromJson(JSON.parse(txt)); // registers custom PIDs with metadata
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
  if (this.obd) trySafe(function () { self.obd.stop(); });

  var status = this.enet.status();
  var transport = null;
  if (status.connected && status.vehicle && status.vehicle.host) {
    transport = doip.makeDoipTransport({
      host: status.vehicle.host,
      port: 13400,
      targetAddr: status.vehicle.logicalAddress || 0
    });
  }

  // The head unit's own diagnostic link (UDS over the car's internal gateway). It is
  // available from app start and needs no CONNECT - the DoIP transport above is an
  // ADDITIONAL path, not a prerequisite. Built once and reused: each construction
  // opens a SOME/IP proxy and a response subscription, and _applyEnetState runs again
  // on every ENABLE/SCAN tap, so rebuilding it leaked a proxy per tap.
  if (!this._huTransport) {
    trySafe(function () { self._huTransport = DiagProvider.makeCtxTransport(self.ctx, 0x12); });
  }
  var hu = this._huTransport;

  var profile = this._loadPidProfile();
  var diagOpts = {};
  if (profile) diagOpts.profile = profile;       // a user-supplied per-tune pidmap.json wins
  else diagOpts.profileName = 'bmw_obd';         // else the car-tested BMW DME profile (UDS 0x22)
  if (transport || hu) diagOpts.transport = transport || hu;
  this.diag = new DiagProvider(this.ctx, diagOpts);
  if (this.diag.supported) trySafe(function () { self.diag.start(); });

  // NOT given the head-unit link on purpose: its request is UDS 0x2C
  // (DynamicallyDefineDataIdentifier), which the read-only diagnostic guard rejects,
  // and it would log an error on every poll. It runs only over a real DoIP transport.
  var monOpts = { platform: this.getSetting('platform') };
  if (transport) monOpts.transport = transport;
  this.monitor = new FastLog(this.ctx, monOpts);
  if (this.monitor.supported) trySafe(function () { self.monitor.start(); });

  // Additional source: standard OBD-II PIDs (service 01), which the read-only guard
  // does permit. This is what supplies charge-air temp (0x0F), ignition timing (0x0E)
  // and boost (0x87/0x70, which do not saturate) over the link that works on-car.
  var obdOpts = { pids: (this._config().obdPids) || undefined, pollMs: (this._config().obdPollMs) || 300 };
  if (transport || hu) obdOpts.transport = transport || hu;
  this.obd = new ObdProvider(this.ctx, obdOpts);
  if (this.obd.supported) trySafe(function () { self.obd.start(); });

  if (this.provider) { this.provider.diag = this.diag; this.provider.monitor = this.monitor; this.provider.obd = this.obd; }
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
  // Rendering: ONE loop for the single 'MAIN' canvas screen. It draws the
  // current page (this.screen) and pushes it to the MAIN graphic cell. Switching
  // page is just a redraw — no RHMI state change — which is reliable on the head
  // unit (the old per-screen ui.open navigation cut buttons off and blanked).
  // 8 fps, like the reference apps (car_vitals 10, dyno 6, live_data 4, dtc_scanner 2).
  // 30 fps redrew and re-pushed a full 1600x520 frame 30x/s for no benefit: the values
  // update at the sample rate, not the frame rate.
  if (this.ctx.loop) {
    self.ctx.loop('MAIN', 8, function () {
      // Yield while the kit draws an overlay sheet (e.g. the settings sheet):
      // drawing our own frame would fight it and blank the screen.
      var d = self.ctx.display;
      if (d && d.sheet) return null;
      // Re-acquire the surface EVERY frame. ctx.canvas() is the only code path that
      // calls Recorder.reset() (kit/runtime/display.js -> record.js), and reset() is
      // the only thing that rewinds the recorded draw-op list. Acquiring once at
      // start() meant every frame appended to a buffer that was never truncated and
      // replayed every op ever drawn - the app grew without bound and the platform
      // killed it after ~30 s. The Recorder itself is cached by size, so this
      // allocates nothing new. Every reference app acquires inside its render fn.
      self._surface = self._makeSurface();
      try {
        self.render(self._surface, self.tab);
      } catch (e) {
        self._fail('render ' + self.tab, e);
        try { self._errorCard(self._surface, self._lastError); } catch (e2) { return null; }
      }
      return self._present();
    });
  }
};

// The HMI hardware buttons (where still shown) mirror the on-screen action bar,
// so pressing one does the same as tapping the button under it.
App.prototype._relabel = function () {
  var ui = this.ctx.ui;
  if (!ui || typeof ui.text !== 'function') return; // sim/preview: no HMI bar
  var acts = this._actions();
  ['BTN_A', 'BTN_B', 'BTN_C', 'BTN_D'].forEach(function (b, i) {
    trySafe(function () { ui.text(b, (acts[i] && acts[i].label) || ''); });
  });
};

// Record a failure without crashing, and surface it on screen so it is
// diagnosable on the car instead of a silent blank.
App.prototype._fail = function (where, err) {
  var msg = (err && err.message) ? err.message : String(err);
  // Log the FULL message and stack before anything is truncated, and guard ctx:
  // an unhandledRejection can arrive before start() has assigned this.ctx, in which
  // case this used to throw inside the caller's empty catch and lose the log line.
  var lg = this.ctx && this.ctx.log;
  if (lg && lg.error) {
    try { lg.error('[wali] ' + where + ': ' + msg + ((err && err.stack) ? '\n' + err.stack : '')); } catch (e) {}
  }
  // Don't show someone else's failure as ours. "Class::method failed due to ..." is
  // the head unit SDK's own phrasing (e.g. CurrentVehicleUnits::initVehicleDataProxy,
  // which appears nowhere in this app); we only see it because we listen for
  // unhandledRejection process-wide. It is logged above, but it is not a BeeM-Flash
  // fault and must not raise an alarm on screen.
  if (where === 'rejection' && /^[A-Za-z][A-Za-z0-9_]*::[A-Za-z][A-Za-z0-9_]* failed due to/.test(msg)) return;
  this._lastError = where + ': ' + msg;
  this._lastErrorAt = Date.now();
};

// Draw a visible error card (used when a frame throws) so the app never shows a
// blank screen: the user can read the message and report it.
App.prototype._errorCard = function (cv, msg) {
  if (!cv) return;
  var t = this.t || {};
  cv.clear(t.bg || '#0b0f14');
  cv.text('BeeM-Flash hit an error', 40, 60, 30, t.text || '#dde', { weight: 'bold' });
  cv.text('The app kept running; please screenshot this.', 40, 104, 22, t.dim || '#9ab');
  var lines = String(msg || 'unknown').match(/.{1,70}/g) || [''];
  for (var i = 0; i < lines.length && i < 8; i++) {
    cv.text(lines[i], 40, 150 + i * 30, 22, t.crit || '#ff2a1f');
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

// The per-tab action bar (≤4). Each: { label, sub?, fn, active?, danger?, disabled? }.
// The on-screen bottom bar draws these; hardware BTN_A..D fire them by index.
App.prototype._actions = function () {
  var self = this, s = this.tab;
  var logging = this.engine.state === LogEngine.STATE.LOGGING;
  if (s === 'live') return [
    { label: logging ? 'STOP' : 'RECORD', active: logging, fn: function () { self._toggleRecord(); } },
    { label: 'MARK', disabled: !logging, fn: function () { self.marker('mark'); } },
    { label: 'STYLE', fn: function () { self._cycleSettingKey('style'); } },
    { label: 'UNITS', fn: function () { self._cycleSettingKey('units'); } }
  ];
  if (s === 'log') return [
    { label: logging ? 'STOP' : 'START', active: logging, fn: function () { self._toggleRecord(); } },
    { label: 'MARKER', disabled: !logging, fn: function () { self.marker('mark'); } },
    { label: 'EXPORT', fn: function () { self._export(); } }
  ];
  if (s === 'channels') return [
    { label: 'LOG', fn: function () { self._toggleLog(); } },
    { label: 'SHOW', fn: function () { self._toggleShow(); } },
    { label: 'CLEAR', fn: function () { self._clearShown(); } },
    { label: 'PAGE', fn: function () { self._channelsPage(1); } }
  ];
  if (s === 'maps') return [
    { label: 'PREV', disabled: !this.map.enabled, fn: function () { self._mapStep(-1); } },
    { label: 'NEXT', disabled: !this.map.enabled, fn: function () { self._mapStep(1); } },
    { label: this.confirm ? 'CONFIRM' : 'APPLY', danger: this.confirm, disabled: !this.map.enabled, fn: function () { self._mapApply(); } },
    { label: 'CANCEL', disabled: !this.confirm, fn: function () { self.confirm = false; } }
  ];
  if (s === 'connect') return [
    { label: 'ACCEPT', active: this.enet.acknowledged, fn: function () { self._enetAck(); } },
    { label: this.enet.enabled ? 'DISABLE' : 'ENABLE', active: this.enet.enabled, fn: function () { self._enetToggleEnable(); } },
    { label: 'SCAN', disabled: !this.enet.enabled, fn: function () { self._enetScan(); } }
  ];
  if (s === 'codes') return [
    { label: 'SCAN', disabled: this.codes.scanning, fn: function () { self._codesScan(); } },
    { label: this.codes.confirmClear ? 'CONFIRM' : 'CLEAR', danger: true, fn: function () { self._codesClear(); } },
    { label: this.codes.scope === 'dme' ? 'ALL' : 'ENGINE', fn: function () { self._codesToggleScope(); } }
  ];
  if (s === 'info') return [
    { label: 'READ', disabled: this.info.reading, fn: function () { self._infoRead(); } },
    { label: 'READ CAL', disabled: this.info.reading || !this._config().calReadout, fn: function () { self._infoReadCal(); } }
  ];
  if (s === 'flash') {
    var ready = this.flash.armed && this.flash.descriptor && !this.flash.running && this.info.done;
    return [
      { label: this.info.done ? (this.flash.armed ? 'ENGINE ON' : 'ENGINE OFF') : 'NEED INFO', active: this.flash.armed, fn: function () { self._flashToggle(); } },
      { label: 'RELOAD', disabled: !this.flash.armed || this.flash.running, fn: function () { self._flashReload(); } },
      { label: this.flash.confirm ? 'CONFIRM' : 'FLASH', danger: true, disabled: !ready, fn: function () { self._flashAction(); } },
      { label: 'CANCEL', disabled: !this.flash.confirm, fn: function () { self.flash.confirm = false; } }
    ];
  }
  if (s === 'setup') return [
    { label: 'CHANGE', fn: function () { self._cycleSetting(self.setupSel); } },
    { label: 'PREV', fn: function () { self._setupMove(-1); } },
    { label: 'NEXT', fn: function () { self._setupMove(1); } }
  ];
  return [];
};

App.prototype.onButton = function (btn) {
  var i = { BTN_A: 0, BTN_B: 1, BTN_C: 2, BTN_D: 3 }[btn];
  if (i == null) return;
  var acts = this._actions();
  var a = acts[i];
  if (a && !a.disabled && typeof a.fn === 'function') a.fn();
};

// A sideways finger drag switches tabs (dx > 0: finger went left -> next tab).
App.prototype._onSwipe = function (dx) {
  if (Math.abs(dx) < 40) return;
  this._tabStep(dx > 0 ? 1 : -1);
};
App.prototype._tabStep = function (dir) {
  var i = this._tabIndex();
  i = (i + dir + TABS.length) % TABS.length;
  this._show(TABS[i].key);
};
App.prototype._tabIndex = function () {
  for (var i = 0; i < TABS.length; i++) if (TABS[i].key === this.tab) return i;
  return 0;
};

// Rotary/scroll support: move the selection on list tabs, else cycle tabs.
App.prototype.onRotate = function (delta) {
  if (this.tab === 'channels') {
    var n = Channels.all().length;
    this.selection = ((this.selection + delta) % n + n) % n;
  } else if (this.tab === 'setup') {
    this._setupMove(delta);
  } else {
    this._tabStep(delta > 0 ? 1 : -1);
  }
};

// ---- actions ------------------------------------------------------------
App.prototype._startLog = function () {
  this.engine.configure({
    channels: this.enabled, rate: Number(this.getSetting('rate')), units: this.getSetting('units')
  });
  this.engine.start();
  this._invalidateSessions();
};
App.prototype._stopLog = function () { this.engine.stop(); this._invalidateSessions(); };
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
  var ch = Channels.all()[this.selection]; if (!ch) return;
  var key = ch.key;
  var i = this.enabled.indexOf(key);
  if (i >= 0) this.enabled.splice(i, 1); else this.enabled.push(key);
  this._saveEnabled();
};
App.prototype._toggleShow = function () {
  var ch = Channels.all()[this.selection]; if (!ch) return;
  var key = ch.key;
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
  var prep = this.map.prepare(this.map.requested, this.latest.values, this.latest.live);
  if (!prep.ok) { this._flash(prep.reasons[0] || 'Cannot switch'); return; }
  if (!this.confirm) { this.confirm = true; return; }
  this.confirm = false;
  this.map.commit(this.map.requested, this.latest.values, this.diag, this.latest.live).then(function (res) {
    self._mapMsg = res.message; self._mapOk = res.ok; self._mapConfirmed = !!res.confirmed;
  });
};

App.prototype._flash = function (msg) {
  this._mapMsg = msg; this._mapOk = false;
  if (this.ctx.log && this.ctx.log.info) this.ctx.log.info(msg);
};

// ---- fault codes (DTC) read/clear --------------------------------------
// Builds a DoIP gateway to the connected vehicle. Reads are read-only; clearing
// erases fault memory and is gated behind a two-step confirm on the Codes page.
// A TCP DoIP socket to the car is device-specific (doip.nodeSocket); a host/sim
// can inject one via ctx.diagSocket for off-car testing.
App.prototype._makeGateway = function () {
  var st = this.enet.status();
  if (!(st.connected && st.vehicle && st.vehicle.host)) return null;
  var tgt = st.vehicle.logicalAddress || 0x1000;
  if (this.ctx.diagSocket) return new doip.DoipGateway({ socket: this.ctx.diagSocket(), targetAddr: tgt, requestTimeoutMs: 1500 });
  return new doip.DoipGateway({ host: st.vehicle.host, port: 13400, targetAddr: tgt, requestTimeoutMs: 1500 });
};
App.prototype._codeModules = function () {
  var list = modules.list(this._config());
  if (this.codes.scope === 'dme') {
    var dmeOnly = list.filter(function (m) { return m.primary || m.key === 'dme'; });
    return dmeOnly.length ? dmeOnly : list.slice(0, 1);
  }
  return list;
};
App.prototype._codesToggleScope = function () {
  this.codes.scope = (this.codes.scope === 'all') ? 'dme' : 'all';
  this.codes.result = null; this.codes.msg = '';
};
App.prototype._codesScan = function () {
  var self = this;
  if (this.codes.scanning) return Promise.resolve();
  var gw = this._makeGateway();
  if (!gw) { this.codes.msg = 'Connect to the vehicle first (Diag → Connect).'; return Promise.resolve(); }
  this.codes.scanning = true; this.codes.confirmClear = false; this.codes.msg = 'Scanning modules…';
  var mods = this._codeModules();
  return gw.activate().then(function () {
    return dtc.scanModules(gw.sendFor(1500), mods, {}, function (m, i, n) { self.codes.msg = 'Reading ' + m.name + ' (' + i + '/' + n + ')…'; });
  }).then(function (res) {
    self.codes.result = res;
    self.codes.msg = res.totalDtcs + ' code' + (res.totalDtcs === 1 ? '' : 's') + ' across ' + res.reached + '/' + res.scanned + ' module' + (res.scanned === 1 ? '' : 's');
    // Also read the DME's calibration / last-flash so the codes view shows what
    // tune is on the car (helps spot an MHD or other tune).
    var cfg = self._config();
    var tuneDids = ecuinfo.DEFAULT_DIDS.filter(function (d) { return d.did === 0xF194 || d.did === 0xF199 || d.did === 0xF17C; });
    return ecuinfo.read(function (b) { return gw.send(b); }, { dids: tuneDids, stockCalIds: cfg.stockCalIds, tuneSignatures: cfg.tuneSignatures }).then(function (ir) {
      self.codes.tune = ir.tune; if (self.info && !self.info.tune) self.info.tune = ir.tune;
    }).catch(function () {});
  }).catch(function (e) {
    self.codes.msg = 'Scan failed: ' + ((e && e.message) || e);
  }).then(function () {
    self.codes.scanning = false; try { gw.close(); } catch (x) {}
  });
};
App.prototype._codesClear = function () {
  var self = this;
  if (this.codes.scanning || this.codes.clearing) return Promise.resolve();
  if (!this.codes.confirmClear) { this.codes.confirmClear = true; this.codes.msg = 'Press Clear again to ERASE fault memory on all reached modules.'; return Promise.resolve(); }
  this.codes.confirmClear = false;
  var gw = this._makeGateway();
  if (!gw) { this.codes.msg = 'Connect to the vehicle first (Diag → Connect).'; return Promise.resolve(); }
  this.codes.clearing = true; this.codes.msg = 'Clearing codes…';
  var mods = this._codeModules();
  return gw.activate().then(function () {
    return dtc.clearModules(gw.sendFor(1500), mods, { acknowledged: true }, function (m, i, n) { self.codes.msg = 'Clearing ' + m.name + ' (' + i + '/' + n + ')…'; });
  }).then(function (cr) {
    self.codes.lastClear = cr;
    self.codes.msg = 'Cleared ' + cr.cleared + '/' + cr.attempted + ' module' + (cr.attempted === 1 ? '' : 's') + '. Re-scan to confirm.';
    self.codes.result = null;
  }).catch(function (e) {
    self.codes.msg = 'Clear failed: ' + ((e && e.message) || e);
  }).then(function () {
    self.codes.clearing = false; try { gw.close(); } catch (x) {}
  });
};

// ---- ECU info (INFO tab) — read-only identification / calibration ------
App.prototype._infoRead = function () {
  var self = this;
  if (this.info.reading) return Promise.resolve();
  var gw = this._makeGateway();
  if (!gw) { this.info.msg = 'Connect to the vehicle first (CONNECT tab).'; return Promise.resolve(); }
  this.info.reading = true; this.info.msg = 'Reading identification…';
  var cfg = this._config();
  var opts = { dids: cfg.infoDids || undefined, stockCalIds: cfg.stockCalIds, tuneSignatures: cfg.tuneSignatures };
  return gw.activate().then(function () {
    return ecuinfo.read(function (b) { return gw.send(b); }, opts, function (d, i, n) { self.info.msg = 'Reading ' + d.label + ' (' + i + '/' + n + ')…'; });
  }).then(function (res) {
    self.info.items = res.items || [];
    self.info.tune = res.tune || null;
    self.info.done = true; // prerequisite for flashing is now satisfied
    var got = self.info.items.filter(function (x) { return x.ok; }).length;
    self.info.msg = got + ' of ' + self.info.items.length + ' identifiers read';
  }).catch(function (e) {
    self.info.msg = 'Read failed: ' + ((e && e.message) || e);
  }).then(function () {
    self.info.reading = false; try { gw.close(); } catch (x) {}
  });
};

// Read the car's current calibration region out and fingerprint it (binverify).
// This is the on-car confirmation that catches a map-only tune keeping the stock
// ID. The region + any security come from config.calReadout (owner-supplied).
App.prototype._infoReadCal = function () {
  var self = this;
  if (this.info.reading) return Promise.resolve();
  var cfg = this._config().calReadout;
  if (!cfg || typeof cfg.address !== 'number') { this.info.msg = 'No calibration region configured (config.calReadout.address/size).'; return Promise.resolve(); }
  var gw = this._makeGateway();
  if (!gw) { this.info.msg = 'Connect to the vehicle first (CONNECT tab).'; return Promise.resolve(); }
  var opts = {}; for (var k in cfg) if (cfg.hasOwnProperty(k)) opts[k] = cfg[k];
  if (cfg.securityAlgo && !opts.keyFn) { try { opts.keyFn = require('./seedkey').makeAlgo(cfg.securityAlgo); } catch (e) {} }
  this.info.reading = true; this.info.msg = 'Reading calibration…'; this.info.binVerify = null;
  return gw.activate().then(function () {
    return calreadout.readCalibration(function (b) { return gw.send(b); }, opts, function (pct) { self.info.msg = 'Reading calibration… ' + pct + '%'; });
  }).then(function (res) {
    if (!res.ok) { self.info.msg = 'Cal read failed: ' + res.error; return; }
    var v = binverify.verify(res.data);
    self.info.binVerify = v;
    self.info.msg = 'Read ' + res.size + ' bytes — ' + binverify.describe(v);
  }).catch(function (e) {
    self.info.msg = 'Cal read failed: ' + ((e && e.message) || e);
  }).then(function () {
    self.info.reading = false; try { gw.close(); } catch (x) {}
  });
};

// ---- settings (SETUP tab) ----------------------------------------------
App.prototype._setupMove = function (d) {
  var n = SETTINGS_SCHEMA.length;
  this.setupSel = ((this.setupSel + d) % n + n) % n;
};
App.prototype._cycleSetting = function (i) {
  var def = SETTINGS_SCHEMA[i]; if (!def) return;
  this._cycleSettingKey(def.key);
};
// Advance a setting to its next option (bool -> toggle) and persist via ctx.settings.
App.prototype._cycleSettingKey = function (key) {
  var def = null;
  for (var i = 0; i < SETTINGS_SCHEMA.length; i++) if (SETTINGS_SCHEMA[i].key === key) def = SETTINGS_SCHEMA[i];
  if (!def) return;
  var cur = this.getSetting(key), next;
  if (def.bool) { next = !(cur === true || cur === 'true'); }
  else {
    var opts = def.options || [], idx = 0;
    for (var j = 0; j < opts.length; j++) if (String(opts[j]) === String(cur)) idx = j;
    next = opts[(idx + 1) % opts.length];
  }
  if (this.ctx.settings && this.ctx.settings.set) { trySafe((function (k, v) { return function () { this.ctx.settings.set(k, v); }; })(key, next).bind(this)); }
  else { this._localSettings = this._localSettings || {}; this._localSettings[key] = next; }
  try { this._applySettings(); } catch (e) {}
};
App.prototype._channelsPage = function (dir) {
  var all = Channels.all(), perPage = 15, pages = Math.ceil(all.length / perPage);
  var page = Math.floor((this.selection || 0) / perPage);
  page = (page + dir + pages) % pages;
  this.selection = page * perPage;
};

// ---- calibration flash (FLASH tab) -------------------------------------
// The engine is an explicit on/off switch. OFF: nothing can be written. ON:
// load the user's descriptor; a flash still needs an explicit confirm.
App.prototype._flashToggle = function () {
  if (this.flash.running) return;
  if (!this.flash.armed && !this.info.done) { // prerequisite: read ECU INFO first
    this.flash.status = 'Read the ECU on the INFO tab first — you must see what is on the car before flashing.';
    return;
  }
  this.flash.armed = !this.flash.armed;
  this.flash.confirm = false;
  if (this.flash.armed) this._flashReload();
  else { this.flash.descriptor = null; this.flash.opts = null; this.flash.status = ''; }
};
App.prototype._flashReload = function () {
  if (!this.flash.armed) return;
  var r = flashrun.loadDescriptor(this.storage);
  if (r.ok) { this.flash.descriptor = r.descriptor; this.flash.opts = r.opts; this.flash.status = ''; this.flash.result = null; }
  else { this.flash.descriptor = null; this.flash.opts = null; this.flash.status = r.status || r.error || 'No calibration found.'; }
};
App.prototype._flashAction = function () {
  if (!this.flash.armed || this.flash.running || !this.flash.descriptor || !this.flash.opts || !this.info.done) return Promise.resolve();
  if (!this.flash.confirm) { this.flash.confirm = true; return Promise.resolve(); }
  this.flash.confirm = false;
  return this._flashRun();
};
App.prototype._flashRun = function () {
  var self = this;
  var gw = this._makeGateway();
  if (!gw) { this.flash.status = 'Connect to the vehicle first (CONNECT tab).'; this.flash.result = { ok: false, message: this.flash.status }; return Promise.resolve(); }
  this.flash.running = true; this.flash.progress = 0; this.flash.step = 'starting'; this.flash.result = null;
  var opts = {}; for (var k in this.flash.opts) opts[k] = this.flash.opts[k];
  opts.acknowledged = true;
  // A checksum scheme can also come from app.json config (not just the descriptor).
  var cfg = this._config();
  if (!opts.checksum && cfg.checksum) { opts.checksum = cfg.checksum; opts.correctChecksums = (cfg.correctChecksums !== false); }
  return gw.activate().then(function () {
    return flash.flashCalibration(function (b) { return gw.send(b); }, opts, function (step) {
      self.flash.step = step;
      var m = /transfer (\d+)%/.exec(step); if (m) self.flash.progress = Number(m[1]);
      else if (step === 'requestDownload') self.flash.progress = 5;
      else if (step === 'transferExit') self.flash.progress = 97;
      else if (step === 'verify' || step === 'reset') self.flash.progress = 99;
    });
  }).then(function (res) {
    self.flash.result = res; self.flash.progress = res.ok ? 100 : self.flash.progress;
  }).catch(function (e) {
    self.flash.result = { ok: false, confirmed: false, message: 'Flash error: ' + ((e && e.message) || e) };
  }).then(function () {
    self.flash.running = false; try { gw.close(); } catch (x) {}
  });
};

// ---- view model + render ------------------------------------------------
// Recorded sessions with their on-disk size, recomputed only when the set can have
// changed (log start/stop, export, delete) rather than on every rendered frame.
App.prototype._sessions = function () {
  if (this._sessionList && !this._sessionsDirty) return this._sessionList;
  var st = this.storage;
  this._sessionList = this.engine.sessions().map(function (n) {
    var size = 0;
    try { size = st.statSize ? st.statSize(n) : (st.read(n) || '').length; } catch (e) {}
    return { name: n, size: size };
  });
  this._sessionsDirty = false;
  return this._sessionList;
};
App.prototype._invalidateSessions = function () { this._sessionsDirty = true; };

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
    rate: Number(this.getSetting('rate')),
    summary: this.engine.getSummary(),
    run: this.engine.lastRun()
  };
  // Only the LOG tab shows this list, and only its size label needs the byte count.
  // Use statSize (a stat, not a full read) and cache it: this used to read and decode
  // every recorded CSV off the filesystem on EVERY frame.
  var sessions = (this.tab === 'log') ? this._sessions() : (this._sessionList || []);

  var prep = this.map.prepare(this.map.requested, this.latest.values, this.latest.live);
  var maps = {
    enabled: this.map.enabled,
    slots: this.map.maps,
    requested: this.map.requested,
    selected: this.map.selected,
    confirm: this.confirm,
    lastMsg: this._mapMsg,
    lastOk: this._mapOk,
    confirmed: this._mapConfirmed,
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
    enet: this.enet.status(),
    codes: {
      scope: this.codes.scope,
      scanning: this.codes.scanning,
      clearing: this.codes.clearing,
      confirmClear: this.codes.confirmClear,
      msg: this.codes.msg,
      result: this.codes.result,
      tune: this.codes.tune,
      moduleCount: this._codeModules().length
    },
    flash: {
      armed: this.flash.armed, running: this.flash.running, confirm: this.flash.confirm,
      progress: this.flash.progress, step: this.flash.step, status: this.flash.status,
      descriptor: this.flash.descriptor, result: this.flash.result,
      blocked: !this.info.done, tune: this.info.tune
    },
    info: { reading: this.info.reading, items: this.info.items, tune: this.info.tune, done: this.info.done, msg: this.info.msg, binVerify: this.info.binVerify },
    setup: this._setupItems(), setupSel: this.setupSel,
    tab: this.tab, tabs: TABS, actions: this._actions(),
    webUrl: this._config().webUrl || ''
  };
};

// Build the SETUP tab rows from the schema + current values.
App.prototype._setupItems = function () {
  var self = this;
  return SETTINGS_SCHEMA.map(function (d) {
    var v = self.getSetting(d.key), disp;
    if (d.bool) disp = (v === true || v === 'true') ? 'ON' : 'OFF';
    else if (v === false) disp = 'OFF';
    else if (v === true) disp = 'ON';
    else if (d.key === 'maxtiles' || d.key === 'rate') disp = String(v) + (d.key === 'rate' ? ' Hz' : '');
    else disp = String(v).toUpperCase();
    return { key: d.key, label: d.label, hint: d.hint, value: v, display: disp, danger: d.danger };
  });
};

// app.json "config" at runtime (car_vitals-style). The user sets config.webUrl
// to any external tuning site they use; empty hides the link.
App.prototype._config = function () { return (this.ctx.spec && this.ctx.spec.config) || {}; };

// Map control is ARMED only on the explicit "armed" choice (safe default: off).
App.prototype._armed = function () {
  var v = this.getSetting('mapcontrol');
  return v === 'armed' || v === true || v === 'on';
};
// The SecurityAccess key algorithm for map control, if the ECU needs one and the
// user configured it (config.mapControl.securityAlgo, a seedkey makeAlgo spec).
// No manufacturer algorithm is bundled.
App.prototype._mapKeyFn = function () {
  var mc = this._config().mapControl || {};
  if (!mc.securityAlgo) return null;
  try { return require('./seedkey').makeAlgo(mc.securityAlgo); } catch (e) { return null; }
};

// Web link hit region (bottom-right of the Live page), shared with screens.js.
var WEB_REGION = { x: 1420, y: 486, w: 160, h: 30 };
App.prototype._openWeb = function () {
  var url = this._config().webUrl;
  if (!url) return;
  if (this.ctx.openUrl) trySafe(function () { this.ctx.openUrl(url); }.bind(this)); // DEVICE: unit browser/uplink
  else this._flash('Open ' + url + ' in a connected browser');
};
// Touch routing: top tab strip, then the bottom action bar, then in-page taps.
App.prototype._onTap = function (x, y) {
  // tabs
  var trects = screens.tabRects(TABS.length);
  for (var i = 0; i < trects.length; i++) {
    if (hit(trects[i], x, y)) { this._show(TABS[i].key); return; }
  }
  // action bar
  var acts = this._actions();
  var brects = screens.barRects(acts.length);
  for (var j = 0; j < brects.length; j++) {
    if (hit(brects[j], x, y)) { var a = acts[j]; if (a && !a.disabled && a.fn) a.fn(); return; }
  }
  // in-page taps
  this._contentTap(x, y);
};

// Page-specific touch targets inside the content band (screens.CONTENT).
App.prototype._contentTap = function (x, y) {
  var R = screens.CONTENT, s = this.tab;
  if (s === 'channels') return this._channelsTap(x, y, R);
  if (s === 'setup') return this._setupTap(x, y, R);
  if (s === 'maps') return this._mapsTap(x, y, R);
  if (s === 'connect') return this._connectTap(x, y, R);
  if (s === 'flash') return this._flashTap(x, y, R);
};

App.prototype._channelsTap = function (x, y, R) {
  var all = Channels.all(), perPage = 15, page = Math.floor((this.selection || 0) / perPage);
  var cols = 3, gx = 16, gy = 10, cw = (R.w - (cols - 1) * gx) / cols, chh = 58;
  for (var p = 0; p < perPage; p++) {
    var gi = page * perPage + p; if (gi >= all.length) break;
    var col = p % cols, row = Math.floor(p / cols);
    var cx = R.x + col * (cw + gx), cy = R.y + 8 + row * (chh + gy);
    if (!hit({ x: cx, y: cy, w: cw, h: chh }, x, y)) continue;
    this.selection = gi;
    if (x >= cx + 12 && x <= cx + 38) this._toggleLog();          // L box
    else if (x >= cx + 44 && x <= cx + 70) this._toggleShow();    // S box
    return;
  }
};
App.prototype._setupTap = function (x, y, R) {
  var items = SETTINGS_SCHEMA, cols = 2, gx = 16, gy = 12, cw = (R.w - gx) / cols, rh = 56, perCol = Math.ceil(items.length / cols);
  for (var i = 0; i < items.length; i++) {
    var col = Math.floor(i / perCol), row = i % perCol;
    var ix = R.x + col * (cw + gx), iy = R.y + row * (rh + gy);
    if (hit({ x: ix, y: iy, w: cw, h: rh }, x, y)) { this.setupSel = i; this._cycleSetting(i); return; }
  }
};
App.prototype._mapsTap = function (x, y, R) {
  if (!this.map.enabled) return;
  var slots = this.map.maps || [], chipW = 150, chipH = 84, gap = 14;
  for (var i = 0; i < slots.length; i++) {
    var cx = R.x + i * (chipW + gap);
    if (hit({ x: cx, y: R.y, w: chipW, h: chipH }, x, y)) { this.map.requested = slots[i].index; this.confirm = false; return; }
  }
};
App.prototype._connectTap = function (x, y, R) {
  var by = R.y + R.h - 52; // the acknowledge checkbox row
  if (x >= R.x + 24 && x <= R.x + 460 && y >= by - 6 && y <= by + 34) this._enetAck();
};
App.prototype._flashTap = function (x, y, R) {
  // the ON/OFF toggle lives top-right of the content header
  var tx = R.x + R.w - 150;
  if (x >= tx && x <= tx + 126 && y >= R.y + 18 && y <= R.y + 56) this._flashToggle();
};

function hit(r, x, y) { return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }

App.prototype.render = function (cv, tabName) {
  var view = this.buildView();
  // Shrink all fonts uniformly so nothing overlaps / runs off the head-unit
  // screen (config.fontScale, default 0.85). Layout boxes are unchanged.
  var scale = this._config().fontScale;
  if (typeof scale !== 'number' || !(scale > 0)) scale = 0.85;
  var scv = screens.scaleCv(cv, scale);
  screens.chrome(scv, this.t, view);
  screens.content(tabName || this.tab)(scv, this.t, view, screens.CONTENT);
  // Diagnostic banner: if something failed in the last 15 s, show it (unscaled, at
  // the very bottom) so an on-car problem is visible and can be screenshotted
  // instead of failing silently. Clears itself afterwards.
  if (this._lastError && this._lastErrorAt && (Date.now() - this._lastErrorAt) < 15000) {
    try {
      // Two lines: a one-line banner cut the decisive tail off longer messages.
      var full = 'ERR ' + String(this._lastError);
      var l1 = full.slice(0, 118), l2 = full.slice(118, 236);
      var bh = l2 ? 38 : 24, by = screens.H - bh;
      cv.fillRect(0, by, screens.W, bh, (this.t && this.t.crit) || '#ff2a1f');
      cv.text(l1, 12, by + 16, 15, '#000000', { weight: 'bold' });
      if (l2) cv.text(l2, 12, by + 32, 15, '#000000', { weight: 'bold' });
    } catch (e) { /* never let the banner itself break a frame */ }
  }
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
    return this.ctx.ui.image('MAIN_GFX', this._surface.handle);
  }
  return null;
};
App.prototype._show = function (name) {
  // Switch the active tab. There is ONE RHMI canvas screen ('MAIN'); changing
  // tab is just a redraw of the next frame (no ui.open / state change), which is
  // what makes navigation reliable on the head unit. Relabel the HMI buttons so
  // any still-visible hardware bar mirrors the new tab's action bar.
  this.tab = name;
  this.confirm = false;
  this.codes.confirmClear = false;
  this.flash.confirm = false;
  this._relabel();
};
App.prototype._mediaDir = function () {
  return this.ctx.mediaDir || '/media/usb'; // DEVICE: USB mount point
};

App.prototype.stop = function () {
  if (this._sampler) clearInterval(this._sampler);
  trySafe(function () { this.someip.stop(); }.bind(this));
  trySafe(function () { this.diag.stop(); }.bind(this));
  trySafe(function () { this.monitor.stop(); }.bind(this));
  trySafe(function () { if (this.obd) this.obd.stop(); }.bind(this));
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
