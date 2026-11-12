'use strict';
//
// dme_profiles.js — diagnostic read map for the extended tuner-class channel set.
//
// Extended logging reads the DME over UDS. The high-rate way is
// to read a few *wide measurement blocks*: one ReadDataByIdentifier (0x22) per
// block returns many values packed at fixed byte offsets, which we unpack into
// many channels. This file models that:
//
//   reads: { <channelKey>: { did, off, len, signed, le, m, b } }
//
// Several channels may share one `did` with different `off` — that is a packed
// block, read once per cycle.
//
// The DID numbers, offsets and scaling are DME- and tune-specific (and, for a
// given tune, are the tuner's reverse-engineered measurement definitions). This
// repo therefore does NOT ship a real vendor PID table. It ships:
//   * `generic_template` — a documented, auto-generated placeholder (one DID per
//     channel, scaling seeded from the channel catalogue), marked verified:false
//     so strict mode suppresses it until calibrated; and
//   * `fromJson()` — import a real per-tune PID profile (see
//     docs/SIGNALS-AND-DIDS.md and profiles/template.json).
//
// Nothing here emits a wrong silent number: an unverified profile is suppressed
// (strict mode) and the app shows clearly-labelled demo data instead.
//
var Channels = require('./channels');

// Build a one-DID-per-channel placeholder from the catalogue's dguess seeds.
function buildTemplate() {
  var reads = {};
  var did = 0x4000;
  var list = Channels.all();
  for (var i = 0; i < list.length; i++) {
    var ch = list[i];
    if (!ch.read || ch.read.kind !== 'diag') continue;
    var g = ch.dguess || {};
    reads[ch.key] = {
      did: did++,
      off: 0,
      len: g.len || 2,
      signed: !!g.signed,
      le: !!g.le,
      m: (g.m != null ? g.m : 1),
      b: (g.b != null ? g.b : 0)
    };
  }
  return reads;
}

var PROFILES = {
  generic_template: {
    label: 'Generic template (CALIBRATE)',
    verified: false,
    reads: buildTemplate()
  },
  // Car-tested BMW DME reads (UDS 0x22), DME control unit 0x12. DIDs + scaling
  // taken from the car-proven config.dme of cauliflowermossgrape's car_vitals.
  // One value per DID here (not packed blocks); unit conversions folded into m
  // (kPa->bar = /100, so 1/32 kPa/bit -> 0.0003125 bar/bit). Relative boost is
  // derived (boostAbs - baro) in the provider. Values validate on a car; knock
  // retard has no standard DID and stays uncalibrated.
  bmw_obd: {
    label: 'BMW DME (UDS 0x22, car-tested)',
    verified: true,
    ecu: 0x12,
    reads: {
      iat:      { did: 0xF40F, off: 0, len: 1, m: 1,         b: -40 }, // charge air temp, deg C
      timing:   { did: 0xF40E, off: 0, len: 1, m: 0.5,       b: -64 }, // ignition timing, deg BTDC
      boostAbs: { did: 0xF470, off: 3, len: 2, m: 0.0003125, b: 0 },   // manifold abs pressure, bar (1/32 kPa/bit)
      baro:     { did: 0xF433, off: 0, len: 1, m: 0.01,      b: 0 },   // barometric pressure, bar (kPa)
      load:     { did: 0x5813, off: 0, len: 1, m: 0.75,      b: 0 },   // actual relative air charge, %
      loadReq:  { did: 0x480C, off: 0, len: 2, m: 0.0234375, b: 0 },   // requested relative air charge, %
      railPressure: { did: 0xF423, off: 0, len: 2, m: 0.1,  b: 0 },   // HPFP rail pressure, bar (10 kPa/bit)
      lpfp:     { did: 0xF40A, off: 0, len: 1, m: 0.03,      b: 0 }    // LPFP pressure, bar (3 kPa/bit)
    }
  }
};

function get(name) { return PROFILES[name] || PROFILES.generic_template; }
function names() { return Object.keys(PROFILES); }

// Validate + normalise an imported PID profile object.
//   { label?, verified?, reads: { key: {did, off?, len?, signed?, le?, m?, b?} } }
function fromJson(obj) {
  if (!obj || typeof obj !== 'object' || !obj.reads) throw new Error('profile: missing reads');
  var reads = {};
  var keys = Object.keys(obj.reads);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var r = obj.reads[k];
    if (!r || typeof r.did !== 'number') throw new Error('profile: ' + k + ' needs a numeric did');
    if (!Channels.get(k)) continue; // ignore unknown channels rather than fail
    reads[k] = {
      did: r.did | 0,
      off: r.off | 0,
      len: r.len ? (r.len | 0) : 2,
      signed: !!r.signed,
      le: !!r.le,
      m: (typeof r.m === 'number' ? r.m : 1),
      b: (typeof r.b === 'number' ? r.b : 0)
    };
  }
  return {
    label: obj.label || 'Imported profile',
    verified: obj.verified !== false, // imported profiles are trusted unless they say otherwise
    reads: reads
  };
}

// Group a profile's reads by DID into packed blocks:
//   [ { did, fields: [ { key, off, len, signed, le, m, b } ] }, ... ]
function byDid(profile) {
  var groups = {};
  var order = [];
  var reads = profile.reads || {};
  var keys = Object.keys(reads);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var r = reads[k];
    if (!groups[r.did]) { groups[r.did] = { did: r.did, fields: [] }; order.push(r.did); }
    groups[r.did].fields.push({
      key: k, off: r.off, len: r.len, signed: r.signed, le: r.le, m: r.m, b: r.b
    });
  }
  return order.map(function (d) { return groups[d]; });
}

module.exports = {
  PROFILES: PROFILES,
  get: get,
  names: names,
  fromJson: fromJson,
  byDid: byDid,
  buildTemplate: buildTemplate
};
