'use strict';
//
// screens.js — renders each app screen onto a drawing surface (cv).
//
// Pure rendering: every screen takes (cv, t, view) and draws. The view model is
// assembled by main.js (on the car) or the simulator (off the car) from the
// provider, the log engine, and map control. No I/O happens here.
//
var Channels = require('../channels');
var F = require('../format');
var D = require('./draw');

var W = 1600, H = 520;

function cval(view, key) {
  var ch = Channels.get(key);
  var v = view.vals ? view.vals[key] : NaN;
  var shown = Channels.toUnits(ch, v, view.units);
  return {
    ch: ch,
    metric: v,
    str: F.isNum(shown) ? F.fixed(shown, ch.dp) : '--',
    unit: Channels.unitLabel(ch, view.units),
    level: levelOf(ch, v)
  };
}
function levelOf(ch, v) {
  if (!ch || !F.isNum(v)) return 'ok';
  if (typeof ch.crit === 'number' && v >= ch.crit) return 'crit';
  if (typeof ch.warn === 'number' && v >= ch.warn) return 'warn';
  return 'ok';
}

function ribbon(cv, t, view, title) {
  var tw = cv.text(title, 32, 34, 26, t.text, { weight: 'bold' });
  // source badge, placed just after the title
  var bx = 32 + tw + 24;
  if (view.demo) D.badge(cv, t, bx, 10, 'DEMO DATA', t.warn);
  else if (view.live) D.badge(cv, t, bx, 10, 'LIVE', t.good);
  else D.badge(cv, t, bx, 10, 'NO DATA', t.faint, t.text);
  // rec indicator right
  if (view.rec && view.rec.logging) {
    D.recDot(cv, t, W - 300, 8, true, 'REC ' + F.mmss(view.rec.durationMs));
  } else {
    cv.text(view.units === 'imperial' ? 'Imperial' : 'Metric', W - 32, 32, 20, t.dim, { align: 'r' });
  }
}

// Grid of n cells inside (x0,y0,totalW,totalH).
function cellGrid(n, cols, x0, y0, totalW, totalH, gap) {
  cols = Math.max(1, cols);
  var rows = Math.ceil(n / cols);
  var w = (totalW - (cols - 1) * gap) / cols;
  var h = (totalH - (rows - 1) * gap) / rows;
  var cells = [];
  for (var i = 0; i < n; i++) {
    var c = i % cols, r = Math.floor(i / cols);
    cells.push({ x: x0 + c * (w + gap), y: y0 + r * (h + gap), w: w, h: h });
  }
  return cells;
}

function rangeU(view, c) {
  return { min: Channels.toUnits(c.ch, c.ch.min, view.units), max: Channels.toUnits(c.ch, c.ch.max, view.units) };
}
function shownVal(view, c) { return F.isNum(c.metric) ? Channels.toUnits(c.ch, c.metric, view.units) : NaN; }

