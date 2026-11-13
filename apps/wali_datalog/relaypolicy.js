'use strict';
//
// relaypolicy.js — the policy the APP enforces on every UDS frame RELAYED from an
// external tool (e.g. xHP) through the optional wireless bridge.
//
// Trust model: the bridge daemon that owns the Wi-Fi listener is treated as
// UNTRUSTED toward the car (it faces the phone and could be compromised). The app
// is the single policy authority: it re-validates every relayed frame here, and
// NEVER takes an allow-list, a mode, or a "flashing" flag from any daemon message.
//
// This is STRICTER than vehiclelink's own allow-list, which exists for the app's
// own local features. Relayed traffic additionally:
//   - may address ONLY an explicit ECU allow-list (default DME 0x12, EGS 0x18),
//   - may NEVER use functional/broadcast addressing (0xDF) from the phone,
//   - splits reads, DTC-clear and writes into three separately-armed tiers,
//   - is refused unless the bridge is armed (and writes unless write-armed).
// Pure and synchronous so it is fully unit-testable off-car.
//
var FUNCTIONAL = 0xDF;

// UDS negative-response codes we hand back to the tool (as 7F <sid> <nrc>).
var NRC = {
  serviceNotSupported: 0x11,
  subFunctionNotSupported: 0x12,
  requestOutOfRange: 0x31,
  securityAccessDenied: 0x33,
  serviceNotSupportedInActiveSession: 0x7F
};

// Services allowed while the bridge is armed for READ/diagnostics only. These
// cannot, by themselves, change a calibration. 0x27 (SecurityAccess) is a
// challenge/response handshake and is allowed because protected regions need it
// to be READ; it grants nothing without a following write, which stays tiered.
var READ_SERVICES = {
  0x10: 'diagnosticSessionControl',   // sessions restricted below
  0x11: 'ecuReset',                   // allowed? no — reset is disruptive; gated to write tier
  0x19: 'readDTCInformation',
  0x22: 'readDataByIdentifier',
  0x23: 'readMemoryByAddress',
  0x27: 'securityAccess',
  0x3E: 'testerPresent'
};
delete READ_SERVICES[0x11]; // keep ecuReset out of the read tier (it is disruptive)

// clearDTC is a WRITE (it erases fault memory). It gets its own arm so a plain
// read session can never wipe codes.
var CLEARDTC_SERVICE = 0x14;

// Services added only while WRITE/flash is separately armed for one ECU.
var WRITE_SERVICES = {
  0x2E: 'writeDataByIdentifier',
  0x31: 'routineControl',
  0x34: 'requestDownload',
  0x36: 'transferData',
  0x37: 'requestTransferExit',
  0x11: 'ecuReset'
};

// Diagnostic sessions a plain read tier may enter: default (01) and extended (03).
// The programming session (02) is a write-tier precondition.
var READ_SESSIONS = { 0x01: true, 0x03: true };

function nack(sid, nrc) { return { allow: false, nack: [0x7F, sid & 0xff, nrc], reason: null }; }

/**
 * evaluate(frame, ctx) -> { allow, nack, reason }
 *   frame = { target: <ecu addr>, uds: [sid, ...] }
 *   ctx   = { armed, writeArmed, writeEcu, ecuAllow:[..], allowClearDtc }
 * `allow:true` means relay it; otherwise `nack` is the UDS negative to return to
 * the tool and `reason` explains the refusal for the on-HU audit line.
 */
function evaluate(frame, ctx) {
  ctx = ctx || {};
  if (!frame || !frame.uds || !frame.uds.length) return { allow: false, nack: null, reason: 'empty frame' };
  var sid = frame.uds[0] & 0xff, target = frame.target & 0xff;

  if (!ctx.armed) return { allow: false, nack: nack(sid, NRC.requestOutOfRange).nack, reason: 'bridge not armed' };

  // Never relay a functional/broadcast request from the phone: one tool must not
  // address every module at once through the bridge.
  if (target === FUNCTIONAL) { var r = nack(sid, NRC.requestOutOfRange); r.reason = 'functional addressing refused'; return r; }

  // Only the explicitly allow-listed ECUs.
  var allow = (ctx.ecuAllow && ctx.ecuAllow.length) ? ctx.ecuAllow : [0x12, 0x18];
  if (allow.indexOf(target) < 0) { var r2 = nack(sid, NRC.requestOutOfRange); r2.reason = 'ECU 0x' + target.toString(16) + ' not in relay allow-list'; return r2; }

  // clearDTC: its own arm.
  if (sid === CLEARDTC_SERVICE) {
    if (!ctx.allowClearDtc) { var r3 = nack(sid, NRC.securityAccessDenied); r3.reason = 'clearDTC not armed'; return r3; }
    return { allow: true, nack: null, reason: null };
  }

  // Write/flash services: only while write-armed, and only for the one armed ECU.
  if (WRITE_SERVICES[sid]) {
    if (!ctx.writeArmed) { var r4 = nack(sid, NRC.securityAccessDenied); r4.reason = 'write/flash not armed'; return r4; }
    if (ctx.writeEcu !== undefined && target !== ctx.writeEcu) { var r5 = nack(sid, NRC.requestOutOfRange); r5.reason = 'write armed for a different ECU'; return r5; }
    return { allow: true, nack: null, reason: null };
  }

  // Programming session (0x10 0x02) is a write-tier precondition.
  if (sid === 0x10) {
    var sub = frame.uds[1] & 0xff;
    if (READ_SESSIONS[sub]) return { allow: true, nack: null, reason: null };
    // any other session (incl. 0x02 programming) needs the write arm
    if (ctx.writeArmed && (ctx.writeEcu === undefined || target === ctx.writeEcu)) return { allow: true, nack: null, reason: null };
    var r6 = nack(sid, NRC.subFunctionNotSupported); r6.reason = 'session 0x' + sub.toString(16) + ' needs write arm'; return r6;
  }

  if (READ_SERVICES[sid]) return { allow: true, nack: null, reason: null };

  // Everything else (incl. 0x2F IO-control, 0x85 control DTC setting, unknown SIDs).
  var r7 = nack(sid, NRC.serviceNotSupported); r7.reason = 'service 0x' + sid.toString(16) + ' not relayable'; return r7;
}

module.exports = {
  evaluate: evaluate,
  NRC: NRC,
  READ_SERVICES: READ_SERVICES,
  WRITE_SERVICES: WRITE_SERVICES,
  CLEARDTC_SERVICE: CLEARDTC_SERVICE,
  DEFAULT_ECU_ALLOW: [0x12, 0x18],
  FUNCTIONAL: FUNCTIONAL
};
