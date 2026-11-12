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

module.exports = { EcuSim: EcuSim, plusOne: plusOne };
