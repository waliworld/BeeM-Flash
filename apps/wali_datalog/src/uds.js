'use strict';
//
// uds.js — ISO 14229 (UDS) request builders and response parser.
//
// Pure byte-array functions, no I/O. The transport (how bytes reach the DME —
// DoIP/SOME/IP diagnostic channel on the MGU) is injected elsewhere (diag.js).
// Bytes are plain arrays of 0..255 so this runs anywhere and is easy to test.
//

var SID = {
  SESSION: 0x10,
  SECURITY: 0x27,
  TESTER_PRESENT: 0x3E,
  READ_DID: 0x22,
  READ_MEM: 0x23, // ReadMemoryByAddress (read-only; used for A2L address measurements)
  DDDI: 0x2C, // DynamicallyDefineDataIdentifier (MHD live monitor uses 2C 88 01)
  ROUTINE: 0x31
};

var ROUTINE_SUB = { START: 0x01, STOP: 0x02, RESULT: 0x03 };

var NRC = {
  0x10: 'generalReject',
  0x11: 'serviceNotSupported',
  0x12: 'subFunctionNotSupported',
  0x13: 'incorrectMessageLengthOrInvalidFormat',
  0x22: 'conditionsNotCorrect',
  0x24: 'requestSequenceError',
  0x31: 'requestOutOfRange',
  0x33: 'securityAccessDenied',
  0x35: 'invalidKey',
  0x36: 'exceedNumberOfAttempts',
  0x37: 'requiredTimeDelayNotExpired',
  0x78: 'responsePending',
  0x7E: 'subFunctionNotSupportedInActiveSession',
  0x7F: 'serviceNotSupportedInActiveSession'
};

function u8(n) { return n & 0xff; }
function hi(n) { return (n >> 8) & 0xff; }
function lo(n) { return n & 0xff; }

function toHex(bytes) {
  var s = [];
  for (var i = 0; i < bytes.length; i++) {
    var h = (bytes[i] & 0xff).toString(16);
    s.push(h.length === 1 ? '0' + h : h);
  }
  return s.join(' ');
}

function fromHex(str) {
  var parts = String(str).trim().split(/[\s,]+/).filter(Boolean);
  return parts.map(function (p) { return parseInt(p, 16) & 0xff; });
}

// ---- request builders -----------------------------------------------------

function buildReadDataByIdentifier(did) {
  return [SID.READ_DID, hi(did), lo(did)];
}

// ReadMemoryByAddress (0x23) — read `size` bytes at `addr`. addrBytes/sizeBytes
// set the addressAndLengthFormatIdentifier (default 4-byte addr, 2-byte size).
// Read-only. The DME may gate this behind a diagnostic session / security.
function buildReadMemoryByAddress(addr, size, addrBytes, sizeBytes) {
  addrBytes = addrBytes || 4; sizeBytes = sizeBytes || 2;
  var alfid = ((sizeBytes & 0x0f) << 4) | (addrBytes & 0x0f);
  var out = [SID.READ_MEM, alfid];
  for (var i = addrBytes - 1; i >= 0; i--) out.push((addr >>> (8 * i)) & 0xff);
  for (var j = sizeBytes - 1; j >= 0; j--) out.push((size >>> (8 * j)) & 0xff);
  return out;
}

function buildSessionControl(session) {
  return [SID.SESSION, u8(session)];
}

function buildTesterPresent() {
  return [SID.TESTER_PRESENT, 0x00];
}

function buildSecurityRequestSeed(level) {
  return [SID.SECURITY, u8(level)]; // level is odd (requestSeed)
}

function buildSecuritySendKey(level, keyBytes) {
  return [SID.SECURITY, u8(level + 1)].concat(keyBytes || []); // even (sendKey)
}

function buildRoutineControl(sub, rid, data) {
  return [SID.ROUTINE, u8(sub), hi(rid), lo(rid)].concat(data || []);
}

// MHD live-monitor request: DynamicallyDefineDataIdentifier 0x2C 0x88 0x01.
// Positive reply is 0x6C 0x88 followed by the packed monitor body.
function buildMonitorRequest() {
  return [SID.DDDI, 0x88, 0x01];
}

// ---- response parsing -----------------------------------------------------

// Returns { positive, sid, sub, did, rid, data, nrc, nrcName, pending, error }
function parseResponse(requestSid, bytes) {
  var out = { positive: false, sid: null, data: [], nrc: null, nrcName: null, pending: false, error: null };
  if (!bytes || bytes.length === 0) { out.error = 'empty response'; return out; }

  if (bytes[0] === 0x7f) {
    out.sid = bytes[1];
    out.nrc = bytes[2];
    out.nrcName = NRC[bytes[2]] || ('nrc_0x' + (bytes[2] || 0).toString(16));
    out.pending = bytes[2] === 0x78;
    out.error = 'negativeResponse ' + out.nrcName;
    return out;
  }

  var expected = (requestSid + 0x40) & 0xff;
  if (bytes[0] !== expected) {
    out.error = 'unexpected SID 0x' + bytes[0].toString(16) + ' (wanted 0x' + expected.toString(16) + ')';
    return out;
  }

  out.positive = true;
  out.sid = bytes[0];
  if (requestSid === SID.READ_DID) {
    out.did = (bytes[1] << 8) | bytes[2];
    out.data = bytes.slice(3);
  } else if (requestSid === SID.READ_MEM) {
    out.data = bytes.slice(1); // 0x63 + raw memory bytes
  } else if (requestSid === SID.ROUTINE) {
    out.sub = bytes[1];
    out.rid = (bytes[2] << 8) | bytes[3];
    out.data = bytes.slice(4);
  } else if (requestSid === SID.DDDI) {
    out.sub = bytes[1];        // 0x88
    out.data = bytes.slice(2); // packed monitor body
  } else {
    out.data = bytes.slice(1);
  }
  return out;
}

// Assemble an integer from a slice of data bytes.
function readInt(data, off, len, signed, le) {
  if (!data || off + len > data.length) return NaN;
  var val = 0;
  if (le) {
    for (var i = len - 1; i >= 0; i--) val = (val * 256) + (data[off + i] & 0xff);
  } else {
    for (var j = 0; j < len; j++) val = (val * 256) + (data[off + j] & 0xff);
  }
  if (signed) {
    var max = Math.pow(2, 8 * len);
    if (val >= max / 2) val -= max;
  }
  return val;
}

// Apply a dme-profile read spec {off,len,signed,le,m,b} to a data array.
function scaleFromSpec(data, spec) {
  var raw = readInt(data, spec.off || 0, spec.len || 1, !!spec.signed, !!spec.le);
  if (isNaN(raw)) return NaN;
  var m = typeof spec.m === 'number' ? spec.m : 1;
  var b = typeof spec.b === 'number' ? spec.b : 0;
  return raw * m + b;
}

module.exports = {
  SID: SID,
  ROUTINE_SUB: ROUTINE_SUB,
  NRC: NRC,
  toHex: toHex,
  fromHex: fromHex,
  buildReadDataByIdentifier: buildReadDataByIdentifier,
  buildReadMemoryByAddress: buildReadMemoryByAddress,
  buildSessionControl: buildSessionControl,
  buildTesterPresent: buildTesterPresent,
  buildSecurityRequestSeed: buildSecurityRequestSeed,
  buildSecuritySendKey: buildSecuritySendKey,
  buildRoutineControl: buildRoutineControl,
  buildMonitorRequest: buildMonitorRequest,
  parseResponse: parseResponse,
  readInt: readInt,
  scaleFromSpec: scaleFromSpec
};
