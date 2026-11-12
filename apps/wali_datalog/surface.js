'use strict';
//
// surface.js — adapts the on-unit ctx.canvas to our drawing contract (cv).
//
// Used only on the head unit. The simulator supplies its own cv backend, so this
// file is never on the critical path for off-car review. Every mapping below is
// matched to the kit's real canvas (kit/runtime/canvas.js):
//   strokeRoundRect(x,y,w,h,r,width,c)   line(xa,ya,xb,yb,width,c)   // width BEFORE colour
//   arc(cx,cy,r0,r1,a0,a1,c,opts)        // angles in DEGREES (its circle() calls arc(..,0,360,..))
//   text(str,x,y,size,c,{font,align})    // fonts baked by the kit are 'label' and 'num' only
// so nothing in our drawing code needs to know the device specifics.
//
function deg2rad(d) { return d * Math.PI / 180; }

function fromCtxCanvas(canvas, W, H) {
  function align(a) { return a === 'c' ? 'center' : (a === 'r' ? 'right' : 'left'); }
  // The kit bakes these families (kit/runtime/fonts/*.json), each with the full
  // glyph set: 'label' (default body text), 'bold', 'light' and 'num' (tabular
  // digits). Map our weights straight onto them; unweighted text is 'label'.
  function font(weight) {
    return weight === 'bold' ? 'bold'
      : weight === 'light' ? 'light'
      : weight === 'num' ? 'num'
      : 'label';
  }

  return {
    handle: canvas,
    clear: function (color) { canvas.fillRect(0, 0, W, H, color); },
    fillRect: function (x, y, w, h, color) { canvas.fillRect(x, y, w, h, color); },
    roundRect: function (x, y, w, h, r, color) { canvas.roundRect(x, y, w, h, r, color); },
    strokeRoundRect: function (x, y, w, h, r, color, lw) {
      canvas.strokeRoundRect(x, y, w, h, r, lw || 2, color);
    },
    line: function (x1, y1, x2, y2, color, lw) { canvas.line(x1, y1, x2, y2, lw || 2, color); },
    circle: function (cx, cy, r, color) { canvas.circle(cx, cy, r, color); },
    arcSector: function (cx, cy, r0, r1, a0, a1, color) {
      canvas.arc(cx, cy, r0, r1, a0, a1, color, { round: false });
    },
    text: function (str, x, y, size, color, opts) {
      opts = opts || {};
      return canvas.text(String(str), x, y, size, color, { font: font(opts.weight), align: align(opts.align), literal: true });
    },
    textWidth: function (str, size, weight) {
      return canvas.textWidth(String(str), size, { font: font(weight), literal: true });
    }
  };
}

module.exports = { fromCtxCanvas: fromCtxCanvas, deg2rad: deg2rad };
