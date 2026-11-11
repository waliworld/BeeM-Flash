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
  .then(report)
  .catch(function (e) { console.error(e); process.exit(1); });

function report() {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('\nFailures:'); failures.forEach(function (m) { console.log('  - ' + m); }); }
  process.exit(fail ? 1 : 0);
}
