'use strict';
//
// surface.js — adapts the on-unit ctx.canvas to our drawing contract (cv).
//
// Used only on the head unit. The simulator supplies its own cv backend, so this
// file is never on the critical path for off-car review. The mapping below
// follows the documented canvas primitives (fillRect, roundRect, arc, text, ...);
// a few option names (stroke width, text align) are the device-tunable points
// and are isolated here so nothing else needs to change if they differ.
//
function deg2rad(d) { return d * Math.PI / 180; }

function fromCtxCanvas(canvas, W, H) {
  function align(a) { return a === 'c' ? 'center' : (a === 'r' ? 'right' : 'left'); }
  function font(weight) { return weight === 'bold' ? 'bold' : (weight === 'light' ? 'light' : 'num'); }

  return {
    handle: canvas,
    clear: function (color) { canvas.fillRect(0, 0, W, H, color); },
    fillRect: function (x, y, w, h, color) { canvas.fillRect(x, y, w, h, color); },
    roundRect: function (x, y, w, h, r, color) { canvas.roundRect(x, y, w, h, r, color); },
    strokeRoundRect: function (x, y, w, h, r, color, lw) {
      canvas.strokeRoundRect(x, y, w, h, r, color, { width: lw || 2 });
    },
    line: function (x1, y1, x2, y2, color, lw) { canvas.line(x1, y1, x2, y2, color, { width: lw || 2 }); },
    circle: function (cx, cy, r, color) { canvas.circle(cx, cy, r, color); },
    arcSector: function (cx, cy, r0, r1, a0, a1, color) {
      canvas.arc(cx, cy, r0, r1, deg2rad(a0), deg2rad(a1), color, { round: false });
    },
    text: function (str, x, y, size, color, opts) {
      opts = opts || {};
      return canvas.text(String(str), x, y, size, color, { font: font(opts.weight), align: align(opts.align) });
    },
    textWidth: function (str, size, weight) {
      return canvas.textWidth(String(str), size, { font: font(weight) });
    }
  };
}

module.exports = { fromCtxCanvas: fromCtxCanvas, deg2rad: deg2rad };
