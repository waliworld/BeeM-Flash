'use strict';
//
// discovery.js — answer a tool's "where is the car?" broadcast AS the gateway.
//
// Tools built for an ENET adapter do not ask for an address: they BROADCAST a
// vehicle-identification request and connect to whatever answers.
//
//   DoIP (ISO 13400, G-series):  UDP 13400, payload type 0x0001/0x0002/0x0003
//                                -> we reply 0x0004 "vehicle announcement"
//   HSFZ (BMW, F-series/ENET):   UDP 6811, control word 0x0011
//                                -> we reply 0x0012 with VIN text
//
// Until now the bridge served the TCP side but never answered this broadcast,
// so a tool like MHD never "found" a car and never connected. A hardware ENET
// adapter solves this by sitting on the car's diagnostic Ethernet, where the
// real gateway answers; the head unit is NOT on that wire (and the gateway's
// diagnostic port stays dormant without the OBD activation line), so the head
// unit answers in the gateway's place. The reply's SOURCE address is the
// address the tool will dial - which is the head unit on whatever network the
// phone shares with it.
//
// This only announces. It changes nothing on the car.
//
var DOIP_PORT = 13400, HSFZ_PORT = 6811;

function Discovery(opts) {
  opts = opts || {};
  this.dgramMod = opts.dgramMod || null;
  this.vin = String(opts.vin || 'BEEMFLASHBRIDGE00').slice(0, 17);
  while (this.vin.length < 17) this.vin += '0';
  this.logicalAddress = opts.logicalAddress || 0x1000;
  this.logFn = opts.log || null;
  this.doipPort = opts.doipPort || DOIP_PORT;
  this.hsfzPort = opts.hsfzPort || HSFZ_PORT;
  this.socks = [];
  this.listening = { doip: false, hsfz: false };
  this.errors = {};
  this.answered = 0;
  this.lastFrom = null;
}

Discovery.prototype._log = function (m) { if (this.logFn) { try { this.logFn(m); } catch (e) {} } };
Discovery.prototype._dgram = function () {
  if (this.dgramMod) return this.dgramMod;
  try { this.dgramMod = require('dgram'); } catch (e) { this.dgramMod = null; }
  return this.dgramMod;
};
Discovery.prototype.setVin = function (v) {
  if (!v) return;
  this.vin = String(v).slice(0, 17);
  while (this.vin.length < 17) this.vin += '0';
};

// ---- DoIP vehicle announcement (payload type 0x0004) -----------------------
// VIN(17) + logical address(2) + EID(6) + GID(6) + further action(1) = 32 bytes
Discovery.prototype.doipAnnouncement = function () {
  var vin = Buffer.from(this.vin, 'ascii');
  var la = Buffer.from([(this.logicalAddress >> 8) & 0xff, this.logicalAddress & 0xff]);
  var eid = Buffer.alloc(6), gid = Buffer.alloc(6);
  var payload = Buffer.concat([vin, la, eid, gid, Buffer.from([0x00])]);
  var head = Buffer.alloc(8);
  head[0] = 0x02; head[1] = 0xFD;
  head.writeUInt16BE(0x0004, 2);
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
};

// ---- HSFZ identification response (control 0x0012) -------------------------
// Payload mirrors what BMW gateways send: an ASCII key/value run the tools scan
// for "DIAGADR" and "VIN". The tool takes OUR IP from the packet source.
Discovery.prototype.hsfzIdentification = function () {
  var text = 'DIAGADR10' + 'BMWVIN' + this.vin;
  var payload = Buffer.from(text, 'ascii');
  var head = Buffer.alloc(6);
  head.writeUInt32BE(payload.length, 0);
  head.writeUInt16BE(0x0012, 4);
  return Buffer.concat([head, payload]);
};

function isDoipIdent(msg) {
  if (msg.length < 8) return false;
  if (!((msg[0] === 0x02 && msg[1] === 0xFD) || (msg[0] === 0x01 && msg[1] === 0xFE))) return false;
  var type = msg.readUInt16BE(2);
  return type === 0x0001 || type === 0x0002 || type === 0x0003;
}
function isHsfzIdent(msg) {
  if (msg.length < 6) return false;
  return msg.readUInt16BE(4) === 0x0011;
}

Discovery.prototype._bind = function (kind, port, onMsg) {
  var self = this, dgram = this._dgram();
  if (!dgram) { this.errors[kind] = 'no UDP support'; return Promise.resolve(false); }
  return new Promise(function (resolve) {
    var s, done = false;
    function settle(ok) { if (!done) { done = true; resolve(ok); } }
    try { s = dgram.createSocket({ type: 'udp4', reuseAddr: true }); }
    catch (e) { self.errors[kind] = (e && (e.code || e.message)) || String(e); return settle(false); }
    s.on('error', function (e) {
      self.errors[kind] = (e && e.code) ? e.code : ((e && e.message) || String(e));
      self.listening[kind] = false;
      self._log('discovery ' + kind + ' failed: ' + self.errors[kind]);
      try { s.close(); } catch (x) {}
      settle(false);
    });
    s.on('message', function (msg, rinfo) {
      try { onMsg(msg, rinfo, s); } catch (e) { self._log('discovery ' + kind + ' handler: ' + ((e && e.message) || e)); }
    });
    try {
      s.bind(port, function () {
        try { s.setBroadcast(true); } catch (e) {}
        self.socks.push(s);
        self.listening[kind] = true;
        delete self.errors[kind];
        self._log('discovery answering ' + kind.toUpperCase() + ' on udp/' + port);
        settle(true);
      });
    } catch (e) {
      self.errors[kind] = (e && (e.code || e.message)) || String(e);
      settle(false);
    }
  });
};

// start() -> Promise<{ doip, hsfz }> : which responders are up
Discovery.prototype.start = function () {
  var self = this;
  var jobs = [
    this._bind('doip', this.doipPort, function (msg, rinfo, s) {
      if (!isDoipIdent(msg)) return;
      self.answered++; self.lastFrom = rinfo.address;
      var out = self.doipAnnouncement();
      s.send(out, 0, out.length, rinfo.port, rinfo.address);
    }),
    this._bind('hsfz', this.hsfzPort, function (msg, rinfo, s) {
      if (!isHsfzIdent(msg)) return;
      self.answered++; self.lastFrom = rinfo.address;
      var out = self.hsfzIdentification();
      s.send(out, 0, out.length, rinfo.port, rinfo.address);
    })
  ];
  return Promise.all(jobs).then(function (r) { return { doip: r[0], hsfz: r[1] }; });
};

Discovery.prototype.stop = function () {
  this.socks.forEach(function (s) { try { s.close(); } catch (e) {} });
  this.socks = [];
  this.listening = { doip: false, hsfz: false };
};

Discovery.prototype.status = function () {
  return {
    doip: this.listening.doip, hsfz: this.listening.hsfz,
    errors: this.errors, answered: this.answered, lastFrom: this.lastFrom, vin: this.vin
  };
};

Discovery.DOIP_PORT = DOIP_PORT;
Discovery.HSFZ_PORT = HSFZ_PORT;
Discovery.isDoipIdent = isDoipIdent;
Discovery.isHsfzIdent = isHsfzIdent;
module.exports = Discovery;
