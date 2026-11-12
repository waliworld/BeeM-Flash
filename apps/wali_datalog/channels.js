'use strict';
//
// channels.js — the catalogue of loggable channels (extended tuner-class coverage).
//
// Each channel is source-agnostic metadata: where to read it, how to show it on
// a gauge, how it appears in the CSV, and how to convert to imperial. The
// provider layer fills engineering values; derived channels are computed from
// other channels.
//
// `read.kind`: 'someip' (sig in signalmap) | 'diag' (read from a DME profile,
//              keyed by this channel's key) | 'derived' (fn over the sample).
// `cat`: UI/category grouping.
// `dguess`: seed for the diagnostic profile template {len,m,b,signed}. The real
//           DID/offset/scaling is per-DME/tune and supplied by an imported PID
//           profile or calibrated on-car (see docs/SIGNALS-AND-DIDS.md).
//
var F = require('./format');

function diag(key) { return { kind: 'diag', key: key }; }
function bus(sig) { return { kind: 'someip', sig: sig }; }

// Base catalogue (per-cylinder channels are appended below).
var BASE = [
  // ---- Engine ------------------------------------------------------------
  { key: 'rpm', label: 'Engine speed', unit: 'rpm', cat: 'Engine', read: bus('engineSpeed'), min: 0, max: 8000, dp: 0, def: true },
  { key: 'speed', label: 'Vehicle speed', unit: 'km/h', iunit: 'mph', toImp: F.kmhToMph, cat: 'Engine', read: bus('vehicleSpeed'), min: 0, max: 320, dp: 0, def: true },
  { key: 'gear', label: 'Gear', unit: '', cat: 'Engine', read: bus('gear'), min: 0, max: 8, dp: 0, def: true },
  { key: 'pedal', label: 'Accel pedal', unit: '%', cat: 'Engine', read: bus('accelPedal'), min: 0, max: 100, dp: 0, def: true },
  { key: 'throttle', label: 'Throttle plate', unit: '%', cat: 'Engine', read: diag('throttle'), min: 0, max: 100, dp: 0, dguess: { len: 1, m: 0.5 }, def: false },
  { key: 'load', label: 'Engine load', unit: '%', cat: 'Engine', read: diag('load'), min: 0, max: 200, dp: 0, dguess: { len: 2, m: 0.01 }, def: true },
  { key: 'loadAbs', label: 'Absolute load', unit: '%', cat: 'Engine', read: diag('loadAbs'), min: 0, max: 300, dp: 0, dguess: { len: 2, m: 0.01 }, def: false },
  { key: 'torqueActual', label: 'Torque actual', unit: 'Nm', iunit: 'lb-ft', toImp: F.nmToLbft, cat: 'Engine', read: diag('torqueActual'), min: 0, max: 900, dp: 0, dguess: { len: 2, m: 0.1 }, def: false },
  { key: 'torqueReq', label: 'Torque requested', unit: 'Nm', iunit: 'lb-ft', toImp: F.nmToLbft, cat: 'Engine', read: diag('torqueReq'), min: 0, max: 900, dp: 0, dguess: { len: 2, m: 0.1 }, def: false },
  { key: 'torqueLimit', label: 'Torque limit', unit: 'Nm', iunit: 'lb-ft', toImp: F.nmToLbft, cat: 'Engine', read: diag('torqueLimit'), min: 0, max: 900, dp: 0, dguess: { len: 2, m: 0.1 }, def: false },

  // ---- Air / Boost -------------------------------------------------------
  { key: 'boost', label: 'Boost (rel)', unit: 'bar', iunit: 'psi', toImp: F.barToPsi, cat: 'Air/Boost', read: diag('boost'), min: -1, max: 3, dp: 2, warn: 2.2, crit: 2.6, dguess: { len: 2, m: 0.001, b: -1 }, def: true },
  { key: 'boostTarget', label: 'Boost target (rel)', unit: 'bar', iunit: 'psi', toImp: F.barToPsi, cat: 'Air/Boost', read: diag('boostTarget'), min: -1, max: 3, dp: 2, dguess: { len: 2, m: 0.001, b: -1 }, def: true },
  { key: 'boostAbs', label: 'Manifold pressure', unit: 'bar', iunit: 'psi', toImp: F.barToPsi, cat: 'Air/Boost', read: diag('boostAbs'), min: 0, max: 4, dp: 2, dguess: { len: 2, m: 0.001 }, def: false },
  { key: 'putp', label: 'Pre-throttle press.', unit: 'bar', iunit: 'psi', toImp: F.barToPsi, cat: 'Air/Boost', read: diag('putp'), min: 0, max: 4, dp: 2, dguess: { len: 2, m: 0.001 }, def: false },
  { key: 'baro', label: 'Barometric press.', unit: 'bar', iunit: 'psi', toImp: F.barToPsi, cat: 'Air/Boost', read: diag('baro'), min: 0, max: 1.2, dp: 2, dguess: { len: 2, m: 0.001 }, def: false },
  { key: 'iat', label: 'Charge air temp', unit: '°C', iunit: '°F', toImp: F.cToF, cat: 'Air/Boost', read: diag('iat'), min: -20, max: 90, dp: 0, warn: 60, crit: 75, dguess: { len: 1, m: 1, b: -40 }, def: true },
  { key: 'ambientT', label: 'Ambient air temp', unit: '°C', iunit: '°F', toImp: F.cToF, cat: 'Air/Boost', read: bus('ambientTemp'), min: -40, max: 60, dp: 0, def: false },
  { key: 'maf', label: 'MAF actual', unit: 'kg/h', cat: 'Air/Boost', read: diag('maf'), min: 0, max: 1200, dp: 0, dguess: { len: 2, m: 0.1 }, def: false },
  { key: 'mafSpec', label: 'MAF specified', unit: 'kg/h', cat: 'Air/Boost', read: diag('mafSpec'), min: 0, max: 1200, dp: 0, dguess: { len: 2, m: 0.1 }, def: false },
  { key: 'wastegate', label: 'Wastegate duty', unit: '%', cat: 'Air/Boost', read: diag('wastegate'), min: 0, max: 100, dp: 0, dguess: { len: 1, m: 0.5 }, def: false },
  { key: 'wastegateTarget', label: 'Wastegate target', unit: '%', cat: 'Air/Boost', read: diag('wastegateTarget'), min: 0, max: 100, dp: 0, dguess: { len: 1, m: 0.5 }, def: false },
  { key: 'wastegatePos', label: 'Wastegate position', unit: '%', cat: 'Air/Boost', read: diag('wastegatePos'), min: 0, max: 100, dp: 0, dguess: { len: 1, m: 0.5 }, def: false },
  // Two OBD-II boost sources kept side-by-side to CONFIRM on-car which reads
  // correctly on a high-boost car: the standard manifold-pressure PID 0x0B
  // saturates at 255 kPa (~2.55 bar absolute), while the boost-control PID 0x70
  // does not. Map both (pidmap / OBD source) and compare. See docs.
  { key: 'boostObd0B', label: 'Manifold (OBD 0x0B)', unit: 'bar', iunit: 'psi', toImp: F.barToPsi, cat: 'Air/Boost', read: diag('boostObd0B'), min: 0, max: 3, dp: 2, dguess: { len: 1, m: 0.01 }, def: false },
  { key: 'boostObd70', label: 'Boost ctrl (OBD 0x70)', unit: 'bar', iunit: 'psi', toImp: F.barToPsi, cat: 'Air/Boost', read: diag('boostObd70'), min: 0, max: 4, dp: 2, dguess: { len: 2, m: 0.001 }, def: false },

  // ---- Fuel --------------------------------------------------------------
  { key: 'lambda', label: 'Lambda actual (B1)', unit: 'λ', cat: 'Fuel', read: diag('lambda'), min: 0.6, max: 1.3, dp: 3, dguess: { len: 2, m: 0.0001 }, def: true },
  { key: 'lambda2', label: 'Lambda actual (B2)', unit: 'λ', cat: 'Fuel', read: diag('lambda2'), min: 0.6, max: 1.3, dp: 3, dguess: { len: 2, m: 0.0001 }, def: false },
  { key: 'lambdaTarget', label: 'Lambda target', unit: 'λ', cat: 'Fuel', read: diag('lambdaTarget'), min: 0.6, max: 1.3, dp: 3, dguess: { len: 2, m: 0.0001 }, def: true },
  { key: 'afr', label: 'AFR actual', unit: ':1', cat: 'Fuel', read: { kind: 'derived', fn: function (s) { return F.isNum(s.lambda) ? s.lambda * 14.7 : NaN; } }, min: 9, max: 19, dp: 1, def: false },
  { key: 'stft', label: 'Short fuel trim', unit: '%', cat: 'Fuel', read: diag('stft'), min: -25, max: 25, dp: 1, dguess: { len: 1, m: 0.5, b: -64, signed: true }, def: false },
  { key: 'ltft', label: 'Long fuel trim', unit: '%', cat: 'Fuel', read: diag('ltft'), min: -25, max: 25, dp: 1, dguess: { len: 1, m: 0.5, b: -64, signed: true }, def: false },
  { key: 'railPressure', label: 'HPFP rail (actual)', unit: 'bar', cat: 'Fuel', read: diag('railPressure'), min: 0, max: 400, dp: 0, dguess: { len: 2, m: 0.1 }, def: true },
  { key: 'railTarget', label: 'HPFP rail (target)', unit: 'bar', cat: 'Fuel', read: diag('railTarget'), min: 0, max: 400, dp: 0, dguess: { len: 2, m: 0.1 }, def: false },
  { key: 'lpfp', label: 'LPFP (actual)', unit: 'bar', cat: 'Fuel', read: diag('lpfp'), min: 0, max: 8, dp: 2, dguess: { len: 2, m: 0.01 }, def: false },
  { key: 'lpfpTarget', label: 'LPFP (target)', unit: 'bar', cat: 'Fuel', read: diag('lpfpTarget'), min: 0, max: 8, dp: 2, dguess: { len: 2, m: 0.01 }, def: false },
  { key: 'injDuty', label: 'Injector duty', unit: '%', cat: 'Fuel', read: diag('injDuty'), min: 0, max: 100, dp: 1, dguess: { len: 1, m: 0.5 }, def: false },
  { key: 'injPulse', label: 'Injection time', unit: 'ms', cat: 'Fuel', read: diag('injPulse'), min: 0, max: 10, dp: 2, dguess: { len: 2, m: 0.001 }, def: false },
  { key: 'fuelFlow', label: 'Fuel flow', unit: 'kg/h', cat: 'Fuel', read: diag('fuelFlow'), min: 0, max: 120, dp: 1, dguess: { len: 2, m: 0.01 }, def: false },
  { key: 'ethanol', label: 'Ethanol content', unit: '%', cat: 'Fuel', read: diag('ethanol'), min: 0, max: 100, dp: 0, dguess: { len: 1, m: 0.5 }, def: false },

  // ---- Ignition (overall; per-cylinder appended below) -------------------
  { key: 'timing', label: 'Ignition timing', unit: '°', cat: 'Ignition', read: diag('timing'), min: -10, max: 40, dp: 1, dguess: { len: 1, m: 0.5, b: -64 }, def: true },
  { key: 'knock', label: 'Knock retard', unit: '°', cat: 'Ignition', read: diag('knock'), min: 0, max: 12, dp: 1, warn: 2, crit: 5, dguess: { len: 1, m: 0.1 }, def: true },

  // ---- Temperatures ------------------------------------------------------
  { key: 'coolant', label: 'Coolant temp', unit: '°C', iunit: '°F', toImp: F.cToF, cat: 'Temps', read: bus('coolantTemp'), min: 0, max: 130, dp: 0, warn: 110, crit: 120, def: true },
  { key: 'oil', label: 'Oil temp', unit: '°C', iunit: '°F', toImp: F.cToF, cat: 'Temps', read: bus('oilTemp'), min: 0, max: 160, dp: 0, warn: 130, crit: 150, def: true },
  { key: 'oilPressure', label: 'Oil pressure', unit: 'bar', cat: 'Temps', read: diag('oilPressure'), min: 0, max: 8, dp: 1, dguess: { len: 1, m: 0.1 }, def: false },
  { key: 'egt', label: 'Exhaust temp (B1)', unit: '°C', iunit: '°F', toImp: F.cToF, cat: 'Temps', read: diag('egt'), min: 0, max: 1000, dp: 0, warn: 850, crit: 950, dguess: { len: 2, m: 1 }, def: false },
  { key: 'egt2', label: 'Exhaust temp (B2)', unit: '°C', iunit: '°F', toImp: F.cToF, cat: 'Temps', read: diag('egt2'), min: 0, max: 1000, dp: 0, warn: 850, crit: 950, dguess: { len: 2, m: 1 }, def: false },
  { key: 'cht', label: 'Cyl head temp', unit: '°C', iunit: '°F', toImp: F.cToF, cat: 'Temps', read: diag('cht'), min: 0, max: 160, dp: 0, dguess: { len: 2, m: 0.1, b: -40, signed: true }, def: false },
  { key: 'transOil', label: 'Trans oil temp', unit: '°C', iunit: '°F', toImp: F.cToF, cat: 'Temps', read: diag('transOil'), min: 0, max: 160, dp: 0, dguess: { len: 1, m: 1, b: -40, signed: true }, def: false },
  { key: 'clutchTemp', label: 'Clutch temp (DCT)', unit: '°C', iunit: '°F', toImp: F.cToF, cat: 'Temps', read: diag('clutchTemp'), min: 0, max: 400, dp: 0, dguess: { len: 2, m: 0.1 }, def: false },

  // ---- Electrical --------------------------------------------------------
  { key: 'battery', label: 'Battery voltage', unit: 'V', cat: 'Electrical', read: diag('battery'), min: 8, max: 16, dp: 2, dguess: { len: 2, m: 0.001 }, def: false },
  { key: 'alternator', label: 'Alternator duty', unit: '%', cat: 'Electrical', read: diag('alternator'), min: 0, max: 100, dp: 0, dguess: { len: 1, m: 0.5 }, def: false },

  // ---- Cams / valvetrain -------------------------------------------------
  { key: 'vanosIn', label: 'VANOS intake (act)', unit: '°', cat: 'Cams', read: diag('vanosIn'), min: -40, max: 60, dp: 1, dguess: { len: 2, m: 0.1, b: -40, signed: true }, def: false },
  { key: 'vanosInTarget', label: 'VANOS intake (tgt)', unit: '°', cat: 'Cams', read: diag('vanosInTarget'), min: -40, max: 60, dp: 1, dguess: { len: 2, m: 0.1, b: -40, signed: true }, def: false },
  { key: 'vanosEx', label: 'VANOS exhaust (act)', unit: '°', cat: 'Cams', read: diag('vanosEx'), min: -40, max: 60, dp: 1, dguess: { len: 2, m: 0.1, b: -40, signed: true }, def: false },
  { key: 'vanosExTarget', label: 'VANOS exhaust (tgt)', unit: '°', cat: 'Cams', read: diag('vanosExTarget'), min: -40, max: 60, dp: 1, dguess: { len: 2, m: 0.1, b: -40, signed: true }, def: false },
  { key: 'valvetronic', label: 'Valvetronic lift', unit: 'mm', cat: 'Cams', read: diag('valvetronic'), min: 0, max: 10, dp: 2, dguess: { len: 2, m: 0.01 }, def: false },

  // ---- Dynamics ----------------------------------------------------------
  { key: 'gLong', label: 'Longitudinal G', unit: 'g', cat: 'Dynamics', read: bus('gLong'), min: -2, max: 2, dp: 2, def: false },
  { key: 'gLat', label: 'Lateral G', unit: 'g', cat: 'Dynamics', read: bus('gLat'), min: -2, max: 2, dp: 2, def: false },

  // ---- Extended boost / wastegate control (B58, extended tuner class) ----
  { key: 'boostDeviation', label: 'Boost deviation', unit: 'bar', iunit: 'psi', toImp: F.barToPsi, cat: 'Air/Boost', read: diag('boostDeviation'), min: -1, max: 1, dp: 2, dguess: { len: 2, m: 0.001, b: -1, signed: true }, def: true },
  { key: 'boostSetpointFactor', label: 'Boost setpoint factor', unit: '', cat: 'Air/Boost', read: diag('boostSetpointFactor'), min: 0, max: 2, dp: 2, dguess: { len: 2, m: 0.001 }, def: true },
  { key: 'compressorAfterPD', label: 'Compressor after P-D', unit: 'bar', iunit: 'psi', toImp: F.barToPsi, cat: 'Air/Boost', read: diag('compressorAfterPD'), min: 0, max: 4, dp: 2, dguess: { len: 2, m: 0.001 }, def: true },
  { key: 'compressorBase', label: 'Compressor base', unit: 'bar', iunit: 'psi', toImp: F.barToPsi, cat: 'Air/Boost', read: diag('compressorBase'), min: 0, max: 4, dp: 2, dguess: { len: 2, m: 0.001 }, def: true },
  { key: 'chargeAirTemp', label: 'Charge air temp', unit: '°C', iunit: '°F', toImp: F.cToF, cat: 'Air/Boost', read: diag('chargeAirTemp'), min: -20, max: 120, dp: 0, warn: 60, crit: 80, dguess: { len: 2, m: 0.1, b: -40, signed: true }, def: false },
  { key: 'mafReq', label: 'MAF req (P corr.)', unit: 'kg/h', cat: 'Air/Boost', read: diag('mafReq'), min: 0, max: 1200, dp: 0, dguess: { len: 2, m: 0.1 }, def: true },
  { key: 'mafReqWg', label: 'MAF req (WGDC)', unit: 'kg/h', cat: 'Air/Boost', read: diag('mafReqWg'), min: 0, max: 1200, dp: 0, dguess: { len: 2, m: 0.1 }, def: true },
  { key: 'wgDistribution', label: 'WG distribution factor', unit: '', cat: 'Air/Boost', read: diag('wgDistribution'), min: 0, max: 2, dp: 2, dguess: { len: 2, m: 0.001 }, def: true },
  { key: 'wgdcP', label: 'WGDC P-factor', unit: '%', cat: 'Air/Boost', read: diag('wgdcP'), min: -50, max: 50, dp: 1, dguess: { len: 2, m: 0.01, b: -50, signed: true }, def: true },
  { key: 'wgdcI', label: 'WGDC I-factor', unit: '%', cat: 'Air/Boost', read: diag('wgdcI'), min: -50, max: 50, dp: 1, dguess: { len: 2, m: 0.01, b: -50, signed: true }, def: true },
  { key: 'wgdcD', label: 'WGDC D-factor', unit: '%', cat: 'Air/Boost', read: diag('wgdcD'), min: -50, max: 50, dp: 1, dguess: { len: 2, m: 0.01, b: -50, signed: true }, def: true },

  // ---- Extended fuel -----------------------------------------------------
  { key: 'loadReq', label: 'Load requested', unit: '%', cat: 'Engine', read: diag('loadReq'), min: 0, max: 200, dp: 0, dguess: { len: 2, m: 0.01 }, def: true },
  { key: 'stft2', label: 'Short fuel trim (B2)', unit: '%', cat: 'Fuel', read: diag('stft2'), min: -25, max: 25, dp: 1, dguess: { len: 1, m: 0.5, b: -64, signed: true }, def: false },
  { key: 'railPressureDev', label: 'Rail pressure dev.', unit: 'bar', cat: 'Fuel', read: diag('railPressureDev'), min: -50, max: 50, dp: 0, dguess: { len: 2, m: 0.1, b: -200, signed: true }, def: false },
  { key: 'diffFuelPress', label: 'Diff. fuel pressure', unit: 'bar', cat: 'Port Inj', read: diag('diffFuelPress'), min: 0, max: 300, dp: 0, dguess: { len: 2, m: 0.1 }, def: false },
  { key: 'portInjIdc', label: 'Port inj duty', unit: '%', cat: 'Port Inj', read: diag('portInjIdc'), min: 0, max: 100, dp: 1, dguess: { len: 1, m: 0.5 }, def: false },
  { key: 'portInjIpw', label: 'Port inj pulse', unit: 'ms', cat: 'Port Inj', read: diag('portInjIpw'), min: 0, max: 20, dp: 2, dguess: { len: 2, m: 0.001 }, def: false },
  { key: 'diInjIdc', label: 'Direct inj duty', unit: '%', cat: 'Port Inj', read: diag('diInjIdc'), min: 0, max: 100, dp: 1, dguess: { len: 1, m: 0.5 }, def: false },
  { key: 'fuelMassTotal', label: 'Fuel mass (total)', unit: 'mg', cat: 'Port Inj', read: diag('fuelMassTotal'), min: 0, max: 120, dp: 1, dguess: { len: 2, m: 0.01 }, def: false },

  // ---- Port injection (Reflex+ / secondary PI systems) -------------------
  // For a car with a secondary port-injection kit the owner supplies the real
  // DIDs/scaling via pidmap.json; these are the standard channels such a kit logs.
  { key: 'portRailPressure', label: 'Port rail pressure', unit: 'bar', iunit: 'psi', toImp: F.barToPsi, cat: 'Port Inj', read: diag('portRailPressure'), min: 0, max: 10, dp: 2, dguess: { len: 2, m: 0.01 }, def: false },
  { key: 'portRailTarget', label: 'Port rail (target)', unit: 'bar', iunit: 'psi', toImp: F.barToPsi, cat: 'Port Inj', read: diag('portRailTarget'), min: 0, max: 10, dp: 2, dguess: { len: 2, m: 0.01 }, def: false },
  { key: 'portInjTarget', label: 'Port inj duty (tgt)', unit: '%', cat: 'Port Inj', read: diag('portInjTarget'), min: 0, max: 100, dp: 1, dguess: { len: 1, m: 0.5 }, def: false },
  { key: 'portInjSplit', label: 'Port fuel split', unit: '%', cat: 'Port Inj', read: diag('portInjSplit'), min: 0, max: 100, dp: 1, dguess: { len: 1, m: 0.5 }, def: false },
  { key: 'portInjActive', label: 'Port inj active', unit: '', cat: 'Port Inj', read: diag('portInjActive'), min: 0, max: 1, dp: 0, dguess: { len: 1 }, def: false },
  { key: 'portFuelMass', label: 'Port fuel mass', unit: 'mg', cat: 'Port Inj', read: diag('portFuelMass'), min: 0, max: 120, dp: 1, dguess: { len: 2, m: 0.01 }, def: false },
  { key: 'diFuelMass', label: 'Direct fuel mass', unit: 'mg', cat: 'Port Inj', read: diag('diFuelMass'), min: 0, max: 120, dp: 1, dguess: { len: 2, m: 0.01 }, def: false },

  // ---- Flex fuel ---------------------------------------------------------
  { key: 'ethanolTarget', label: 'Ethanol (target)', unit: '%', cat: 'Fuel', read: diag('ethanolTarget'), min: 0, max: 100, dp: 0, dguess: { len: 1, m: 0.5 }, def: false },
  { key: 'flexFactor', label: 'Flex-fuel factor', unit: '', cat: 'Fuel', read: diag('flexFactor'), min: 0, max: 2, dp: 2, dguess: { len: 2, m: 0.001 }, def: false },
  { key: 'fuelTemp', label: 'Fuel temp', unit: '°C', iunit: '°F', toImp: F.cToF, cat: 'Fuel', read: diag('fuelTemp'), min: -20, max: 120, dp: 0, dguess: { len: 1, m: 1, b: -40, signed: true }, def: false },

  // ---- Ignition (knock adaptation) ---------------------------------------
  { key: 'knockAdapt', label: 'Knock adapt delta', unit: '°', cat: 'Ignition', read: diag('knockAdapt'), min: -5, max: 5, dp: 1, dguess: { len: 1, m: 0.1, b: -12, signed: true }, def: true },

  // ---- Status / driver ---------------------------------------------------
  { key: 'throttleReq', label: 'Throttle requested', unit: '%', cat: 'Status', read: diag('throttleReq'), min: 0, max: 100, dp: 0, dguess: { len: 1, m: 0.5 }, def: false },
  { key: 'torqueLimiter', label: 'Torque limiter status', unit: '', cat: 'Status', read: diag('torqueLimiter'), min: 0, max: 15, dp: 0, dguess: { len: 1 }, def: false },
  { key: 'fuelLevel', label: 'Fuel level', unit: '%', cat: 'Status', read: diag('fuelLevel'), min: 0, max: 100, dp: 0, dguess: { len: 1, m: 0.5 }, def: false },
  { key: 'exhaustFlap', label: 'Exhaust flap', unit: '', cat: 'Status', read: diag('exhaustFlap'), min: 0, max: 1, dp: 0, dguess: { len: 1 }, def: false },
  { key: 'launchStatus', label: 'Launch control status', unit: '', cat: 'Status', read: diag('launchStatus'), min: 0, max: 10, dp: 0, dguess: { len: 1 }, def: false }
];

