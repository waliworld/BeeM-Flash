'use strict';
//
// ecusim.js — a fake UDS ECU server for off-car development and tests.
//
// Implements enough of ISO 14229 to exercise the client flows without a car:
// diagnostic sessions (0x10), SecurityAccess seed/key (0x27) with a configurable
// test algorithm, TesterPresent (0x3E), ReadDataByIdentifier (0x22) with some
// identifiers gated behind an unlock, and RoutineControl (0x31). It is the seed
// of the "all-in" harness the community can build on: contributors wire it to a
// fake DoIP/ENET transport and develop against it.
//
// Use it as a transport: `new EcuSim(opts).transport()` returns a function
// `send(bytes) -> Promise<respBytes>` compatible with seedkey.js / diag.js.
//
// The default seed->key test algorithm is a trivial "each byte + 1": it is a
// stand-in for exercising the protocol, NOT a real manufacturer algorithm.
//
var uds = require('../apps/wali_datalog/uds');

function eq(a, b) { if (a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

// The default test key algorithm (also the one a matching client would use).
function plusOne(seed) { return seed.map(function (b) { return (b + 1) & 0xff; }); }

function EcuSim(opts) {
  opts = opts || {};
  this.session = 0x01;
  this.unlocked = false;
  this.seed = opts.seed || [0x11, 0x22, 0x33, 0x44];
  this.algo = opts.algo || plusOne;              // server-side key check
  this.dids = opts.dids || {};                    // { did(number): [bytes] }  (open reads)
  this.securedDids = opts.securedDids || {};      // { did: [bytes] }  (need unlock first)
  this.routines = opts.routines || {};            // { rid: fn(sub,data)->[bytes] | [bytes] }
  this._lastSeed = null;
  this.log = [];                                  // every request seen (for assertions)
  // ---- flashing (write) simulation state ----
  this.maxBlock = opts.maxBlock || 0x0102;        // max TransferData block the "DME" accepts
  this.flashNeedsUnlock = opts.flashNeedsUnlock === true; // gate 0x34 behind SecurityAccess
  this.flashNeedsProg = opts.flashNeedsProg === true;     // gate 0x34 behind programmingSession (0x02)
  this.download = null;                           // active download { addr, size, received[], counter }
  this.flashed = null;                            // the bytes written by the last completed download
  this.resetType = null;                          // last ECU reset subfunction seen
}

EcuSim.prototype.handle = function (req) {
  req = Array.prototype.slice.call(req || []);
  this.log.push(req.slice());
  var sid = req[0];

  if (sid === uds.SID.SESSION) { this.session = req[1]; return [0x50, req[1], 0x00, 0x32, 0x01, 0xF4]; }
  if (sid === uds.SID.TESTER_PRESENT) return [0x7E, 0x00];

  if (sid === uds.SID.SECURITY) {
    var lvl = req[1];
    if ((lvl & 1) === 1) {                         // request seed (odd level)
      if (this.unlocked) return [0x67, lvl, 0x00, 0x00, 0x00, 0x00]; // already open -> zero seed
      this._lastSeed = this.seed.slice();
      return [0x67, lvl].concat(this.seed);
    }
    var key = req.slice(2);                         // send key (even level)
    var expect = this.algo(this._lastSeed || this.seed, lvl - 1);
    if (eq(key, expect)) { this.unlocked = true; return [0x67, lvl]; }
    return [0x7F, 0x27, 0x35];                      // invalidKey
  }

  if (sid === uds.SID.READ_DID) {
    var did = (req[1] << 8) | req[2];
    if (this.securedDids.hasOwnProperty(did)) {
      if (!this.unlocked) return [0x7F, 0x22, 0x33]; // securityAccessDenied
      return [0x62, req[1], req[2]].concat(this.securedDids[did]);
    }
    if (this.dids.hasOwnProperty(did)) return [0x62, req[1], req[2]].concat(this.dids[did]);
    return [0x7F, 0x22, 0x31];                      // requestOutOfRange
  }

  if (sid === uds.SID.ECU_RESET) { this.resetType = req[1]; this.download = null; return [0x51, req[1]]; }

  // RequestDownload (0x34): begin a write. Optionally gated behind unlock / a
  // programming session — the standard preconditions a real DME enforces.
  if (sid === uds.SID.REQUEST_DOWNLOAD) {
    if (this.flashNeedsUnlock && !this.unlocked) return [0x7F, 0x34, 0x33]; // securityAccessDenied
    if (this.flashNeedsProg && this.session !== 0x02) return [0x7F, 0x34, 0x22]; // conditionsNotCorrect
    var alfid = req[2], aB = alfid & 0x0f, sB = (alfid >> 4) & 0x0f, k = 3, addr = 0, size = 0;
    for (var ai = 0; ai < aB; ai++) addr = addr * 256 + (req[k++] & 0xff);
    for (var si = 0; si < sB; si++) size = size * 256 + (req[k++] & 0xff);
    this.download = { addr: addr, size: size, received: [], counter: 0 };
    var mb = this.maxBlock;
    return [0x74, 0x20, (mb >> 8) & 0xff, mb & 0xff]; // lengthFormatId 0x20 = 2-byte maxBlockLength
  }

  // TransferData (0x36): one block; append it and echo the sequence counter.
  if (sid === uds.SID.TRANSFER_DATA) {
    if (!this.download) return [0x7F, 0x36, 0x24]; // requestSequenceError
    this.download.counter = req[1];
    this.download.received = this.download.received.concat(req.slice(2));
    return [0x76, req[1]];
  }

  // RequestTransferExit (0x37): finalize; expose the written bytes for assertions.
  if (sid === uds.SID.TRANSFER_EXIT) {
    if (!this.download) return [0x7F, 0x37, 0x24];
    this.flashed = this.download.received.slice();
    this.download = null;
    return [0x77];
  }

  if (sid === uds.SID.ROUTINE) {
    var sub = req[1], rid = (req[2] << 8) | req[3], data = req.slice(4);
    var r = this.routines[rid];
    if (r === undefined) return [0x7F, 0x31, 0x31]; // requestOutOfRange
    var body = (typeof r === 'function') ? r(sub, data) : r;
    return [0x71, sub, req[2], req[3]].concat(body || []);
  }

  return [0x7F, sid, 0x11];                          // serviceNotSupported
};

// A send(bytes) -> Promise<respBytes> transport (async, like a real link).
EcuSim.prototype.transport = function () {
  var self = this;
  return function (bytes) { return Promise.resolve(self.handle(bytes)); };
};

// A fake DoIP socket ({ onData, write, close }) that speaks ISO 13400 framing to
// a DoipClient / DoipGateway: it answers routing activation and wraps each UDS
// reply in a diagnostic message, exactly as a car's DoIP gateway would. Lets the
// whole ENET/DoIP path (discover -> activate -> unlock -> read) run off-car.
EcuSim.prototype.doipSocket = function (opts) {
  var self = this, dataCb = null;
  opts = opts || {};
  var tester = opts.sourceAddr || 0x0E00, ecu = opts.targetAddr || 0x1000;
  var doip = require('../apps/wali_datalog/doip');
  function deliver(bytes) { if (dataCb) dataCb(bytes); }
  return {
    onData: function (fn) { dataCb = fn; },
    write: function (bytes) {
      var r = doip.parseFrames(Array.prototype.slice.call(bytes));
      r.frames.forEach(function (f) {
        if (f.type === doip.PT.ROUTE_REQ) {
          deliver(doip.header(doip.PT.ROUTE_RESP,
            [(tester >> 8) & 0xff, tester & 0xff, (ecu >> 8) & 0xff, ecu & 0xff, 0x10, 0, 0, 0, 0]));
        } else if (f.type === doip.PT.DIAG) {
          var reqUds = f.payload.slice(4);           // src(2), tgt(2), uds...
          var respUds = self.handle(reqUds);
          var addr = [(ecu >> 8) & 0xff, ecu & 0xff, (tester >> 8) & 0xff, tester & 0xff];
          deliver(doip.header(doip.PT.DIAG_ACK, addr.concat([0x00])));  // positive ack
          deliver(doip.header(doip.PT.DIAG, addr.concat(respUds)));      // the UDS reply
        }
      });
    },
    close: function () {}
  };
};

module.exports = { EcuSim: EcuSim, plusOne: plusOne };
