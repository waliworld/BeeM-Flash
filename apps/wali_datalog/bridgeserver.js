'use strict';
//
// bridgeserver.js — the bridge, hosted by the app itself. No helper, no PC.
//
// The project previously assumed a listening socket must live in a root daemon.
// That was an assumption from absence of evidence ("nothing in any reference app
// opens one"), never an actual test. This module simply TRIES: it asks Node for
// a TCP listener on the head unit's own network and reports exactly what the
// sandbox said. If the bind succeeds, a phone already joined to the car's Wi-Fi
// can reach the app directly and the daemon is unnecessary.
//
//      phone  --car's Wi-Fi-->  [this listener in the app]  --TASU-->  DME / EGS
//
// It does NOT create a Wi-Fi network — an app cannot. It listens on an address
// the head unit already has (e.g. the wlan_bridge interface), so the phone has
// to be on that same network. Creating a fresh access point is the one thing
// that still needs the root helper.
//
// Every request is judged by relayengine against the on-screen consent gate,
// exactly as the helper path is: same policy, same refusals, same audit.
//
var relayengine = require('./relayengine');

var DOIP_V = 0x02;
var DEFAULT_PORT = 13400;
var MAX_FRAME = 8 * 1024 * 1024;

function BridgeServer(opts) {
  opts = opts || {};
  this.netMod = opts.netMod || null;
  this.port = opts.port || DEFAULT_PORT;
  this.host = opts.host || null;          // null = every address the unit has
  this.gate = opts.gate || null;
  this.ecuAllow = opts.ecuAllow || null;
  this.sendTo = opts.sendTo || null;
  this.logFn = opts.log || null;
  this.logicalAddress = opts.logicalAddress || 0x1000;
  this.rawEcu = opts.rawEcu || 0x12;      // raw sockets carry no address: default to the DME
  this.mode = null;                       // what the connected tool turned out to speak

  this.server = null;
  this.listening = false;
  this.boundHost = null;
  this.lastError = null;
  this.peers = [];                        // currently connected tools
  this.stats = { relayed: 0, refused: 0, lastRefusal: null, audit: [] };
}

BridgeServer.prototype._log = function (m) { if (this.logFn) { try { this.logFn(m); } catch (e) {} } };
BridgeServer.prototype._net = function () {
  if (this.netMod) return this.netMod;
  try { this.netMod = require('net'); } catch (e) { this.netMod = null; }
  return this.netMod;
};

// start() -> Promise<{ ok, host, port, error }>
// Never throws: a sandbox refusal is an ANSWER (and the UI shows the errno),
// not a crash.
BridgeServer.prototype.start = function (_retried) {
  var self = this;
  if (this.listening) return Promise.resolve({ ok: true, host: this.boundHost, port: this.port });
  var net = this._net();
  if (!net || !net.createServer) {
    this.lastError = 'no socket support in this runtime';
    return Promise.resolve({ ok: false, error: this.lastError });
  }
  return new Promise(function (resolve) {
    var settled = false;
    function settle(r) { if (!settled) { settled = true; resolve(r); } }
    var srv;
    try { srv = net.createServer(function (c) { self._onTool(c); }); }
    catch (e) {
      self.lastError = (e && (e.code || e.message)) || String(e);
      return settle({ ok: false, error: self.lastError });
    }
    srv.on('error', function (e) {
      // EACCES / EPERM -> the sandbox forbids listening (the helper is needed).
      // EADDRINUSE     -> the port is still held, almost always by OUR OWN
      //   previous listener that had not finished closing (toggling off then
      //   on fast, or a reload). Drop whatever we have and try ONCE more after
      //   a moment before giving up.
      var code = (e && e.code) ? e.code : ((e && e.message) || String(e));
      self.listening = false;
      self.server = null;
      self._log('bridge listener failed: ' + code);
      if (code === 'EADDRINUSE' && !_retried) {
        try { srv.close(); } catch (x) {}
        setTimeout(function () {
          self.start(true).then(settle);
        }, 600);
        return;
      }
      self.lastError = code;
      settle({ ok: false, error: code });
    });
    try {
      if (self.host) srv.listen(self.port, self.host, ready);
      else srv.listen(self.port, ready);
    } catch (e) {
      self.lastError = (e && (e.code || e.message)) || String(e);
      return settle({ ok: false, error: self.lastError });
    }
    function ready() {
      self.server = srv;
      self.listening = true;
      self.lastError = null;
      var a = null;
      try { a = srv.address(); } catch (e) {}
      self.boundHost = (a && a.address) ? a.address : (self.host || '0.0.0.0');
      self._log('bridge listening on ' + self.boundHost + ':' + self.port);
      settle({ ok: true, host: self.boundHost, port: self.port });
    }
  });
};

