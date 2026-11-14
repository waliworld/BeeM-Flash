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
      // --- car-tested first, then community-sourced candidates -------------
      // Each entry below is an ORDERED list: the proven read is rank 0, and the
      // extended identifiers follow. A DME that refuses the first one backs it
      // off and the next candidate supplies the channel instead.
      //
      // HONESTY: the rank-1+ identifiers and their scaling come from the
      // community BMW enhanced-PID tables and the B58 A2L measurement set in
      // data/ (see data/SOURCES.md). They are NOT verified on any particular
      // car. Each carries min/max plausibility bounds so an implausible decode
      // is DISCARDED rather than shown as a confident number — but if a value
      // here looks wrong for your engine, treat it as wrong and report it.
      railPressure: [
        { did: 0xF423, off: 0, len: 2, m: 0.1,  b: 0, min: 0, max: 400 },      // 10 kPa/bit
        { did: 0x5658, off: 0, len: 2, m: 0.02, b: 0, min: 0, max: 400 }       // 0.002 MPa/bit
      ],
      lpfp: [
        { did: 0xF40A, off: 0, len: 1, m: 0.03,  b: 0, min: 0, max: 8 },       // 3 kPa/bit
        { did: 0x58F3, off: 0, len: 2, m: 0.001, b: 0, min: 0, max: 8 }        // 0.1 kPa/bit
      ],
      railTarget:    { did: 0x56C1, off: 0, len: 2, m: 0.02,       b: 0,       min: 0,   max: 400 },
      oilPressure: [
        { did: 0x586F, off: 0, len: 2, signed: true, m: 0.001, b: 0, min: 0, max: 8 },   // hPa
        { did: 0x4436, off: 0, len: 2, m: 0.001, b: 0, min: 0, max: 8 }                  // absolute
      ],
      fuelFlow:      { did: 0x4521, off: 0, len: 2, m: 0.1,        b: 0,       min: 0,   max: 120 },
      ethanol:       { did: 0x5938, off: 0, len: 2, m: 0.003052,   b: 0,       min: 0,   max: 100 },
      chargeAirTemp: { did: 0x59D4, off: 0, len: 2, m: 0.0234375,  b: -273.15, min: -20, max: 120 },
      cht:           { did: 0x5958, off: 0, len: 2, signed: true, m: 0.1, b: -273.14, min: 0, max: 160 },
      transOil:      { did: 0x4650, off: 0, len: 1, m: 0.75,       b: -48,     min: 0,   max: 160 },
      vanosIn:       { did: 0x452E, off: 0, len: 2, signed: true, m: 0.1, b: 0, min: -40, max: 60 },
      vanosInTarget: { did: 0x452B, off: 0, len: 2, signed: true, m: 0.1, b: 0, min: -40, max: 60 }
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
    var entry = obj.reads[k];
    // A channel may carry a single spec or an ORDERED LIST of candidate specs.
    var list = (Object.prototype.toString.call(entry) === '[object Array]') ? entry : [entry];
    if (!list.length) throw new Error('profile: ' + k + ' has no read spec');
    for (var ci = 0; ci < list.length; ci++) {
      if (!list[ci] || typeof list[ci].did !== 'number') throw new Error('profile: ' + k + ' needs a numeric did');
    }
    var r = list[0];   // display metadata is taken from the first candidate
    if (!Channels.get(k)) {
      // A custom PID: an unknown key that carries display metadata registers a
      // new channel, so a tune's custom measurements (e.g. "MHD+ boost") can be
      // logged and shown. Without metadata an unknown key is still ignored.
      if (r.label || r.unit || r.custom) {
        Channels.register({
          key: k, label: r.label || k, unit: r.unit || '', iunit: r.iunit,
          cat: r.cat || 'Custom', min: r.min, max: r.max, dp: r.dp, warn: r.warn, crit: r.crit
        });
      } else {
        continue;
      }
    }
    var norm = [];
    for (var cj = 0; cj < list.length; cj++) {
      var c = list[cj];
      norm.push({
        did: c.did | 0,
        off: c.off | 0,
        len: c.len ? (c.len | 0) : 2,
        signed: !!c.signed,
        le: !!c.le,
        m: (typeof c.m === 'number' ? c.m : 1),
        b: (typeof c.b === 'number' ? c.b : 0),
        min: (typeof c.min === 'number' ? c.min : undefined),
        max: (typeof c.max === 'number' ? c.max : undefined)
      });
    }
    reads[k] = (norm.length === 1) ? norm[0] : norm;
  }
  return {
    label: obj.label || 'Imported profile',
    verified: obj.verified !== false, // imported profiles are trusted unless they say otherwise
    reads: reads
  };
}

// Group a profile's reads by DID into packed blocks:
//   [ { did, fields: [ { key, off, len, signed, le, m, b } ] }, ... ]
// Group the profile's reads into one request per DID.
//
// A channel's entry may be a single spec OR an ORDERED LIST of candidate specs:
//
//   railPressure: [ { did: 0x5658, ... },      // rank 0: preferred
//                   { did: 0xF423, ... } ]     // rank 1: fallback
//
// Different DMEs answer different identifiers, so a channel that reads '--' on
// one car may read fine on another from a different source. Every candidate is
// polled; the decoder keeps the best-ranked one that actually answers, and a
// candidate the DME refuses is backed off and lets the next one through.
function byDid(profile) {
  var groups = {};
  var order = [];
  var reads = profile.reads || {};
  var keys = Object.keys(reads);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var entry = reads[k];
    var list = (Object.prototype.toString.call(entry) === '[object Array]') ? entry : [entry];
    for (var c = 0; c < list.length; c++) {
      var r = list[c];
      if (!r || r.did == null) continue;
      if (!groups[r.did]) { groups[r.did] = { did: r.did, fields: [] }; order.push(r.did); }
      groups[r.did].fields.push({
        key: k, rank: c, off: r.off, len: r.len, signed: r.signed, le: r.le, m: r.m, b: r.b,
        min: r.min, max: r.max
      });
    }
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
