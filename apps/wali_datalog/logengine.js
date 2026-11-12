'use strict';
//
// logengine.js — the datalogging state machine.
//
// Host-driven: the application (or the simulator harness) feeds one metric
// sample per tick via sample(). The engine resolves derived channels, converts
// to the chosen unit system, formats a CSV row, buffers it, and flushes to the
// injected storage. It owns session lifecycle, markers, stats, and errors.
//
// States: idle -> logging -> saving -> done ; any write failure -> error.
//
var Channels = require('./channels');
var RunCapture = require('./runcapture');
var F = require('./format');

var STATE = {
  IDLE: 'idle',
  LOGGING: 'logging',
  SAVING: 'saving',
  DONE: 'done',
  ERROR: 'error'
};

function noop() {}

function LogEngine(opts) {
  opts = opts || {};
  this.appId = opts.appId || 'wali_datalog';
  this.storage = opts.storage; // required: { open,append,close,size,list,read,remove,export }
  this.clock = opts.clock || Date.now;
  this.onState = opts.onState || noop;
  this.onError = opts.onError || noop;
  this.flushEveryMs = opts.flushEveryMs || 1000;
  this.flushEveryRows = opts.flushEveryRows || 50;
  this.vehicle = opts.vehicle || {}; // { massKg, cda, crr, drivetrain } for run power estimates
  this.runCapture = new RunCapture(this.vehicle);
  this._resetConfig();
  this._resetSession();
}

// Session parameters chosen by the user; preserved across start/stop.
LogEngine.prototype._resetConfig = function () {
  this.enabled = Channels.defaults();
  this.rate = 10;
  this.units = 'metric';
};

// Per-recording state; cleared at the start of each session.
LogEngine.prototype._resetSession = function () {
  this.state = STATE.IDLE;
  this.handle = null;
  this.file = null;
  this.startMs = 0;
  this.lastMs = 0;
  this.lastFlush = 0;
  this.buffer = [];
  this.markerPending = '';
  this.stats = { samples: 0, bytes: 0, durationMs: 0, rate: 0, markers: 0 };
  this.errorMsg = '';
  this.last = {}; // last resolved metric values, for the live UI
  this.summary = {}; // per-channel min/max/sum/n over the session (metric values)
  if (this.runCapture) this.runCapture.reset();
};

LogEngine.prototype.configure = function (cfg) {
  if (this.state === STATE.LOGGING || this.state === STATE.SAVING) return false;
  cfg = cfg || {};
  if (cfg.channels && cfg.channels.length) this.enabled = cfg.channels.slice();
  if (cfg.rate) this.rate = cfg.rate;
  if (cfg.units) this.units = cfg.units;
  return true;
};

LogEngine.prototype._setState = function (s) {
  if (this.state === s) return;
  this.state = s;
  this.onState(s, this);
};

// Resolve derived channels and keep metric values for any enabled channel.
LogEngine.prototype.resolve = function (metric) {
  var out = {};
  for (var i = 0; i < this.enabled.length; i++) {
    var key = this.enabled[i];
    var ch = Channels.get(key);
    if (!ch) continue;
    if (ch.read && ch.read.kind === 'derived') out[key] = ch.read.fn(metric);
    else out[key] = metric[key];
  }
  return out;
};

LogEngine.prototype._header = function () {
  var cols = ['time_ms', 'iso_time', 'marker'];
  for (var i = 0; i < this.enabled.length; i++) {
    var ch = Channels.get(this.enabled[i]);
    if (!ch) continue;
    var u = Channels.unitLabel(ch, this.units);
    cols.push(u ? ch.key + '[' + u + ']' : ch.key);
  }
  return F.csvRow(cols);
};

LogEngine.prototype.start = function () {
  if (this.state === STATE.LOGGING) return false;
  this._resetSession();
  var now = this.clock();
  this.file = this.appId + '_' + F.stamp(now) + '.csv';
  try {
    this.handle = this.storage.open(this.file);
    this.storage.append(this.handle, this._header() + '\n');
  } catch (e) {
    return this._fail('Could not create log file: ' + (e && e.message ? e.message : e));
  }
  this.startMs = now;
  this.lastMs = now;
  this.lastFlush = now;
  this._setState(STATE.LOGGING);
  return true;
};

LogEngine.prototype.marker = function (label) {
  if (this.state !== STATE.LOGGING) return false;
  this.markerPending = label ? String(label) : 'mark';
  return true;
};

