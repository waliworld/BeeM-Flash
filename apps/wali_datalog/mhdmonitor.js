'use strict';
//
// mhdmonitor.js — MHD live-monitor datalog source for MG1 DMEs (B58/S58).
//
// MHD's live monitor is a single fixed UDS exchange: request 0x2C 0x88 0x01
// (DynamicallyDefineDataIdentifier), positive reply 0x6C 0x88 followed by a
// 36-byte little-endian packed body of ~19 measured values. This one request
// yields a full live set, correctly scaled — the efficient, canonical way to
// datalog an MHD-flashed MG1 car.
//
// The field table (offsets, sizes, signedness, scaling) is transcribed from
// MHD Tuning's own PUBLICLY PUBLISHED TunerPro RT ADX file (MG1.adx), via the
// MIT-licensed open-source package github.com/freebeamer/core (pkg/mhd). See
// data/SOURCES.md. Read-only: the write / map-switch path is MHD's closed
// plugin and is intentionally not implemented.
//
var uds = require('./uds');

var PSI_TO_BAR = 0.0689476;
var GPS_TO_KGH = 3.6;

// name, off (within 36-byte body), bits, signed, m (raw -> native unit),
// channel (our key or null), uscale (native unit -> our internal unit).
var FIELDS = [
  { name: 'RPM',            off: 0x00, bits: 16, signed: false, m: 1,                   channel: 'rpm',                 uscale: 1 },
  { name: 'LOAD',           off: 0x02, bits: 16, signed: true,  m: 0.01,                channel: 'load',                uscale: 1 },
  { name: 'BOOST',          off: 0x04, bits: 16, signed: false, m: 0.001133107328125,  channel: 'boost',               uscale: PSI_TO_BAR },
  { name: 'BOOSTTARGET',    off: 0x06, bits: 16, signed: false, m: 0.0018129717,       channel: 'boostTarget',         uscale: PSI_TO_BAR },
  { name: 'BOOSTDEVIATION', off: 0x08, bits: 16, signed: true,  m: 0.0018129717,       channel: 'boostDeviation',      uscale: PSI_TO_BAR },
  { name: 'BOOSTDEVGRAD',   off: 0x0A, bits: 16, signed: true,  m: 0.0018129717,       channel: null,                  uscale: PSI_TO_BAR },
  { name: 'ENGINETEMP',     off: 0x0C, bits: 16, signed: true,  m: 0.01,                channel: 'coolant',             uscale: 1 },
  { name: 'GEAR',           off: 0x0E, bits: 8,  signed: false, m: 1,                   channel: 'gear',                uscale: 1 },
  { name: 'ETHANOLCONTENT', off: 0x0F, bits: 8,  signed: false, m: 1,                   channel: 'ethanol',             uscale: 1 },
  { name: 'WGDISTRIBFAC',   off: 0x10, bits: 16, signed: false, m: 1 / 16384,           channel: 'wgDistribution',      uscale: 1 },
  { name: 'TURBOMASSFLOW',  off: 0x12, bits: 16, signed: false, m: 0.0390625 / 3.6,     channel: null,                  uscale: GPS_TO_KGH },
  { name: 'TURBOMASSFLOW2', off: 0x14, bits: 16, signed: false, m: 0.03125 / 3.6,       channel: null,                  uscale: GPS_TO_KGH },
  { name: 'CMPRMASSFLOW',   off: 0x16, bits: 16, signed: false, m: 0.0625 / 3.6,        channel: null,                  uscale: GPS_TO_KGH, s58maf: true },
  { name: 'CMPRMASSFLOW2',  off: 0x18, bits: 16, signed: false, m: 0.03125 / 3.6,       channel: 'maf',                 uscale: GPS_TO_KGH, b58maf: true },
  { name: 'BOOSTSETPOINTF', off: 0x1A, bits: 16, signed: false, m: 1 / 8192,            channel: 'boostSetpointFactor', uscale: 1 },
  { name: 'SPEED',          off: 0x1C, bits: 16, signed: false, m: 1,                   channel: 'speed',               uscale: 1 },
  { name: 'AMBIENTTEMP',    off: 0x1E, bits: 16, signed: true,  m: 0.1,                 channel: 'ambientT',            uscale: 1 },
  { name: 'INTAKEAIRTEMP',  off: 0x20, bits: 16, signed: true,  m: 0.1,                 channel: 'iat',                 uscale: 1 },
  { name: 'MHDMAFCALC',     off: 0x22, bits: 16, signed: false, m: 0.03472225,          channel: null,                  uscale: 1 }
];