BridgeServer.prototype.stop = function () {
  this.peers = [];
  this.listening = false;
  if (this.server) { try { this.server.close(); } catch (e) {} this.server = null; }
};

BridgeServer.prototype.status = function () {
  return {
    listening: this.listening,
    mode: this.mode,
    host: this.boundHost,
    port: this.port,
    error: this.lastError,
    peers: this.peers.slice(0),
    relayed: this.stats.relayed,
    refused: this.stats.refused,
    lastRefusal: this.stats.lastRefusal,
    audit: this.stats.audit.slice(0, 5)
  };
};

// ---- one connected tool ----------------------------------------------------
BridgeServer.prototype._onTool = function (c) {
  var self = this;
  var peer = { ip: c.remoteAddress || '?', mac: null };
  this.peers.push(peer);
  var mode = null;                    // 'doip' | 'raw' — decided from the first bytes
  var buf = Buffer.alloc(0);
  this._log('tool connected from ' + peer.ip);

  c.on('data', function (d) {
    buf = Buffer.concat([buf, d]);

    // Decide once, from what the tool actually sent. A DoIP header starts with
    // the protocol version followed by its bitwise inverse (02/FD, or 01/FE on
    // older tools). Anything else is treated as a RAW socket: the convention
    // used by Wi-Fi-to-serial bridge modules, where the bytes you write are the
    // request and nothing frames them. Supporting both means one port serves
    // either kind of tool and nobody has to guess a setting.
    if (mode === null) {
      if (buf.length < 2) return;
      var v = buf[0], iv = buf[1];
      mode = ((v === 0x02 && iv === 0xFD) || (v === 0x01 && iv === 0xFE)) ? 'doip' : 'raw';
      self.mode = mode;
      self._log('tool speaks ' + mode.toUpperCase());
    }

    if (mode === 'doip') {
      while (buf.length >= 8) {
        var type = buf.readUInt16BE(2), len = buf.readUInt32BE(4);
        if (len > MAX_FRAME) { try { c.destroy(); } catch (e) {} return; }
        if (buf.length < 8 + len) break;
        var payload = buf.slice(8, 8 + len);
        buf = buf.slice(8 + len);
        self._onFrame(c, peer, type, payload);
      }
      return;
    }

    // RAW: treat what arrived as one complete UDS request, the way a serial
    // bridge does. There is no addressing in a raw stream, so it goes to the
    // configured default ECU (the engine controller) and the answer is written
    // back unframed.
    var req = Array.prototype.slice.call(buf);
    buf = Buffer.alloc(0);
    if (!req.length) return;
    self._relayRaw(c, peer, req);
  });

  function gone() {
    for (var i = 0; i < self.peers.length; i++) if (self.peers[i] === peer) { self.peers.splice(i, 1); break; }
  }
  c.on('error', gone);
  c.on('close', gone);
};

// One raw (unframed) UDS request. Judged by exactly the same engine as DoIP:
// a raw socket is a different envelope, never a way around the policy.
BridgeServer.prototype._relayRaw = function (c, peer, req) {
  var self = this;
  relayengine.handle({ target: this.rawEcu, uds: req, peer: peer }, {
    gate: this.gate, ecuAllow: this.ecuAllow, sendTo: this.sendTo, stats: this.stats
  }).then(function (r) {
    if (!r.bytes || !r.bytes.length) return;
    try { c.write(Buffer.from(r.bytes)); } catch (e) {}
  }).catch(function (e) { self._log('raw relay error: ' + ((e && e.message) || e)); });
};