LogEngine.prototype.sample = function (metric) {
  if (this.state !== STATE.LOGGING) return false;
  var now = this.clock();
  var resolved = this.resolve(metric);
  this.last = resolved;

  var marker = this.markerPending;
  if (marker) { this.markerPending = ''; this.stats.markers++; }

  // per-channel running min/max/avg (metric units) + dyno pull capture
  for (var si = 0; si < this.enabled.length; si++) {
    var sk = this.enabled[si], sv = resolved[sk];
    if (!F.isNum(sv)) continue;
    var ac = this.summary[sk] || (this.summary[sk] = { min: sv, max: sv, sum: 0, n: 0 });
    if (sv < ac.min) ac.min = sv; if (sv > ac.max) ac.max = sv; ac.sum += sv; ac.n++;
  }
  try { this.runCapture.feed(metric, now); } catch (e) {}

  var row = [now - this.startMs, F.iso(now), marker];
  for (var i = 0; i < this.enabled.length; i++) {
    var ch = Channels.get(this.enabled[i]);
    if (!ch) { row.push(''); continue; }
    var v = Channels.toUnits(ch, resolved[this.enabled[i]], this.units);
    row.push(F.isNum(v) ? F.fixed(v, ch.dp) : '');
  }
  this.buffer.push(F.csvRow(row));
  this.stats.samples++;
  this.lastMs = now;
  this.stats.durationMs = now - this.startMs;
  var secs = this.stats.durationMs / 1000;
  this.stats.rate = secs > 0 ? this.stats.samples / secs : 0;

  if (this.buffer.length >= this.flushEveryRows || now - this.lastFlush >= this.flushEveryMs) {
    this._flush();
  }
  return true;
};

LogEngine.prototype._flush = function () {
  if (!this.handle || this.buffer.length === 0) return;
  var text = this.buffer.join('\n') + '\n';
  try {
    this.storage.append(this.handle, text);
    this.stats.bytes += (typeof Buffer !== 'undefined' && Buffer.byteLength) ? Buffer.byteLength(text) : text.length;
    this.buffer = [];
    this.lastFlush = this.clock();
  } catch (e) {
    this._fail('Write failed: ' + (e && e.message ? e.message : e));
  }
};

// Per-channel session summary (metric units): [{ key, label, unit, min, max, avg, n }].
LogEngine.prototype.getSummary = function () {
  var out = [];
  for (var i = 0; i < this.enabled.length; i++) {
    var key = this.enabled[i], a = this.summary[key], ch = Channels.get(key);
    if (!a || !ch || !a.n) continue;
    out.push({ key: key, label: ch.label, unit: ch.unit || '', min: a.min, max: a.max, avg: a.sum / a.n, n: a.n, dp: ch.dp });
  }
  return out;
};
LogEngine.prototype.lastRun = function () { return this.runCapture ? this.runCapture.last() : null; };
LogEngine.prototype.runs = function () { return this.runCapture ? this.runCapture.runs.slice() : []; };

// Append a human-readable summary footer (commented) to the CSV.
LogEngine.prototype._writeSummary = function () {
  if (!this.handle) return;
  var lines = ['', '# --- session summary ---',
    '# channel,min,max,avg'];
  var s = this.getSummary();
  for (var i = 0; i < s.length; i++) {
    lines.push('# ' + s[i].key + ',' + F.fixed(s[i].min, s[i].dp) + ',' + F.fixed(s[i].max, s[i].dp) + ',' + F.fixed(s[i].avg, s[i].dp));
  }
  var r = this.lastRun();
  if (r) {
    lines.push('# --- last pull (estimated) ---');
    lines.push('# duration_s,' + F.fixed(r.durationMs / 1000, 1));
    lines.push('# peak_boost_bar,' + (F.isNum(r.peakBoost) ? F.fixed(r.peakBoost, 2) : ''));
    lines.push('# est_peak_power_whp,' + F.fixed(r.peakPowerHp, 0) + ',at_rpm,' + F.fixed(r.peakPowerRpm, 0));
    lines.push('# est_peak_power_crank_hp,' + F.fixed(r.peakPowerCrankHp, 0));
    if (r.t100_200 != null) lines.push('# 100-200kmh_s,' + F.fixed(r.t100_200 / 1000, 2));
    lines.push('# NOTE: power is an acceleration-based estimate, not a dyno figure.');
  }
  try { this.storage.append(this.handle, lines.join('\n') + '\n'); } catch (e) {}
};

LogEngine.prototype.stop = function () {
  if (this.state !== STATE.LOGGING) return false;
  this._setState(STATE.SAVING);
  this._flush();
  this._writeSummary();
  try {
    if (this.handle) this.storage.close(this.handle);
  } catch (e) {
    return this._fail('Close failed: ' + (e && e.message ? e.message : e));
  }
  this.handle = null;
  this._setState(STATE.DONE);
  return true;
};

LogEngine.prototype._fail = function (msg) {
  this.errorMsg = msg;
  this.buffer = [];
  try { if (this.handle) this.storage.close(this.handle); } catch (e) {}
  this.handle = null;
  this._setState(STATE.ERROR);
  this.onError(msg, this);
  return false;
};

// Clear a terminal state back to idle so a new session can start.
LogEngine.prototype.reset = function () {
  if (this.state === STATE.DONE || this.state === STATE.ERROR) this._resetSession();
};

LogEngine.prototype.sessions = function () {
  try {
    var list = this.storage.list ? this.storage.list() : [];
    return list.filter(function (n) { return /\.csv$/.test(n); }).sort().reverse();
  } catch (e) { return []; }
};

LogEngine.prototype.exportTo = function (name, destDir) {
  if (!this.storage.export) throw new Error('export not supported');
  return this.storage.export(name, destDir);
};

LogEngine.STATE = STATE;
module.exports = LogEngine;
