'use strict';
//
// preset_from_csv.js — convert a tuner log-preset CSV (channel names + flags) into a
// Wali Datalog preset (an enabled-channel list). This reads only the parameter
// NAMES and their on/off flags from the user's own exported preset; it maps them
// to our neutral channel keys. It copies no vendor code or scaling.
//
// Usage: node scripts/preset_from_csv.js <presets.csv> [out.json]
//
var fs = require('fs');
var path = require('path');
var Channels = require('../apps/wali_datalog/channels');

function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

// Tuner parameter name (normalised) -> our channel key.
var NAME_MAP = {
  'Accel Ped. Pos.': 'pedal', 'Amb. temp.': 'ambientT', 'Battery volt.': 'battery',
  'Boost': 'boost', 'Boost (mani)': 'boostAbs', 'Boost deviation': 'boostDeviation',
  'Boost setpoint factor': 'boostSetpointFactor', 'Boost target': 'boostTarget',
  'Charge air temp.': 'chargeAirTemp', 'Compressor after P-D': 'compressorAfterPD',
  'Compressor base': 'compressorBase', 'Coolant': 'coolant',
  'Cyl1 Timing Cor': 'knockCyl1', 'Cyl2 Timing Cor': 'knockCyl2', 'Cyl3 Timing Cor': 'knockCyl3',
  'Cyl4 Timing Cor': 'knockCyl4', 'Cyl5 Timing Cor': 'knockCyl5', 'Cyl6 Timing Cor': 'knockCyl6',
  'Ethanol Content (Active)': 'ethanol', 'Ethanol Content (CAN)': 'ethanol',
  'Exhaust flap status': 'exhaustFlap', 'Exhaust gas calculated temp.': 'egt',
  'Fuel level': 'fuelLevel', 'Gear': 'gear', 'IAT': 'iat',
  'Lambda 1': 'lambda', 'Lambda 2': 'lambda2', 'Lambda target': 'lambdaTarget',
  'Load act.': 'load', 'Load req.': 'loadReq', 'LTFT 1': 'ltft',
  'MAF': 'maf', 'MAF REQ (P corr.)': 'mafReq', 'MAF req. WGDC': 'mafReqWg',
  'LC Status': 'launchStatus',
  'Oil pressure': 'oilPressure', 'Oil temp': 'oil',
  'PI+ Direct Inj IDC': 'diInjIdc', 'PI+ Diff. Fuel Press': 'diffFuelPress',
  'PI+ Fuel Mass (Total)': 'fuelMassTotal', 'PI+ LPFP Actual': 'lpfp', 'PI+ LPFP Setpoint': 'lpfpTarget',
  'PI+ Port Inj IDC': 'portInjIdc', 'PI+ Port Inj Actual IPW': 'portInjIpw',
  'Rail pressure dev.': 'railPressureDev', 'Rail pressure mean 1': 'railPressure', 'Rail pressure req.': 'railTarget',
  'Raw pos. EWG': 'wastegatePos', 'RPM': 'rpm', 'Speed': 'speed',
  'STFT 1': 'stft', 'STFT 2': 'stft2',
  'Throttle Pos. Req': 'throttleReq', 'Throttle Position': 'throttle',
  'Timing Cyl. 1': 'timingCyl1', 'Timing Cyl. 2': 'timingCyl2', 'Timing Cyl. 3': 'timingCyl3',
  'Timing Cyl. 4': 'timingCyl4', 'Timing Cyl. 5': 'timingCyl5', 'Timing Cyl. 6': 'timingCyl6',
  'Timing delta for knock adapt.': 'knockAdapt',
  'Torque act. clutch': 'torqueActual', 'Torque lim. 1': 'torqueLimit', 'Status Torque limiter': 'torqueLimiter',
  'Transmission temp': 'transOil', 'Valvelift': 'valvetronic',
  'VANOS EX act.': 'vanosEx', 'VANOS EX req.': 'vanosExTarget', 'VANOS IN act.': 'vanosIn', 'VANOS IN req.': 'vanosInTarget',
  'WG distribution factor': 'wgDistribution', 'WGDC 1': 'wastegate',
  'WGDC D-factor': 'wgdcD', 'WGDC I-factor': 'wgdcI', 'WGDC P-factor': 'wgdcP'
};
// normalise map keys once
var MAP = {};
Object.keys(NAME_MAP).forEach(function (k) { MAP[norm(k)] = NAME_MAP[k]; });

function convert(csvText) {
  var lines = csvText.split(/\r?\n/);
  var ecu = '', enabled = [], seen = {}, unmappedSelected = [], mapped = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) continue;
    if (line.charAt(0) === '#') {
      var m = line.match(/ECU Info:\s*([A-Za-z0-9]+)/);
      if (m) ecu = m[1];
      continue;
    }
    var parts = line.split(';');
    if (parts.length < 2) continue;
    var name = norm(parts[0]);
    if (name === 'Parameter') continue;
    var sel = norm(parts[1]) === '1';
    var key = MAP[name];
    if (key) {
      mapped++;
      if (sel && Channels.get(key) && !seen[key]) { seen[key] = true; enabled.push(key); }
    } else if (sel) {
      unmappedSelected.push(parts[0].trim());
    }
  }
  return { ecu: ecu, enabled: enabled, unmappedSelected: unmappedSelected, mapped: mapped };
}

if (require.main === module) {
  var csvPath = process.argv[2];
  if (!csvPath) { console.error('usage: node scripts/preset_from_csv.js <presets.csv> [out.json]'); process.exit(2); }
  var res = convert(fs.readFileSync(csvPath, 'utf8'));
  var out = { label: 'Imported preset ' + (res.ecu || 'unknown'), ecu: res.ecu, enabled: res.enabled };
  var outPath = process.argv[3] || path.join('presets', (res.ecu || 'preset') + '.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log('ECU: ' + res.ecu);
  console.log('mapped names: ' + res.mapped + ' | enabled channels: ' + res.enabled.length);
  console.log('wrote ' + outPath);
  if (res.unmappedSelected.length) {
    console.log('\nSelected but not represented (' + res.unmappedSelected.length + '):');
    console.log('  ' + res.unmappedSelected.join('\n  '));
  }
}

module.exports = { convert: convert, NAME_MAP: NAME_MAP };
