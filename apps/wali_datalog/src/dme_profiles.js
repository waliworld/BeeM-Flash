'use strict';
//
// dme_profiles.js — diagnostic read map for performance channels.
//
// Performance values (boost, timing, lambda, rail pressure, ...) are not
// broadcast on the car's comfort bus; they are read from the engine
// controller (DME) as measured values over UDS ReadDataByIdentifier (0x22).
//
// The DID numbers, byte offsets, lengths and scaling below are DME- and
// tune-specific. BMW / tuner measurement blocks differ between engine
// families and even between tune revisions, exactly as they do in any
// professional logging tool. The values here are a DOCUMENTED TEMPLATE with
// representative layouts; they are *unverified placeholders* and must be
// calibrated against the target DME before live diagnostic logging is trusted.
// See docs/SIGNALS-AND-DIDS.md for the calibration procedure.
//
// Importantly: an unverified entry never produces a wrong *silent* number —
// the diagnostic reader marks a channel 'unverified' until its profile entry
// is confirmed, and the demo backend does not use these entries at all. So the
// app runs and is fully reviewable without a calibrated profile.
//
// Scaling: engineering = raw * m + b, where `raw` is the unsigned (or signed,
// if signed=true) integer assembled from `len` bytes at `off`, big-endian
// unless le=true.

var PROFILES = {
  // Generic in-line-6 turbo template (e.g. B58/S58-class). CALIBRATE before use.
  generic_i6t: {
    label: 'Generic I6 turbo (template)',
    verified: false,
    reads: {
      boost:        { did: 0x4000, off: 0, len: 2, m: 0.001,  b: -1.0, signed: false }, // bar, relative
      iat:          { did: 0x4001, off: 0, len: 2, m: 0.1,    b: -40,  signed: true },  // deg C
      timing:       { did: 0x4002, off: 0, len: 1, m: 0.5,    b: -24,  signed: true },  // deg
      lambda:       { did: 0x4003, off: 0, len: 2, m: 0.0001, b: 0,    signed: false }, // lambda
      lambdaTarget: { did: 0x4003, off: 2, len: 2, m: 0.0001, b: 0,    signed: false }, // lambda
      railPressure: { did: 0x4004, off: 0, len: 2, m: 0.1,    b: 0,    signed: false }, // bar
      wastegate:    { did: 0x4005, off: 0, len: 1, m: 0.5,    b: 0,    signed: false }, // %
      load:         { did: 0x4006, off: 0, len: 2, m: 0.01,   b: 0,    signed: false }, // %
      throttle:     { did: 0x4007, off: 0, len: 1, m: 0.5,    b: 0,    signed: false }, // %
      knock:        { did: 0x4008, off: 0, len: 1, m: 0.1,    b: 0,    signed: true },  // deg retard
      egt:          { did: 0x4009, off: 0, len: 2, m: 1,      b: 0,    signed: false }  // deg C (if equipped)
    }
  }
};

function get(name) {
  return PROFILES[name] || PROFILES.generic_i6t;
}

function names() {
  return Object.keys(PROFILES);
}

module.exports = { PROFILES: PROFILES, get: get, names: names };
