'use strict';
//
// screens.js — Beta 2 UI: a tabs-on-top shell with in-tab controls on the
// bottom, drawn in a Lamborghini-influenced dark/yellow theme.
//
// Layout (1600x520), all pixels in app drawing space (ctx.onTap coords):
//   brand row   y 0..42     app name + live/rec status
//   tab strip   y 46..96     one touch tab per page (chrome)
//   content     y 104..428   the active page draws here (R)
//   action bar  y 438..512   up to 4 touch buttons = the page's controls
//
// The chrome (brand, tabs, action bar) is drawn by chrome(); each page draws
// only its content inside R. Hardware HMI buttons map to the action bar, and the
// bar + tabs are also touch targets — see main.js for input + geometry use.
//
var Channels = require('./channels');
var F = require('./format');
var D = require('./draw');

var W = 1600, H = 520;
var TAB_Y = 46, TAB_H = 50;
// Content sits well below the tab baseline so each page's small header line never
// collides with the tabs.
var CONTENT = { x: 24, y: 126, w: W - 48, h: 300 };
var BAR = { x: 24, y: 438, w: W - 48, h: 74 };

// Wrap a drawing surface so every text size is scaled by `s` (and textWidth
// matches), without moving any layout box. Used to shrink all fonts uniformly so
// nothing overlaps or runs off the edge on the head unit, where the baked fonts
// render wider than the preview. Positions/shapes are untouched.
function scaleCv(cv, s) {
  if (!cv || !(s > 0) || s === 1) return cv;
  function z(v) { return Math.max(8, Math.round(v * s)); }
  return {
    handle: cv.handle,
    clear: function (c) { return cv.clear(c); },
    fillRect: function (x, y, w, h, c) { return cv.fillRect(x, y, w, h, c); },
    roundRect: function (x, y, w, h, r, c) { return cv.roundRect(x, y, w, h, r, c); },
    strokeRoundRect: function (x, y, w, h, r, c, lw) { return cv.strokeRoundRect(x, y, w, h, r, c, lw); },
    line: function (x1, y1, x2, y2, c, lw) { return cv.line(x1, y1, x2, y2, c, lw); },
    circle: function (cx, cy, r, c) { return cv.circle(cx, cy, r, c); },
    arcSector: function (cx, cy, r0, r1, a0, a1, c) { return cv.arcSector(cx, cy, r0, r1, a0, a1, c); },
    text: function (str, x, y, size, color, opts) { return cv.text(str, x, y, z(size), color, opts); },
    textWidth: function (str, size, weight) { return cv.textWidth(str, z(size), weight); }
  };
}

// ---- geometry (shared with main.js hit-testing) ---------------------------
function tabRects(n) {
  var out = [], width = (W - 48) / n;
  for (var i = 0; i < n; i++) out.push({ x: 24 + i * width, y: TAB_Y, w: width, h: TAB_H });
  return out;
}
function barRects(n) {
  if (n <= 0) return [];
  var out = [], gap = 12, bw = (BAR.w - (n - 1) * gap) / n;
  for (var i = 0; i < n; i++) out.push({ x: BAR.x + i * (bw + gap), y: BAR.y, w: bw, h: BAR.h });
  return out;
}

// ---- channel value helper --------------------------------------------------
function cval(view, key) {
  var ch = Channels.get(key);
  var v = view.vals ? view.vals[key] : NaN;
  var shown = Channels.toUnits(ch, v, view.units);
  return { ch: ch, metric: v, str: F.isNum(shown) ? F.fixed(shown, ch.dp) : '--',
    unit: Channels.unitLabel(ch, view.units), level: levelOf(ch, v) };
}
function levelOf(ch, v) {
  if (!ch || !F.isNum(v)) return 'ok';
  if (typeof ch.crit === 'number' && v >= ch.crit) return 'crit';
  if (typeof ch.warn === 'number' && v >= ch.warn) return 'warn';
  return 'ok';
}
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
function rangeU(view, c) { return { min: Channels.toUnits(c.ch, c.ch.min, view.units), max: Channels.toUnits(c.ch, c.ch.max, view.units) }; }
function shownVal(view, c) { return F.isNum(c.metric) ? Channels.toUnits(c.ch, c.metric, view.units) : NaN; }

function wrapText(cv, t, text, x, y, maxWidth, size, color) {
  var words = String(text).split(' '), line = '', ly = y, lh = size + 8;
  for (var i = 0; i < words.length; i++) {
    var test = line ? line + ' ' + words[i] : words[i];
    if (line && cv.textWidth(test, size) > maxWidth) { cv.text(line, x, ly, size, color, {}); line = words[i]; ly += lh; }
    else line = test;
  }
  if (line) cv.text(line, x, ly, size, color, {});
  return ly + lh;
}