// ---------------------------------------------------------------- LIVE ------
function live(cv, t, view) {
  cv.clear(t.bg);
  ribbon(cv, t, view, 'Live');

  var keys = (view.displayed || []).slice(0, view.maxtiles || 8).filter(function (k) { return !!Channels.get(k); });
  var x0 = 24, y0 = 58, W2 = W - 48, H2 = 452, gap = 14;
  if (keys.length === 0) {
    cv.text('No display channels selected', W / 2, 240, 30, t.dim, { align: 'c' });
    cv.text('On Channels, press Show to add up to ' + (view.maxtiles || 8) + ' gauges.', W / 2, 282, 22, t.faint, { align: 'c' });
    return;
  }
  var style = view.style || 'tiles';
  var i, c, cell;

  if (style === 'dials') {
    var dcols = keys.length <= 3 ? keys.length : 4;
    var dc = cellGrid(keys.length, dcols, x0, y0, W2, H2, gap);
    for (i = 0; i < keys.length; i++) {
      c = cval(view, keys[i]); cell = dc[i];
      var r = Math.min(cell.w, cell.h) / 2 - 6;
      var rg = rangeU(view, c);
      D.radial(cv, t, cell.x + cell.w / 2, cell.y + cell.h / 2, r, {
        value: shownVal(view, c), min: rg.min, max: rg.max, dp: c.ch.dp,
        label: c.ch.label.toUpperCase(), unit: c.unit, level: c.level,
        thick: Math.max(10, r * 0.16), vsize: Math.max(22, r * 0.52)
      });
    }
  } else if (style === 'bars') {
    var bcols = keys.length > 6 ? 2 : 1;
    var bc = cellGrid(keys.length, bcols, x0, y0, W2, H2, gap);
    for (i = 0; i < keys.length; i++) {
      c = cval(view, keys[i]); cell = bc[i];
      var rg2 = rangeU(view, c);
      D.barMeter(cv, t, cell.x, cell.y + (cell.h - 48) / 2, cell.w, 20, {
        label: c.ch.label, value: shownVal(view, c), min: rg2.min, max: rg2.max,
        dp: c.ch.dp, unit: c.unit, level: c.level
      });
    }
  } else { // tiles
    var tcols = keys.length <= 6 ? 3 : 4;
    var tc = cellGrid(keys.length, tcols, x0, y0, W2, H2, gap);
    for (i = 0; i < keys.length; i++) {
      c = cval(view, keys[i]); cell = tc[i];
      D.statTile(cv, t, cell.x, cell.y, cell.w, cell.h, {
        label: c.ch.label.toUpperCase(), value: c.str, unit: c.unit, level: c.level
      });
    }
  }
}

// -------------------------------------------------------------- DATALOG -----
function datalog(cv, t, view) {
  cv.clear(t.bg);
  ribbon(cv, t, view, 'Datalog');
  var rec = view.rec || {};
  var st = rec.state || 'idle';

  // state panel
  D.panel(cv, t, 32, 56, 720, 300);
  var word = 'READY', col = t.accent, sub = 'Press Start (A) to record a session';
  if (st === 'logging') { word = '● REC'; col = t.rec; sub = 'Recording ' + rec.enabledCount + ' channels at ' + rec.rate + ' Hz'; }
  else if (st === 'saving') { word = 'SAVING…'; col = t.warn; sub = 'Flushing to storage'; }
  else if (st === 'done') { word = 'SAVED'; col = t.good; sub = rec.file || ''; }
  else if (st === 'error') { word = 'ERROR'; col = t.crit; sub = rec.error || 'Logging failed'; }
  cv.text(word, 56, 150, 72, col, { weight: 'bold' });
  cv.text(sub, 56, 196, 22, t.dim, {});

  // stats grid
  var stats = [
    ['Duration', F.mmss(rec.durationMs)],
    ['Samples', String(rec.samples || 0)],
    ['Rate', (rec.rateActual ? rec.rateActual.toFixed(1) : '0.0') + ' Hz'],
    ['Size', F.humanBytes(rec.bytes || 0)],
    ['Markers', String(rec.markers || 0)],
    ['Channels', String(rec.enabledCount || 0)]
  ];
  for (var i = 0; i < stats.length; i++) {
    var col2 = i % 3, row = Math.floor(i / 3);
    var x = 56 + col2 * 230, y = 236 + row * 60;
    cv.text(stats[i][0], x, y, 18, t.dim, { weight: 'bold' });
    cv.text(stats[i][1], x, y + 30, 30, t.text, { weight: 'bold' });
  }

  // sessions list
  D.panel(cv, t, 776, 56, 792, 420, { title: 'RECENT LOGS' });
  var sess = view.sessions || [];
  if (sess.length === 0) {
    cv.text('No logs yet', 800, 250, 30, t.dim, {});
    cv.text('Recorded sessions appear here and export to USB (C).', 800, 292, 20, t.faint, {});
  } else {
    for (var s = 0; s < Math.min(sess.length, 8); s++) {
      var yy = 128 + s * 42;
      cv.text(sess[s].name, 800, yy, 20, t.text, {});
      cv.text(F.humanBytes(sess[s].size), 1540, yy, 20, t.dim, { align: 'r' });
      cv.line(800, yy + 12, 1540, yy + 12, t.line, 1);
    }
  }
  cv.text('A Start/Stop   ·   B Marker   ·   C Export   ·   D Live', 32, 506, 20, t.dim, {});
}

