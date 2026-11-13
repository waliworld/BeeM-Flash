'use strict';
//
// make-shots.js — render the preview page and screenshot each screen.
//
var path = require('path');
var fs = require('fs');
var { chromium } = require('playwright');

var ROOT = path.resolve(__dirname, '..');
var WEB = path.join(ROOT, 'runtime', 'web');
var OUT = path.join(ROOT, 'out', 'shots');

var SCREENS = ['live', 'live-bars', 'live-dials', 'log', 'log-rec', 'log-run', 'channels', 'maps-off', 'maps', 'maps-confirm', 'connect', 'connect-locked', 'codes', 'codes-result', 'codes-confirm', 'info', 'flash-blocked', 'flash-off', 'flash-ready', 'flash-confirm', 'flash-running', 'setup', 'setup-diag'];

(async function () {
  fs.mkdirSync(OUT, { recursive: true });
  var browser = await chromium.launch({ args: ['--no-sandbox'] });
  var page = await browser.newPage({ viewport: { width: 1640, height: 600 }, deviceScaleFactor: 2 });
  var errors = [];
  page.on('console', function (m) { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', function (e) { errors.push(String(e)); });

  await page.goto('file://' + path.join(WEB, 'index.html'));
  await page.waitForFunction('window.PREVIEW_READY === true', { timeout: 15000 });

  for (var i = 0; i < SCREENS.length; i++) {
    var name = SCREENS[i];
    await page.evaluate(function (n) { return window.renderScreen(n); }, name);
    await page.waitForTimeout(80);
    var el = await page.$('#screen');
    await el.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('shot: ' + name + '.png');
  }

  await browser.close();
  if (errors.length) { console.log('\nPAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
  console.log('\nAll screenshots written to out/shots/');
})().catch(function (e) { console.error(e); process.exit(1); });
