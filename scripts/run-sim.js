'use strict';
//
// run-sim.js — drive the full app off-car.
//
// Boots the App with a simulated ctx, runs a demo "drive" while logging, renders
// every screen in several states (proving they don't throw), and prints a
// summary plus a slice of the CSV. This is the headless end-to-end check.
//
var path = require('path');
var main = require(path.join('..', 'apps', 'wali_datalog', 'main.js'));
var sim = require(path.join('..', 'runtime', 'sim-ctx.js'));
var record = require(path.join('..', 'runtime', 'record-surface.js'));

function run() {
  var surf = record.recordSurface(1600, 520);
  var ctx = sim.makeSimCtx({ surface: surf, settings: { demo: 'on', rate: 20, units: 'metric', mapcontrol: true } });
  var app = new main.App();
  app.start(ctx);

  // Simulate ~12 s of driving at 20 Hz while logging.
  var clock = { now: 1700000000000 };
  app.engine.clock = function () { return clock.now; }; // deterministic timestamps
  app._startLog();
  var frames = 240;
  for (var i = 0; i < frames; i++) {
    clock.now += 50;
    app.tick(clock.now);
    if (i === 80) app.marker('pull-1');
    if (i === 180) app.marker('pull-2');
  }
  app._stopLog();

  // Render every screen in representative states; count ops, catch throws.
  var states = [
    { screen: 'live', note: 'live gauges' },
    { screen: 'datalog', note: 'after recording (DONE)' },
    { screen: 'channels', note: 'channel picker' },
    { screen: 'maps', note: 'map control (enabled)' },
    { screen: 'mhd', note: 'MHD web link' },
    { screen: 'connect', note: 'vehicle connection (disabled, default)' }
  ];
  var ok = true;
  states.forEach(function (s) {
    surf.reset();
    try {
      app.screen = s.screen;
      app.render(surf, s.screen);
      console.log('  render ' + pad(s.screen, 9) + ' ops=' + pad(String(surf._ops.length), 4) + '  (' + s.note + ')');
    } catch (e) {
      ok = false;
      console.log('  render ' + s.screen + ' THREW: ' + (e && e.stack ? e.stack : e));
    }
  });

  // Map-control gating demo: off by default refuses a switch.
  var offMap = new (require('../apps/wali_datalog/src/mapcontrol'))({ enabled: false });
  var prep = offMap.prepare(1, { speed: 0, rpm: 800 });
  console.log('\nMap switch while control OFF -> ok=' + prep.ok + ' (expected false)');

  // Logging summary
  var file = app.engine.file;
  var csv = ctx._store.read(file).split('\n');
  console.log('\nLog file: ' + file);
  console.log('State: ' + app.engine.state + '  samples=' + app.engine.stats.samples +
    '  bytes=' + app.engine.stats.bytes + '  markers=' + app.engine.stats.markers);
  console.log('Header: ' + csv[0]);
  console.log('Row 1 : ' + csv[1]);
  console.log('Row 90: ' + csv[90]);
  console.log('\nSIM ' + (ok ? 'PASSED' : 'FAILED'));
  process.exit(ok ? 0 : 1);
}
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

run();