// ---- chrome: brand + tabs + action bar ------------------------------------
function chrome(cv, t, view) {
  cv.clear(t.bg);

  // brand: a yellow slab mark + the app name (kept minimal)
  cv.fillRect(24, 8, 40, 26, t.accent);
  cv.text('B', 44, 30, 22, t.ink, { align: 'c', weight: 'bold' });
  cv.text('BeeM', 76, 30, 22, t.text, { weight: 'bold' });
  var wbeem = cv.textWidth('BeeM', 22, 'bold');
  cv.text('FLASH', 76 + wbeem + 10, 30, 22, t.accent, { weight: 'bold' });

  // status (right)
  var sx = W - 24;
  cv.text(view.units === 'imperial' ? 'IMPERIAL' : 'METRIC', sx, 29, 16, t.faint, { align: 'r', weight: 'bold' });
  sx -= cv.textWidth(view.units === 'imperial' ? 'IMPERIAL' : 'METRIC', 16, 'bold') + 18;
  if (view.rec && view.rec.logging) { D.badge(cv, t, sx - 118, 6, 'REC ' + F.mmss(view.rec.durationMs), t.rec, '#fff'); sx -= 118 + 12; }
  // DEMO is neutral (grey), LIVE is the yellow accent, NO DATA is faint.
  var slabel = view.demo ? 'DEMO' : (view.live ? 'LIVE' : 'NO DATA');
  var scol = view.demo ? t.faint : (view.live ? t.accent : t.panel3);
  var stc = view.demo ? t.text : (view.live ? t.ink : t.dim);
  D.badge(cv, t, sx - (cv.textWidth(slabel, 18, 'bold') + 24), 6, slabel, scol, stc);

  // tab strip — the active tab is emphasised with a solid fill, a yellow underline,
  // and BOLDER/LARGER text (not a different colour).
  var tabs = view.tabs || [];
  var rects = tabRects(tabs.length);
  cv.fillRect(24, TAB_Y + TAB_H, W - 48, 2, t.line); // baseline hairline
  for (var i = 0; i < tabs.length; i++) {
    var r = rects[i], active = tabs[i].key === view.tab;
    if (active) {
      cv.fillRect(r.x, r.y, r.w, r.h, t.panel2);
      cv.fillRect(r.x, r.y + r.h - 4, r.w, 4, t.accent); // yellow underline
    }
    if (i > 0) cv.fillRect(r.x, r.y + 10, 1, r.h - 20, t.line); // separator
    cv.text(tabs[i].label, r.x + r.w / 2, r.y + r.h / 2 + (active ? 8 : 7), active ? 23 : 19, active ? t.accent : t.dim, { align: 'c', weight: 'bold' });
  }

  // transient banner: one-off messages (export result, scan result, ...) sit in
  // the gap between the tabs and the content and fade after a few seconds. MAPS
  // and CODES have their own status panels, so these never leak onto them.
  if (view.toast && view.toast.msg) {
    var tmsg = view.toast.msg, tcol = view.toast.ok ? t.good : t.warn;
    var tw = cv.textWidth(tmsg, 18, 'bold') + 44, tx = (W - tw) / 2;
    cv.roundRect(tx, 99, tw, 24, 3, t.panel2);
    cv.fillRect(tx, 99, 4, 24, tcol);
    cv.text(tmsg, W / 2 + 2, 116, 18, tcol, { align: 'c', weight: 'bold' });
  }

  // action bar
  var acts = view.actions || [];
  var brects = barRects(acts.length);
  for (var j = 0; j < acts.length; j++) {
    var a = acts[j], br = brects[j];
    D.cutButton(cv, t, br.x, br.y, br.w, br.h, a.label, {
      active: !!a.active, disabled: !!a.disabled, sub: a.sub,
      edgeColor: a.danger ? t.crit : t.accent,
      activeColor: a.danger ? t.crit : t.accent,
      inkColor: a.danger ? '#fff' : t.ink
    });
  }
}

// ----------------------------------------------------------------- LIVE -----
function live(cv, t, view, R) {
  var keys = (view.displayed || []).slice(0, view.maxtiles || 8).filter(function (k) { return !!Channels.get(k); });
  if (keys.length === 0) {
    cv.text('NO GAUGES SELECTED', R.x + R.w / 2, R.y + R.h / 2 - 14, 32, t.text, { align: 'c', weight: 'bold' });
    cv.text('Open CHANNELS and tap a row to add gauges (up to ' + (view.maxtiles || 8) + ').', R.x + R.w / 2, R.y + R.h / 2 + 24, 22, t.dim, { align: 'c' });
    return;
  }
  var style = view.style || 'tiles', gap = 14, i, c, cell;
  if (style === 'dials') {
    var dcols = keys.length <= 3 ? keys.length : 4;
    var dc = cellGrid(keys.length, dcols, R.x, R.y, R.w, R.h, gap);
    for (i = 0; i < keys.length; i++) {
      c = cval(view, keys[i]); cell = dc[i];
      var rad = Math.min(cell.w, cell.h) / 2 - 6, rg = rangeU(view, c);
      D.radial(cv, t, cell.x + cell.w / 2, cell.y + cell.h / 2, rad, {
        value: shownVal(view, c), min: rg.min, max: rg.max, dp: c.ch.dp,
        label: c.ch.label.toUpperCase(), unit: c.unit, level: c.level,
        thick: Math.max(9, rad * 0.16), vsize: Math.max(20, rad * 0.5)
      });
    }
  } else if (style === 'bars') {
    var bcols = keys.length > 6 ? 2 : 1;
    var bc = cellGrid(keys.length, bcols, R.x, R.y, R.w, R.h, gap);
    for (i = 0; i < keys.length; i++) {
      c = cval(view, keys[i]); cell = bc[i]; var rg2 = rangeU(view, c);
      D.barMeter(cv, t, cell.x, cell.y + (cell.h - 48) / 2, cell.w, 18, {
        label: c.ch.label, value: shownVal(view, c), min: rg2.min, max: rg2.max, dp: c.ch.dp, unit: c.unit, level: c.level });
    }
  } else {
    var tcols = keys.length <= 6 ? 3 : 4;
    var tc = cellGrid(keys.length, tcols, R.x, R.y, R.w, R.h, gap);
    for (i = 0; i < keys.length; i++) {
      c = cval(view, keys[i]); cell = tc[i];
      D.statTile(cv, t, cell.x, cell.y, cell.w, cell.h, { label: c.ch.label.toUpperCase(), value: c.str, unit: c.unit, level: c.level });
    }
  }
}

