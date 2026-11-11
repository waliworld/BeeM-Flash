'use strict';
//
// demo.js — DEMONSTRATION DATA generator.
//
// Produces a plausible, deterministic "drive" so the whole app (gauges, logging,
// CSV, states) is usable and reviewable without a car. Values are synthetic and
// clearly flagged demo:true everywhere they surface. This is NOT vehicle data.
//
// Toy physics: a scripted throttle drives rpm/speed/boost, temperatures warm up,
// mixture/timing respond to load. Smooth, repeatable, no randomness.
//
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function lerp(a, b, t) { return a + (b - a) * t; }
// Deterministic small "noise" from sines.
function wobble(t, amp, f, p) { return amp * Math.sin(t * f + (p || 0)); }

function Demo() { this.reset(); }

Demo.prototype.reset = function () {
  this.t = 0;         // seconds
  this.last = null;   // last wall-clock ms
  this.rpm = 820;
  this.speed = 0;
  this.gear = 1;
  this.throttle = 0;
  this.coolant = 60;
  this.oil = 55;
  this.iat = 28;
  this.egt = 300;
};

// Scripted throttle over a 44 s loop: cruise, pull, coast, cruise, pull, cool.
Demo.prototype._scriptThrottle = function (t) {
  var p = t % 44;
  if (p < 8) return 12 + wobble(t, 4, 0.7);          // idle/cruise
  if (p < 15) return 100;                             // pull 1
  if (p < 19) return 0;                               // coast
  if (p < 26) return 30 + wobble(t, 8, 0.5);          // cruise
  if (p < 33) return 100;                             // pull 2
  return 8 + wobble(t, 3, 0.6);                       // cool down
};

Demo.prototype.step = function (dt) {
  if (!(dt > 0)) dt = 0.05;
  if (dt > 0.5) dt = 0.5;
  this.t += dt;

  var tgt = clamp(this._scriptThrottle(this.t), 0, 100);
  this.throttle = lerp(this.throttle, tgt, clamp(dt * 6, 0, 1));

  // Gear logic
  if (this.rpm > 6800 && this.gear < 7) this.gear++;
  if (this.rpm < 2400 && this.gear > 1 && this.throttle < 50) this.gear--;

  // rpm responds to throttle; falls toward idle when off throttle
  var rpmTarget = 820 + (this.throttle / 100) * (7000 - 820 * (this.gear > 3 ? 0.6 : 1));
  if (this.throttle < 5) rpmTarget = 820 + this.speed * 12 / this.gear;
  this.rpm = clamp(lerp(this.rpm, rpmTarget, clamp(dt * 2.2, 0, 1)), 650, 7200);

  // speed integrates from net accel (throttle vs drag)
  var accel = (this.throttle / 100) * (9 - this.gear) * 1.4 - this.speed * 0.012 - 0.3;
  this.speed = clamp(this.speed + accel * dt * 3.0, 0, 295);

  // boost from throttle & rpm (relative bar)
  var spool = clamp((this.rpm - 1600) / 2200, 0, 1);
  var boost = (this.throttle / 100) * spool * 2.4 - (1 - this.throttle / 100) * 0.9;
  boost = clamp(boost, -0.95, 2.6) + wobble(this.t, 0.03, 9);

  // load / wastegate / throttle plate
  var load = clamp((this.throttle / 100) * (60 + 120 * spool), 0, 200);
  var wg = clamp(this.throttle * 0.9 + 8, 0, 100);
  var plate = clamp(this.throttle, 0, 100);

  // mixture: enrich under load
  var lamTarget = this.throttle > 70 ? 0.84 : (this.throttle > 25 ? 0.95 : 1.0);
  var lambda = clamp(lamTarget + wobble(this.t, 0.015, 7), 0.75, 1.05);

  // timing: pulled under high load/iat; cruise advance
  var knock = clamp((this.iat - 45) * 0.02 + (this.throttle > 80 ? 0.4 : 0), 0, 4) + Math.max(0, wobble(this.t, 0.6, 3.3) - 0.3);
  knock = clamp(knock, 0, 6);
  var timing = clamp((this.throttle > 70 ? 8 : 26) - knock * 1.5 + wobble(this.t, 1.2, 2.1), -8, 36);

  var rail = clamp(180 + load * 0.8, 120, 360);

  // temperatures: warm toward steady state; iat tracks boost
  this.coolant = clamp(lerp(this.coolant, 95, dt * 0.02), 40, 112);
  this.oil = clamp(lerp(this.oil, this.throttle > 60 ? 118 : 100, dt * 0.015), 40, 135);
  var iatTarget = 25 + boost * 14 + (this.throttle > 70 ? 18 : 0);
  this.iat = clamp(lerp(this.iat, iatTarget, clamp(dt * 0.5, 0, 1)), 18, 85);
  this.egt = clamp(lerp(this.egt, 300 + load * 4, clamp(dt * 0.6, 0, 1)), 250, 980);

  return {
    rpm: this.rpm,
    speed: this.speed,
    gear: this.gear,
    pedal: this.throttle,
    throttle: plate,
    boost: boost,
    iat: this.iat,
    coolant: this.coolant,
    oil: this.oil,
    timing: timing,
    lambda: lambda,
    lambdaTarget: lamTarget,
    railPressure: rail,
    wastegate: wg,
    load: load,
    knock: knock,
    egt: this.egt,
    demo: true
  };
};

// Advance using wall-clock delta; safe to call at any cadence.
Demo.prototype.sample = function (nowMs) {
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (this.last == null) this.last = now;
  var dt = (now - this.last) / 1000;
  this.last = now;
  return this.step(dt);
};

module.exports = Demo;
