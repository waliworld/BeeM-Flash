'use strict';
//
// signalmap.js — logical signal -> SOME/IP interface/field + scaling.
//
// The MGU exposes vehicle signals over SOME/IP. Interface and field names are
// specific to each unit's catalogue (/etc/oap/someip/someip-interfaces.json).
// The entries below are PLACEHOLDERS that must be confirmed on the unit with
// kit/tools/sigdoc.py and kit/tools/check_signals.py, then corrected here.
//
// `verified:false` means the binding is a guess; someip.js reports such signals
// as unavailable (NaN) rather than emitting a wrong number, and the provider
// falls back to diagnostics or demo. Set verified:true once confirmed on a car.
//
// Scaling: engineering = raw * m + b.
//
var MAP = {
  engineSpeed:  { iface: 'VehicleData', instance: 0, field: 'engineSpeed',  m: 1,    b: 0,   verified: false }, // rpm
  vehicleSpeed: { iface: 'VehicleData', instance: 0, field: 'vehicleSpeed', m: 1,    b: 0,   verified: false }, // km/h
  coolantTemp:  { iface: 'VehicleData', instance: 0, field: 'coolantTemp',  m: 1,    b: -48, verified: false }, // deg C
  oilTemp:      { iface: 'VehicleData', instance: 0, field: 'oilTemp',      m: 1,    b: -48, verified: false }, // deg C
  intakeTemp:   { iface: 'VehicleData', instance: 0, field: 'intakeTemp',   m: 1,    b: -48, verified: false }, // deg C
  accelPedal:   { iface: 'VehicleData', instance: 0, field: 'accelPedal',   m: 0.5,  b: 0,   verified: false }, // %
  gear:         { iface: 'VehicleData', instance: 0, field: 'gear',         m: 1,    b: 0,   verified: false }  // gear index
};

function get(sig) { return MAP[sig] || null; }

// Group bindings by interface+instance so someip.js can set up one watch each.
function watchGroups() {
  var groups = {};
  for (var sig in MAP) {
    if (!MAP.hasOwnProperty(sig)) continue;
    var m = MAP[sig];
    var k = m.iface + '#' + m.instance;
    if (!groups[k]) groups[k] = { iface: m.iface, instance: m.instance, fields: {} };
    groups[k].fields[m.field] = sig;
  }
  return groups;
}

function scale(sig, raw) {
  var m = MAP[sig];
  if (!m) return NaN;
  return raw * m.m + m.b;
}

module.exports = { MAP: MAP, get: get, watchGroups: watchGroups, scale: scale };