// ------------------------------------------------------------- CHANNELS -----
function channels(cv, t, view) {
  cv.clear(t.bg);
  var enabled = view.enabled || [];
  var shown = view.displayed || [];
  var limit = view.maxtiles || 8;
  var all = Channels.all();
  var perPage = 18;
  var sel = view.selection || 0;
  var page = Math.floor(sel / perPage);
  var pages = Math.ceil(all.length / perPage);
  ribbon(cv, t, view, 'Channels — log ' + enabled.length + ' · show ' + shown.length + '/' + limit);

  var cols = 3, cw = 500, ch = 60, gx = 20, gy = 12;
  var x0 = 32, y0 = 50;
  var startI = page * perPage;
  for (var p = 0; p < perPage; p++) {
    var gi = startI + p;
    if (gi >= all.length) break;
    var c = all[gi];
    var col = p % cols, row = Math.floor(p / cols);
    var x = x0 + col * (cw + gx), y = y0 + row * (ch + gy);
    var onLog = enabled.indexOf(c.key) >= 0;
    var onShow = shown.indexOf(c.key) >= 0;
    var isSel = gi === sel;
    cv.roundRect(x, y, cw, ch, 10, isSel ? t.accentDim : t.panel2);
    if (isSel) cv.strokeRoundRect(x, y, cw, ch, 10, t.accent, 2);
    // Log box (L) and Show box (S)
    cv.roundRect(x + 12, y + 16, 28, 28, 6, onLog ? t.good : t.line);
    cv.text('L', x + 26, y + 37, 18, onLog ? '#07121a' : t.dim, { align: 'c', weight: 'bold' });
    cv.roundRect(x + 46, y + 16, 28, 28, 6, onShow ? t.accent : t.line);
    cv.text('S', x + 60, y + 37, 18, onShow ? '#07121a' : t.dim, { align: 'c', weight: 'bold' });
    cv.text(c.label, x + 90, y + 27, 20, t.text, { weight: 'bold' });
    var tag = c.read.kind === 'diag' ? (c.cat || 'diag') : (c.read.kind === 'derived' ? 'calc' : 'bus');
    cv.text(tag, x + 90, y + 50, 15, t.faint, {});
    var cvv = cval(view, c.key);
    cv.text(cvv.str + (cvv.unit ? ' ' + cvv.unit : ''), x + cw - 16, y + 39, 22, onLog || onShow ? t.text : t.dim, { align: 'r', weight: 'bold' });
  }
  cv.text('A Log   ·   B Show   ·   C Clear shown   ·   D Back', 32, 506, 20, t.dim, {});
  cv.text('Page ' + (page + 1) + '/' + pages + '   ·   rotary to scroll', W - 32, 506, 20, t.dim, { align: 'r' });
}

