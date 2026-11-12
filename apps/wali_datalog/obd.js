'use strict';
//
// obd.js — an ADDITIONAL live-data source: standard OBD-II (SAE J1979) Mode 01
// PIDs. It does not replace the UDS/DID, fast-block or bus sources — it is an
// extra option for cars without a per-tune pidmap, and it answers the
// boost-PID question directly: it reads boost from PID 0x70 / 0x87 (which do not
// saturate) as well as PID 0x0B (which caps at 255 kPa), exposing all of them.
//
// PID scalings follow SAE J1979 and were cross-checked against the MIT-licensed
// openbimmer project (see data/SOURCES.md). Request = [0x01, pid]; a positive
// reply is [0x41, pid, data…]. Transport is injected (same shape as diag.js).
//
var Channels = require('./channels');

function u16(d, i) { return ((d[i] & 0xff) << 8) | (d[i + 1] & 0xff); }

// pid -> function(dataBytes) -> partial { channelKey: value } (+ _tmp keys used
// only to derive boost; stripped before they reach the UI).
var PIDS = {
  0x04: function (d) { return { load: d[0] * 100 / 255 }; },
  0x05: function (d) { return { coolant: d[0] - 40 }; },
  0x0B: function (d) { return { boostObd0B: d[0] / 100, _absB: d[0] }; },          // manifold abs kPa (caps 255)
  0x0C: function (d) { return { rpm: u16(d, 0) / 4 }; },
  0x0D: function (d) { return { speed: d[0] }; },
  0x0E: function (d) { return { timing: d[0] / 2 - 64 }; },
  0x0F: function (d) { return { iat: d[0] - 40 }; },
  0x10: function (d) { return { maf: (u16(d, 0) / 100) * 3.6 }; },                 // g/s -> kg/h
  0x11: function (d) { return { throttle: d[0] * 100 / 255 }; },
  0x24: function (d) { return { lambda: (2 / 65536) * u16(d, 0) }; },              // wideband equivalence ratio
  0x34: function (d) { return { lambda: (2 / 65536) * u16(d, 0) }; },
  0x33: function (d) { return { baro: d[0] / 100, _baro: d[0] }; },               // kPa -> bar
  0x46: function (d) { return { ambientT: d[0] - 40 }; },
  0x5C: function (d) { return { oil: d[0] - 40 }; },
  0x87: function (d) { return { _abs87: u16(d, 0) / 32 }; },                       // intake manifold abs (wide range) kPa
  0x70: function (d) {                                                             // boost pressure control (does not cap)
    if (d.length < 3) return {};
    var kpa = u16(d, 1) / 32; // best-effort actual boost pressure (kPa)
    return (isFinite(kpa) && kpa > 0 && kpa < 600) ? { boostObd70: kpa / 100, _abs70: kpa } : {};
  }
};

// The PIDs polled by default (owner can override via config.obdPids).
var DEFAULT_PIDS = [0x0C, 0x0D, 0x05, 0x0F, 0x11, 0x04, 0x0E, 0x10, 0x33, 0x0B, 0x87, 0x70, 0x5C, 0x46, 0x24];

function parse(pid, resp) {
  if (!resp || resp.length < 2) return null;
  if (resp[0] === 0x7f) return null;           // negative response
  if (resp[0] !== 0x41 || resp[1] !== pid) return null;
  var fn = PIDS[pid];
  if (!fn) return null;
  try { return fn(resp.slice(2)); } catch (e) { return null; }
}

function promisify(transport) {
  return function (bytes) {
    return new Promise(function (resolve, reject) {
      transport.send(bytes, function (err, r) { if (err) reject(err); else resolve(r); });
    });
  };
}

function ObdProvider(ctx, opts) {
  opts = opts || {};
  this.ctx = ctx || {};
  this.transport = opts.transport || { supported: false, send: function (_b, cb) { cb && cb(new Error('no transport')); } };
  this.send = opts.send || promisify(this.transport);
  this.pids = (opts.pids && opts.pids.length) ? opts.pids.slice() : DEFAULT_PIDS.slice();
  this.pollMs = opts.pollMs || 60;
  this.supported = !!this.transport.supported;
  this.cache = {};
  this._tmp = {};
  this.lastUpdate = 0;
  this.timer = null;
  this.busy = false;
  this._i = 0;
}

ObdProvider.prototype.start = function (scheduler) {
  if (!this.supported) return false;
  var self = this, setI = scheduler || (typeof setInterval === 'function' ? setInterval : null);
  if (!setI) return false;
  this.timer = setI(function () {
    if (self.busy || !self.pids.length) return;
    var pid = self.pids[self._i % self.pids.length]; self._i++;
    self.busy = true;
    self.send([0x01, pid & 0xff]).then(function (resp) {
      var vals = parse(pid, resp || []);
      if (vals) self._apply(vals);
      self.busy = false;
    }, function () { self.busy = false; });
  }, this.pollMs);
  return true;
};

// Merge a decoded partial into the cache, keeping the _tmp boost values aside,
// then derive the preferred absolute manifold pressure and relative boost.
ObdProvider.prototype._apply = function (vals) {
  for (var k in vals) {
    if (!vals.hasOwnProperty(k)) continue;
    var v = vals[k];
    if (typeof v !== 'number' || !isFinite(v)) continue;
    if (k.charAt(0) === '_') this._tmp[k] = v;
    else if (Channels.get(k)) this.cache[k] = v;
  }
  // boost: prefer 0x87 / 0x70 (wide range) over 0x0B (caps at 255 kPa).
  var absKpa = this._tmp._abs87 || this._tmp._abs70 || this._tmp._absB;
  var baroBar = this.cache.baro || (this._tmp._baro ? this._tmp._baro / 100 : 1.0);
  if (typeof absKpa === 'number' && isFinite(absKpa)) {
    this.cache.boostAbs = absKpa / 100;
    this.cache.boost = absKpa / 100 - baroBar;
  }
  this.lastUpdate = Date.now();
};

ObdProvider.prototype.read = function () {
  var out = {};
  for (var k in this.cache) if (this.cache.hasOwnProperty(k)) out[k] = this.cache[k];
  return out;
};
ObdProvider.prototype.health = function () {
  return { supported: this.supported, fresh: this.supported && (Date.now() - this.lastUpdate) < 1000, lastUpdate: this.lastUpdate };
};
ObdProvider.prototype.stop = function () { if (this.timer && typeof clearInterval === 'function') clearInterval(this.timer); this.timer = null; };

module.exports = { ObdProvider: ObdProvider, PIDS: PIDS, DEFAULT_PIDS: DEFAULT_PIDS, parse: parse };