// ------------------------------------------------------------- DATALOG ------
function peakOf(summary, key, which) {
  for (var i = 0; i < (summary || []).length; i++) if (summary[i].key === key) return summary[i][which];
  return NaN;
}
function log(cv, t, view, R) {
  var rec = view.rec || {}, st = rec.state || 'idle';
  var pw = 470;
  D.panel(cv, t, R.x, R.y, pw, R.h, { accent: true, accentColor: st === 'logging' ? t.rec : t.accent });
  var word = 'READY', col = t.accent, sub = 'Tap START to record a session';
  if (st === 'logging') { word = '● REC'; col = t.rec; sub = 'Recording ' + rec.enabledCount + ' ch @ ' + rec.rate + ' Hz'; }
  else if (st === 'saving') { word = 'SAVING…'; col = t.warn; sub = 'Flushing to storage'; }
  else if (st === 'done') { word = 'SAVED'; col = t.good; sub = rec.file || ''; }
  else if (st === 'error') { word = 'ERROR'; col = t.crit; sub = rec.error || 'Logging failed'; }
  cv.text(word, R.x + 28, R.y + 80, 58, col, { weight: 'bold' });
  cv.text(sub, R.x + 28, R.y + 116, 18, t.dim, {});
  var stats = [['DURATION', F.mmss(rec.durationMs)], ['SAMPLES', String(rec.samples || 0)],
    ['RATE', (rec.rateActual ? rec.rateActual.toFixed(1) : '0.0') + ' Hz'], ['SIZE', F.humanBytes(rec.bytes || 0)],
    ['MARKERS', String(rec.markers || 0)], ['CHANNELS', String(rec.enabledCount || 0)]];
  for (var i = 0; i < stats.length; i++) {
    var cc = i % 3, rr = Math.floor(i / 3), x = R.x + 28 + cc * 146, y = R.y + 164 + rr * 66;
    cv.text(stats[i][0], x, y, 14, t.faint, { weight: 'bold' });
    cv.text(stats[i][1], x, y + 28, 24, t.text, { weight: 'bold' });
  }

  // middle: last pull (estimated) + session peaks
  var mx = R.x + pw + 16, mw = 560, mh = R.h;
  D.panel(cv, t, mx, R.y, mw, mh, { title: 'LAST PULL (ESTIMATE)' });
  var run = rec.run;
  if (run) {
    cv.text(F.fixed(run.peakPowerHp, 0), mx + 24, R.y + 108, 72, t.accent, { weight: 'bold' });
    var hw = cv.textWidth(F.fixed(run.peakPowerHp, 0), 72, 'bold');
    cv.text('whp', mx + 24 + hw + 10, R.y + 108, 26, t.dim, {});
    cv.text('@ ' + F.fixed(run.peakPowerRpm, 0) + ' rpm   ·   ~' + F.fixed(run.peakPowerCrankHp, 0) + ' crank hp', mx + 24, R.y + 140, 18, t.dim, {});
    var rr2 = [['PEAK BOOST', (F.isNum(run.peakBoost) ? F.fixed(run.peakBoost, 2) + ' bar' : '--')],
      ['PULL', F.fixed(run.durationMs / 1000, 1) + ' s'],
      ['100–200', run.t100_200 != null ? F.fixed(run.t100_200 / 1000, 2) + ' s' : '--']];
    for (var k = 0; k < rr2.length; k++) {
      var rx = mx + 24 + k * 178;
      cv.text(rr2[k][0], rx, R.y + 182, 14, t.faint, { weight: 'bold' });
      cv.text(rr2[k][1], rx, R.y + 210, 22, t.text, { weight: 'bold' });
    }
    cv.text('Acceleration-based estimate — not a dyno. Set mass/drag in config.', mx + 24, R.y + mh - 18, 15, t.faint, {});
  } else {
    cv.text('No full-throttle pull captured yet.', mx + 24, R.y + 96, 22, t.dim, {});
    cv.text('Record a log, then do a clean WOT pull — the peak power estimate,', mx + 24, R.y + 128, 17, t.faint, {});
    cv.text('peak boost and 100–200 time are captured automatically.', mx + 24, R.y + 150, 17, t.faint, {});
  }
  // right: recent logs
  var lx = mx + mw + 16, lw = R.x + R.w - lx;
  D.panel(cv, t, lx, R.y, lw, R.h, { title: 'RECENT LOGS' });
  var sess = view.sessions || [];
  if (sess.length === 0) {
    cv.text('No logs yet.', lx + 24, R.y + 86, 22, t.dim, {});
    cv.text('Sessions export to USB with a summary footer.', lx + 20, R.y + 118, 16, t.faint, {});
  } else {
    for (var s = 0; s < Math.min(sess.length, 6); s++) {
      var yy = R.y + 70 + s * 38;
      cv.text(sess[s].name, lx + 20, yy, 17, t.text, {});
      cv.text(F.humanBytes(sess[s].size), lx + lw - 18, yy, 17, t.dim, { align: 'r' });
      cv.fillRect(lx + 20, yy + 10, lw - 38, 1, t.line);
    }
  }
}

