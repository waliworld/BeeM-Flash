'use strict';
//
// channels.js — the catalogue of loggable channels.
//
// Each channel is source-agnostic metadata: where to read it, how to show it
// on a gauge, how it appears in the CSV, and how to convert to imperial. The
// provider layer (someip.js / diag.js) fills in engineering values; derived
// channels are computed from other channels.
//
var F = require('./format');

// read.kind: 'someip' (sig = field in signalmap) | 'diag' (key in dme profile)
//            | 'derived' (fn over the resolved sample)
var CHANNELS = [
  { key: 'rpm',          label: 'Engine speed',  unit: 'rpm', iunit: 'rpm',
    read: { kind: 'someip', sig: 'engineSpeed' }, min: 0, max: 8000, dp: 0, def: true },

  { key: 'speed',        label: 'Vehicle speed', unit: 'km/h', iunit: 'mph', toImp: F.kmhToMph,
    read: { kind: 'someip', sig: 'vehicleSpeed' }, min: 0, max: 320, dp: 0, def: true },

  { key: 'gear',         label: 'Gear',          unit: '', iunit: '',
    read: { kind: 'someip', sig: 'gear' }, min: 0, max: 8, dp: 0, def: true },

  { key: 'pedal',        label: 'Accel pedal',   unit: '%', iunit: '%',
    read: { kind: 'someip', sig: 'accelPedal' }, min: 0, max: 100, dp: 0, def: true },

  { key: 'boost',        label: 'Boost',         unit: 'bar', iunit: 'psi', toImp: F.barToPsi,
    read: { kind: 'diag', key: 'boost' }, min: -1, max: 3, dp: 2, warn: 2.2, crit: 2.6, def: true },

  { key: 'iat',          label: 'Charge air temp', unit: '°C', iunit: '°F', toImp: F.cToF,
    read: { kind: 'diag', key: 'iat' }, min: -20, max: 90, dp: 0, warn: 60, crit: 75, def: true },

  { key: 'coolant',      label: 'Coolant temp',  unit: '°C', iunit: '°F', toImp: F.cToF,
    read: { kind: 'someip', sig: 'coolantTemp' }, min: 0, max: 130, dp: 0, warn: 110, crit: 120, def: true },

  { key: 'oil',          label: 'Oil temp',      unit: '°C', iunit: '°F', toImp: F.cToF,
    read: { kind: 'someip', sig: 'oilTemp' }, min: 0, max: 160, dp: 0, warn: 130, crit: 150, def: true },

  { key: 'timing',       label: 'Ignition timing', unit: '°', iunit: '°',
    read: { kind: 'diag', key: 'timing' }, min: -10, max: 40, dp: 1, def: true },

  { key: 'lambda',       label: 'Lambda (actual)', unit: 'λ', iunit: 'λ',
    read: { kind: 'diag', key: 'lambda' }, min: 0.6, max: 1.3, dp: 3, def: true },

  { key: 'lambdaTarget', label: 'Lambda (target)', unit: 'λ', iunit: 'λ',
    read: { kind: 'diag', key: 'lambdaTarget' }, min: 0.6, max: 1.3, dp: 3, def: false },

  { key: 'afr',          label: 'AFR (actual)',  unit: ':1', iunit: ':1',
    read: { kind: 'derived', fn: function (s) { return F.isNum(s.lambda) ? s.lambda * 14.7 : NaN; } },
    min: 9, max: 19, dp: 1, def: false },

  { key: 'railPressure', label: 'Rail pressure', unit: 'bar', iunit: 'bar',
    read: { kind: 'diag', key: 'railPressure' }, min: 0, max: 400, dp: 0, def: false },

  { key: 'wastegate',    label: 'Wastegate duty', unit: '%', iunit: '%',
    read: { kind: 'diag', key: 'wastegate' }, min: 0, max: 100, dp: 0, def: false },

  { key: 'load',         label: 'Engine load',   unit: '%', iunit: '%',
    read: { kind: 'diag', key: 'load' }, min: 0, max: 200, dp: 0, def: false },

  { key: 'throttle',     label: 'Throttle plate', unit: '%', iunit: '%',
    read: { kind: 'diag', key: 'throttle' }, min: 0, max: 100, dp: 0, def: false },

  { key: 'knock',        label: 'Knock retard',  unit: '°', iunit: '°',
    read: { kind: 'diag', key: 'knock' }, min: 0, max: 12, dp: 1, warn: 2, crit: 5, def: false },

  { key: 'egt',          label: 'Exhaust temp',  unit: '°C', iunit: '°F', toImp: F.cToF,
    read: { kind: 'diag', key: 'egt' }, min: 0, max: 1000, dp: 0, warn: 850, crit: 950, def: false }
];

var BY_KEY = {};
for (var i = 0; i < CHANNELS.length; i++) BY_KEY[CHANNELS[i].key] = CHANNELS[i];

function all() { return CHANNELS.slice(); }
function get(key) { return BY_KEY[key] || null; }
function defaults() {
  var out = [];
  for (var j = 0; j < CHANNELS.length; j++) if (CHANNELS[j].def) out.push(CHANNELS[j].key);
  return out;
}

// Value in the unit system requested ('metric' | 'imperial').
function toUnits(ch, metricValue, units) {
  if (units === 'imperial' && ch && typeof ch.toImp === 'function') return ch.toImp(metricValue);
  return metricValue;
}
function unitLabel(ch, units) {
  if (!ch) return '';
  return units === 'imperial' ? (ch.iunit || ch.unit || '') : (ch.unit || '');
}

module.exports = {
  all: all,
  get: get,
  defaults: defaults,
  toUnits: toUnits,
  unitLabel: unitLabel
};
