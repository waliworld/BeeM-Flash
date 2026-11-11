'use strict';
//
// draw.js — dashboard widgets built on a small drawing surface (`cv`).
//
// The `cv` contract (implemented by the on-unit canvas adapter and by the
// simulator backends) is:
//   cv.clear(color)
//   cv.fillRect(x,y,w,h,color)
//   cv.roundRect(x,y,w,h,r,color)
//   cv.strokeRoundRect(x,y,w,h,r,color,lineWidth)
//   cv.line(x1,y1,x2,y2,color,lineWidth)
//   cv.circle(cx,cy,r,color)
//   cv.arcSector(cx,cy,r0,r1,aStartDeg,aEndDeg,color)   // filled annulus sector, CW in screen space
//   cv.text(str,x,y,size,color,opts) -> width            // opts:{align:'l'|'c'|'r', weight:'normal'|'bold'|'light'}
//   cv.textWidth(str,size,weight) -> width
//
var F = require('../format');

var GAUGE_A0 = 150;
var GAUGE_A1 = 390; // 240-degree sweep, open at the bottom

function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

function panel(cv, t, x, y, w, h, opts) {
  opts = opts || {};
  cv.roundRect(x, y, w, h, opts.r || 14, opts.fill || t.panel);
  if (opts.title) {
    cv.text(opts.title, x + 18, y + 30, 20, t.dim, { weight: 'bold' });
  }
}

function badge(cv, t, x, y, text, color, textColor) {
  var padX = 12;
  var w = cv.textWidth(text, 18, 'bold') + padX * 2;
  cv.roundRect(x, y, w, 30, 15, color);
  cv.text(text, x + w / 2, y + 21, 18, textColor || '#07121a', { align: 'c', weight: 'bold' });
  return w;
}

function recDot(cv, t, x, y, on, label) {
  cv.circle(x + 10, y + 10, 9, on ? t.rec : t.faint);
  cv.text(label, x + 26, y + 17, 20, on ? t.text : t.dim, { weight: 'bold' });
}

// A stat tile: label, big value, unit, status colour.
function statTile(cv, t, x, y, w, h, o) {
  cv.roundRect(x, y, w, h, 12, t.panel2);
  var lvl = o.level || 'ok';
  var accent = lvl === 'crit' ? t.crit : (lvl === 'warn' ? t.warn : (o.accent || t.accent));
  cv.fillRect(x, y + h - 5, w, 5, accent);
  cv.text(o.label, x + 16, y + 28, 18, t.dim, { weight: 'bold' });
  var valColor = lvl === 'crit' ? t.crit : (lvl === 'warn' ? t.warn : t.text);
  var vstr = o.value;
  cv.text(vstr, x + 16, y + h - 26, o.big ? 54 : 44, valColor, { weight: 'bold' });
  if (o.unit) {
    var vw = cv.textWidth(vstr, o.big ? 54 : 44, 'bold');
    cv.text(o.unit, x + 16 + vw + 10, y + h - 30, 20, t.dim, {});
  }
}

// Radial gauge with centre readout.
function radial(cv, t, cx, cy, r, o) {
  var lvl = o.level || 'ok';
  var color = lvl === 'crit' ? t.crit : (lvl === 'warn' ? t.warn : (o.color || t.accent));
  var r0 = r - (o.thick || 26);
  // track
  cv.arcSector(cx, cy, r0, r, GAUGE_A0, GAUGE_A1, t.line);
  // value
  var frac = clamp01(((o.value - o.min) / (o.max - o.min)));
  if (F.isNum(o.value)) {
    var a1 = GAUGE_A0 + frac * (GAUGE_A1 - GAUGE_A0);
    cv.arcSector(cx, cy, r0, r, GAUGE_A0, a1, color);
  }
  // centre value
  var disp = F.isNum(o.value) ? F.fixed(o.value, o.dp == null ? 0 : o.dp) : '--';
  cv.text(disp, cx, cy + 8, o.vsize || 72, t.text, { align: 'c', weight: 'bold' });
  if (o.label) cv.text(o.label, cx, cy - r0 + 34, 20, t.dim, { align: 'c', weight: 'bold' });
  if (o.sub) cv.text(o.sub, cx, cy + 44, 22, t.dim, { align: 'c' });
  if (o.unit) cv.text(o.unit, cx, cy + 40, 22, t.dim, { align: 'c' });
}

// Horizontal bar meter.
function barMeter(cv, t, x, y, w, h, o) {
  var lvl = o.level || 'ok';
  var color = lvl === 'crit' ? t.crit : (lvl === 'warn' ? t.warn : (o.color || t.accent));
  cv.text(o.label, x, y + 18, 18, t.dim, { weight: 'bold' });
  var disp = F.isNum(o.value) ? F.fixed(o.value, o.dp == null ? 0 : o.dp) : '--';
  cv.text(disp + (o.unit ? ' ' + o.unit : ''), x + w, y + 18, 20, color, { align: 'r', weight: 'bold' });
  var by = y + 28;
  cv.roundRect(x, by, w, h, h / 2, t.panel2);
  var frac = clamp01((o.value - o.min) / (o.max - o.min));
  if (F.isNum(o.value) && frac > 0) cv.roundRect(x, by, Math.max(h, w * frac), h, h / 2, color);
}

module.exports = {
  panel: panel,
  badge: badge,
  recDot: recDot,
  statTile: statTile,
  radial: radial,
  barMeter: barMeter,
  GAUGE_A0: GAUGE_A0,
  GAUGE_A1: GAUGE_A1
};