// ----------------------------------------------------------------- MAPS -----
function maps(cv, t, view) {
  cv.clear(t.bg);
  ribbon(cv, t, view, 'Map Control');
  var m = view.maps || {};

  if (!m.enabled) {
    D.panel(cv, t, 360, 120, 880, 280);
    cv.text('🔒', 800, 230, 70, t.warn, { align: 'c' });
    cv.text('MAP CONTROL IS OFF', 800, 290, 40, t.text, { align: 'c', weight: 'bold' });
    cv.text('Writing tune maps to the engine is disabled by default.', 800, 334, 22, t.dim, { align: 'c' });
    cv.text('Enable it in Settings → "Enable map control" to use this screen.', 800, 366, 22, t.dim, { align: 'c' });
    return;
  }

  // slot chips
  var slots = m.slots || [];
  var chipW = 150, chipH = 90, gap = 16, x0 = 40, y0 = 70;
  for (var i = 0; i < slots.length; i++) {
    var x = x0 + i * (chipW + gap);
    var isReq = slots[i].index === m.requested;
    var isSel = slots[i].index === m.selected;
    cv.roundRect(x, y0, chipW, chipH, 12, isReq ? t.accentDim : t.panel2);
    if (isReq) cv.strokeRoundRect(x, y0, chipW, chipH, 12, t.accent, 3);
    cv.text(slots[i].label, x + chipW / 2, y0 + 44, 24, t.text, { align: 'c', weight: 'bold' });
    if (isSel) cv.text('✓ active', x + chipW / 2, y0 + 72, 18, t.good, { align: 'c' });
  }

  // preconditions
  var pre = m.pre || { reasons: [] };
  D.panel(cv, t, 40, 190, 740, 250, { title: 'PRECONDITIONS' });
  var speedOk = pre.speedOk, idleOk = pre.idleOk;
  cv.text((speedOk ? '✓ ' : '✗ ') + 'Vehicle stationary', 64, 262, 24, speedOk ? t.good : t.crit, { weight: 'bold' });
  cv.text((idleOk ? '✓ ' : '✗ ') + 'Engine at idle', 64, 304, 24, idleOk ? t.good : t.crit, { weight: 'bold' });
  if (pre.reasons && pre.reasons.length) {
    cv.text(pre.reasons[0], 64, 360, 20, t.dim, {});
    if (pre.reasons[1]) cv.text(pre.reasons[1], 64, 388, 20, t.dim, {});
  } else {
    cv.text('Ready to apply the highlighted map.', 64, 360, 20, t.good, {});
  }

  // status / result
  D.panel(cv, t, 800, 190, 760, 250, { title: 'STATUS' });
  if (m.lastMsg) cv.text(m.lastMsg, 824, 262, 22, m.lastOk ? t.good : t.crit, { weight: 'bold' });
  else cv.text('Select a map with Prev/Next, then Apply.', 824, 262, 22, t.dim, {});
  cv.text('Requested: ' + labelOf(slots, m.requested), 824, 316, 22, t.text, {});
  cv.text('Active: ' + labelOf(slots, m.selected), 824, 352, 22, t.text, {});

  cv.text('A Prev   ·   B Next   ·   C Apply   ·   D Back', 32, 506, 20, t.dim, {});

  // confirm overlay
  if (m.confirm) {
    cv.fillRect(0, 0, W, H, 'rgba(3,7,11,0.78)');
    D.panel(cv, t, 420, 150, 760, 240, { fill: t.panel });
    cv.strokeRoundRect(420, 150, 760, 240, 14, t.warn, 2);
    cv.text('Confirm map switch', 800, 206, 32, t.text, { align: 'c', weight: 'bold' });
    cv.text('Switch to "' + labelOf(slots, m.requested) + '" — this writes to the DME.', 800, 256, 22, t.dim, { align: 'c' });
    cv.text('Press Apply (C) to confirm, Back (D) to cancel.', 800, 320, 22, t.warn, { align: 'c', weight: 'bold' });
  }
}
function labelOf(slots, idx) {
  for (var i = 0; i < slots.length; i++) if (slots[i].index === idx) return slots[i].label;
  return '-';
}

// ------------------------------------------------------------------ MHD -----
function mhd(cv, t, view) {
  cv.clear(t.bg);
  ribbon(cv, t, view, 'MHD Datalog (web)');
  var mh = view.mhd || {};
  D.panel(cv, t, 32, 64, 1536, 410);
  cv.text('Datalog through MHD’s own page', 64, 120, 32, t.text, { weight: 'bold' });
  cv.text('This opens MHD’s website so you can sign in and use MHD’s own', 64, 168, 24, t.dim, {});
  cv.text('datalogging. It is a shortcut, not an integration — this app never', 64, 200, 24, t.dim, {});
  cv.text('sees or stores your MHD login.', 64, 232, 24, t.dim, {});
  cv.text(mh.url || 'https://www.mhdtuning.com', 64, 300, 24, t.accent, {});
  if (mh.internet) D.badge(cv, t, 64, 330, 'INTERNET OK', t.good);
  else {
    D.badge(cv, t, 64, 330, 'NO INTERNET', t.warn);
    cv.text('Needs mgu-uplink installed and online.', 300, 352, 20, t.dim, {});
  }
  cv.text('A Open site   ·   D Back', 32, 506, 20, t.dim, {});
}

module.exports = {
  W: W, H: H,
  live: live,
  datalog: datalog,
  channels: channels,
  maps: maps,
  mhd: mhd,
  cval: cval,
  byName: function (name) {
    return { live: live, datalog: datalog, channels: channels, maps: maps, mhd: mhd }[name] || live;
  }
};
