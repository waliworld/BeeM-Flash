'use strict';
//
// run.js — zero-dependency test runner for the app's pure logic.
//
// Covers formatting, the UDS codec, the log engine (incl. error path), map-
// control gating, the provider's demo fallback, and channel helpers.
//
var A = '../apps/wali_datalog/';
var F = require(A + 'format');
var uds = require(A + 'uds');
var Channels = require(A + 'channels');
var LogEngine = require(A + 'logengine');
var MapControl = require(A + 'mapcontrol');
var Provider = require(A + 'provider');
var Store = require(A + 'storage');
var dme = require(A + 'dme_profiles');
var DiagProvider = require(A + 'diag');
var signalmap = require(A + 'signalmap');

var pass = 0, fail = 0, failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); } }
function eq(a, b, msg) { ok(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function near(a, b, eps, msg) { ok(Math.abs(a - b) <= eps, msg + ' (got ' + a + ', want ~' + b + ')'); }

// ---- SOME/IP signal map (real BMW interface/field/member + struct reader) --
// The four core engine signals use BMW's own TypeConverters (idrive7-apps
// live_data/signals.js) and are the verified bindings.
(function () {
  var m = signalmap.MAP;
  eq(m.engineSpeed.iface, 'de.bmw.infotainment.vehicle.CDS', 'rpm interface');
  eq(m.engineSpeed.field, 'statusEngineSpeed2', 'rpm field');
  eq(m.engineSpeed.member, 'actualValueRPMEngineCrankshaft', 'rpm member');
  ok(m.engineSpeed.verified && m.vehicleSpeed.verified && m.coolantTemp.verified && m.oilTemp.verified, 'core four verified');
  // readValue: member selection + scaling (raw 12000 * 0.25 = 3000 rpm)
  near(signalmap.readValue('engineSpeed', { actualValueRPMEngineCrankshaft: 12000 }), 3000, 1e-9, 'rpm scale 0.25');
  // speed 6400 * 0.015625 = 100 km/h
  near(signalmap.readValue('vehicleSpeed', { speedVehicleCentreOfGravity: 6400 }), 100, 1e-9, 'speed scale 0.015625');
  // coolant raw 138 - 48 = 90 °C
  near(signalmap.readValue('coolantTemp', { temperatureEngineDrive: 138 }), 90, 1e-9, 'coolant offset -48');
  // one struct feeds BOTH coolant and oil (shared statusEngineTemperature)
  var s = { temperatureEngineDrive: 138, temperatureEngineOilDrive: 150 };
  near(signalmap.readValue('coolantTemp', s), 90, 1e-9, 'coolant from shared struct');
  near(signalmap.readValue('oilTemp', s), 102, 1e-9, 'oil from shared struct');
  // "no data" sentinels are rejected (not scaled into a wrong number)
  ok(isNaN(signalmap.readValue('engineSpeed', { actualValueRPMEngineCrankshaft: 65535 })), 'rpm 65535 sentinel -> NaN');
  ok(isNaN(signalmap.readValue('coolantTemp', { temperatureEngineDrive: 255 })), 'coolant 255 sentinel -> NaN');
  ok(isNaN(signalmap.readValue('engineSpeed', {})), 'missing member -> NaN');
  // interfaces() declares the real interfaces for the manifest
  var ifs = signalmap.interfaces();
  ok(ifs['de.bmw.infotainment.vehicle.CDS'] && ifs['de.bmw.infotainment.vehicle.CDS'].statusEngineSpeed2 === 'rs', 'interfaces() lists CDS');
  ok(!ifs.VehicleData, 'no fake VehicleData interface');
  // watchGroups groups by interface then field (coolant+oil share one field)
  var g = signalmap.watchGroups();
  eq(g['de.bmw.infotainment.vehicle.CDS'].fields.statusEngineTemperature.sort().join(','), 'coolantTemp,oilTemp', 'coolant+oil grouped on one field');
})();

// ---- gear decode + G-force + ambient bus signals (car-tested) --------------
(function () {
  // gear: D1..D9 -> 1..9; P/N/R -> 0 (DataPowerTrain2.statusGearSelectionDrive)
  eq(signalmap.readValue('gear', { statusGearSelectionDrive: 5 }), 1, 'gear D1 (raw 5) -> 1');
  eq(signalmap.readValue('gear', { statusGearSelectionDrive: 12 }), 8, 'gear D8 (raw 12) -> 8');
  eq(signalmap.readValue('gear', { statusGearSelectionDrive: 3 }), 0, 'gear P (raw 3) -> 0');
  eq(signalmap.readValue('gear', { statusGearSelectionDrive: 'R' }), 0, 'gear R (string) -> 0');
  eq(signalmap.readValue('gear', { statusGearSelectionDrive: '_6' }), 6, 'gear "_6" -> D6 -> 6');
  ok(signalmap.MAP.gear.verified && signalmap.MAP.gLong.verified && signalmap.MAP.ambientTemp.verified, 'gear/gLong/ambient verified');
  // ambient: raw 120 * 0.5 - 40 = 20 C; sentinel 255 -> NaN
  near(signalmap.readValue('ambientTemp', { temperatureExterior: 120 }), 20, 1e-9, 'ambient raw 120 -> 20 C');
  ok(isNaN(signalmap.readValue('ambientTemp', { temperatureExterior: 255 })), 'ambient 255 sentinel -> NaN');
  // G-force: value = (raw*0.002 - 65) / 9.80665 g; raw 32500 -> 0 g (centre)
  near(signalmap.readValue('gLong', { longitudinalAccelerationCentreOfGravity: 32500 }), 0, 1e-6, 'gLong centre -> 0 g');
  near(signalmap.readValue('gLong', { longitudinalAccelerationCentreOfGravity: 37403 }), 1, 1e-2, 'gLong +1 g');
  near(signalmap.readValue('gLat', { lateralAccelerationCentreOfGravity: 32500 }), 0, 1e-6, 'gLat centre -> 0 g');
})();

// ---- bmw_obd DME profile (car-tested DIDs) + relative-boost derivation ------
(function () {
  var p = dme.get('bmw_obd');
  ok(p.verified === true, 'bmw_obd profile is verified (shown live, not suppressed)');
  eq(p.ecu, 0x12, 'bmw_obd targets the DME control unit (0x12)');
  var r = p.reads;
  near(90 * r.iat.m + r.iat.b, 50, 1e-9, 'bmw_obd iat: raw 90 -> 50 C (offset -40)');
  near(148 * r.timing.m + r.timing.b, 10, 1e-9, 'bmw_obd timing: raw 148 -> 10 BTDC (x0.5, offset -64)');
  near(3200 * r.boostAbs.m + r.boostAbs.b, 1.0, 1e-6, 'bmw_obd manifold abs: raw 3200 -> 1.0 bar');
  near(101 * r.baro.m + r.baro.b, 1.01, 1e-6, 'bmw_obd baro: raw 101 -> 1.01 bar');
  near(2000 * r.railPressure.m + r.railPressure.b, 200, 1e-9, 'bmw_obd rail: raw 2000 -> 200 bar');
  // relative boost derived in the provider when not read directly (manifold - baro)
  var prov = new Provider({}, {
    getSetting: function (k) { return { demo: 'off', source: 'diag' }[k]; },
    diag: { read: function () { return { boostAbs: 2.5, baro: 1.0 }; } }
  });
  var out = prov.read(1000);
  near(out.values.boost, 1.5, 1e-9, 'relative boost derived = manifold (2.5) - baro (1.0)');
  ok(out.live === true, 'diag live values mark the sample live');
})();

// ---- seedkey.makeAlgo: declarative, configurable key algorithms ------------
(function () {
  var seedkey = require(A + 'seedkey');
  eq(seedkey.makeAlgo({ type: 'add', value: 1 })([1, 2, 3]).join(','), '2,3,4', 'makeAlgo add +1');
  eq(seedkey.makeAlgo({ type: 'sub', value: 1 })([2, 3, 4]).join(','), '1,2,3', 'makeAlgo sub');
  eq(seedkey.makeAlgo({ type: 'xor', value: 0xFF })([0x01]).join(','), String(0xFE), 'makeAlgo xor const');
  eq(seedkey.makeAlgo({ type: 'xorkey', key: [0xF0, 0x0F] })([0x11, 0x22]).join(','), (0x11 ^ 0xF0) + ',' + (0x22 ^ 0x0F), 'makeAlgo xorkey (repeating)');
  eq(seedkey.makeAlgo({ type: 'reverse' })([1, 2, 3]).join(','), '3,2,1', 'makeAlgo reverse');
  eq(seedkey.makeAlgo({ type: 'const', key: [9, 9] })([1, 2, 3]).join(','), '9,9', 'makeAlgo const');
  eq(seedkey.makeAlgo({ type: 'pipe', steps: [{ type: 'add', value: 1 }, { type: 'reverse' }] })([1, 2, 3]).join(','), '4,3,2', 'makeAlgo pipe (add then reverse)');
  ok(seedkey.makeAlgo(null) === null, 'makeAlgo null spec -> null');
  ok(typeof seedkey.makeAlgo(function (s) { return s; }) === 'function', 'makeAlgo passes a function spec through');
})();

// ---- custom PID channels (tune-specific "MHD+" PIDs, e.g. MHD+ boost) -------
(function () {
  Channels.unregisterCustom();
  var before = Channels.all().length;
  var prof = dme.fromJson({ label: 'tune', reads: {
    mhdplus_boost: { did: 0x4A01, off: 0, len: 2, m: 0.001, b: -1, label: 'MHD+ Boost', unit: 'bar', min: -1, max: 4, dp: 2 },
    nometa_key: { did: 0x4A02 }
  } });
  var ch = Channels.get('mhdplus_boost');
  ok(!!ch && ch.label === 'MHD+ Boost' && ch.unit === 'bar', 'custom PID registered from pidmap metadata');
  eq(ch.cat, 'Custom', 'custom PID categorised as Custom');
  ok(ch.read.kind === 'diag' && ch.read.key === 'mhdplus_boost', 'custom PID reads via diagnostics');
  ok(!!prof.reads.mhdplus_boost && prof.reads.mhdplus_boost.did === 0x4A01, 'custom PID DID kept in the built profile');
  ok(!Channels.get('nometa_key') && !prof.reads.nometa_key, 'unknown key without metadata is ignored');
  eq(Channels.all().length, before + 1, 'catalogue grew by one custom channel');
  Channels.unregisterCustom();
  ok(!Channels.get('mhdplus_boost') && Channels.all().length === before, 'unregisterCustom removes custom channels');
})();

// ---- format ---------------------------------------------------------------
eq(F.csvRow(['a', 'b,c', 'd"e']), 'a,"b,c","d""e"', 'csv escaping');
eq(F.mmss(65000), '01:05', 'mmss');
eq(F.humanBytes(2048), '2.0 KB', 'humanBytes');
near(F.cToF(100), 212, 1e-6, 'cToF');
near(F.barToPsi(1), 14.5038, 1e-3, 'barToPsi');
eq(F.display(NaN, 1, 'bar'), '--', 'display invalid');
eq(F.stamp(0).length, 15, 'stamp length YYYYMMDD-HHMMSS');

// ---- uds ------------------------------------------------------------------
eq(uds.toHex(uds.buildReadDataByIdentifier(0x4000)), '22 40 00', 'RDBI frame');
var pr = uds.parseResponse(uds.SID.READ_DID, [0x62, 0x40, 0x00, 0x07, 0xD0]);
ok(pr.positive && pr.did === 0x4000, 'RDBI positive parse');
eq(uds.readInt(pr.data, 0, 2, false, false), 2000, 'readInt BE');
eq(uds.readInt([0x10, 0x00], 0, 2, false, true), 0x0010, 'readInt LE');
eq(uds.readInt([0xFF, 0xFF], 0, 2, true, false), -1, 'readInt signed');
near(uds.scaleFromSpec([0x07, 0xD0], { off: 0, len: 2, m: 0.001, b: -1 }), 1.0, 1e-9, 'scaleFromSpec');
var neg = uds.parseResponse(uds.SID.READ_DID, [0x7f, 0x22, 0x31]);
ok(!neg.positive && neg.nrcName === 'requestOutOfRange', 'negative response NRC');
var rc = uds.parseResponse(uds.SID.ROUTINE, [0x71, 0x01, 0x61, 0x1e, 0x00]);
ok(rc.positive && rc.rid === 0x611e && rc.sub === 0x01, 'routine positive parse');

// ---- channels -------------------------------------------------------------
ok(Channels.defaults().indexOf('rpm') >= 0, 'rpm is a default channel');
near(Channels.toUnits(Channels.get('speed'), 100, 'imperial'), 62.1371, 1e-3, 'speed to mph');
eq(Channels.unitLabel(Channels.get('boost'), 'imperial'), 'psi', 'boost imperial unit');

// ---- extended PID profile + packed blocks --------------------------------
ok(Channels.all().length > 85, 'catalogue has 85+ channels (extended class)');
ok(!!Channels.get('timingCyl6') && !!Channels.get('knockCyl6'), 'per-cylinder channels present');
ok(!!Channels.get('wgdcP') && !!Channels.get('boostDeviation') && !!Channels.get('loadReq'), 'B58 wastegate/boost control channels present');

// tuner log-preset CSV -> preset converter (names + flags only; no vendor data)
(function () {
  var conv = require('../scripts/preset_from_csv');
  var csv = [
    '#ECU Info: 0000TEST',
    'Parameter;Selected',
    'RPM;1', 'Boost;1', 'WGDC P-factor;1', 'Cyl1 Timing Cor;1',
    'Amb. temp.;0', 'RF Max Index;1'
  ].join('\n');
  var r = conv.convert(csv);
  eq(r.ecu, '0000TEST', 'converter reads ECU id');
  ok(r.enabled.indexOf('rpm') >= 0 && r.enabled.indexOf('boost') >= 0 && r.enabled.indexOf('wgdcP') >= 0, 'selected names map to keys');
  ok(r.enabled.indexOf('knockCyl1') >= 0, 'Cyl1 Timing Cor -> knockCyl1');
  ok(r.enabled.indexOf('ambientT') < 0, 'unselected names are excluded');
  ok(r.unmappedSelected.indexOf('RF Max Index') >= 0, 'unmapped selected names are reported');
})();

// Measurement-definition importer (ISTA/INPA/tuner table -> pidmap.json)
(function () {
  var mi = require('../scripts/pidmap_from_measurements');
  var rows = mi.parseCsv('name;did;off;len;scale;signed\nLadedruck;0x4100;0;2;0.03;false\nZuendwinkel;0x4101;0;1;0.5;true\nBogus Chan;0x4102;0;2;1;false');
  var r = mi.build(rows);
  ok(r.reads.boostAbs && r.reads.boostAbs.did === 0x4100, 'German "Ladedruck" + hex DID -> boostAbs');
  ok(r.reads.timing && r.reads.timing.did === 0x4101 && r.reads.timing.signed === true, 'German "Zuendwinkel" -> timing (signed)');
  ok(r.unmapped.indexOf('Bogus Chan') >= 0, 'unknown measurement name is reported, not guessed');
  eq(mi.keyFor('Oil temperature'), 'oil', 'English BMW alias maps to channel key');
})();

// Unified enhanced-PID dataset + curated pidmap composition
(function () {
  var dsb = require('../scripts/build_pid_dataset');
  var pfd = require('../scripts/pidmap_from_dataset');
  var dt = dsb.dtype('signed int'); eq(dt.bytes, 2, 'data type "int" = 2 bytes'); ok(dt.signed, '"signed int" is signed');
  var dt2 = dsb.dtype('unsigned char'); eq(dt2.bytes, 1, '"char" = 1 byte'); ok(!dt2.signed, '"unsigned char" unsigned');
  var csv = dsb.COLS.join(',') + '\n' +
    'B58,,,Coolant temperature,enhanced_pid,0x4300,,i16,big,0.1,-273.14,C,src,false\n' +
    'B58,,,Boost pressure,enhanced_pid,0x4205,,u16,big,0.078125,0,hPa,src,false';
  var res = pfd.build(csv, { platform: 'B58', select: { coolant: { pid: '0x4300', uscale: 1 }, boostAbs: { pid: '0x4205', uscale: 0.001 } } });
  eq(res.mapped, 2, 'composed 2 channels from dataset');
  var c = res.reads.coolant;
  eq(c.did, 0x4300, 'coolant DID'); eq(c.len, 2, 'coolant len'); ok(c.signed, 'coolant signed');
  near(c.m, 0.1, 1e-9, 'coolant scale'); near(c.b, -273.14, 1e-6, 'coolant offset');
  var b = res.reads.boostAbs;
  near(b.m, 0.078125 * 0.001, 1e-12, 'boost hPa->bar unit conversion folded into scale');
  ok(b.signed === false, 'boost unsigned');
})();

// A2L MEASUREMENT parser (ASAM) -> address dataset rows
(function () {
  var a2l = require('../scripts/a2l_to_dataset');
  var txt = [
    '/begin COMPU_METHOD cm_boost', '""', 'RAT_FUNC', '"%6.4" "hPa"', 'COEFFS 0 128 0 0 0 3', '/end COMPU_METHOD',
    '/begin MEASUREMENT Boost_abs', '"Boost pressure"', 'UWORD', 'cm_boost',
    'ECU_ADDRESS 0x50001234', 'BYTE_ORDER MSB_LAST', '/end MEASUREMENT'
  ].join('\n');
  var rows = a2l.parse(txt);
  eq(rows.length, 1, 'A2L: one measurement parsed');
  var r = rows[0];
  eq(r.identifier, '0x50001234', 'A2L: ECU_ADDRESS captured');
  eq(r.data_type, 'u16', 'A2L: UWORD -> u16');
  eq(r.endianness, 'little', 'A2L: MSB_LAST -> little-endian');
  near(r.scale, 3 / 128, 1e-9, 'A2L: RAT_FUNC linear scale = f/b');
  eq(r.unit, 'hPa', 'A2L: unit from COMPU_METHOD');
  // UDS ReadMemoryByAddress frame
  eq(uds.toHex(uds.buildReadMemoryByAddress(0x50001234, 2)), '23 24 50 00 12 34 00 02', 'UDS 0x23 frame (4-byte addr, 2-byte size)');
})();
(function () {
  var tmpl = dme.get('generic_template');
  ok(Object.keys(tmpl.reads).length > 30, 'template covers many diag channels');
  ok(tmpl.verified === false, 'template is unverified (suppressed in strict mode)');

  var prof = dme.fromJson({
    label: 't', verified: true,
    reads: {
      boost: { did: 0x4100, off: 0, len: 2, m: 0.001, b: -1 },
      iat: { did: 0x4100, off: 2, len: 2, m: 0.1, b: -40, signed: true },
      railPressure: { did: 0x4101, off: 0, len: 2, m: 0.1 }
    }
  });
  var blocks = dme.byDid(prof);
  eq(blocks.length, 2, 'two DIDs -> two packed blocks');
  eq(blocks[0].fields.length, 2, 'first block packs 2 channels (boost+iat share a DID)');
  ok(dme.fromJson({ reads: { not_a_channel: { did: 1 } } }).reads.not_a_channel === undefined, 'unknown channel ignored');
  var threw = false; try { dme.fromJson({ reads: { boost: { off: 0 } } }); } catch (e) { threw = true; }
  ok(threw, 'profile entry without a did is rejected');
})();

// ---- fast block decode (UDS 2C 88 01 -> 36-byte LE packed block) ----------
(function () {
  var FastLog = require(A + 'fastlog');
  var body = [];
  for (var i = 0; i < 36; i++) body.push(0);
  function u16(off, v) { body[off] = v & 0xff; body[off + 1] = (v >> 8) & 0xff; }
  u16(0x00, 3000);   // RPM
  u16(0x02, 5000);   // LOAD -> 50.00 %
  u16(0x04, 12800);  // BOOST -> ~1.00 bar (psi->bar)
  u16(0x0C, 9000);   // ENGINETEMP -> 90 C
  body[0x0E] = 3;    // GEAR
  u16(0x1C, 100);    // SPEED
  u16(0x20, 300);    // INTAKEAIRTEMP -> 30 C
  var reply = [0x6C, 0x88].concat(body);
  var v = FastLog.decodeReply(reply, 'B58');
  eq(v.rpm, 3000, 'fast log: RPM');
  near(v.load, 50.0, 1e-6, 'fast log: LOAD (signed, %)');
  near(v.boost, 1.0, 0.01, 'fast log: BOOST psi->bar');
  near(v.coolant, 90.0, 1e-6, 'fast log: ENGINETEMP -> coolant');
  eq(v.gear, 3, 'fast log: GEAR');
  eq(v.speed, 100, 'fast log: SPEED');
  near(v.iat, 30.0, 1e-6, 'fast log: INTAKEAIRTEMP -> iat');
  ok(FastLog.decodeReply([0x7f, 0x2c, 0x31].concat(body), 'B58') === null, 'negative monitor reply -> null');
})();

// ---- DoIP (ISO 13400) read transport --------------------------------------
(function () {
  var doip = require(A + 'doip');
  eq(uds.toHex(doip.buildRoutingActivation(0x0E00, 0x00)),
    '02 fd 00 05 00 00 00 07 0e 00 00 00 00 00 00', 'DoIP routing-activation frame');
  var dm = doip.buildDiagnosticMessage(0x0E00, 0x1000, [0x62, 0x41, 0x00, 0x07, 0xd0]);
  var r = doip.parseFrames(dm);
  eq(r.frames.length, 1, 'DoIP: one frame parsed'); eq(r.frames[0].type, doip.PT.DIAG, 'DoIP: diag payload type');
  // client round-trip over a fake socket
  var dataCb = null;
  var sock = {
    onData: function (fn) { dataCb = fn; },
    write: function (b) {
      var f = doip.parseFrames(b).frames[0];
      if (f.type === doip.PT.ROUTE_REQ) dataCb(doip.header(doip.PT.ROUTE_RESP, [0x0e, 0x00, 0x10, 0x00, 0x10, 0, 0, 0, 0]));
      else if (f.type === doip.PT.DIAG) dataCb(doip.buildDiagnosticMessage(0x1000, 0x0e00, [0x62, 0x41, 0x00, 0x07, 0xd0]));
    },
    close: function () {}
  };
  var tr = doip.makeDoipTransport({ socket: sock, targetAddr: 0x1000 });
  var got = null;
  tr.send([0x22, 0x41, 0x00], function (err, resp) { got = { err: err, resp: resp }; });
  ok(got && !got.err, 'DoIP transport activates then returns a reply');
  eq(uds.toHex(got.resp), '62 41 00 07 d0', 'DoIP transport unwraps the UDS reply');
})();

// ---- DoIP vehicle discovery (ISO 13400 Vehicle Identification) ------------
(function () {
  var doip = require(A + 'doip');
  eq(uds.toHex(doip.buildVehicleIdentificationRequest()), '02 fd 00 01 00 00 00 00', 'vehicle ID request frame (empty payload)');

  // Build a crafted announcement payload: VIN(17) + logicalAddr(2) + EID(6) + GID(6) + FAR(1)
  var payload = [];
  'WBA00000000000001'.slice(0, 17).split('').forEach(function (c) { payload.push(c.charCodeAt(0)); });
  payload.push(0x10, 0x01); // logical address 0x1001
  for (var i = 0; i < 6; i++) payload.push(0xAA);
  for (var i2 = 0; i2 < 6; i2++) payload.push(0xBB);
  payload.push(0x00);
  var v = doip.parseVehicleAnnouncement(payload);
  eq(v.vin, 'WBA00000000000001', 'announcement: VIN decoded');
  eq(v.logicalAddress, 0x1001, 'announcement: logical address decoded');

  var datagram = doip.header(doip.PT.VEHICLE_ANNOUNCE, payload);
  var v2 = doip.decodeAnnouncementDatagram(datagram);
  ok(v2 && v2.vin === 'WBA00000000000001', 'full datagram decodes to the same announcement');
  ok(doip.decodeAnnouncementDatagram(doip.header(doip.PT.ROUTE_RESP, [0, 0, 0, 0, 0])) === null, 'non-announcement datagram -> null');

  ok(doip.parseVehicleAnnouncement([1, 2, 3]) === null, 'short payload -> null, not a crash');
})();

// ---- enetgate.js: the vehicle-connection safety gate (synchronous parts) --
(function () {
  var EnetGate = require(A + 'enetgate');

  var mem = Store.memStorage();
  var g = new EnetGate({ storage: mem });
  ok(!g.acknowledged && !g.enabled, 'enetgate: starts fully disabled and unacknowledged');

  var r1 = g.setEnabled(true);
  ok(!r1.ok && !g.enabled, 'enetgate: enabling before acknowledgment is refused');

  g.acknowledge();
  var r2 = g.setEnabled(true);
  ok(r2.ok && g.enabled, 'enetgate: enabling after acknowledgment succeeds');
  ok(g.status().connected === false, 'enetgate: not "connected" until a vehicle is set');

  g.setVehicle({ host: '169.254.1.1', logicalAddress: 0x1000, vin: 'X' });
  ok(g.status().connected === true, 'enetgate: connected once enabled + a vehicle is known');

  g.setEnabled(false);
  ok(g.vehicle === null, 'enetgate: disabling forgets the discovered vehicle');

  // The core safety property: acknowledgment persists, but "enabled" never does.
  var g2 = new EnetGate({ storage: mem });
  ok(g2.acknowledged === true, 'enetgate: acknowledgment persists across restarts');
  ok(g2.enabled === false, 'enetgate: "enabled" is never persisted -- always false on a fresh start');
})();

// Helpers for the async discovery/gate assertions folded into the main chain
// below (kept out of a detached Promise so nothing can race report()/exit()).
function announceBytes(vin, addr) {
  var doipMod = require(A + 'doip');
  var p = [];
  vin.split('').forEach(function (c) { p.push(c.charCodeAt(0)); });
  while (p.length < 17) p.push(0x20);
  p.push((addr >> 8) & 0xff, addr & 0xff);
  for (var i = 0; i < 12; i++) p.push(0);
  p.push(0);
  return doipMod.header(doipMod.PT.VEHICLE_ANNOUNCE, p);
}
function makeFakeDiscoverySocket(respond) {
  var cb = null;
  return {
    onMessage: function (fn) { cb = fn; },
    send: function () { if (respond) respond(function (bytes, rinfo) { cb(bytes, rinfo); }); },
    close: function () {}
  };
}

// ---- log engine -----------------------------------------------------------
(function () {
  var mem = Store.memStorage();
  var t = 1000;
  var eng = new LogEngine({ storage: mem, clock: function () { return t; }, flushEveryRows: 3 });
  eng.configure({ channels: ['rpm', 'boost', 'afr'], rate: 10, units: 'metric' });
  ok(eng.start(), 'engine starts');
  eq(eng.state, 'logging', 'state logging');
  for (var i = 0; i < 5; i++) { t += 100; if (i === 2) eng.marker('m'); eng.sample({ rpm: 3000 + i, boost: 1.2, lambda: 0.85 }); }
  eng.stop();
  eq(eng.state, 'done', 'state done');
  eq(eng.stats.samples, 5, 'sample count');
  eq(eng.stats.markers, 1, 'marker count');
  var allLines = mem.read(eng.file).trim().split('\n');
  // data rows are everything before the commented summary footer
  var lines = allLines.filter(function (l) { return l.indexOf('#') !== 0 && l.trim() !== ''; });
  eq(lines.length, 6, 'header + 5 rows');
  ok(allLines.some(function (l) { return /session summary/.test(l); }), 'summary footer written');
  ok(lines[0].indexOf('afr[:1]') >= 0, 'derived afr column present');
  ok(lines[3].split(',')[2] === 'm', 'marker lands on row 3');
  // derived afr = lambda*14.7
  var afrCol = lines[0].split(',').indexOf('afr[:1]');
  near(parseFloat(lines[1].split(',')[afrCol]), 0.85 * 14.7, 0.05, 'afr value');
  // config preserved across start()
  ok(lines[0].indexOf('rpm') >= 0 && lines[0].indexOf('speed') < 0, 'configure preserved through start');
})();

// ---- session summary + dyno run capture (#23) ------------------------------
(function () {
  var mem = Store.memStorage();
  var tk = 0;
  var eng = new LogEngine({ storage: mem, clock: function () { return (tk += 100); } });
  eng.configure({ channels: ['rpm', 'boost'], rate: 10 });
  eng.start();
  for (var i = 0; i < 10; i++) eng.sample({ rpm: 3000 + i * 100, boost: 1 + i * 0.1 });
  var sum = eng.getSummary();
  var rpm = sum.filter(function (x) { return x.key === 'rpm'; })[0];
  ok(rpm && rpm.n === 10 && rpm.min === 3000 && rpm.max === 3900, 'summary: per-channel min/max/avg tracked');
  near(rpm.avg, 3450, 1, 'summary: average correct');
  eng.stop();
  ok(/session summary/.test(mem.read(eng.file)), 'summary: footer appended to CSV');
})();

(function () {
  var RunCapture = require(A + 'runcapture');
  var rc = new RunCapture({ massKg: 1600 });
  var t = 0, v = 20;
  for (var i = 0; i < 60; i++) { t += 100; v = Math.min(v + 3.5, 250); rc.feed({ pedal: 100, rpm: 3000 + i * 60, speed: v, boost: 2.1, gLong: 0.6 }, t); }
  for (var j = 0; j < 6; j++) { t += 100; v = Math.max(0, v - 3); rc.feed({ pedal: 0, rpm: 4000, speed: v, boost: 0.2, gLong: -0.4 }, t); }
  var run = rc.last();
  ok(run && run.peakPowerHp > 0, 'runcapture: captures a pull with a positive power estimate');
  ok(run.peakPowerCrankHp > run.peakPowerHp, 'runcapture: crank estimate above wheel estimate');
  near(run.peakBoost, 2.1, 1e-6, 'runcapture: records peak boost');
  ok(run.durationMs >= 800 && run.peakPowerRpm > 0, 'runcapture: run duration + peak rpm recorded');
  // no pull without WOT
  var rc2 = new RunCapture(); var tt = 0;
  for (var k = 0; k < 40; k++) { tt += 100; rc2.feed({ pedal: 20, rpm: 2000, speed: 40 + k * 0.1, boost: 0.3 }, tt); }
  ok(rc2.last() === null, 'runcapture: no pull captured when off-throttle');
})();

(function () {
  var Demo = require(A + 'demo');
  var d = new Demo(), s = null;
  for (var i = 0; i < 400; i++) s = d.sample(1700000000000 + i * 50);
  ['ethanol', 'ethanolTarget', 'flexFactor', 'fuelTemp', 'portRailPressure', 'portRailTarget',
    'portInjTarget', 'portInjSplit', 'portInjActive', 'portFuelMass', 'diFuelMass'].forEach(function (k) {
    ok(typeof s[k] === 'number' && isFinite(s[k]), 'demo: ' + k + ' produced for the datalogger');
  });
  // flex-fuel + port-injection channels exist in the catalogue
  ['ethanol', 'flexFactor', 'fuelTemp', 'portRailPressure', 'portInjSplit', 'portInjActive'].forEach(function (k) {
    ok(!!Channels.get(k), 'channels: ' + k + ' in the catalogue');
  });
  // both OBD boost PIDs available; 0x0B saturates at 2.55 bar, 0x70 does not
  ok(!!Channels.get('boostObd0B') && !!Channels.get('boostObd70'), 'channels: both OBD boost PIDs (0x0B and 0x70) available');
  ok(s.boostObd0B <= 2.5500001 && s.boostObd70 >= s.boostObd0B - 1e-6, 'demo: OBD 0x0B saturates while 0x70 does not');
})();

// ---- tune detection (computeTune heuristic) --------------------------------
(function () {
  var ecuinfo = require(A + 'ecuinfo');
  function item(did, value) { return { did: did, value: value, ok: true }; }
  // signature match
  var t1 = ecuinfo.computeTune([item(0xF17C, 'CAL_MHD_STG2'), item(0xF194, '00008051')], {});
  ok(t1.detected === 'MHD' && t1.modified === true, 'tune: MHD signature detected in calibration ID');
  // stock list match -> looks stock
  var t2 = ecuinfo.computeTune([item(0xF17C, 'STOCK_ABC')], { stockCalIds: ['STOCK_ABC'] });
  ok(t2.modified === false && !t2.detected, 'tune: calibration ID in stock list -> looks stock');
  // not in stock list -> modified
  var t3 = ecuinfo.computeTune([item(0xF17C, 'WEIRD_XYZ')], { stockCalIds: ['STOCK_ABC'] });
  ok(t3.modified === true, 'tune: calibration ID not in stock list -> looks modified');
  // unknown (no list, no signature) -> honest null
  var t4 = ecuinfo.computeTune([item(0xF17C, 'SOME_CAL')], {});
  ok(t4.modified === null && /compare/i.test(t4.note), 'tune: unknown without a stock reference, reported honestly');

  // ---- definitive matching against the bundled stock DB (from A2Ls) --------
  var stockdb = require(A + 'stockdb');
  ok(Object.keys(stockdb.ecus).length >= 3 && stockdb.ecus.MG1CS049 && stockdb.ecus.MG1CS201, 'stockdb: bundled with S58 + B58 Gen2 DMEs');
  var s58ver = stockdb.ecus.MG1CS049.versions[0];       // a real stock S58 version
  var s58tok = stockdb.ecus.MG1CS049.fileTokens[0];
  // stock S58 calibration -> definitively stock
  var t5 = ecuinfo.computeTune([item(0xF191, 'MG1CS049'), item(0xF17C, s58ver)], {});
  ok(t5.modified === false && t5.matchedStock && t5.ecuType === 'MG1CS049', 'tune: stock S58 calibration matched -> looks stock');
  ok(/stock/i.test(t5.note), 'tune: stock match note mentions stock');
  // filename-token form also matches
  var t6 = ecuinfo.computeTune([item(0xF191, 'MG1CS049'), item(0xF17C, s58tok)], {});
  ok(t6.modified === false && t6.matchedStock, 'tune: stock version in filename-token form also matches');
  // known DME, calibration not in the stock set -> definitively modified
  var t7 = ecuinfo.computeTune([item(0xF191, 'MG1CS049'), item(0xF17C, 'TUNED_NOTSTOCK_01')], {});
  ok(t7.modified === true && t7.ecuType === 'MG1CS049' && /not in the known-stock set/i.test(t7.note), 'tune: known DME with unknown calibration -> looks modified');
  // B58 Gen2 stock version matches its ECU
  var g2 = stockdb.ecus.MG1CS201.versions[0];
  var t8 = ecuinfo.computeTune([item(0xF191, 'MG1CS201'), item(0xF17C, g2)], {});
  ok(t8.modified === false && t8.matchedStock, 'tune: stock B58 Gen2 calibration matched -> looks stock');

  // numeric stock software ID (from the bin fingerprints) also matches stock
  var binverify = require(A + 'binverify');
  var numId = binverify.stockIds.MG1CS201 && binverify.stockIds.MG1CS201[0];
  if (numId) {
    var t9 = ecuinfo.computeTune([item(0xF191, 'MG1CS201'), item(0xF194, '0000' + numId.slice(4))], {});
    var t9b = ecuinfo.computeTune([item(0xF191, 'MG1CS201'), item(0xF194, numId)], {});
    ok(t9b.modified === false && t9b.matchedStock === numId, 'tune: numeric stock software ID matched -> looks stock');
  }
})();

// ---- bin fingerprint verification (close the ID-preserving-tune gap) --------
(function () {
  var binverify = require(A + 'binverify');
  var stockbins = require(A + 'stockbins');
  // SHA-256 correctness, both the crypto fast path and the pure-JS fallback.
  var abc = [0x61, 0x62, 0x63]; // "abc"
  var want = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  eq(binverify.sha256(abc), want, 'binverify: sha256("abc") (primary path)');
  eq(binverify._sha256js(abc), want, 'binverify: sha256("abc") (pure-JS fallback)');
  // empty input vector
  eq(binverify._sha256js([]), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'binverify: sha256("") pure-JS');
  // fingerprint DB present with stock + MHD+ images
  var shas = Object.keys(stockbins.bySha);
  ok(shas.length >= 100, 'stockbins: fingerprint DB bundled');
  var hasStock = shas.some(function (s) { return stockbins.bySha[s].k === 'stock'; });
  var hasMhd = shas.some(function (s) { return stockbins.bySha[s].k === 'mhdplus'; });
  ok(hasStock && hasMhd, 'stockbins: has both stock and MHD+ fingerprints');
  // a known stock hash resolves to a stock image; a known MHD+ hash to mhdplus
  var stockSha = shas.filter(function (s) { return stockbins.bySha[s].k === 'stock'; })[0];
  var mhdSha = shas.filter(function (s) { return stockbins.bySha[s].k === 'mhdplus'; })[0];
  var vs = binverify.verifyHash(stockSha);
  ok(vs.match && vs.kind === 'stock' && /^[0-9A-F]+$/.test(vs.id), 'binverify: stock fingerprint -> STOCK image');
  ok(/STOCK image/.test(binverify.describe(vs)), 'binverify: describe() names the stock image');
  var vm = binverify.verifyHash(mhdSha);
  ok(vm.match && vm.kind === 'mhdplus', 'binverify: MHD+ base fingerprint -> MHD+ detected');
  // an unknown image (bytes not in the DB) -> no match, honest hex
  var vr = binverify.verify([1, 2, 3, 4, 5]);
  ok(vr.match === false && /^[0-9a-f]{64}$/.test(vr.sha256), 'binverify: unknown image -> no match, reports its hash');
})();

// error path: storage that throws on open -> engine error state
(function () {
  var bad = { open: function () { throw new Error('disk full'); } };
  var eng = new LogEngine({ storage: bad, clock: function () { return 1; } });
  eng.start();
  eq(eng.state, 'error', 'engine enters error on open failure');
  ok(/disk full/.test(eng.errorMsg), 'error message captured');
})();

// ---- map control gating ---------------------------------------------------
(function () {
  var off = new MapControl({ enabled: false });
  ok(!off.prepare(1, { speed: 0, rpm: 800 }).ok, 'disabled blocks switch');
  var on = new MapControl({ enabled: true });
  ok(!on.prepare(1, { speed: 40, rpm: 800 }).ok, 'moving blocks switch');
  ok(!on.prepare(1, { speed: 0, rpm: 4000 }).ok, 'high rpm blocks switch');
  var good = on.prepare(2, { speed: 0, rpm: 800 });
  ok(good.ok && good.speedOk && good.idleOk, 'stationary+idle allows switch');
})();

// map control commit (async) with a fake diagnostic transport
function fakeDiag(positive) {
  return {
    sessionControl: function () { return Promise.resolve({ positive: true }); },
    security: function () { return Promise.resolve({ ok: true }); },
    routineControl: function () { return Promise.resolve({ positive: positive, nrcName: positive ? null : 'conditionsNotCorrect' }); }
  };
}

// ---- provider demo fallback ----------------------------------------------
(function () {
  var s = { demo: 'on' };
  var p = new Provider({}, { getSetting: function (k) { return s[k]; } });
  var r = p.read(0);
  ok(r.demo === true, 'demo on -> demo true');
  ok(F.isNum(r.values.rpm) && F.isNum(r.values.afr), 'demo provides rpm and derived afr');

  var s2 = { demo: 'off' };
  var p2 = new Provider({}, { getSetting: function (k) { return s2[k]; } });
  var r2 = p2.read(0);
  ok(r2.demo === false && r2.live === false, 'demo off + no source -> not demo, not live');
  ok(!F.isNum(r2.values.rpm), 'no live data -> NaN values');

  var s3 = { demo: 'auto' };
  var p3 = new Provider({}, { getSetting: function (k) { return s3[k]; } });
  var a0 = p3.read(1000); ok(!a0.demo, 'auto: not demo immediately');
  var a1 = p3.read(1000 + 6000); ok(a1.demo === true, 'auto: demo after 5s without data');
})();

// ---- async section + report ----------------------------------------------
Promise.resolve()
  .then(function () {
    // honest commit: no read-back configured -> accepted but NOT confirmed
    var on = new MapControl({ enabled: true });
    return on.commit(2, { speed: 0, rpm: 800 }, fakeDiag(true), true).then(function (res) {
      ok(res.ok && res.confirmed === false, 'commit: accepted but unconfirmed without read-back');
      ok(/requested/i.test(res.message), 'commit: message says "requested" (no overclaim)');
      ok(on.selected === null, 'commit: active map stays unknown when unconfirmed');
    });
  })
  .then(function () {
    // read-back CONFIRMS the requested map -> confirmed, active set
    var on = new MapControl({ enabled: true, config: { statusDid: 0x4B00 } });
    var diag = fakeDiag(true); diag.readDid = function () { return Promise.resolve({ positive: true, data: [2] }); };
    return on.commit(2, { speed: 0, rpm: 800 }, diag, true).then(function (res) {
      ok(res.ok && res.confirmed === true, 'commit: read-back confirms the switch');
      ok(on.selected === 2, 'commit: active map set only after confirmation');
    });
  })
  .then(function () {
    // read-back MISMATCH -> not confirmed, active stays unknown
    var on = new MapControl({ enabled: true, config: { statusDid: 0x4B00 } });
    var diag = fakeDiag(true); diag.readDid = function () { return Promise.resolve({ positive: true, data: [0] }); };
    return on.commit(2, { speed: 0, rpm: 800 }, diag, true).then(function (res) {
      ok(res.ok && res.confirmed === false, 'commit: read-back mismatch -> unconfirmed');
      ok(on.selected === null, 'commit: active stays unknown on mismatch');
    });
  })
  .then(function () {
    var on = new MapControl({ enabled: true });
    return on.commit(2, { speed: 0, rpm: 800 }, fakeDiag(false), true).then(function (res) {
      ok(!res.ok && /rejected/i.test(res.message), 'commit reports DME rejection');
    });
  })
  .then(function () {
    var on = new MapControl({ enabled: true });
    return on.commit(1, { speed: 50, rpm: 800 }, fakeDiag(true), true).then(function (res) {
      ok(!res.ok, 'commit refuses when moving (never calls DME)');
    });
  })
  .then(function () {
    // demo/stale data (live=false) is refused
    var on = new MapControl({ enabled: true });
    return on.commit(2, { speed: 0, rpm: 800 }, fakeDiag(true), false).then(function (res) {
      ok(!res.ok && /live/i.test(res.message), 'commit refuses demo/stale data');
    });
  })
  .then(function () {
    // Packed-block read: one DID returns boost (raw 2000) + iat (raw 650).
    var prof = dme.fromJson({
      label: 'pk', verified: true,
      reads: {
        boost: { did: 0x4100, off: 0, len: 2, m: 0.001, b: -1 },
        iat: { did: 0x4100, off: 2, len: 2, m: 0.1, b: -40, signed: true }
      }
    });
    var resp = [0x62, 0x41, 0x00, 0x07, 0xD0, 0x02, 0x8A];
    var trans = { supported: true, send: function (bytes, cb) { cb(null, resp); } };
    var d = new DiagProvider({}, { transport: trans, profile: prof, strict: true });
    var sched = function (fn) { sched.fn = fn; return 1; };
    d.start(sched);
    var delay = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
    sched.fn();
    return delay().then(function () {
      var r = d.read();
      near(r.boost, 1.0, 1e-6, 'packed block: boost unpacked + scaled');
      near(r.iat, 25.0, 1e-6, 'packed block: iat unpacked + scaled from same DID');
    });
  })
  .then(function () {
    // discoverVehicles(): finds a responding gateway and reports its host/address.
    var doip = require(A + 'doip');
    var sock = makeFakeDiscoverySocket(function (deliver) {
      deliver(announceBytes('TESTVIN0000000001', 0x1000), { address: '10.0.0.5' });
    });
    return doip.discoverVehicles(sock, { stopOnFirst: true, timeoutMs: 500 }).then(function (found) {
      eq(found.length, 1, 'discoverVehicles: finds one vehicle');
      eq(found[0].host, '10.0.0.5', 'discoverVehicles: host comes from the datagram source address');
      eq(found[0].logicalAddress, 0x1000, 'discoverVehicles: logical address decoded');
    });
  })
  .then(function () {
    // Times out to an empty list when nothing answers (bounded wait).
    var doip = require(A + 'doip');
    var sock = makeFakeDiscoverySocket(null);
    return doip.discoverVehicles(sock, { timeoutMs: 10 }).then(function (found) {
      eq(found.length, 0, 'discoverVehicles: times out to an empty list when nothing answers');
    });
  })
  .then(function () {
    // enetgate.scan() must never touch the network while the connection is disabled.
    var EnetGate = require(A + 'enetgate');
    var g3 = new EnetGate({ storage: Store.memStorage() });
    var socketFactoryCalled = false;
    return g3.scan(function () { socketFactoryCalled = true; return {}; }).then(function (found) {
      ok(!socketFactoryCalled, 'enetgate: scan() never opens a socket while disabled');
      eq(found.length, 0, 'enetgate: scan() resolves empty while disabled');
    });
  })
  .then(function () {
    // Full app wiring: acknowledge -> enable -> scan -> a real transport appears;
    // disable -> the transport disappears. Exercises main.js's _applyEnetState.
    var main = require('../apps/wali_datalog/main.js');
    var sim = require('../runtime/sim-ctx.js');
    var ctx = sim.makeSimCtx({ settings: { demo: 'off', source: 'auto' } });
    var app = new main.App();
    app.start(ctx);
    app._show('connect');

    ok(!app.diag.supported && !app.monitor.supported, 'app: boots with no transport until connected');

    app.onButton('BTN_B'); // Enable before Acknowledge -> refused
    ok(!app.enet.enabled, 'app: Enable is refused before Acknowledge');

    app.onButton('BTN_A'); // Acknowledge
    app.onButton('BTN_B'); // Enable
    ok(app.enet.acknowledged && app.enet.enabled, 'app: Acknowledge then Enable succeeds');
    ok(!app.diag.supported, 'app: enabled but no vehicle yet -> still no transport');

    ctx.doipSocket = function () {
      return makeFakeDiscoverySocket(function (deliver) {
        deliver(announceBytes('WBATESTVIN0000001', 0x1000), { address: '169.254.1.1' });
      });
    };
    app.onButton('BTN_C'); // Scan
    return new Promise(function (resolve) { setTimeout(resolve, 20); }).then(function () {
      ok(app.diag.supported && app.monitor.supported, 'app: after a successful scan, a real transport is wired in');
      eq(app.enet.vehicle.host, '169.254.1.1', 'app: discovered vehicle host stored');

      // ---- Codes page wired to the connected vehicle -----------------------
      var EcuSim = require('./ecusim').EcuSim;
      function asc(s) { return s.split('').map(function (ch) { return ch.charCodeAt(0); }); }
      var dmeDids = {}; dmeDids[0xF17C] = asc('CAL_MHD_STG1'); dmeDids[0xF190] = asc('WBATESTVIN0000001');
      var dmeSim = new EcuSim({ dids: dmeDids, dtcs: [{ bytes: [0x12, 0x34, 0x68], status: 0x08 }, { bytes: [0x45, 0x67, 0x00], status: 0x04 }] });
      var egsSim = new EcuSim({ dtcs: [{ bytes: [0xC1, 0x23, 0x00], status: 0x08 }] });
      var modMap = {}; modMap[0x1000] = dmeSim; modMap[0x1800] = egsSim;
      ctx.diagSocket = function () { return dmeSim.doipSocket({ modules: modMap }); };
      ctx.spec = ctx.spec || {}; ctx.spec.config = { modules: [{ name: 'DME', address: 0x1000 }, { name: 'EGS', address: 0x1800 }] };
      app._show('codes');
      eq(app.tab, 'codes', 'app: CODES tab opens');
      return app._codesScan().then(function () {
        ok(app.codes.result && app.codes.result.totalDtcs === 3, 'app: Codes scan reads 3 codes across modules');
        ok(/3 codes across 2\/2/.test(app.codes.msg), 'app: Codes status line summarizes the scan');
        // Clear is gated: first press only arms the confirmation.
        return app._codesClear();
      }).then(function () {
        ok(app.codes.confirmClear === true && dmeSim.cleared === 0, 'app: first Clear press arms confirmation, erases nothing');
        return app._codesClear(); // confirmed
      }).then(function () {
        ok(dmeSim.cleared === 1 && egsSim.cleared === 1, 'app: confirmed Clear erases each module');
        ok(app.codes.confirmClear === false, 'app: confirmation resets after clearing');
        // the codes scan also read the DME's calibration / last flash
        ok(app.codes.tune && app.codes.tune.detected === 'MHD', 'app: codes scan surfaces the tune on the car (MHD detected)');

        // ---- Flash prerequisite: must read the ECU (INFO) first --------------
        var cal = []; for (var q = 0; q < 300; q++) cal.push((q * 11 + 5) & 0xff);
        var h = app.storage.open('flash/descriptor.json');
        app.storage.append(h, JSON.stringify({ address: '0xA0010000', data: cal }));
        app.storage.close(h);
        app._show('flash');
        ok(app.flash.armed === false && app.info.done === false, 'app: flash engine OFF and INFO not yet read');
        app._flashToggle(); // blocked — INFO not read
        ok(app.flash.armed === false && /INFO tab first/i.test(app.flash.status), 'app: flash is locked until the ECU is read on INFO');
        // read the ECU on the INFO tab (prerequisite), then flash
        app._show('info');
        return app._infoRead().then(function () {
          ok(app.info.done === true, 'app: INFO read satisfies the flash prerequisite');
          ok(app.info.tune && app.info.tune.detected === 'MHD', 'app: INFO read detects the MHD tune');
          app._show('flash');
          app._flashToggle();
          ok(app.flash.armed === true && app.flash.descriptor && app.flash.descriptor.size === 300, 'app: engine ON after INFO loads the user descriptor (300 bytes)');
        // First FLASH press arms the confirm; nothing written yet.
        app._flashAction();
        ok(app.flash.confirm === true && dmeSim.flashed === null, 'app: first FLASH press only arms confirmation');
        // Confirmed press writes the calibration to the DME.
        return app._flashAction().then(function () {
          ok(app.flash.result && app.flash.result.ok === true, 'app: confirmed FLASH completes');
          var same = dmeSim.flashed && dmeSim.flashed.length === 300 && dmeSim.flashed.every(function (b, k) { return b === cal[k]; });
          ok(same, 'app: DME received exactly the calibration bytes via the Flash tab');
          ok(app.flash.progress === 100, 'app: flash progress reaches 100%');
          // Turning the engine OFF drops the loaded calibration.
          app._flashToggle();
          ok(app.flash.armed === false && app.flash.descriptor === null, 'app: engine OFF clears the loaded calibration');

          // ---- Setup tab: cycling a setting persists + applies --------------
          app._show('setup');
          var before = app.getSetting('units');
          app._cycleSettingKey('units');
          var after = app.getSetting('units');
          ok(before !== after && (after === 'metric' || after === 'imperial'), 'app: SETUP cycles a setting value');

          app._show('connect');
        });
        });
      }).then(function () {
        app.onButton('BTN_B'); // Disable
        ok(!app.diag.supported && !app.monitor.supported, 'app: disabling tears the transport back out');

        app.stop(); // release timers so the test process can exit cleanly

        // A fresh App instance (same storage) must NOT auto-reconnect.
        var app2 = new main.App();
        app2.start(ctx);
        ok(app2.enet.acknowledged === true, 'app: acknowledgment is remembered on restart');
        ok(app2.enet.enabled === false, 'app: connection is NOT enabled on restart -- requires a fresh Enable');
        app2.stop();
      });
    });
  })
  .then(function () {
    // ---- UDS SecurityAccess seed/key flow (seedkey.js + the test ECU) -------
    var seedkey = require(A + 'seedkey');
    var EcuSim = require('./ecusim').EcuSim;
    var clientAlgo = function (seed) { return seed.map(function (b) { return (b + 1) & 0xff; }); };

    var ecu = new EcuSim({ securedDids: { 0x1234: [0xAA, 0xBB] } });
    return seedkey.unlock(ecu.transport(), 0x11, clientAlgo).then(function (r) {
      ok(r.unlocked === true, 'seedkey: correct key unlocks the level');
      ok(ecu.unlocked === true, 'seedkey: ECU reports unlocked');
      ok(r.seed && r.seed.length === 4, 'seedkey: seed returned by the ECU');
      // already-unlocked -> zero seed -> shortcut (no key sent)
      return seedkey.unlock(ecu.transport(), 0x11, clientAlgo);
    }).then(function (r3) {
      ok(r3.unlocked === true && r3.already === true, 'seedkey: already-unlocked shortcut (zero seed)');
      // a wrong algorithm is rejected with invalidKey
      var badAlgo = function (seed) { return seed.slice(); }; // identity (wrong)
      return seedkey.unlock(new EcuSim().transport(), 0x11, badAlgo);
    }).then(function (r2) {
      ok(r2.unlocked === false, 'seedkey: wrong key is rejected');
      eq(r2.nrcName, 'invalidKey', 'seedkey: NRC is invalidKey');
      // a secured DID is denied before unlock, readable after
      var ecu3 = new EcuSim({ securedDids: { 0x4A36: [0x01, 0x02] } });
      var s3 = ecu3.transport();
      return s3(uds.buildReadDataByIdentifier(0x4A36)).then(function (resp) {
        var p = uds.parseResponse(uds.SID.READ_DID, resp);
        ok(!p.positive && p.nrcName === 'securityAccessDenied', 'seedkey: secured DID denied before unlock');
        return seedkey.unlock(s3, 0x11, clientAlgo).then(function () {
          return s3(uds.buildReadDataByIdentifier(0x4A36));
        }).then(function (resp2) {
          var p2 = uds.parseResponse(uds.SID.READ_DID, resp2);
          ok(p2.positive && p2.data[0] === 0x01, 'seedkey: secured DID readable after unlock');
        });
      });
    }).then(function () {
      // refuses to proceed without a key algorithm (no proprietary keys bundled)
      return seedkey.unlock(new EcuSim().transport(), 0x11, null).then(function (r4) {
        ok(r4.unlocked === false && /no security algorithm/.test(r4.error || ''), 'seedkey: refuses without a key algorithm');
        // diagnostic session control
        return seedkey.session(new EcuSim().transport(), 0x03).then(function (sr) {
          ok(sr.ok === true, 'seedkey: extended diagnostic session (0x10 03) ok');
        });
      });
    });
  })
  .then(function () {
    // ---- DoIP/ENET gateway end-to-end over the test ECU --------------------
    var doip = require(A + 'doip');
    var seedkey = require(A + 'seedkey');
    var EcuSim = require('./ecusim').EcuSim;
    var clientAlgo = function (seed) { return seed.map(function (b) { return (b + 1) & 0xff; }); };

    var ecu = new EcuSim({ securedDids: { 0x4A36: [0xDE, 0xAD] } });
    var gw = new doip.DoipGateway({ socket: ecu.doipSocket(), targetAddr: 0x1000 });
    ok(gw.supported === true, 'doip gateway: supported with a socket');
    return gw.activate().then(function (a) {
      ok(a === true, 'doip gateway: routing activation succeeds');
      // secured DID denied before unlock (over DoIP)
      return gw.send(uds.buildReadDataByIdentifier(0x4A36));
    }).then(function (resp) {
      var p = uds.parseResponse(uds.SID.READ_DID, resp);
      ok(!p.positive && p.nrcName === 'securityAccessDenied', 'doip gateway: secured DID denied before unlock');
      // unlock over DoIP with a caller-supplied algorithm
      return gw.unlock(0x11, clientAlgo);
    }).then(function (u) {
      ok(u.unlocked === true, 'doip gateway: SecurityAccess unlock over DoIP');
      return gw.send(uds.buildReadDataByIdentifier(0x4A36));
    }).then(function (resp2) {
      var p2 = uds.parseResponse(uds.SID.READ_DID, resp2);
      ok(p2.positive && p2.data[0] === 0xDE && p2.data[1] === 0xAD, 'doip gateway: secured DID readable after unlock');
      return gw.session(0x03);
    }).then(function (s) {
      ok(s.ok === true, 'doip gateway: diagnostic session over DoIP');
      gw.close();
    });
  })
  .then(function () {
    // unlock using a makeAlgo-configured algorithm (no code) over the test ECU
    var seedkey = require(A + 'seedkey');
    var EcuSim = require('./ecusim').EcuSim;
    var algo = seedkey.makeAlgo({ type: 'add', value: 1 }); // matches the ECU default (plusOne)
    return seedkey.unlock(new EcuSim().transport(), 0x11, algo).then(function (r) {
      ok(r.unlocked === true, 'seedkey: unlock with a makeAlgo({add:1}) configured algorithm');
    });
  })
  .then(function () {
    // ---- calibration-section flashing (open UDS write path) ----------------
    // Flash a BIN through the full session -> security -> erase -> download ->
    // transfer -> exit -> verify -> reset sequence against the test ECU, and
    // confirm the written bytes match and the write is confirmed.
    var flash = require(A + 'flash');
    var EcuSim = require('./ecusim').EcuSim;
    var cal = []; for (var i = 0; i < 300; i++) cal.push((i * 7 + 3) & 0xff); // multi-block payload
    var clientKey = function (seed) { return seed.map(function (b) { return (b + 1) & 0xff; }); };

    // Hard gates first: no silent flashing.
    return flash.flashCalibration(null, { data: cal, address: 0x80000000 }).then(function (r0) {
      ok(r0.ok === false && /acknowledg/i.test(r0.message), 'flash: refuses without explicit acknowledgment');
      return flash.flashCalibration(null, { acknowledged: true, address: 0x80000000 });
    }).then(function (r1) {
      ok(r1.ok === false && /no calibration data/i.test(r1.message), 'flash: refuses without calibration data');
      return flash.flashCalibration(null, { acknowledged: true, data: cal });
    }).then(function (r2) {
      ok(r2.ok === false && /address/i.test(r2.message), 'flash: refuses without a section address');

      // Full flash against a DME that gates the write behind unlock + prog session.
      var sim = new EcuSim({
        maxBlock: 66, flashNeedsUnlock: true, flashNeedsProg: true,
        routines: { 0xFF00: [0x00], 0xFF01: [0x00] } // erase ok, verify ok
      });
      var steps = [];
      return flash.flashCalibration(sim.transport(), {
        acknowledged: true, data: cal, address: 0xA0010000,
        securityLevel: 0x11, keyFn: clientKey,
        eraseRid: 0xFF00, checkRid: 0xFF01
      }, function (s) { steps.push(s); }).then(function (res) {
        ok(res.ok === true, 'flash: full sequence succeeds');
        ok(res.confirmed === true, 'flash: write confirmed by verify routine');
        var same = sim.flashed && sim.flashed.length === cal.length && sim.flashed.every(function (b, k) { return b === cal[k]; });
        ok(same, 'flash: ECU received exactly the calibration bytes (reassembled across blocks)');
        ok(sim.resetType === 0x01, 'flash: ECU reset issued after flashing');
        ok(steps.indexOf('requestDownload') >= 0 && steps.indexOf('transferExit') >= 0, 'flash: progress reported through the sequence');
      });
    }).then(function () {
      // Denied security must surface honestly, not report success.
      var sim2 = new EcuSim({ flashNeedsUnlock: true });
      return flash.flashCalibration(sim2.transport(), {
        acknowledged: true, data: cal, address: 0xA0010000,
        securityLevel: 0x11, keyFn: function (s) { return s.map(function (b) { return (b ^ 0xFF) & 0xff; }); } // wrong key
      }).then(function (res) {
        ok(res.ok === false && /SecurityAccess denied/i.test(res.message), 'flash: wrong key -> honest SecurityAccess failure, not written');
        ok(sim2.flashed === null, 'flash: nothing written when security fails');
      });
    }).then(function () {
      // Declarative descriptor -> opts (user-supplied data, no code, nothing bundled).
      var bad = flash.normalizeDescriptor({}, cal);
      ok(bad.error && /address/i.test(bad.error), 'flash: descriptor without an address is rejected');
      var norm = flash.normalizeDescriptor({
        address: '0xA0010000', session: 2,
        security: { level: 17, algo: { type: 'add', value: 1 } },
        eraseRoutine: '0xFF00', checkRoutine: '0xFF01'
      }, cal);
      ok(norm.opts && norm.opts.address === 0xA0010000 && typeof norm.opts.keyFn === 'function' && norm.opts.acknowledged === false,
        'flash: descriptor normalizes to opts (algo built from spec, not acknowledged by default)');
      var sim4 = new EcuSim({ maxBlock: 66, flashNeedsUnlock: true, routines: { 0xFF00: [0x00], 0xFF01: [0x00] } });
      norm.opts.acknowledged = true; // the owner acknowledges at flash time
      return flash.flashCalibration(sim4.transport(), norm.opts).then(function (res) {
        ok(res.ok === true && res.confirmed === true, 'flash: descriptor-driven flash succeeds and verifies');
      });
    }).then(function () {
      // End-to-end over the ENET/DoIP gateway (proves it works through the real transport).
      var doip = require(A + 'doip');
      var flash = require(A + 'flash');
      var EcuSim = require('./ecusim').EcuSim;
      var sim3 = new EcuSim({ maxBlock: 130, routines: { 0xFF10: [0x00] } });
      var gw = new doip.DoipGateway({ socket: sim3.doipSocket(), targetAddr: 0x1000 });
      var cal2 = []; for (var j = 0; j < 200; j++) cal2.push((255 - j) & 0xff);
      return gw.activate().then(function () {
        return flash.flashCalibration(function (bytes) { return gw.send(bytes); }, {
          acknowledged: true, data: cal2, address: 0xA0020000, checkRid: 0xFF10
        });
      }).then(function (res) {
        ok(res.ok === true && res.confirmed === true, 'flash: works end-to-end over the ENET/DoIP gateway');
        var same = sim3.flashed && sim3.flashed.length === cal2.length && sim3.flashed.every(function (b, k) { return b === cal2[k]; });
        ok(same, 'flash: DoIP-delivered calibration bytes match');
        gw.close();
      });
    });
  })
  .then(function () {
    // ---- fault codes: read (0x19) + clear (0x14), per module and whole-car ---
    var dtc = require(A + 'dtc');
    var modules = require(A + 'modules');
    var EcuSim = require('./ecusim').EcuSim;

    // codec
    eq(dtc.dtcCode(0x12, 0x34), 'P1234', 'dtc: SAE code decode P1234');
    eq(dtc.dtcCode(0x41, 0x23), 'C0123', 'dtc: C-prefix code decode');
    eq(dtc.dtcCode(0xC1, 0x23), 'U0123', 'dtc: U-prefix code decode (top two bits = 11)');
    var st = dtc.decodeStatus(0x08);
    ok(st.confirmed && !st.pending && st.active.join(',') === 'confirmed', 'dtc: status bit decode (confirmed)');
    var recs = dtc.parseRecords([0x12, 0x34, 0x68, 0x08, 0x45, 0x67, 0x00, 0x04]);
    ok(recs.length === 2 && recs[0].code === 'P1234' && recs[0].failureType === 0x68 && recs[1].status.pending, 'dtc: parseRecords two codes');

    // module catalog: defaults are honestly marked unverified + configurable
    ok(modules.list({}).length >= 4 && modules.list({}).every(function (m) { return m.verified === false; }), 'dtc: default module map present and marked unverified');
    var custom = modules.list({ modules: [{ name: 'DME', address: '0x1000', verified: true }] });
    ok(custom.length === 1 && custom[0].address === 0x1000 && custom[0].verified === true, 'dtc: config.modules overrides defaults');

    // read codes from one module
    var sim = new EcuSim({ dtcs: [{ bytes: [0x12, 0x34, 0x68], status: 0x08 }, { bytes: [0x45, 0x67, 0x00], status: 0x0A }] });
    return dtc.readDtcs(sim.transport(), {}).then(function (r) {
      ok(r.ok && r.dtcs.length === 2 && r.dtcs[0].code === 'P1234', 'dtc: read two codes from a module');
      // clear refuses without acknowledgment
      return dtc.clearDtcs(sim.transport(), {});
    }).then(function (r2) {
      ok(r2.ok === false && /confirmation required/i.test(r2.message), 'dtc: clear refuses without confirmation');
      // clear with acknowledgment, verified by re-read
      return dtc.clearDtcs(sim.transport(), { acknowledged: true });
    }).then(function (r3) {
      ok(r3.ok === true && r3.confirmed === true && sim.cleared === 1, 'dtc: clear + re-read confirms empty');
      // an active fault that comes straight back is reported honestly
      var busy = new EcuSim({ dtcs: [{ bytes: [0x22, 0x11, 0x00], status: 0x09 }] });
      var origClear = busy.dtcs;
      busy.handle = (function (base) { return function (req) { // clear, but the fault re-sets instantly
        var resp = base.call(busy, req); if (req[0] === uds.SID.CLEAR_DTC) busy.dtcs = origClear; return resp; }; })(EcuSim.prototype.handle);
      return dtc.clearDtcs(busy.transport(), { acknowledged: true });
    }).then(function (r4) {
      ok(r4.ok === true && r4.confirmed === false && /returned immediately|active fault/i.test(r4.message), 'dtc: active fault after clear reported honestly');
    }).then(function () {
      // ---- whole-vehicle scan over the ENET/DoIP gateway, many modules --------
      var doip = require(A + 'doip');
      var dmeSim = new EcuSim({ dtcs: [{ bytes: [0x12, 0x34, 0x68], status: 0x08 }, { bytes: [0x45, 0x67, 0x00], status: 0x08 }] });
      var egsSim = new EcuSim({ dtcs: [{ bytes: [0xC1, 0x23, 0x00], status: 0x08 }] });
      var modMap = {}; modMap[0x1000] = dmeSim; modMap[0x1800] = egsSim; // 0x2900 absent
      var gw = new doip.DoipGateway({ socket: dmeSim.doipSocket({ modules: modMap }), targetAddr: 0x1000 });
      var modList = [
        { key: 'dme', name: 'DME', address: 0x1000 },
        { key: 'egs', name: 'EGS', address: 0x1800 },
        { key: 'dsc', name: 'DSC', address: 0x2900 } // not present -> should time out, not hang
      ];
      var seen = [];
      return gw.activate().then(function () {
        return dtc.scanModules(gw.sendFor(60), modList, {}, function (m) { seen.push(m.key); });
      }).then(function (res) {
        ok(res.totalDtcs === 3, 'dtc: whole-vehicle scan aggregates codes across modules (2 DME + 1 EGS)');
        ok(res.reached === 2 && res.scanned === 3, 'dtc: absent module times out, scan still completes');
        ok(seen.join(',') === 'dme,egs,dsc', 'dtc: scan reports progress per module');
        var dsc = res.modules.filter(function (x) { return x.module.key === 'dsc'; })[0];
        ok(dsc && dsc.ok === false, 'dtc: unreachable module flagged, not failed silently');
        // clear across the reachable modules
        return dtc.clearModules(gw.sendFor(60), modList, { acknowledged: true });
      }).then(function (cr) {
        ok(cr.cleared === 2 && dmeSim.cleared === 1 && egsSim.cleared === 1, 'dtc: whole-vehicle clear erases each reachable module');
        gw.close();
      });
    });
  })
  .then(function () {
    // ---- read-only ECU identification / calibration info (#21) -------------
    var ecuinfo = require(A + 'ecuinfo');
    var EcuSim = require('./ecusim').EcuSim;
    function ascii(s) { return s.split('').map(function (c) { return c.charCodeAt(0); }); }
    var didMap = {}; didMap[0xF190] = ascii('WBA12345678901234'); didMap[0xF194] = ascii('7920000-1.2.3'); didMap[0xF17C] = ascii('CAL_B58_X1');
    var sim = new EcuSim({ dids: didMap });
    return ecuinfo.read(sim.transport()).then(function (res) {
      ok(res.ok, 'ecuinfo: read completes');
      var vin = res.items.filter(function (x) { return x.did === 0xF190; })[0];
      ok(vin && vin.ok && vin.value === 'WBA12345678901234', 'ecuinfo: VIN decoded as ASCII');
      var cal = res.items.filter(function (x) { return x.did === 0xF17C; })[0];
      ok(cal && cal.ok && cal.value === 'CAL_B58_X1', 'ecuinfo: calibration ID decoded');
      var missing = res.items.filter(function (x) { return x.did === 0xF18C; })[0];
      ok(missing && !missing.ok && /not available/.test(missing.value), 'ecuinfo: absent DID shown as not available');
      // read-only: ecuinfo issues only 0x22 requests
      var onlyReads = sim.log.every(function (r) { return r[0] === uds.SID.READ_DID; });
      ok(onlyReads, 'ecuinfo: only ReadDataByIdentifier (0x22) issued — read-only');
    });
  })
  .then(report)
  .catch(function (e) { console.error(e); process.exit(1); });

function report() {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('\nFailures:'); failures.forEach(function (m) { console.log('  - ' + m); }); }
  process.exit(fail ? 1 : 0);
}
