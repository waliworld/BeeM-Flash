'use strict';
//
// bridgelink.js — the app's client to the root bridge daemon.
//
// WHY A DAEMON AT ALL: the head unit's app sandbox cannot bring up Wi-Fi or
// listen on a port. (On the car, probing the app's own socket paths returns
// ENOENT — "no such file" — not EACCES, which tells us a UNIX *client* connect
// is permitted; what is missing is something to connect to.) So a small root
// daemon (tools/beem-bridge) owns the access point and the DoIP listener, and
// the app attaches to its UNIX socket as a client.
//
// Division of responsibility, and this is the important part:
//
//      phone / tool  --Wi-Fi-->  daemon (AP + DoIP)  --UNIX socket-->  APP
//                                                                       |
//                                                              TASU to the car
//
// The daemon carries bytes. It does NOT decide what may reach the car. Every
// relayed request is judged here, by relaypolicy against the on-screen consent
// gate (bridgegate). The daemon is treated as untrusted input: it can ask, the
// app decides. A malformed line, a socket error, a frame while the gate is not
// armed, an ECU outside the allow-list — all refused, fail closed.
//
// The app never takes an allow-list, a mode or a "flashing" flag from a daemon
// message, and never widens its own policy because a message asked it to.
//
var relaypolicy = require('./relaypolicy');

var DEFAULT_SOCKET = '/run/beem-bridge/bridge.sock';
var MAX_BUF = 256 * 1024;        // a daemon that floods us is dropped, not buffered
var REQ_TIMEOUT_MS = 4000;

function BridgeLink(opts) {
  opts = opts || {};
  this.path = opts.socket || DEFAULT_SOCKET;
  this.netMod = opts.netMod || null;          // injected in tests; else require('net')
  this.gate = opts.gate || null;              // BridgeGate — the consent state machine
  this.ecuAllow = opts.ecuAllow || relaypolicy.DEFAULT_ECU_ALLOW;
  this.sendTo = opts.sendTo || null;          // function(ecu, bytes) -> Promise<respBytes>
  this.logFn = opts.log || null;

  this.sock = null;
  this.connected = false;
  this.connecting = false;
  this.buf = '';
  this.lastError = null;
  this.seq = 1;
  this.pending = {};                          // control-request id -> { resolve, reject, timer }

  // last known daemon state (never trusted for policy, only displayed)
  this.ap = { up: false, ssid: null, pass: null, security: null, channel: null, address: null };
  this.stations = [];
  this.relayed = 0;
  this.refused = 0;
  this.lastRefusal = null;
  this.audit = [];                            // recent relay decisions, newest first
}

BridgeLink.prototype._log = function (m) { if (this.logFn) { try { this.logFn(m); } catch (e) {} } };

BridgeLink.prototype._net = function () {
  if (this.netMod) return this.netMod;
  try { this.netMod = require('net'); } catch (e) { this.netMod = null; }
  return this.netMod;
};

// ---- connection ------------------------------------------------------------

BridgeLink.prototype.connect = function () {
  var self = this;
  if (this.connected || this.connecting) return Promise.resolve(this.connected);
  var net = this._net();
  if (!net || !net.connect) {
    this.lastError = 'no socket support';
    return Promise.resolve(false);
  }
  this.connecting = true;
  return new Promise(function (resolve) {
    var done = false;
    function settle(ok) { if (done) return; done = true; self.connecting = false; resolve(ok); }
    var s;
    try { s = net.connect(self.path); } catch (e) {
      self.lastError = (e && e.message) || String(e);
      return settle(false);
    }
    self.sock = s;
    s.on('connect', function () {
      self.connected = true; self.lastError = null; self.buf = '';
      self._log('bridge daemon connected (' + self.path + ')');
      settle(true);
    });
    s.on('data', function (d) { self._onData(d); });
    s.on('error', function (e) {
      self.lastError = (e && e.code) ? (e.code + ' ' + self.path) : ((e && e.message) || String(e));
      self._drop();
      settle(false);
    });
    s.on('close', function () { self._drop(); settle(false); });
  });
};

BridgeLink.prototype._drop = function () {
  this.connected = false;
  this.connecting = false;
  this.sock = null;
  this.buf = '';
  // Reject anything still waiting rather than leaving the UI spinning.
  for (var k in this.pending) if (this.pending.hasOwnProperty(k)) {
    var p = this.pending[k];
    if (p.timer && typeof clearTimeout === 'function') clearTimeout(p.timer);
    try { p.reject(new Error('bridge daemon disconnected')); } catch (e) {}
  }
  this.pending = {};
  // A dropped daemon means no AP and no peers, as far as we can honestly say.
  this.ap = { up: false, ssid: this.ap && this.ap.ssid, pass: null, security: null, channel: null, address: null };
  this.stations = [];
};

