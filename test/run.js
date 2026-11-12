'use strict';
//
// run.js — zero-dependency test runner for the app's pure logic.
//
// Covers formatting, the UDS codec, the log engine (incl. error path), map-
// control gating, the provider's demo fallback, and channel helpers.
//
var A = '../apps/wali_datalog/src/';
var F = require(A + 'format');
var uds = require(A + 'uds');
var Channels = require(A + 'channels');
var LogEngine = require(A + 'logengine');
var MapControl = require(A + 'mapcontrol');
var Provider = require(A + 'provider');
var Store = require(A + 'storage');
var dme = require(A + 'dme_profiles');
var DiagProvider = require(A + 'diag');

var pass = 0, fail = 0, failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); } }
function eq(a, b, msg) { ok(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function near(a, b, eps, msg) { ok(Math.abs(a - b) <= eps, msg + ' (got ' + a + ', want ~' + b + ')'); }

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

// ---- MHD+ PID profile + packed blocks ------------------------------------
ok(Channels.all().length > 85, 'catalogue has 85+ channels (MHD+ class)');
ok(!!Channels.get('timingCyl6') && !!Channels.get('knockCyl6'), 'per-cylinder channels present');
ok(!!Channels.get('wgdcP') && !!Channels.get('boostDeviation') && !!Channels.get('loadReq'), 'B58 wastegate/boost control channels present');

// MHD LogPresets.csv -> preset converter (names + flags only; no vendor data)
(function () {
  var conv = require('../scripts/preset_from_mhd_csv');
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

// ---- MHD live-monitor decode (2C 88 01 -> 36-byte LE packed block) --------
(function () {
  var MhdMonitor = require(A + 'mhdmonitor');
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
  var v = MhdMonitor.decodeReply(reply, 'B58');
  eq(v.rpm, 3000, 'mhd monitor: RPM');
  near(v.load, 50.0, 1e-6, 'mhd monitor: LOAD (signed, %)');
  near(v.boost, 1.0, 0.01, 'mhd monitor: BOOST psi->bar');
  near(v.coolant, 90.0, 1e-6, 'mhd monitor: ENGINETEMP -> coolant');
  eq(v.gear, 3, 'mhd monitor: GEAR');
  eq(v.speed, 100, 'mhd monitor: SPEED');
  near(v.iat, 30.0, 1e-6, 'mhd monitor: INTAKEAIRTEMP -> iat');
  ok(MhdMonitor.decodeReply([0x7f, 0x2c, 0x31].concat(body), 'B58') === null, 'negative monitor reply -> null');
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
  var lines = mem.read(eng.file).trim().split('\n');
  eq(lines.length, 6, 'header + 5 rows');
  ok(lines[0].indexOf('afr[:1]') >= 0, 'derived afr column present');
  ok(lines[3].split(',')[2] === 'm', 'marker lands on row 3');
  // derived afr = lambda*14.7
  var afrCol = lines[0].split(',').indexOf('afr[:1]');
  near(parseFloat(lines[1].split(',')[afrCol]), 0.85 * 14.7, 0.05, 'afr value');
  // config preserved across start()
  ok(lines[0].indexOf('rpm') >= 0 && lines[0].indexOf('speed') < 0, 'configure preserved through start');
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
    var on = new MapControl({ enabled: true });
    return on.commit(2, { speed: 0, rpm: 800 }, fakeDiag(true)).then(function (res) {
      ok(res.ok, 'commit succeeds with valid preconditions + positive DME');
    });
  })
  .then(function () {
    var on = new MapControl({ enabled: true });
    return on.commit(2, { speed: 0, rpm: 800 }, fakeDiag(false)).then(function (res) {
      ok(!res.ok && /conditionsNotCorrect|rejected/i.test(res.message), 'commit reports DME rejection');
    });
  })
  .then(function () {
    var on = new MapControl({ enabled: true });
    return on.commit(1, { speed: 50, rpm: 800 }, fakeDiag(true)).then(function (res) {
      ok(!res.ok, 'commit refuses when preconditions fail (never calls DME)');
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
  })
  .then(report)
  .catch(function (e) { console.error(e); process.exit(1); });

function report() {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('\nFailures:'); failures.forEach(function (m) { console.log('  - ' + m); }); }
  process.exit(fail ? 1 : 0);
}
