'use strict';
//
// signalmap.js — logical signal -> real BMW SOME/IP interface/field/struct-member + scaling.
//
// The MGU exposes vehicle signals over SOME/IP. Each field a unit publishes is a
// STRUCT; the value we want is one named member of it (the kit's signals.watch
// hands the whole struct to the handler, so someip.js reads binding.member).
//
// Interface/field/member names and scalings below are the car-tested values used
// by cauliflowermossgrape's reference apps (idrive7-apps live_data/signals.js and
// car_vitals), which take BMW's own TypeConverters (M Laptimer / x_call). The four
// core engine signals are BMW's own converters and are marked verified:true; the
// rest are left verified:false until confirmed on a car (someip.js reports an
// unverified binding as unavailable rather than emitting a wrong number).
//
// value = raw * m + b, after rejecting the field's "no data" sentinels.
//   invalid: [..]   raw values that mean "no data" (skip the sample)
//   invalidFrom: n  raw >= n means "no data" (e.g. 12-bit fields)
//   s16: true       treat raw as a signed 16-bit value before scaling
//   lim: [lo, hi]   drop the scaled value if outside this plausible range
//   enum: {..}      map a raw/string code to a number (e.g. gear); null entry = no data
//
var CDS = 'de.bmw.infotainment.vehicle.CDS';
var V2 = 'de.bmw.infotainment.vehicle.Vehicle2';
var PEDAL = 'de.bmw.powertrain.AcceleratorPedal';
var VI = 'de.bmw.infrastructure.VehicleInformation';

var MAP = {
  // id            iface   field                      member                               m          b     flags
  engineSpeed:  { iface: CDS,   field: 'statusEngineSpeed2',   member: 'actualValueRPMEngineCrankshaft', m: 0.25,     b: 0,   invalid: [65535], verified: true },  // rpm
  vehicleSpeed: { iface: V2,    field: 'statusCarSpeed2',      member: 'speedVehicleCentreOfGravity',    m: 0.015625, b: 0,   invalid: [65535], verified: true },  // km/h
  coolantTemp:  { iface: CDS,   field: 'statusEngineTemperature', member: 'temperatureEngineDrive',      m: 1,        b: -48, invalid: [255],   verified: true },  // °C
  oilTemp:      { iface: CDS,   field: 'statusEngineTemperature', member: 'temperatureEngineOilDrive',   m: 1,        b: -48, invalid: [255],   verified: true },  // °C (shares the field struct with coolant)
  // Ready but not yet car-confirmed (kept verified:false so they read as "--" until confirmed):
  accelPedal:   { iface: PEDAL, field: 'AngleAcceleratorPedal', member: 'actualValueAngleAcceleratorPedal', m: 0.025, b: 0, lim: [-2, 102], verified: false }, // %
  gear:         { iface: VI,    field: 'DataPowerTrain2',      member: 'actualGear', enum: null, verified: false } // gear: needs the DataPowerTrain2 selection decode (P/R/N/D1..D8 -> number)
};

function get(sig) { return MAP[sig] || null; }

// Group bindings by interface, then by field, so someip.js sets up ONE watch per
// interface with one handler per field, and a field shared by several signals
// (coolant + oil both on statusEngineTemperature) is read once into both.
function watchGroups() {
  var groups = {};
  for (var sig in MAP) {
    if (!MAP.hasOwnProperty(sig)) continue;
    var m = MAP[sig];
    if (!groups[m.iface]) groups[m.iface] = { iface: m.iface, fields: {} };
    if (!groups[m.iface].fields[m.field]) groups[m.iface].fields[m.field] = [];
    groups[m.iface].fields[m.field].push(sig);
  }
  return groups;
}

// Read one logical signal's engineering value out of its field STRUCT, applying
// the member selection, "no data" sentinels, sign extension, scaling and bounds
// (the reference value() logic). Returns a finite number or NaN.
function readValue(sig, struct) {
  var b = MAP[sig];
  if (!b || !struct || typeof struct !== 'object') return NaN;
  var raw = struct[b.member];
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) raw = Number(raw);
  if (raw === undefined || raw === null) return NaN;
  if (b.enum) {
    var t = b.enum[raw];
    return (typeof t === 'number') ? t : NaN;
  }
  if (typeof raw !== 'number' || !isFinite(raw)) return NaN;
  if (b.invalid && b.invalid.indexOf(raw) >= 0) return NaN;
  if (b.invalidFrom !== undefined && raw >= b.invalidFrom) return NaN;
  if (b.s16 && raw >= 32768) raw -= 65536;
  var v = raw * (b.m === undefined ? 1 : b.m) + (b.b || 0);
  if (b.lim && (v < b.lim[0] || v > b.lim[1])) return NaN;
  return v;
}

// Back-compat: scale a raw scalar (kept for any caller/test that passes a number).
function scale(sig, raw) {
  var b = MAP[sig];
  if (!b) return NaN;
  if (typeof raw === 'object') return readValue(sig, raw);
  if (b.invalid && b.invalid.indexOf(raw) >= 0) return NaN;
  if (b.invalidFrom !== undefined && raw >= b.invalidFrom) return NaN;
  if (b.s16 && raw >= 32768) raw -= 65536;
  return raw * (b.m === undefined ? 1 : b.m) + (b.b || 0);
}

// The real interfaces this app reads, for app.json signals{} / the SOME/IP manifest.
function interfaces() {
  var out = {};
  for (var sig in MAP) {
    if (!MAP.hasOwnProperty(sig)) continue;
    var m = MAP[sig];
    if (!out[m.iface]) out[m.iface] = {};
    out[m.iface][m.field] = 'rs';
  }
  return out;
}

module.exports = { MAP: MAP, get: get, watchGroups: watchGroups, readValue: readValue, scale: scale, interfaces: interfaces };