BridgeLink.prototype.close = function () {
  if (this.sock) { try { this.sock.end(); } catch (e) {} try { this.sock.destroy(); } catch (e) {} }
  this._drop();
};

// ---- line framing ----------------------------------------------------------

BridgeLink.prototype._onData = function (chunk) {
  this.buf += String(chunk);
  if (this.buf.length > MAX_BUF) { this._log('bridge: oversized frame, dropping link'); this.close(); return; }
  var i;
  while ((i = this.buf.indexOf('\n')) >= 0) {
    var line = this.buf.slice(0, i);
    this.buf = this.buf.slice(i + 1);
    if (!line) continue;
    var msg = null;
    try { msg = JSON.parse(line); } catch (e) { this._log('bridge: unparsable line ignored'); continue; }
    if (msg && typeof msg === 'object') this._onMessage(msg);
  }
};

BridgeLink.prototype._send = function (obj) {
  if (!this.sock || !this.connected) return false;
  try { this.sock.write(JSON.stringify(obj) + '\n'); return true; } catch (e) { this._drop(); return false; }
};

BridgeLink.prototype._onMessage = function (msg) {
  // a reply to one of our control requests
  if (msg.id != null && this.pending[msg.id]) {
    var p = this.pending[msg.id];
    delete this.pending[msg.id];
    if (p.timer && typeof clearTimeout === 'function') clearTimeout(p.timer);
    if (msg.ok === false) p.reject(new Error(msg.error || 'daemon refused'));
    else p.resolve(msg);
    return;
  }
  if (msg.t === 'state') { this._applyState(msg); return; }
  if (msg.t === 'uds') { this._onUds(msg); return; }
  // anything else is ignored on purpose
};

// Display-only. None of this is allowed to influence a policy decision.
BridgeLink.prototype._applyState = function (msg) {
  if (msg.ap && typeof msg.ap === 'object') {
    this.ap = {
      up: !!msg.ap.up,
      ssid: msg.ap.ssid != null ? String(msg.ap.ssid).slice(0, 64) : null,
      // Shown on the car's own screen so it can be typed into the phone. Never
      // logged, never sent anywhere.
      pass: msg.ap.pass != null ? String(msg.ap.pass).slice(0, 63) : null,
      security: msg.ap.security != null ? String(msg.ap.security).slice(0, 16) : null,
      channel: msg.ap.channel != null ? Number(msg.ap.channel) : null,
      address: msg.ap.address != null ? String(msg.ap.address).slice(0, 64) : null
    };
  }
  if (Object.prototype.toString.call(msg.stations) === '[object Array]') {
    var out = [];
    for (var i = 0; i < msg.stations.length && i < 8; i++) {
      var s = msg.stations[i] || {};
      out.push({
        mac: s.mac != null ? String(s.mac).slice(0, 24) : '?',
        ip: s.ip != null ? String(s.ip).slice(0, 48) : null,
        since: s.since != null ? Number(s.since) : null
      });
    }
    this.stations = out;
  }
};

// ---- control requests ------------------------------------------------------

BridgeLink.prototype.request = function (cmd, extra) {
  var self = this;
  if (!this.connected) return Promise.reject(new Error('bridge daemon not connected'));
  var id = 'c' + (this.seq++);
  var msg = { id: id, cmd: cmd };
  if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) msg[k] = extra[k];
  return new Promise(function (resolve, reject) {
    self.pending[id] = {
      resolve: function (m) { if (m.t === 'state' || m.ap || m.stations) self._applyState(m); resolve(m); },
      reject: reject,
      timer: (typeof setTimeout === 'function') ? setTimeout(function () {
        if (self.pending[id]) { delete self.pending[id]; reject(new Error('bridge daemon did not answer')); }
      }, REQ_TIMEOUT_MS) : null
    };
    if (!self._send(msg)) {
      delete self.pending[id];
      reject(new Error('bridge daemon write failed'));
    }
  });
};