// Per-cylinder ignition timing and knock (1..6).
var CYL = 6;
for (var cyl = 1; cyl <= CYL; cyl++) {
  BASE.push({ key: 'timingCyl' + cyl, label: 'Timing cyl ' + cyl, unit: '°', cat: 'Ignition', read: diag('timingCyl' + cyl), min: -10, max: 40, dp: 1, dguess: { len: 1, m: 0.5, b: -64 }, def: false });
}
for (var cyl2 = 1; cyl2 <= CYL; cyl2++) {
  BASE.push({ key: 'knockCyl' + cyl2, label: 'Knock cyl ' + cyl2, unit: '°', cat: 'Ignition', read: diag('knockCyl' + cyl2), min: 0, max: 15, dp: 1, warn: 2, crit: 5, dguess: { len: 1, m: 0.1 }, def: false });
}

var CHANNELS = BASE;
var BY_KEY = {};
for (var i = 0; i < CHANNELS.length; i++) BY_KEY[CHANNELS[i].key] = CHANNELS[i];

function all() { return CHANNELS.slice(); }
function get(key) { return BY_KEY[key] || null; }
function defaults() {
  var out = [];
  for (var j = 0; j < CHANNELS.length; j++) if (CHANNELS[j].def) out.push(CHANNELS[j].key);
  return out;
}
function categories() {
  var seen = {}, out = [];
  for (var k = 0; k < CHANNELS.length; k++) {
    var c = CHANNELS[k].cat || 'Other';
    if (!seen[c]) { seen[c] = true; out.push(c); }
  }
  return out;
}

