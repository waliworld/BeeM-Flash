'use strict';
//
// doip.js — ISO 13400 (DoIP) client: the app's own diagnostic connection to the
// vehicle over its diagnostic Ethernet (ENET), the open-source equivalent of an
// ENET adapter's link.
//
// SCOPE: a standards diagnostic transport. It reaches an ECU (UDP vehicle
// discovery + routing activation + diagnostic request/response) and carries any
// UDS request the caller builds — reads, sessions, and SecurityAccess (the
// seed/key handshake itself lives in seedkey.js, and no manufacturer key is
// bundled). It is a CLIENT that connects OUT to the car on a connection the user
// has enabled (enetgate.js); it is NOT a network bridge — it opens no external
// listener and forwards no third-party traffic. ISO 13400 framing is a published
// standard; this is an original implementation.
//
// The socket is injected ({ onData(fn), write(bytes), close() }) so the DoIP
// framing is testable off-car (see test/ecusim.js) and the device binding (a TCP
// socket to the vehicle's DoIP gateway) stays isolated. Logical addresses are
// vehicle-specific and configured, not hard-coded to act on a car by default.
//
var PROTO = 0x02, INV = 0xFD;
var PT = {
  VEHICLE_ID_REQ: 0x0001, VEHICLE_ANNOUNCE: 0x0004, // UDP vehicle discovery
  ROUTE_REQ: 0x0005, ROUTE_RESP: 0x0006, ALIVE_REQ: 0x0007, ALIVE_RESP: 0x0008,
  DIAG: 0x8001, DIAG_ACK: 0x8002, DIAG_NACK: 0x8003
};

function u16(v) { return [(v >> 8) & 0xff, v & 0xff]; }
function u32(v) { return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]; }

function header(pt, payload) {
  return [PROTO, INV].concat(u16(pt)).concat(u32(payload.length)).concat(payload);
}
function buildRoutingActivation(src, actType) {
  return header(PT.ROUTE_REQ, u16(src).concat([actType & 0xff, 0, 0, 0, 0]));
}
function buildDiagnosticMessage(src, tgt, uds) {
  return header(PT.DIAG, u16(src).concat(u16(tgt)).concat(uds));
}

// Parse as many whole frames as `bytes` contains; return {frames, consumed}.
function parseFrames(bytes) {
  var frames = [], i = 0;
  while (i + 8 <= bytes.length) {
    if (bytes[i] !== PROTO) { i++; continue; } // basic resync
    var pt = (bytes[i + 2] << 8) | bytes[i + 3];
    var len = (bytes[i + 4] * 0x1000000) + (bytes[i + 5] << 16) + (bytes[i + 6] << 8) + bytes[i + 7];
    if (i + 8 + len > bytes.length) break; // incomplete
    frames.push({ type: pt, payload: bytes.slice(i + 8, i + 8 + len) });
    i += 8 + len;
  }
  return { frames: frames, consumed: i };
}

function DoipClient(socket, opts) {
  opts = opts || {};
  this.socket = socket;
  this.src = opts.sourceAddr || 0x0E00;      // tester logical address
  this.tgt = opts.targetAddr || 0;           // ECU logical address (configure)
  this.actType = opts.activationType || 0x00;
  this.buf = [];
  this.activated = false;
  this._actCb = null;
  this.pending = null;
  var self = this;
  if (socket && socket.onData) socket.onData(function (bytes) { self._onData(bytes); });
}

DoipClient.prototype._onData = function (bytes) {
  this.buf = this.buf.concat(Array.prototype.slice.call(bytes));
  var r = parseFrames(this.buf);
  this.buf = this.buf.slice(r.consumed);
  for (var i = 0; i < r.frames.length; i++) this._handle(r.frames[i]);
};

DoipClient.prototype._handle = function (f) {
  if (f.type === PT.ROUTE_RESP) {
    var code = f.payload[4]; // testerAddr(2), entityAddr(2), code(1)
    var cb = this._actCb; this._actCb = null;
    if (cb) cb(code === 0x10 ? null : new Error('routing activation failed (0x' + (code || 0).toString(16) + ')'));
  } else if (f.type === PT.DIAG) {
    var uds = f.payload.slice(4); // src(2), tgt(2), uds...
    var p = this.pending; this.pending = null;
    if (p) p(null, uds);
  } else if (f.type === PT.DIAG_NACK) {
    var p2 = this.pending; this.pending = null;
    if (p2) p2(new Error('diagnostic NACK (0x' + ((f.payload[4] || 0).toString(16)) + ')'));
  } // DIAG_ACK (0x8002) is a positive ack; the UDS reply arrives as a DIAG frame
};

