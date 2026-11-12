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
var CONTENT = { x: 24, y: 104, w: W - 48, h: 324 };
var BAR = { x: 24, y: 438, w: W - 48, h: 74 };

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
  cv.text('W', 44, 30, 22, t.ink, { align: 'c', weight: 'bold' });
  cv.text('WALI', 76, 30, 22, t.text, { weight: 'bold' });
  var wwali = cv.textWidth('WALI', 22, 'bold');
  cv.text('DATALOG', 76 + wwali + 10, 30, 22, t.dim, { weight: 'bold' });

  // status (right)
  var sx = W - 24;
  cv.text(view.units === 'imperial' ? 'IMPERIAL' : 'METRIC', sx, 29, 16, t.faint, { align: 'r', weight: 'bold' });
  sx -= cv.textWidth(view.units === 'imperial' ? 'IMPERIAL' : 'METRIC', 16, 'bold') + 18;
  if (view.rec && view.rec.logging) { var rw = D.badge(cv, t, sx - 118, 6, 'REC ' + F.mmss(view.rec.durationMs), t.rec, '#fff'); sx -= 118 + 12; }
  var slabel = view.demo ? 'DEMO' : (view.live ? 'LIVE' : 'NO DATA');
  var scol = view.demo ? t.warn : (view.live ? t.accent : t.faint);
  D.badge(cv, t, sx - (cv.textWidth(slabel, 18, 'bold') + 24), 6, slabel, scol, t.ink);

  // tab strip
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
    cv.text(tabs[i].label, r.x + r.w / 2, r.y + r.h / 2 + 7, 20, active ? t.accent : t.dim, { align: 'c', weight: 'bold' });
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
function log(cv, t, view, R) {
  var rec = view.rec || {}, st = rec.state || 'idle';
  var pw = 560;
  D.panel(cv, t, R.x, R.y, pw, R.h, { accent: true, accentColor: st === 'logging' ? t.rec : t.accent });
  var word = 'READY', col = t.accent, sub = 'Tap START to record a session';
  if (st === 'logging') { word = '● REC'; col = t.rec; sub = 'Recording ' + rec.enabledCount + ' ch @ ' + rec.rate + ' Hz'; }
  else if (st === 'saving') { word = 'SAVING…'; col = t.warn; sub = 'Flushing to storage'; }
  else if (st === 'done') { word = 'SAVED'; col = t.good; sub = rec.file || ''; }
  else if (st === 'error') { word = 'ERROR'; col = t.crit; sub = rec.error || 'Logging failed'; }
  cv.text(word, R.x + 28, R.y + 86, 64, col, { weight: 'bold' });
  cv.text(sub, R.x + 28, R.y + 124, 20, t.dim, {});
  var stats = [['DURATION', F.mmss(rec.durationMs)], ['SAMPLES', String(rec.samples || 0)],
    ['RATE', (rec.rateActual ? rec.rateActual.toFixed(1) : '0.0') + ' Hz'], ['SIZE', F.humanBytes(rec.bytes || 0)],
    ['MARKERS', String(rec.markers || 0)], ['CHANNELS', String(rec.enabledCount || 0)]];
  for (var i = 0; i < stats.length; i++) {
    var cc = i % 3, rr = Math.floor(i / 3), x = R.x + 28 + cc * 176, y = R.y + 176 + rr * 64;
    cv.text(stats[i][0], x, y, 15, t.faint, { weight: 'bold' });
    cv.text(stats[i][1], x, y + 30, 26, t.text, { weight: 'bold' });
  }
  // sessions
  var lx = R.x + pw + 16, lw = R.x + R.w - lx;
  D.panel(cv, t, lx, R.y, lw, R.h, { title: 'RECENT LOGS' });
  var sess = view.sessions || [];
  if (sess.length === 0) {
    cv.text('No logs yet.', lx + 24, R.y + 90, 24, t.dim, {});
    cv.text('Recorded sessions appear here and export to USB.', lx + 24, R.y + 124, 18, t.faint, {});
  } else {
    for (var s = 0; s < Math.min(sess.length, 6); s++) {
      var yy = R.y + 72 + s * 40;
      cv.text(sess[s].name, lx + 24, yy, 19, t.text, {});
      cv.text(F.humanBytes(sess[s].size), lx + lw - 20, yy, 19, t.dim, { align: 'r' });
      cv.fillRect(lx + 24, yy + 11, lw - 44, 1, t.line);
    }
  }
}