// ------------------------------------------------------------- CHANNELS -----
function channels(cv, t, view, R) {
  var enabled = view.enabled || [], shown = view.displayed || [], limit = view.maxtiles || 8;
  // 12 per page (4 rows x 3 cols). The 5th row of the old 15-per-page grid drew
  // down to y~464, past the content area (ends y=426) and into the action bar.
  var all = Channels.all(), perPage = 12, sel = view.selection || 0;
  var page = Math.floor(sel / perPage), pages = Math.ceil(all.length / perPage);
  cv.text('LOG ' + enabled.length + '  ·  SHOW ' + shown.length + '/' + limit + '  ·  tap a row to log, hold-tap to show', R.x, R.y - 8, 18, t.dim, { weight: 'bold' });
  cv.text('PAGE ' + (page + 1) + '/' + pages, R.x + R.w, R.y - 8, 18, t.faint, { align: 'r', weight: 'bold' });
  var cols = 3, gx = 16, gy = 10, cw = (R.w - (cols - 1) * gx) / cols, chh = 58;
  var startI = page * perPage;
  for (var p = 0; p < perPage; p++) {
    var gi = startI + p; if (gi >= all.length) break;
    var c = all[gi], col = p % cols, row = Math.floor(p / cols);
    var x = R.x + col * (cw + gx), y = R.y + 8 + row * (chh + gy);
    var onLog = enabled.indexOf(c.key) >= 0, onShow = shown.indexOf(c.key) >= 0, isSel = gi === sel;
    cv.roundRect(x, y, cw, chh, 3, isSel ? t.panel3 : t.panel2);
    if (isSel) cv.fillRect(x, y, 3, chh, t.accent);
    cv.roundRect(x + 12, y + 15, 26, 26, 2, onLog ? t.good : t.line);
    cv.text('L', x + 25, y + 34, 16, onLog ? t.ink : t.dim, { align: 'c', weight: 'bold' });
    cv.roundRect(x + 44, y + 15, 26, 26, 2, onShow ? t.accent : t.line);
    cv.text('S', x + 57, y + 34, 16, onShow ? t.ink : t.dim, { align: 'c', weight: 'bold' });
    cv.text(c.label, x + 82, y + 26, 19, t.text, { weight: 'bold' });
    var tag = c.read.kind === 'diag' ? (c.cat || 'diag') : (c.read.kind === 'derived' ? 'calc' : 'bus');
    cv.text(tag, x + 82, y + 47, 14, t.faint, {});
    var cvv = cval(view, c.key);
    cv.text(cvv.str + (cvv.unit ? ' ' + cvv.unit : ''), x + cw - 14, y + 37, 20, onLog || onShow ? t.text : t.dim, { align: 'r', weight: 'bold' });
  }
}

// ----------------------------------------------------------------- MAPS -----
function labelOf(slots, idx) { for (var i = 0; i < slots.length; i++) if (slots[i].index === idx) return slots[i].label; return '-'; }
function maps(cv, t, view, R) {
  var m = view.maps || {};
  if (!m.enabled) {
    D.panel(cv, t, R.x, R.y, R.w, R.h, { accent: true, accentColor: t.warn });
    cv.text('MAP CONTROL IS OFF', R.x + R.w / 2, R.y + R.h / 2 - 20, 40, t.text, { align: 'c', weight: 'bold' });
    cv.text('Writing tune maps to the engine is disabled by default.', R.x + R.w / 2, R.y + R.h / 2 + 22, 22, t.dim, { align: 'c' });
    cv.text('Turn it on in SETUP → "Map control" to use this page.', R.x + R.w / 2, R.y + R.h / 2 + 54, 22, t.dim, { align: 'c' });
    return;
  }
  var slots = m.slots || [], chipW = 150, chipH = 84, gap = 14;
  for (var i = 0; i < slots.length; i++) {
    var x = R.x + i * (chipW + gap), isReq = slots[i].index === m.requested, isSel = slots[i].index === m.selected;
    cv.roundRect(x, R.y, chipW, chipH, 3, isReq ? t.panel3 : t.panel2);
    if (isReq) { cv.fillRect(x, R.y, chipW, 4, t.accent); }
    cv.text(slots[i].label, x + chipW / 2, R.y + 46, 22, isReq ? t.accent : t.text, { align: 'c', weight: 'bold' });
    if (isSel) cv.text('ACTIVE', x + chipW / 2, R.y + 70, 15, t.good, { align: 'c', weight: 'bold' });
  }
  var pre = m.pre || { reasons: [] }, py = R.y + chipH + 16, pw = (R.w - 16) / 2;
  D.panel(cv, t, R.x, py, pw, R.h - chipH - 16, { title: 'PRECONDITIONS' });
  cv.text((pre.speedOk ? '✓ ' : '✗ ') + 'Vehicle stationary', R.x + 24, py + 62, 22, pre.speedOk ? t.good : t.crit, { weight: 'bold' });
  cv.text((pre.idleOk ? '✓ ' : '✗ ') + 'Engine at idle', R.x + 24, py + 98, 22, pre.idleOk ? t.good : t.crit, { weight: 'bold' });
  if (pre.reasons && pre.reasons.length) cv.text(pre.reasons[0], R.x + 24, py + 138, 19, t.dim, {});
  else cv.text('Ready to apply the highlighted map.', R.x + 24, py + 138, 19, t.good, {});
  D.panel(cv, t, R.x + pw + 16, py, pw, R.h - chipH - 16, { title: 'STATUS' });
  var sx = R.x + pw + 40;
  if (m.lastMsg) wrapText(cv, t, m.lastMsg, sx, py + 62, pw - 48, 20, m.lastOk ? t.good : t.crit);
  else cv.text('Select a map, then APPLY.', sx, py + 62, 20, t.dim, {});
  cv.text('Requested: ' + labelOf(slots, m.requested), sx, py + 112, 20, t.text, {});
  var active = (m.selected == null) ? 'unknown (not read back)' : (labelOf(slots, m.selected) + (m.confirmed ? '  ✓ confirmed' : ''));
  cv.text('Active: ' + active, sx, py + 144, 20, (m.selected == null) ? t.dim : t.text, {});
  if (m.confirm) overlay(cv, t, 'CONFIRM MAP SWITCH', 'Switch to "' + labelOf(slots, m.requested) + '" — this writes to the DME.', 'Tap APPLY to confirm, BACK to cancel.', t.crit);
}

