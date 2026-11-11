'use strict';
// cv2d.js — canvas2D implementation of the app drawing contract (browser only).
(function () {
  function fontStr(size, weight) {
    var w = weight === 'bold' ? '700' : (weight === 'light' ? '300' : '600');
    return w + ' ' + size + 'px "Inter","Segoe UI",Roboto,Arial,sans-serif';
  }
  function rr(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  window.makeCv2d = function (canvas, W, H) {
    var g = canvas.getContext('2d');
    return {
      handle: canvas,
      clear: function (c) { g.fillStyle = c; g.fillRect(0, 0, W, H); },
      fillRect: function (x, y, w, h, c) { g.fillStyle = c; g.fillRect(x, y, w, h); },
      roundRect: function (x, y, w, h, r, c) { rr(g, x, y, w, h, r); g.fillStyle = c; g.fill(); },
      strokeRoundRect: function (x, y, w, h, r, c, lw) { rr(g, x, y, w, h, r); g.lineWidth = lw || 2; g.strokeStyle = c; g.stroke(); },
      line: function (x1, y1, x2, y2, c, lw) { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.lineWidth = lw || 2; g.strokeStyle = c; g.stroke(); },
      circle: function (cx, cy, r, c) { g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = c; g.fill(); },
      arcSector: function (cx, cy, r0, r1, a0, a1, c) {
        var A0 = a0 * Math.PI / 180, A1 = a1 * Math.PI / 180;
        g.beginPath();
        g.arc(cx, cy, r1, A0, A1, false);
        g.arc(cx, cy, r0, A1, A0, true);
        g.closePath(); g.fillStyle = c; g.fill();
      },
      text: function (s, x, y, size, c, o) {
        o = o || {};
        g.font = fontStr(size, o.weight);
        g.fillStyle = c;
        g.textAlign = o.align === 'c' ? 'center' : (o.align === 'r' ? 'right' : 'left');
        g.textBaseline = 'alphabetic';
        g.fillText(String(s), x, y);
        var w = g.measureText(String(s)).width;
        g.textAlign = 'left';
        return w;
      },
      textWidth: function (s, size, weight) { g.font = fontStr(size, weight); return g.measureText(String(s)).width; }
    };
  };
})();