BridgeLink.prototype.refresh = function () { return this.request('status'); };
BridgeLink.prototype.stationList = function () { return this.request('stations'); };
BridgeLink.prototype.apOn = function () { return this.request('ap', { up: true }); };
BridgeLink.prototype.apOff = function () { return this.request('ap', { up: false }); };
BridgeLink.prototype.setSsid = function (v) {
  var s = String(v == null ? '' : v).trim();
  if (s.length < 1 || s.length > 32) return Promise.reject(new Error('SSID must be 1-32 characters'));
  return this.request('set-ssid', { ssid: s });
};
// WPA2 requires 8-63 characters. Refuse anything shorter rather than silently
// bringing up an open network a stranger could join.
BridgeLink.prototype.setPass = function (v) {
  var s = String(v == null ? '' : v);
  if (s.length < 8 || s.length > 63) return Promise.reject(new Error('Wi-Fi password must be 8-63 characters'));
  return this.request('set-pass', { pass: s });
};
// Ask the daemon for a freshly generated passphrase. The head unit has no
// keyboard, so the car DISPLAYS the network name and password and you type them
// into the phone — the same way a vehicle hotspot works. This is also why the
// password is shown in full on screen: it is of no use to anyone who cannot
// already see your dashboard.
BridgeLink.prototype.newPass = function () { return this.request('new-pass'); };

// ---- the relay -------------------------------------------------------------
//
// One request from a connected tool. The APP decides; the daemon only carried it.
BridgeLink.prototype._onUds = function (msg) {
  var self = this;
  var id = msg.id;
  var ecu = (msg.ecu != null) ? (Number(msg.ecu) & 0xff) : -1;
  var data = toBytes(msg.data);
  var frame = { target: ecu, uds: data };

  function answer(bytes, note, allowed) {
    self._send({ t: 'uds-reply', id: id, data: bytes || [] });
    self.audit.unshift({
      ecu: ecu, sid: data.length ? data[0] : null,
      allowed: !!allowed, note: note || null,
      at: (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0
    });
    if (self.audit.length > 12) self.audit.length = 12;
  }

  // The gate must exist and be armed; with no gate we refuse outright.
  var ctx = this.gate ? this.gate.policyCtx(this.ecuAllow) : { armed: false, ecuAllow: this.ecuAllow };

  // If a peer was approved, only that peer may drive the bridge.
  if (this.gate && msg.peer && typeof this.gate.peerAllowed === 'function') {
    if (!this.gate.peerAllowed(msg.peer)) {
      this.refused++; this.lastRefusal = 'another device tried to use the bridge';
      return answer(nackFor(data, 0x33), this.lastRefusal, false);
    }
  }

  var verdict = relaypolicy.evaluate(frame, ctx);
  if (!verdict.allow) {
    this.refused++;
    this.lastRefusal = verdict.reason || 'refused';
    return answer(verdict.nack || nackFor(data, 0x31), this.lastRefusal, false);
  }

  if (typeof this.sendTo !== 'function') {
    this.refused++; this.lastRefusal = 'no link to the car';
    return answer(nackFor(data, 0x31), this.lastRefusal, false);
  }

  // Allowed: put it on the car and hand the answer back verbatim.
  Promise.resolve(this.sendTo(ecu, data)).then(function (resp) {
    self.relayed++;
    answer(toBytes(resp), null, true);
  }, function (e) {
    self.refused++;
    self.lastRefusal = (e && e.message) || 'the car did not answer';
    answer(nackFor(data, 0x78), self.lastRefusal, false);
  });
};

function nackFor(data, nrc) { return [0x7F, (data && data.length ? data[0] : 0x00) & 0xff, nrc & 0xff]; }

function toBytes(v) {
  var out = [];
  if (!v) return out;
  if (typeof v === 'string') {
    var h = v.replace(/[^0-9a-fA-F]/g, '');
    for (var i = 0; i + 2 <= h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16));
    return out;
  }
  if (Object.prototype.toString.call(v) === '[object Array]') {
    for (var k = 0; k < v.length; k++) out.push(Number(v[k]) & 0xff);
  }
  return out;
}

// ---- status for the UI -----------------------------------------------------
BridgeLink.prototype.status = function () {
  var g = this.gate ? this.gate.status() : { acknowledged: false, enabled: false, armed: false };
  return {
    socket: this.path,
    connected: this.connected,
    error: this.lastError,
    ap: this.ap,
    stations: this.stations,
    relayed: this.relayed,
    refused: this.refused,
    lastRefusal: this.lastRefusal,
    audit: this.audit.slice(0, 5),
    gate: g
  };
};

BridgeLink.DEFAULT_SOCKET = DEFAULT_SOCKET;
BridgeLink.toBytes = toBytes;
module.exports = BridgeLink;