// A centered modal confirmation overlay.
function overlay(cv, t, title, body, foot, color) {
  cv.fillRect(0, 0, W, BAR.y - 8, 'rgba(6,6,6,0.82)'); // dim the page, keep the action bar bright
  var bw = 900, bh = 240, bx = (W - bw) / 2, by = (H - bh) / 2;
  cv.roundRect(bx, by, bw, bh, 4, t.panel);
  cv.fillRect(bx, by, bw, 5, color || t.accent);
  cv.text(title, W / 2, by + 70, 34, t.text, { align: 'c', weight: 'bold' });
  wrapText(cv, t, body, bx + 60, by + 118, bw - 120, 22, t.dim);
  cv.text(foot, W / 2, by + bh - 34, 22, color || t.accent, { align: 'c', weight: 'bold' });
}

// ------------------------------------------------------------- CONNECT ------
function connect(cv, t, view, R) {
  var e = view.enet || {}, c = view.connect || {};
  var pw = (R.w - 16) * 0.58;

  // PRIMARY: the head-unit diagnostic link — the transport the app actually uses.
  D.panel(cv, t, R.x, R.y, pw, R.h, { title: 'HEAD-UNIT LINK', accent: true });
  var sx = R.x + 24, sy = R.y + 78, big, col, sub;
  if (c.checking) { big = 'Checking…'; col = t.warn; sub = 'Reading the DME over the head unit link.'; }
  else if (c.state === 'ok') { big = 'Connected'; col = t.good; sub = c.detail || 'The car answered.'; }
  else if (c.state === 'fail') { big = 'Not responding'; col = t.crit; sub = c.detail || 'The link did not answer.'; }
  else { big = 'Ready'; col = t.accent; sub = 'Tap CHECK LINK to confirm the car answers.'; }
  cv.text(big, sx, sy, 34, col, { weight: 'bold' });
  var y2 = wrapText(cv, t, sub, sx, sy + 40, pw - 48, 19, t.dim);
  wrapText(cv, t, 'BeeM-Flash reads your car over the head unit’s own diagnostic link. Live data, fault codes and ECU info use it with no connection step — you don’t need to “connect”.', sx, y2 + 16, pw - 48, 18, t.faint);

  // SECONDARY: ENET/DoIP — optional, advanced, and honest that it won't connect here.
  var vx = R.x + pw + 16, vw = R.x + R.w - vx;
  D.panel(cv, t, vx, R.y, vw, R.h, { title: 'ENET / DoIP — OPTIONAL' });
  var ex = vx + 20, ey = R.y + 64;
  ey = wrapText(cv, t, 'For an external ENET / Wi-Fi adapter only. Not needed for normal use — and the head unit’s own software can’t open this link, so SCAN won’t find a vehicle here.', ex, ey, vw - 40, 16, t.faint) + 12;
  if (e.vehicle) { cv.text('Vehicle: ' + (e.vehicle.host || '?'), ex, ey, 17, t.text, { weight: 'bold' }); }
  else if (e.scanning) { cv.text('Scanning…', ex, ey, 17, t.warn, { weight: 'bold' }); }
  else { cv.text(e.enabled ? 'ENET ON — tap ENET SCAN' : 'ENET OFF (tap ENET: OFF to enable)', ex, ey, 15, e.enabled ? t.warn : t.faint, {}); }
}

// --------------------------------------------------------------- CODES ------
function codes(cv, t, view, R) {
  var c = view.codes || {};
  cv.text((c.scope === 'dme' ? 'ENGINE ONLY' : 'ALL MODULES') + ' (' + (c.moduleCount || 0) + ')', R.x, R.y - 8, 18, t.faint, { weight: 'bold' });
  cv.text(c.msg || 'Tap SCAN to read fault codes from the vehicle.', R.x + R.w, R.y - 8, 18, c.confirmClear ? t.warn : t.dim, { align: 'r', weight: c.confirmClear ? 'bold' : 'normal' });
  D.panel(cv, t, R.x, R.y, R.w, R.h, { title: 'MODULES', accent: c.confirmClear, accentColor: t.crit });
  var res = c.result;
  if (!res || !res.modules || !res.modules.length) {
    cv.text(c.scanning ? 'Scanning…' : 'No scan yet.', R.x + 28, R.y + 80, 24, t.dim, {});
    cv.text('Codes are read over the connected ENET/DoIP link. Module addresses are configurable per vehicle.', R.x + 28, R.y + 116, 18, t.faint, {});
    return;
  }
  var y = R.y + 56, rowH = 28, maxRows = 8, shown = 0;
  for (var i = 0; i < res.modules.length && shown < maxRows; i++) {
    var m = res.modules[i], name = (m.module && m.module.name) || 'module', statusTxt, colr;
    if (!m.ok) { statusTxt = 'no response'; colr = t.faint; }
    else if (m.dtcs.length === 0) { statusTxt = 'no codes'; colr = t.good; }
    else { statusTxt = m.dtcs.length + ' code' + (m.dtcs.length === 1 ? '' : 's'); colr = t.warn; }
    cv.text(name, R.x + 28, y, 20, t.text, { weight: 'bold' });
    cv.text(statusTxt, R.x + 430, y, 20, colr, {});
    if (m.ok && m.dtcs.length) {
      var cs = [];
      for (var k = 0; k < m.dtcs.length && k < 6; k++) cs.push((m.dtcs[k].bmw || m.dtcs[k].code) + (m.dtcs[k].status && m.dtcs[k].status.confirmed ? '' : '?'));
      cv.text(cs.join('  ') + (m.dtcs.length > 6 ? '  +' + (m.dtcs.length - 6) : ''), R.x + 620, y, 19, t.dim, {});
    }
    y += rowH; shown++;
  }
  // (DME calibration / tune detection lives on the INFO tab - it was confusing
  //  and overlapped the module list when shown here.)
  cv.text('“?” = pending (not confirmed).  Total: ' + res.totalDtcs + ' across ' + res.reached + '/' + res.scanned + ' modules.', R.x + 28, R.y + R.h - 20, 17, t.faint, {});
}

