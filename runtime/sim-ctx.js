'use strict';
//
// sim-ctx.js — a head-unit-compatible ctx for off-car runs.
//
// Provides the same surface the app expects (settings, surface, ui.onClick,
// log, storage) but backed by memory and a record/canvas surface. Timers and
// ctx.loop are omitted so the harness drives tick()/render() deterministically.
//
var record = require('./record-surface');
var storageMod = require('../apps/wali_datalog/src/storage');

function makeSimCtx(opts) {
  opts = opts || {};
  var settings = assign({
    demo: 'on', source: 'auto', rate: 20, units: 'metric', autostart: false, mapcontrol: false
  }, opts.settings || {});
  var changeCbs = [];
  var clickHandlers = {};
  var surf = opts.surface || record.recordSurface(1600, 520);
  var store = opts.storage || storageMod.memStorage();

  return {
    _noTimers: true,
    _storage: store,
    internet: opts.internet === undefined ? true : opts.internet,
    mediaDir: opts.mediaDir || null,
    dataDir: opts.dataDir || '/tmp/wali',
    theme: null,
    settings: {
      get: function (k) { return settings[k]; },
      set: function (k, v) { settings[k] = v; changeCbs.forEach(function (f) { f(); }); },
      onChange: function (f) { changeCbs.push(f); }
    },
    surface: function () { return surf; },
    ui: {
      onClick: function (name, fn) { clickHandlers[name] = fn; },
      image: function () { return null; }
    },
    log: { info: function () {}, warn: function () {}, error: function () {} },
    openUrl: function () {},
    show: function () {},
    _click: function (name) { if (clickHandlers[name]) clickHandlers[name](); },
    _settings: settings,
    _surface: surf,
    _store: store
  };
}

function assign(a, b) { for (var k in b) if (b.hasOwnProperty(k)) a[k] = b[k]; return a; }

module.exports = { makeSimCtx: makeSimCtx };