DoipClient.prototype.activate = function (cb) {
  this._actCb = cb;
  this.socket.write(buildRoutingActivation(this.src, this.actType));
};

// send(uds, cb) -> cb(err, udsResponseBytes). Matches the DiagProvider transport.
DoipClient.prototype.send = function (uds, cb) {
  var self = this;
  function doSend() {
    self.pending = function (err, resp) { cb(err, resp); };
    self.socket.write(buildDiagnosticMessage(self.src, self.tgt, uds));
  }
  if (!this.activated) {
    this.activate(function (err) { if (err) { cb(err); return; } self.activated = true; doSend(); });
  } else doSend();
};

// ---- UDP vehicle discovery (ISO 13400 Vehicle Identification) -------------
//
// Real ENET adapters find the car by broadcasting a Vehicle Identification
// Request on UDP 13400 and reading back the gateway's Vehicle Announcement
// (VIN + logical address + its IP, from the response datagram's source
// address) — no manual IP entry. This is read-only discovery: it sends no
// diagnostic request and activates no routing.

function buildVehicleIdentificationRequest() {
  return header(PT.VEHICLE_ID_REQ, []);
}

// Decode a Vehicle Announcement payload (the bytes after the 8-byte header):
// VIN(17) + LogicalAddress(2) + EID(6) + GID(6) + FurtherActionRequired(1).
function parseVehicleAnnouncement(payload) {
  if (!payload || payload.length < 32) return null;
  var vin = '';
  for (var i = 0; i < 17; i++) {
    var c = payload[i];
    if (c >= 0x20 && c < 0x7f) vin += String.fromCharCode(c);
  }
  return {
    vin: vin.trim(),
    logicalAddress: (payload[17] << 8) | payload[18],
    eid: payload.slice(19, 25),
    gid: payload.slice(25, 31),
    furtherActionRequired: payload[31]
  };
}

// Decode a full UDP datagram (header + payload) into a Vehicle Announcement,
// or null if it isn't one.
function decodeAnnouncementDatagram(bytes) {
  var r = parseFrames(bytes);
  for (var i = 0; i < r.frames.length; i++) {
    if (r.frames[i].type === PT.VEHICLE_ANNOUNCE) return parseVehicleAnnouncement(r.frames[i].payload);
  }
  return null;
}

// Broadcast a Vehicle Identification Request over `socket` and collect
// Vehicle Announcements for `opts.timeoutMs` (default 2000ms). Resolves an
// array of { vin, logicalAddress, host }, one per responding gateway. Never
// called while the connection is disabled — see enetgate.js.
function discoverVehicles(socket, opts) {
  opts = opts || {};
  var timeoutMs = opts.timeoutMs == null ? 2000 : opts.timeoutMs;
  var setT = opts.setTimeout || (typeof setTimeout === 'function' ? setTimeout : null);
  return new Promise(function (resolve) {
    var found = [], seen = {}, done = false;
    function finish() {
      if (done) return;
      done = true;
      try { socket.close(); } catch (e) {}
      resolve(found);
    }
    socket.onMessage(function (bytes, rinfo) {
      var v = decodeAnnouncementDatagram(bytes);
      if (!v) return;
      var host = (rinfo && rinfo.address) || opts.assumeHost || null;
      var key = host + '/' + v.logicalAddress;
      if (seen[key]) return;
      seen[key] = true;
      v.host = host;
      found.push(v);
      if (opts.stopOnFirst) finish();
    });
    try {
      socket.send(buildVehicleIdentificationRequest(), opts.broadcastHost || '255.255.255.255', opts.port || 13400);
    } catch (e) { finish(); return; }
    if (setT) setT(finish, timeoutMs); else finish();
  });
}

// Node UDP (dgram) socket adapter for discovery (used on the head unit).
function nodeUdpSocket() {
  var dgram; try { dgram = require('dgram'); } catch (e) { return null; }
  var sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  var msgCb = null;
  sock.on('message', function (msg, rinfo) { if (msgCb) msgCb(Array.prototype.slice.call(msg), rinfo); });
  sock.on('error', function () {});
  try { sock.bind(function () { try { sock.setBroadcast(true); } catch (e) {} }); } catch (e) {}
  return {
    onMessage: function (fn) { msgCb = fn; },
    send: function (bytes, host, port) { try { sock.send(Buffer.from(bytes), port || 13400, host || '255.255.255.255'); } catch (e) {} },
    close: function () { try { sock.close(); } catch (e) {} }
  };
}