// --------------------------------------------------------------- FLASH ------
function flash(cv, t, view, R) {
  var f = view.flash || {};
  // engine on/off header
  var hw = R.w;
  D.panel(cv, t, R.x, R.y, hw, 72, {});
  cv.text('CALIBRATION FLASH ENGINE', R.x + 24, R.y + 44, 24, t.text, { weight: 'bold' });
  var tgl = f.armed ? 'ON' : 'OFF', tcol = f.armed ? t.accent : t.faint;
  cv.roundRect(R.x + hw - 150, R.y + 18, 126, 38, 3, f.armed ? t.accent : t.panel3);
  cv.text(tgl, R.x + hw - 150 + 63, R.y + 43, 22, f.armed ? t.ink : t.dim, { align: 'c', weight: 'bold' });

  var py = R.y + 84, ph = R.h - 84;
  D.panel(cv, t, R.x, py, hw, ph, { accent: true, accentColor: t.crit });
  if (!f.armed) {
    if (f.blocked) {
      // Prerequisite: the ECU must be read on the INFO tab first.
      cv.text('READ THE ECU FIRST', R.x + 24, py + 52, 28, t.crit, { weight: 'bold' });
      cv.text('Flashing is locked until you read the car on the INFO tab — you must see', R.x + 24, py + 90, 20, t.text, {});
      cv.text('its current software and calibration (and any tune) before writing to it.', R.x + 24, py + 118, 20, t.text, {});
      cv.text('Open INFO → READ, then come back here.', R.x + 24, py + 156, 19, t.accent, { weight: 'bold' });
      return;
    }
    cv.text('ENGINE OFF — SAFE', R.x + 24, py + 48, 26, t.text, { weight: 'bold' });
    cv.text('Nothing can be written to the DME while the flash engine is OFF.', R.x + 24, py + 82, 19, t.dim, {});
    cv.text('For an ALREADY-UNLOCKED DME (flashed tune). This app does not unlock the DME or', R.x + 24, py + 112, 18, t.faint, {});
    cv.text('bypass its signature — a locked, signature-checked ECU will reject the write.', R.x + 24, py + 136, 18, t.faint, {});
    if (f.tune) cv.text('On the car now: ' + (f.tune.calId || '—') + (f.tune.detected ? '  (looks like ' + f.tune.detected + ')' : ''), R.x + 24, py + 168, 19, (f.tune.detected || f.tune.modified === true) ? t.crit : t.dim, { weight: (f.tune.detected || f.tune.modified === true) ? 'bold' : 'normal' });
    return;
  }
  // armed
  if (f.running) {
    cv.text('FLASHING — DO NOT INTERRUPT', R.x + 24, py + 50, 26, t.crit, { weight: 'bold' });
    cv.text(f.step || '…', R.x + 24, py + 86, 20, t.dim, {});
    var bx = R.x + 24, bw = hw - 48, by = py + 110;
    cv.roundRect(bx, by, bw, 22, 2, t.panel3);
    cv.roundRect(bx, by, Math.max(4, bw * (f.progress || 0) / 100), 22, 2, t.accent);
    cv.text((f.progress || 0) + '%', R.x + hw / 2, by + 54, 22, t.text, { align: 'c', weight: 'bold' });
    return;
  }
  if (!f.descriptor) {
    cv.text('NO CALIBRATION LOADED', R.x + 24, py + 50, 24, t.warn, { weight: 'bold' });
    cv.text(f.status || 'Place your descriptor + calibration under the app data dir (flash/).', R.x + 24, py + 86, 19, t.dim, {});
    cv.text('Nothing is bundled — you supply the calibration, address and keys. See docs/FLASHING.md.', R.x + 24, py + 116, 18, t.faint, {});
    return;
  }
  var d = f.descriptor;
  cv.text('CALIBRATION READY', R.x + 24, py + 36, 24, t.text, { weight: 'bold' });
  // left column: the write parameters
  var rows = [['Address', d.addressHex || '—'], ['Size', (d.size || 0) + ' bytes'], ['Security', d.security || 'none'],
    ['Erase', d.erase || 'none'], ['Verify', d.verify || 'none']];
  for (var i = 0; i < rows.length; i++) {
    var yy = py + 72 + i * 26;
    cv.text(rows[i][0].toUpperCase(), R.x + 24, yy, 15, t.faint, { weight: 'bold' });
    cv.text(rows[i][1], R.x + 200, yy, 19, t.text, {});
  }
  // right column: what's on the car, the image fingerprint, and checksum status
  var rx = R.x + Math.round(R.w * 0.52);
  if (f.tune) {
    var oc = (f.tune.detected || f.tune.modified === true);
    cv.text('ON CAR', rx, py + 46, 15, t.faint, { weight: 'bold' });
    cv.text((f.tune.calId || '—') + (f.tune.detected ? '  (looks like ' + f.tune.detected + ')' : ''), rx, py + 72, 19, oc ? t.crit : t.dim, { weight: oc ? 'bold' : 'normal' });
  }
  if (d.fingerprint) {
    var fk = d.fingerprint.kind, fcol = (fk === 'stock') ? t.text : (fk === 'mhdplus' ? t.accent : t.dim);
    cv.text('IMAGE', rx, py + 110, 15, t.faint, { weight: 'bold' });
    cv.text(d.fingerprint.text, rx, py + 136, 19, fcol, { weight: fk ? 'bold' : 'normal' });
  }
  if (d.checksum) {
    var cz = d.checksum, czText, czCol;
    if (cz.ok) { czText = 'valid (' + cz.count + ' block' + (cz.count === 1 ? '' : 's') + ')'; czCol = t.text; }
    else if (cz.correct) { czText = cz.bad + ' of ' + cz.count + ' invalid — will CORRECT on flash'; czCol = t.accent; }
    else { czText = cz.bad + ' of ' + cz.count + ' INVALID — correction off (flash blocked)'; czCol = t.crit; }
    cv.text('CHECKSUMS', rx, py + 174, 15, t.faint, { weight: 'bold' });
    cv.text(czText, rx, py + 200, 19, czCol, { weight: cz.ok ? 'normal' : 'bold' });
  }
  if (f.result) cv.text(f.result.message, R.x + 24, py + ph - 12, 18, f.result.ok ? (f.result.confirmed ? t.good : t.accent) : t.crit, { weight: 'bold' });
  else cv.text('Tap FLASH, then confirm. Charged battery, stable connection, do not interrupt.', R.x + 24, py + ph - 12, 18, t.crit, {});
  if (f.confirm) overlay(cv, t, 'WRITE TO THE DME?', 'This writes ' + (d.size || 0) + ' bytes to ' + (d.addressHex || 'the calibration section') + '. It can damage or brick the ECU. Your vehicle, your data, your responsibility.', 'Tap FLASH to confirm, BACK to cancel.', t.crit);
}