var BODY_LEN = 36;

function rawAt(body, off, bits, signed) {
  if (off + bits / 8 > body.length) return NaN;
  var v;
  if (bits === 8) { v = body[off] & 0xff; if (signed && v >= 0x80) v -= 0x100; }
  else { v = (body[off] & 0xff) | ((body[off + 1] & 0xff) << 8); if (signed && v >= 0x8000) v -= 0x10000; } // little-endian
  return v;
}

// Decode a 36-byte monitor body into { channelKey: value } (our internal units).
// platform 'S58' sources MAF from the S58 compressor field instead of B58's.
function decodeBody(body, platform) {
  var out = {};
  for (var i = 0; i < FIELDS.length; i++) {
    var f = FIELDS[i];
    var ch = f.channel;
    if (platform === 'S58') {
      if (f.b58maf) continue;              // skip B58 maf field
      if (f.s58maf) ch = 'maf';            // use S58 compressor as maf
    } else if (f.s58maf) {
      continue;                             // B58: skip S58 maf field
    }
    if (!ch) continue;
    var raw = rawAt(body, f.off, f.bits, f.signed);
    if (typeof raw === 'number' && isFinite(raw)) out[ch] = raw * f.m * f.uscale;
  }
  return out;
}

// Decode a full reply (0x6C 0x88 + 36-byte body).
function decodeReply(reply, platform) {
  var p = uds.parseResponse(uds.SID.DDDI, reply);
  if (!p.positive) return null;
  if (!p.data || p.data.length < BODY_LEN) return null;
  return decodeBody(p.data.slice(0, BODY_LEN), platform);
}

function promisifySend(transport) {
  return function (bytes) {
    return new Promise(function (resolve, reject) {
      try {
        var r = transport.send(bytes, function (err, resp) { if (err) reject(err); else resolve(resp); });
        if (r && typeof r.then === 'function') r.then(resolve, reject);
      } catch (e) { reject(e); }
    });
  };
}

function MhdMonitor(ctx, opts) {
  opts = opts || {};
  this.ctx = ctx || {};
  this.transport = opts.transport || null;
  this.send = this.transport ? promisifySend(this.transport) : null;
  this.platform = opts.platform || 'B58';
  this.pollMs = opts.pollMs || 50;
  this.supported = !!(this.transport && this.transport.supported);
  this.cache = {};
  this.lastUpdate = 0;
  this.timer = null;
  this.busy = false;
}

MhdMonitor.prototype.start = function (scheduler) {
  if (!this.supported) return false;
  var self = this;
  var setI = scheduler || (typeof setInterval === 'function' ? setInterval : null);
  if (!setI) return false;
  this.timer = setI(function () {
    if (self.busy) return;
    self.busy = true;
    self.send(uds.buildMonitorRequest()).then(function (reply) {
      var vals = decodeReply(reply, self.platform);
      if (vals) { self.cache = vals; self.lastUpdate = Date.now(); }
      self.busy = false;
    }, function () { self.busy = false; });
  }, this.pollMs);
  return true;
};

MhdMonitor.prototype.read = function () {
  var out = {};
  for (var k in this.cache) if (this.cache.hasOwnProperty(k)) out[k] = this.cache[k];
  return out;
};

MhdMonitor.prototype.health = function () {
  return { supported: this.supported, platform: this.platform, fresh: this.supported && (Date.now() - this.lastUpdate) < 1000, lastUpdate: this.lastUpdate };
};

MhdMonitor.prototype.stop = function () {
  if (this.timer && typeof clearInterval === 'function') clearInterval(this.timer);
  this.timer = null;
};

MhdMonitor.FIELDS = FIELDS;
MhdMonitor.BODY_LEN = BODY_LEN;
MhdMonitor.decodeBody = decodeBody;
MhdMonitor.decodeReply = decodeReply;
module.exports = MhdMonitor;