function frame(type, payload) {
  var head = Buffer.alloc(8);
  head[0] = DOIP_V; head[1] = (~DOIP_V) & 0xff;
  head.writeUInt16BE(type, 2);
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

BridgeServer.prototype._onFrame = function (c, peer, type, payload) {
  var self = this;
  if (type === 0x0005) {                               // routing activation
    var src = payload.length >= 2 ? payload.readUInt16BE(0) : 0x0e00;
    var armed = !!(this.gate && this.gate.status && this.gate.status().armed);
    var res = Buffer.alloc(9);
    res.writeUInt16BE(src, 0);
    res.writeUInt16BE(this.logicalAddress, 2);
    // Refuse routing outright unless the user armed the bridge on the car's
    // screen: a tool should be told "no" up front, not per request.
    res[4] = armed ? 0x10 : 0x06;
    try { c.write(frame(0x0006, res)); } catch (e) {}
    return;
  }
  if (type === 0x0007) { try { c.write(frame(0x0008, Buffer.alloc(0))); } catch (e) {} return; }
  if (type !== 0x8001) { try { c.write(frame(0x0000, Buffer.from([0x02]))); } catch (e) {} return; }

  if (payload.length < 5) return;
  var sa = payload.readUInt16BE(0), ta = payload.readUInt16BE(2);
  var uds = Array.prototype.slice.call(payload.slice(4));

  var ack = Buffer.alloc(5);
  ack.writeUInt16BE(ta, 0); ack.writeUInt16BE(sa, 2); ack[4] = 0x00;
  try { c.write(frame(0x8002, ack)); } catch (e) {}

  relayengine.handle({ target: ta & 0xff, uds: uds, peer: peer }, {
    gate: this.gate, ecuAllow: this.ecuAllow, sendTo: this.sendTo, stats: this.stats
  }).then(function (r) {
    if (!r.bytes || !r.bytes.length) return;
    var body = Buffer.concat([
      Buffer.from([(ta >> 8) & 0xff, ta & 0xff, (sa >> 8) & 0xff, sa & 0xff]),
      Buffer.from(r.bytes)
    ]);
    try { c.write(frame(0x8001, body)); } catch (e) {}
  }).catch(function (e) { self._log('relay error: ' + ((e && e.message) || e)); });
};

// selfTest() -> Promise<{ ok, detail }>
//
// Dials our OWN listener over the loopback address and performs a DoIP routing
// activation. It proves the listener is up, reachable and framing correctly
// WITHOUT any phone or tool, which separates the two failures people actually
// hit: "the app is not serving" vs "the network cannot reach the app". The
// second is far more common and needs a completely different fix.
BridgeServer.prototype.selfTest = function () {
  var self = this;
  if (!this.listening) return Promise.resolve({ ok: false, detail: 'the listener is not running' });
  var net = this._net();
  if (!net || !net.connect) return Promise.resolve({ ok: false, detail: 'no socket support' });
  return new Promise(function (resolve) {
    var done = false, got = Buffer.alloc(0), c;
    function finish(r) {
      if (done) return; done = true;
      try { c && c.destroy(); } catch (e) {}
      resolve(r);
    }
    var timer = setTimeout(function () { finish({ ok: false, detail: 'no answer from our own listener' }); }, 1500);
    try { c = net.connect(self.port, '127.0.0.1'); } catch (e) {
      clearTimeout(timer);
      return finish({ ok: false, detail: (e && (e.code || e.message)) || String(e) });
    }
    c.on('connect', function () {
      try { c.write(frame(0x0005, Buffer.from([0x0e, 0x00, 0, 0, 0, 0, 0]))); } catch (e) {}
    });
    c.on('data', function (d) {
      got = Buffer.concat([got, d]);
      while (got.length >= 8) {
        var type = got.readUInt16BE(2), len = got.readUInt32BE(4);
        if (got.length < 8 + len) break;
        var payload = got.slice(8, 8 + len);
        got = got.slice(8 + len);
        if (type === 0x0006) {
          clearTimeout(timer);
          var code = payload[4];
          // 0x10 = accepted (the bridge is armed), 0x06 = refused because it is
          // not armed. BOTH prove the listener and the framing work.
          return finish({
            ok: true,
            armed: code === 0x10,
            detail: code === 0x10 ? 'listener answered and accepted routing'
              : 'listener answered (routing refused until the bridge is armed)'
          });
        }
      }
    });
    c.on('error', function (e) {
      clearTimeout(timer);
      finish({ ok: false, detail: (e && (e.code || e.message)) || String(e) });
    });
  });
};

BridgeServer.DEFAULT_PORT = DEFAULT_PORT;
BridgeServer.frame = frame;
module.exports = BridgeServer;