// --------------------------------------------------------------- SETUP ------
function setupDiag(cv, t, view, R) {
  var d = view.bdiag || {}, res = d.result;
  cv.text('BRIDGE DIAGNOSTICS', R.x, R.y - 8, 18, t.faint, { weight: 'bold' });
  cv.text(d.running ? 'Running…' : (res ? 'Done' : 'Tap RUN'), R.x + R.w, R.y - 8, 18, t.dim, { align: 'r' });
  if (!res) {
    cv.text('Tests what the app itself can check, no SSH needed:', R.x, R.y + 30, 20, t.text, {});
    cv.text('NET  — the head unit\u2019s Wi-Fi/IP addresses (the address a phone would target)', R.x + 10, R.y + 66, 17, t.dim, {});
    cv.text('P1   — can the app reach a bridge daemon\u2019s local socket', R.x + 10, R.y + 92, 17, t.dim, {});
    cv.text('P6   — one live read from the car over the TASU link (does the DME answer us)', R.x + 10, R.y + 118, 17, t.dim, {});
    cv.text('P3 (a phone reaching the head unit) needs the root daemon \u2014 see tools/bridge-probes.', R.x + 10, R.y + 158, 16, t.faint, {});
    return;
  }
  var y = R.y + 18, L = R.x + 10;
  // NET
  cv.text('NET', L, y, 16, t.accent, { weight: 'bold' });
  var nets = res.net || [];
  if (!nets.length) cv.text('no interfaces', L + 70, y, 17, t.dim, {});
  for (var i = 0; i < nets.length && i < 5; i++) {
    var n = nets[i], hot = /wlan/i.test(n.iface || '');
    cv.text((n.iface || '?') + '   ' + (n.ip || '') + '   ' + (n.mac || ''), L + 70, y + i * 22, 16,
      hot ? t.accent : (n.internal ? t.faint : t.text), { weight: hot ? 'bold' : 'normal' });
  }
  // P1 sockets
  y = R.y + 18; var R2 = R.x + R.w * 0.52;
  cv.text('P1 app\u2192daemon', R2, y, 16, t.accent, { weight: 'bold' });
  var socks = res.sockets || [];
  for (var j = 0; j < socks.length && j < 3; j++) {
    var sk = socks[j], okk = sk.status === 'ok';
    cv.text(sk.status.toUpperCase() + '  ' + sk.path, R2, y + 24 + j * 22, 15, okk ? t.accent : t.faint, { weight: okk ? 'bold' : 'normal' });
  }
  if (!socks.length) cv.text('no socket paths tested', R2, y + 24, 15, t.faint, {});
  // TASU (P6)
  var ty = R.y + 150;
  cv.fillRect(R.x, ty - 16, R.w, 1, t.line);
  cv.text('P6 TASU', L, ty + 6, 16, t.accent, { weight: 'bold' });
  var tu = res.tasu || {};
  var tmsg, tcol;
  if (tu.status === 'ok') { tmsg = 'DME answered \u2014 VIN ' + (tu.vin || '') + '  (the car talks to us \u2014 GO)'; tcol = t.text; }
  else if (tu.status === 'nrc') { tmsg = 'DME refused: NRC 0x' + (tu.nrc || 0).toString(16).toUpperCase() + ' (reached the ECU, it declined this read)'; tcol = t.warn; }
  else if (tu.status === 'no-reply') { tmsg = 'No reply from the DME (' + (tu.note || '') + ')'; tcol = t.crit; }
  else if (tu.status === 'no-link') { tmsg = 'No diagnostic link in this build'; tcol = t.faint; }
  else { tmsg = 'Unexpected: ' + JSON.stringify(tu).slice(0, 60); tcol = t.dim; }
  cv.text(tmsg, L + 110, ty + 6, 17, tcol, { weight: 'bold' });
  cv.text('P3 (phone \u2192 head unit) is not testable from the app \u2014 run tools/bridge-probes on the unit.', L, ty + 40, 15, t.faint, {});
}