// ------------------------------------------------------------- CHANNELS -----
function channels(cv, t, view, R) {
  var enabled = view.enabled || [], shown = view.displayed || [], limit = view.maxtiles || 8;
  var all = Channels.all(), perPage = 15, sel = view.selection || 0;
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
  if (m.confirm) overlay(cv, t, 'CONFIRM MAP SWITCH', 'Switch to "' + labelOf(slots, m.requested) + '" — this writes to the DME.', 'Tap APPLY to confirm, BACK to cancel.', t.warn);
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
  var e = view.enet || {};
  var pw = (R.w - 16) * 0.6;
  D.panel(cv, t, R.x, R.y, pw, R.h, { title: 'BEFORE YOU CONNECT', accent: true });
  var lines = [
    'Opens a connection to your car’s diagnostic bus (ENET / DoIP) to read live data.',
    'This link is read-only: live data + fault-code reading. Writes (clear codes, map switch, flashing) are separate, confirmed actions.',
    'Use a cable/adapter you trust, on a vehicle you own. Keep the car stationary while connecting hardware.',
    'Disconnect if anything seems unexpected. You are responsible for how this connection is used.'
  ];
  var ly = R.y + 58;
  for (var i = 0; i < lines.length; i++) ly = wrapText(cv, t, '› ' + lines[i], R.x + 24, ly, pw - 48, 18, t.dim) + 6;

  var vx = R.x + pw + 16, vw = R.x + R.w - vx;
  D.panel(cv, t, vx, R.y, vw, R.h, { title: 'VEHICLE' });
  if (e.vehicle) {
    cv.text('VIN', vx + 24, R.y + 70, 15, t.faint, { weight: 'bold' }); cv.text(e.vehicle.vin || '(unknown)', vx + 24, R.y + 98, 22, t.text, {});
    cv.text('HOST', vx + 24, R.y + 134, 15, t.faint, { weight: 'bold' }); cv.text(e.vehicle.host || '--', vx + 24, R.y + 162, 22, t.text, {});
    cv.text('ECU', vx + 24, R.y + 198, 15, t.faint, { weight: 'bold' }); cv.text('0x' + (e.vehicle.logicalAddress || 0).toString(16), vx + 24, R.y + 226, 22, t.text, {});
  } else if (e.scanning) { cv.text('Scanning…', vx + 24, R.y + 100, 24, t.warn, { weight: 'bold' }); }
  else { cv.text('No vehicle connected', vx + 24, R.y + 100, 22, t.dim, {}); cv.text(e.enabled ? 'Tap SCAN to search.' : 'Tap ENABLE, then SCAN.', vx + 24, R.y + 132, 18, t.faint, {}); }

  // state strip + ack box
  var by = R.y + R.h - 52;
  cv.roundRect(R.x + 24, by, 28, 28, 2, e.acknowledged ? t.good : t.line);
  if (e.acknowledged) cv.text('✓', R.x + 38, by + 21, 20, t.ink, { align: 'c', weight: 'bold' });
  cv.text('I have read and understand this warning', R.x + 64, by + 21, 20, t.text, { weight: 'bold' });
  var stateTxt, stateColor;
  if (!e.acknowledged) { stateTxt = 'LOCKED — tap ACK'; stateColor = t.dim; }
  else if (e.connected) { stateTxt = 'CONNECTED (read-only)'; stateColor = t.good; }
  else if (e.enabled) { stateTxt = 'ENABLED — tap SCAN'; stateColor = t.warn; }
  else { stateTxt = 'DISABLED — tap ENABLE'; stateColor = t.dim; }
  cv.text(stateTxt, R.x + R.w - 8, by + 21, 20, stateColor, { align: 'r', weight: 'bold' });
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
  var y = R.y + 62, rowH = 34, maxRows = 7, shown = 0;
  for (var i = 0; i < res.modules.length && shown < maxRows; i++) {
    var m = res.modules[i], name = (m.module && m.module.name) || 'module', statusTxt, colr;
    if (!m.ok) { statusTxt = 'no response'; colr = t.faint; }
    else if (m.dtcs.length === 0) { statusTxt = 'no codes'; colr = t.good; }
    else { statusTxt = m.dtcs.length + ' code' + (m.dtcs.length === 1 ? '' : 's'); colr = t.warn; }
    cv.text(name, R.x + 28, y, 20, t.text, { weight: 'bold' });
    cv.text(statusTxt, R.x + 430, y, 20, colr, {});
    if (m.ok && m.dtcs.length) {
      var cs = [];
      for (var k = 0; k < m.dtcs.length && k < 6; k++) cs.push(m.dtcs[k].code + (m.dtcs[k].status && m.dtcs[k].status.confirmed ? '' : '?'));
      cv.text(cs.join('  ') + (m.dtcs.length > 6 ? '  +' + (m.dtcs.length - 6) : ''), R.x + 620, y, 19, t.dim, {});
    }
    y += rowH; shown++;
  }
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
    cv.text('ENGINE OFF — SAFE', R.x + 24, py + 50, 26, t.text, { weight: 'bold' });
    cv.text('Nothing can be written to the DME while the flash engine is OFF.', R.x + 24, py + 86, 20, t.dim, {});
    cv.text('Turn it ON to review your calibration descriptor and flash. Your vehicle, your data, your responsibility.', R.x + 24, py + 118, 19, t.faint, {});
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
  cv.text('CALIBRATION READY', R.x + 24, py + 42, 24, t.text, { weight: 'bold' });
  var rows = [['Address', d.addressHex || '—'], ['Size', (d.size || 0) + ' bytes'], ['Security', d.security || 'none'],
    ['Erase', d.erase || 'none'], ['Verify', d.verify || 'none']];
  for (var i = 0; i < rows.length; i++) {
    var yy = py + 74 + i * 28;
    cv.text(rows[i][0].toUpperCase(), R.x + 24, yy, 15, t.faint, { weight: 'bold' });
    cv.text(rows[i][1], R.x + 200, yy, 19, t.text, {});
  }
  if (f.result) cv.text(f.result.message, R.x + 24, py + ph - 14, 18, f.result.ok ? (f.result.confirmed ? t.good : t.warn) : t.crit, { weight: 'bold' });
  else cv.text('Tap FLASH, then confirm. Charged battery, stable connection, do not interrupt.', R.x + 24, py + ph - 14, 18, t.warn, {});
  if (f.confirm) overlay(cv, t, 'WRITE TO THE DME?', 'This writes ' + (d.size || 0) + ' bytes to ' + (d.addressHex || 'the calibration section') + '. It can damage or brick the ECU. Your vehicle, your data, your responsibility.', 'Tap FLASH to confirm, BACK to cancel.', t.crit);
}

// --------------------------------------------------------------- SETUP ------
function setup(cv, t, view, R) {
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

function content(name) {
  return { live: live, log: log, channels: channels, maps: maps, connect: connect, codes: codes, flash: flash, setup: setup }[name] || live;
}

module.exports = {
  W: W, H: H, CONTENT: CONTENT, BAR: BAR,
  tabRects: tabRects, barRects: barRects,
  chrome: chrome, content: content,
  live: live, log: log, channels: channels, maps: maps, connect: connect, codes: codes, flash: flash, setup: setup,
  cval: cval,
  byName: content
};
