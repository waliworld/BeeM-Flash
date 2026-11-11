'use strict';
//
// record-surface.js — a headless cv backend.
//
// Implements the drawing contract without pixels: it counts operations and
// estimates text widths, so the full App and every screen can be rendered in
// Node (tests / harness) to prove they run without throwing. Pixels come from
// the browser backend (runtime/web) for actual screenshots.
//
function recordSurface(W, H) {
  var ops = [];
  function rec(op, args) { ops.push({ op: op, args: args }); }
  return {
    handle: { _record: true },
    _ops: ops,
    reset: function () { ops.length = 0; },
    clear: function (c) { rec('clear', [c]); },
    fillRect: function (x, y, w, h, c) { rec('fillRect', [x, y, w, h, c]); },
    roundRect: function (x, y, w, h, r, c) { rec('roundRect', [x, y, w, h, r, c]); },
    strokeRoundRect: function (x, y, w, h, r, c, lw) { rec('strokeRoundRect', [x, y, w, h, r, c, lw]); },
    line: function (x1, y1, x2, y2, c, lw) { rec('line', [x1, y1, x2, y2, c, lw]); },
    circle: function (cx, cy, r, c) { rec('circle', [cx, cy, r, c]); },
    arcSector: function (cx, cy, r0, r1, a0, a1, c) { rec('arcSector', [cx, cy, r0, r1, a0, a1, c]); },
    text: function (s, x, y, size, c, o) { rec('text', [s, x, y, size, c, o]); return estWidth(s, size, o); },
    textWidth: function (s, size) { return estWidth(s, size); }
  };
}
function estWidth(s, size, o) {
  s = String(s == null ? '' : s);
  var k = (o && o.weight === 'bold') ? 0.58 : 0.52;
  return s.length * size * k;
}
module.exports = { recordSurface: recordSurface, estWidth: estWidth };