function setup(cv, t, view, R) {
  if (view.setupView === 'diag') return setupDiag(cv, t, view, R);
  var items = view.setup || [];
  var cols = 2, gx = 16, gy = 12, cw = (R.w - gx) / cols, rh = 56, perCol = Math.ceil(items.length / cols);
  for (var i = 0; i < items.length; i++) {
    var col = Math.floor(i / perCol), row = i % perCol;
    var x = R.x + col * (cw + gx), y = R.y + row * (rh + gy);
    var it = items[i], sel = i === (view.setupSel || 0);
    cv.roundRect(x, y, cw, rh, 3, sel ? t.panel3 : t.panel2);
    if (sel) cv.fillRect(x, y, 3, rh, t.accent);
    cv.text(it.label, x + 20, y + 24, 19, t.text, { weight: 'bold' });
    if (it.hint) cv.text(it.hint, x + 20, y + 46, 14, t.faint, {});
    var danger = it.danger && (it.value === 'armed' || it.value === 'on' || it.value === true);
    cv.text(String(it.display), x + cw - 20, y + 34, 22, danger ? t.crit : t.accent, { align: 'r', weight: 'bold' });
  }
}

// ---------------------------------------------------------------- INFO -----
// Read-only ECU identification / calibration. Two columns of label : value.
function info(cv, t, view, R) {
  var f = view.info || {};
  cv.text('READ-ONLY', R.x, R.y - 8, 18, t.faint, { weight: 'bold' });
  cv.text(f.msg || 'Tap READ to query the DME’s identification + calibration IDs.', R.x + R.w, R.y - 8, 18, t.dim, { align: 'r' });
  D.panel(cv, t, R.x, R.y, R.w, R.h, { title: 'ECU IDENTIFICATION', accent: true });
  var items = f.items;
  if (!items || !items.length) {
    cv.text(f.reading ? 'Reading…' : 'No data yet.', R.x + 28, R.y + 82, 24, t.dim, {});
    cv.text('Standard 22 F1xx identification DIDs (VIN, hardware/software numbers, serial,', R.x + 28, R.y + 116, 18, t.faint, {});
    cv.text('calibration ID…). Read-only; your DME may expose a subset. Configurable per vehicle.', R.x + 28, R.y + 140, 18, t.faint, {});
    return;
  }
  var cols = 2, cw = (R.w - 40) / cols, perCol = Math.ceil(items.length / cols);
  for (var i = 0; i < items.length; i++) {
    var col = Math.floor(i / perCol), row = i % perCol;
    var x = R.x + 28 + col * cw, y = R.y + 56 + row * 29;
    var it = items[i];
    cv.text(it.label.toUpperCase(), x, y, 15, t.faint, { weight: 'bold' });
    cv.text(it.value, x + 230, y, 20, it.ok ? t.text : t.faint, { weight: it.ok ? 'bold' : 'normal' });
    cv.fillRect(x, y + 11, cw - 24, 1, t.line);
  }
  // Tune / last-flash status line.
  var tn = f.tune, bv = f.binVerify;
  if (tn || bv) {
    cv.fillRect(R.x + 24, R.y + R.h - 68, R.w - 48, 1, t.line);
  }
  if (tn) {
    var oc = (tn.detected || tn.modified === true);
    cv.text('TUNE (ID)', R.x + 28, R.y + R.h - 44, 15, t.faint, { weight: 'bold' });
    var msg = tn.detected ? ('Looks like ' + tn.detected + ' — ' + (tn.calId || '')) :
      (tn.modified === true ? ('Looks modified — ' + (tn.calId || '')) :
      (tn.modified === false ? ('Looks stock — ' + (tn.calId || '')) : tn.note));
    cv.text(msg, R.x + 150, R.y + R.h - 44, 18, oc ? t.crit : t.text, { weight: oc ? 'bold' : 'normal' });
  }
  if (bv) {
    // On-car image fingerprint (definitive): stock = white, anything else = red.
    var isStock = bv.match && bv.kind === 'stock';
    cv.text('IMAGE', R.x + 28, R.y + R.h - 16, 15, t.faint, { weight: 'bold' });
    var imsg = bv.match ? (bv.kind === 'stock' ? ('STOCK image (' + bv.id + ')') : ('MHD+ base (' + bv.id + ')')) : 'not a known stock image (modified)';
    cv.text(imsg, R.x + 150, R.y + R.h - 16, 18, isStock ? t.text : t.crit, { weight: isStock ? 'normal' : 'bold' });
  }
}

function content(name) {
  return { live: live, log: log, channels: channels, maps: maps, connect: connect, codes: codes, info: info, flash: flash, setup: setup }[name] || live;
}

module.exports = {
  W: W, H: H, CONTENT: CONTENT, BAR: BAR,
  tabRects: tabRects, barRects: barRects, scaleCv: scaleCv,
  chrome: chrome, content: content,
  live: live, log: log, channels: channels, maps: maps, connect: connect, codes: codes, info: info, flash: flash, setup: setup,
  cval: cval,
  byName: content
};
