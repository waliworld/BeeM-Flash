'use strict';
//
// doip.js — minimal ISO 13400 (DoIP) client, for the app's own live-data reads
// over the vehicle's diagnostic Ethernet. Independent of MHD.
//
// SCOPE: read-only transport. It gives our datalogger a standards-based way to
// reach the DME (routing activation + diagnostic request/response) so it can
// issue the read requests it already generates (UDS 0x22 / 0x2C monitor / 0x19).
// It is NOT a gateway/bridge: it opens no external listener, forwards no
// third-party traffic, and contains no flashing, calibration-write, or
// security-access (seed/key) code. ISO 13400 framing is a published standard;
// this is an original implementation.
//
// The socket is injected ({ onData(fn), write(bytes), close() }) so the DoIP
// framing is testable off-car and the device binding (a TCP socket to the
// vehicle's DoIP gateway) stays isolated. Logical addresses are vehicle-specific
// and configured, not hard-coded to anything that would act on a car by default.
//
var PROTO = 0x02, INV = 0xFD;
var PT = {
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

module.exports = {
  PT: PT, buildRoutingActivation: buildRoutingActivation, buildDiagnosticMessage: buildDiagnosticMessage,
  parseFrames: parseFrames, header: header, DoipClient: DoipClient, nodeSocket: nodeSocket, makeDoipTransport: makeDoipTransport
};