// Node TCP socket adapter (used on the head unit). Device binding is isolated here.
function nodeSocket(host, port) {
  var net; try { net = require('net'); } catch (e) { return null; }
  var sock = new net.Socket(), dataCb = null, connected = false, queue = [];
  sock.on('data', function (d) { if (dataCb) dataCb(d); });
  sock.on('error', function () {});
  sock.connect(port || 13400, host, function () {
    connected = true;
    queue.forEach(function (b) { sock.write(Buffer.from(b)); }); queue = [];
  });
  return {
    onData: function (fn) { dataCb = fn; },
    write: function (bytes) { if (connected) sock.write(Buffer.from(bytes)); else queue.push(bytes); },
    close: function () { try { sock.destroy(); } catch (e) {} }
  };
}

// Transport factory matching DiagProvider's { supported, send(bytes, cb) }.
function makeDoipTransport(opts) {
  opts = opts || {};
  var socket = opts.socket || (opts.host ? nodeSocket(opts.host, opts.port) : null);
  if (!socket) return { supported: false, send: function (_b, cb) { cb && cb(new Error('no DoIP socket')); } };
  var client = new DoipClient(socket, opts);
  return { supported: true, send: function (bytes, cb) { client.send(bytes, cb); }, client: client };
}

// A promise-shaped send(bytes) -> Promise<resp> from a callback transport
// ({ send(bytes, cb) }); seedkey.js and any UDS flow consume this shape.
function promiseSend(transport) {
  return function (bytes) {
    return new Promise(function (resolve, reject) {
      transport.send(bytes, function (err, resp) { if (err) reject(err); else resolve(resp); });
    });
  };
}

// DoipGateway — the open diagnostic connection to the vehicle over ENET/DoIP.
// Composes the DoIP transport with routing activation, an optional TesterPresent
// keep-alive, a promise-based send(), and convenience session()/unlock() that run
// the standard UDS session + SecurityAccess handshake with a CALLER-SUPPLIED key
// algorithm (seedkey.js; no manufacturer key is bundled). For a vehicle you own,
// on a connection the user has enabled (enetgate.js).
function DoipGateway(opts) {
  opts = opts || {};
  this._opts = opts;
  this.transport = makeDoipTransport(opts);
  this.supported = this.transport.supported;
  this.send = promiseSend(this.transport);   // send(udsBytes) -> Promise<respBytes>
  this.client = this.transport.client || null;
  this._keep = null;
}
DoipGateway.prototype.activate = function () {
  var self = this;
  return new Promise(function (resolve, reject) {
    if (!self.client) { reject(new Error('no DoIP transport')); return; }
    self.client.activate(function (err) { if (err) { reject(err); return; } self.client.activated = true; resolve(true); });
  });
};
DoipGateway.prototype.session = function (type, opts) { return require('./seedkey').session(this.send, type, opts); };
DoipGateway.prototype.unlock = function (level, algo, opts) { return require('./seedkey').unlock(this.send, level, algo, opts); };
DoipGateway.prototype.keepAlive = function (ms, setIntervalFn) {
  var self = this, si = setIntervalFn || (typeof setInterval === 'function' ? setInterval : null);
  if (!si) return;
  this.stopKeepAlive();
  var u = require('./uds');
  this._keep = si(function () { self.send(u.buildTesterPresent()).catch(function () {}); }, ms || 2000);
};
DoipGateway.prototype.stopKeepAlive = function () {
  if (this._keep != null && typeof clearInterval === 'function') clearInterval(this._keep);
  this._keep = null;
};
DoipGateway.prototype.close = function () {
  this.stopKeepAlive();
  try { if (this.client && this.client.socket && this.client.socket.close) this.client.socket.close(); } catch (e) {}
  try { if (this._opts.socket && this._opts.socket.close) this._opts.socket.close(); } catch (e) {}
};

module.exports = {
  PT: PT, buildRoutingActivation: buildRoutingActivation, buildDiagnosticMessage: buildDiagnosticMessage,
  parseFrames: parseFrames, header: header, DoipClient: DoipClient, nodeSocket: nodeSocket, makeDoipTransport: makeDoipTransport,
  promiseSend: promiseSend, DoipGateway: DoipGateway,
  buildVehicleIdentificationRequest: buildVehicleIdentificationRequest,
  parseVehicleAnnouncement: parseVehicleAnnouncement,
  decodeAnnouncementDatagram: decodeAnnouncementDatagram,
  discoverVehicles: discoverVehicles,
  nodeUdpSocket: nodeUdpSocket
};
