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
  ECU_RESET: 0x11,
  CLEAR_DTC: 0x14, // ClearDiagnosticInformation (clears fault memory): see dtc.js
  READ_DTC: 0x19,  // ReadDTCInformation (read fault codes): see dtc.js
  SECURITY: 0x27,
  TESTER_PRESENT: 0x3E,
  READ_DID: 0x22,
  READ_MEM: 0x23, // ReadMemoryByAddress (read-only; used for A2L address measurements)
  DDDI: 0x2C, // DynamicallyDefineDataIdentifier (the fast block read uses 2C 88 01)
  ROUTINE: 0x31,
  REQUEST_DOWNLOAD: 0x34, // calibration flashing (write): see flash.js
  TRANSFER_DATA: 0x36,
  TRANSFER_EXIT: 0x37
};

// ReadDTCInformation subfunctions (ISO 14229 §11.3).
var DTC_SUB = {
  BY_STATUS_MASK: 0x02,   // reportDTCByStatusMask (the usual "read codes")
  SUPPORTED: 0x0A,        // reportSupportedDTC (every DTC the ECU knows)
  SNAPSHOT_IDS: 0x03,     // reportDTCSnapshotIdentification
  COUNT: 0x01             // reportNumberOfDTCByStatusMask
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

// ReadDTCInformation (0x19): read fault codes. Default subfunction 0x02
// (reportDTCByStatusMask) with statusMask 0xFF (all stored codes).
function buildReadDtc(sub, statusMask) {
  sub = (sub == null) ? 0x02 : sub;
  if (sub === DTC_SUB.BY_STATUS_MASK || sub === DTC_SUB.COUNT || sub === DTC_SUB.SUPPORTED) {
    return [SID.READ_DTC, sub, statusMask == null ? 0xFF : (statusMask & 0xff)];
  }
  return [SID.READ_DTC, sub];
}

// ClearDiagnosticInformation (0x14): clear fault memory for a DTC group.
// group 0xFFFFFF = all groups (the usual "clear all codes"). This is a WRITE
// (it erases the ECU's fault memory); it is gated behind confirmation in the UI.
function buildClearDtc(group) {
  var g = (group == null) ? 0xFFFFFF : group;
  return [SID.CLEAR_DTC, (g >> 16) & 0xff, (g >> 8) & 0xff, g & 0xff];
}

// Fast block read: DynamicallyDefineDataIdentifier 0x2C 0x88 0x01.
// Positive reply is 0x6C 0x88 followed by the packed monitor body.
function buildMonitorRequest() {
  return [SID.DDDI, 0x88, 0x01];
}

// Big-endian byte array of a value (addresses can exceed 32 bits, so divide).
function bytesOf(val, n) {
  var out = [];
  for (var i = n - 1; i >= 0; i--) out.push(Math.floor(val / Math.pow(256, i)) & 0xff);
  return out;
}

// ---- programming / flashing (write) — see flash.js -----------------------
// These are the standard UDS download services. They are used ONLY by the gated,
// user-confirmed calibration flash flow, for a vehicle the owner has already
// flashed, with user-supplied data. Nothing here acts on a car by itself.

function buildEcuReset(type) { return [SID.ECU_RESET, u8(type == null ? 0x01 : type)]; }

// RequestDownload (0x34): announce a write of `size` bytes at `addr`.
// dataFormatIdentifier 0x00 = no compression/encryption. The DME replies with
// the maximum block length it will accept per TransferData.
function buildRequestDownload(addr, size, opts) {
  opts = opts || {};
  var dataFormat = opts.dataFormat == null ? 0x00 : opts.dataFormat;
  var addrBytes = opts.addrBytes || 4, sizeBytes = opts.sizeBytes || 4;
  var alfid = ((sizeBytes & 0x0f) << 4) | (addrBytes & 0x0f);
  return [SID.REQUEST_DOWNLOAD, dataFormat & 0xff, alfid].concat(bytesOf(addr, addrBytes)).concat(bytesOf(size, sizeBytes));
}

// TransferData (0x36): one block, with a 1-byte block sequence counter (1..255,0,..).
function buildTransferData(counter, data) {
  return [SID.TRANSFER_DATA, counter & 0xff].concat(data || []);
}

// RequestTransferExit (0x37): end the download.
function buildRequestTransferExit(data) {
  return [SID.TRANSFER_EXIT].concat(data || []);
}

// Parse the RequestDownload (0x74) reply -> { maxBlockLength }.
function parseDownloadResponse(bytes) {
  var p = parseResponse(SID.REQUEST_DOWNLOAD, bytes);
  if (!p.positive) return p;
  var lenFmt = (p.data[0] >> 4) & 0x0f; // lengthFormatIdentifier: high nibble = #bytes
  var max = 0;
  for (var i = 0; i < lenFmt && 1 + i < p.data.length; i++) max = max * 256 + p.data[1 + i];
  p.maxBlockLength = max;
  return p;
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
  } else if (requestSid === SID.READ_DTC) {
    out.sub = bytes[1];                 // reportType echo
    out.statusAvailabilityMask = bytes[2];
    out.data = bytes.slice(3);          // DTC records (parsed in dtc.js)
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
  DTC_SUB: DTC_SUB,
  NRC: NRC,
  buildReadDtc: buildReadDtc,
  buildClearDtc: buildClearDtc,
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
  buildEcuReset: buildEcuReset,
  buildRequestDownload: buildRequestDownload,
  buildTransferData: buildTransferData,
  buildRequestTransferExit: buildRequestTransferExit,
  parseDownloadResponse: parseDownloadResponse,
  bytesOf: bytesOf,
  parseResponse: parseResponse,
  readInt: readInt,
  scaleFromSpec: scaleFromSpec
};