// Register a custom channel at runtime — e.g. a tune-specific "MHD+" PID
// (MHD+ boost and the like) defined in a user's pidmap.json. def:
//   { key, label?, unit?, iunit?, toImp?, cat?, min?, max?, dp?, warn?, crit?, read? }
// read defaults to a diagnostic read of the key. Re-registering a key updates it.
function register(def) {
  if (!def || !def.key) return null;
  var ch = {
    key: def.key,
    label: def.label || def.key,
    unit: def.unit || '',
    iunit: def.iunit,
    toImp: typeof def.toImp === 'function' ? def.toImp : undefined,
    cat: def.cat || 'Custom',
    read: def.read || diag(def.key),
    min: typeof def.min === 'number' ? def.min : 0,
    max: typeof def.max === 'number' ? def.max : 100,
    dp: typeof def.dp === 'number' ? def.dp : 2,
    warn: typeof def.warn === 'number' ? def.warn : undefined,
    crit: typeof def.crit === 'number' ? def.crit : undefined,
    def: !!def.def,
    custom: true
  };
  if (BY_KEY[ch.key]) {
    var idx = CHANNELS.indexOf(BY_KEY[ch.key]);
    if (idx >= 0) CHANNELS[idx] = ch; else CHANNELS.push(ch);
  } else {
    CHANNELS.push(ch);
  }
  BY_KEY[ch.key] = ch;
  return ch;
}

// Remove all custom channels (called before (re)loading a profile; and in tests).
function unregisterCustom() {
  CHANNELS = CHANNELS.filter(function (c) { return !c.custom; });
  BY_KEY = {};
  for (var n = 0; n < CHANNELS.length; n++) BY_KEY[CHANNELS[n].key] = CHANNELS[n];
}

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
  categories: categories,
  toUnits: toUnits,
  unitLabel: unitLabel,
  register: register,
  unregisterCustom: unregisterCustom
};
