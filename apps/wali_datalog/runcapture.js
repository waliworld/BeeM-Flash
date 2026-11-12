'use strict';
//
// runcapture.js — detect wide-open-throttle "pulls" and summarise each one.
//
// Fed one metric sample per tick (feed(metric, tMs)), it watches throttle, rpm
// and speed, and when it sees a pull (near-WOT with the car accelerating) it
// captures a run: peak boost, an ESTIMATED power figure, and interval times.
//
// The power figure is an ACCELERATION-BASED ESTIMATE, not a dyno reading. It
// comes from P = (m·a + drag)·v using the vehicle mass and drag you configure;
// it is a rough wheel-power estimate and depends entirely on those inputs and a
// clean, level, full-power pull. Treat it as indicative, not a measurement.
//
function num(v) { return typeof v === 'number' && isFinite(v) ? v : NaN; }

// opts: { massKg, cda (Cd·A m²), crr, drivetrain (crank = wheel/drivetrain),
//         wotPedal (enter %), offPedal (exit %), minSpeed (km/h) }
function RunCapture(opts) {
  opts = opts || {};
  this.massKg = opts.massKg || 1700;      // car + driver; owner-configurable
  this.cda = opts.cda != null ? opts.cda : 0.70; // Cd·A (coupe ≈ 0.30·2.2)
  this.crr = opts.crr != null ? opts.crr : 0.015;
  this.drivetrain = opts.drivetrain || 0.85; // crank ≈ wheel / 0.85
  this.rho = 1.2; this.g = 9.81;
  this.wotPedal = opts.wotPedal || 90;
  this.offPedal = opts.offPedal || 55;
  this.minSpeed = opts.minSpeed != null ? opts.minSpeed : 10;
  this.reset();
}
RunCapture.prototype.reset = function () { this.runs = []; this.cur = null; this._prev = null; this._aEma = 0; };

RunCapture.prototype.pedalOf = function (m) {
  var p = num(m.pedal); if (!isNaN(p)) return p;
  var t = num(m.throttle); return isNaN(t) ? NaN : t;
};

// Feed one sample. Returns the active run (live) or null.
RunCapture.prototype.feed = function (m, tMs) {
  if (!m) return this.cur;
  var t = num(tMs); if (isNaN(t)) return this.cur;
  var vk = num(m.speed), rpm = num(m.rpm), pedal = this.pedalOf(m), boost = num(m.boost);
  var v = isNaN(vk) ? NaN : vk / 3.6; // m/s

  // acceleration from the speed derivative (smoothed), else fall back to gLong
  var a = NaN;
  if (this._prev && !isNaN(v) && !isNaN(this._prev.v)) {
    var dt = (t - this._prev.t) / 1000;
    if (dt > 0.001 && dt < 1) a = (v - this._prev.v) / dt;
  }
  if (isNaN(a) && !isNaN(num(m.gLong))) a = num(m.gLong) * this.g;
  if (!isNaN(a)) this._aEma = this._aEma ? (this._aEma * 0.6 + a * 0.4) : a;
  var aUse = this._aEma;

  // estimated power (kW) at the wheels, from this sample
  var pkw = NaN;
  if (!isNaN(v) && v > 2 && !isNaN(aUse)) {
    var fInertia = this.massKg * aUse;
    var fDrag = 0.5 * this.rho * this.cda * v * v + this.crr * this.massKg * this.g;
    pkw = (fInertia + fDrag) * v / 1000;
  }

  var accelerating = !isNaN(aUse) && aUse > 0.3;
  var wot = !isNaN(pedal) && pedal >= this.wotPedal;

  if (!this.cur) {
    if (wot && accelerating && !isNaN(vk) && vk >= 0) {
      this.cur = { startMs: t, endMs: t, vStart: vk, vEnd: vk, rpmStart: rpm, rpmEnd: rpm,
        peakBoost: isNaN(boost) ? NaN : boost, peakPowerKw: isNaN(pkw) ? 0 : pkw,
        peakPowerSpeed: vk, peakPowerRpm: rpm, samples: 1, _marks: {} };
      this._markInterval(this.cur, vk, t);
    }
  } else {
    var r = this.cur;
    r.endMs = t; r.vEnd = vk; r.rpmEnd = rpm; r.samples++;
    if (!isNaN(boost) && (isNaN(r.peakBoost) || boost > r.peakBoost)) r.peakBoost = boost;
    if (!isNaN(pkw) && pkw > r.peakPowerKw) { r.peakPowerKw = pkw; r.peakPowerSpeed = vk; r.peakPowerRpm = rpm; }
    this._markInterval(r, vk, t);
    // end the run when the driver lifts, or the car stops accelerating for real
    var ended = (!isNaN(pedal) && pedal < this.offPedal) || (!isNaN(aUse) && aUse < -0.2) || (t - r.startMs > 30000);
    if (ended) this._finish();
  }

  this._prev = { t: t, v: v };
  return this.cur;
};

// Record the time the car crossed common interval speeds (km/h) during a run.
RunCapture.prototype._markInterval = function (r, vk, t) {
  if (isNaN(vk)) return;
  var bands = [60, 100, 130, 160, 200];
  for (var i = 0; i < bands.length; i++) if (r._marks[bands[i]] == null && vk >= bands[i]) r._marks[bands[i]] = t;
};

RunCapture.prototype._finish = function () {
  var r = this.cur; this.cur = null;
  if (!r || r.samples < 4 || (r.endMs - r.startMs) < 800) return; // ignore noise
  r.durationMs = r.endMs - r.startMs;
  r.peakPowerHp = r.peakPowerKw * 1.34102;
  r.peakPowerCrankHp = (r.peakPowerKw / this.drivetrain) * 1.34102;
  var mk = r._marks;
  function span(a, b) { return (mk[a] != null && mk[b] != null) ? (mk[b] - mk[a]) : null; }
  r.t100_200 = span(100, 200);   // km/h
  r.t60_130mph = span(97, 209);  // ~60-130 mph in km/h bands (not exact; see note)
  delete r._marks;
  this.runs.push(r);
  return r;
};

RunCapture.prototype.last = function () { return this.runs.length ? this.runs[this.runs.length - 1] : null; };

module.exports = RunCapture;
