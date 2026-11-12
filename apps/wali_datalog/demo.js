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

  // Extended tuner-class channels derived from the toy model.
  var baro = 1.0;
  var boostAbs = clamp(boost + baro, 0, 4);
  var out = {
    rpm: this.rpm, speed: this.speed, gear: this.gear, pedal: this.throttle, throttle: plate,
    load: load, loadAbs: clamp(load * 1.25, 0, 300),
    torqueActual: clamp(load * 4.2, 0, 900), torqueReq: clamp(this.throttle * 7.5, 0, 900), torqueLimit: 680,

    boost: boost, boostTarget: clamp(boost * 1.03 + 0.02, -0.95, 2.6), boostAbs: boostAbs,
    putp: clamp(boostAbs * 0.98, 0, 4), baro: baro,
    iat: this.iat, ambientT: 22,
    maf: clamp(load * 6, 0, 1200), mafSpec: clamp(load * 6.1, 0, 1200),
    wastegate: wg, wastegateTarget: clamp(wg * 0.98, 0, 100), wastegatePos: clamp(wg, 0, 100),

    lambda: lambda, lambda2: clamp(lambda + 0.008 * Math.sin(this.t * 5), 0.75, 1.05), lambdaTarget: lamTarget,
    stft: clamp(2 * Math.sin(this.t * 3), -10, 10), ltft: clamp(-1.5 + Math.sin(this.t * 0.2), -8, 8),
    railPressure: rail, railTarget: clamp(rail * 1.02, 120, 360),
    lpfp: clamp(5 + load * 0.004, 4.5, 6.5), lpfpTarget: 5.2,
    injDuty: clamp(load * 0.45, 0, 100), injPulse: clamp(0.3 + load * 0.03, 0, 10),
    fuelFlow: clamp(load * 0.45, 0, 120), ethanol: 10,

    timing: timing, knock: knock,

    coolant: this.coolant, oil: this.oil, oilPressure: clamp(1.2 + this.rpm / 2200, 1, 6),
    egt: this.egt, egt2: clamp(this.egt - 12, 250, 980), cht: clamp(this.coolant + 8, 40, 160),
    transOil: clamp(80 + load * 0.1, 60, 140), clutchTemp: clamp(55 + load * 0.4, 40, 400),

    battery: clamp(14.1 - load * 0.003 - (this.throttle > 80 ? 0.2 : 0), 11.5, 14.6),
    alternator: clamp(55 + load * 0.1, 0, 100),

    vanosIn: clamp(5 + this.throttle * 0.25, -40, 60), vanosInTarget: clamp(6.5 + this.throttle * 0.25, -40, 60),
    vanosEx: clamp(-5 - this.throttle * 0.1, -40, 60), vanosExTarget: clamp(-6 - this.throttle * 0.1, -40, 60),
    valvetronic: clamp(1 + this.throttle * 0.085, 0, 10),

    gLong: clamp((this.throttle / 100) * 0.9 - 0.1, -1.2, 1.3), gLat: clamp(0.15 * Math.sin(this.t * 0.8), -1.5, 1.5),
    demo: true
  };
  for (var c = 1; c <= 6; c++) {
    out['timingCyl' + c] = clamp(timing + (c - 3.5) * 0.4 + 0.2 * Math.sin(this.t * 2 + c), -8, 36);
    out['knockCyl' + c] = clamp(knock + (c % 2) * 0.3 + Math.max(0, 0.4 * Math.sin(this.t * 0.7 + c)), 0, 15);
  }

  // Extended B58 tuner-class channels
  out.boostDeviation = clamp(boost - (boost * 1.03 + 0.02), -1, 1);
  out.boostSetpointFactor = clamp(0.9 + this.throttle * 0.001, 0, 2);
  out.compressorAfterPD = clamp(boostAbs * 0.99, 0, 4);
  out.compressorBase = clamp(boostAbs * 0.92, 0, 4);
  out.chargeAirTemp = clamp(this.iat + 6, -20, 120);
  out.mafReq = clamp(load * 6.2, 0, 1200);
  out.mafReqWg = clamp(load * 6.3, 0, 1200);
  out.wgDistribution = clamp(0.5 + this.throttle * 0.004, 0, 2);
  out.wgdcP = clamp(wg * 0.3 - 5, -50, 50);
  out.wgdcI = clamp(wg * 0.1, -50, 50);
  out.wgdcD = clamp(2 * Math.sin(this.t * 4), -50, 50);
  out.loadReq = clamp(load * 1.02, 0, 200);
  out.stft2 = clamp(1.5 * Math.sin(this.t * 3 + 1), -10, 10);
  out.railPressureDev = clamp(3 * Math.sin(this.t * 2), -50, 50);
  out.diffFuelPress = clamp(rail * 0.98, 0, 300);
  out.portInjIdc = clamp(this.throttle > 50 ? load * 0.3 : 0, 0, 100);
  out.portInjIpw = clamp(this.throttle > 50 ? load * 0.02 : 0, 0, 20);
  out.diInjIdc = clamp(load * 0.35, 0, 100);
  out.fuelMassTotal = clamp(load * 0.4, 0, 120);

  // Reflex+ / secondary port-injection channels (demo; real values come from a pidmap).
  out.portRailPressure = clamp(5.0 + load * 0.004, 4.5, 7.0);
  out.portRailTarget = 5.2;
  out.portInjTarget = clamp(this.throttle > 50 ? load * 0.32 : 0, 0, 100);
  out.portInjSplit = clamp(this.throttle > 60 ? 25 + load * 0.12 : 0, 0, 60);
  out.portInjActive = this.throttle > 50 ? 1 : 0;
  out.portFuelMass = clamp(out.fuelMassTotal * out.portInjSplit / 100, 0, 120);
  out.diFuelMass = clamp(out.fuelMassTotal - out.portFuelMass, 0, 120);
  // Flex fuel (demo blend ~E10).
  out.ethanolTarget = 10;
  out.flexFactor = clamp(1 + (out.ethanol / 100) * 0.6, 0.9, 2);
  out.fuelTemp = clamp(30 + load * 0.05, 18, 80);
  // Two OBD boost sources: 0x0B saturates at 2.55 bar abs; 0x70 does not.
  out.boostObd0B = clamp(boostAbs, 0, 2.55);
  out.boostObd70 = clamp(boostAbs, 0, 4);
  out.knockAdapt = clamp(-knock * 0.5 + 0.3 * Math.sin(this.t), -5, 5);
  out.throttleReq = clamp(this.throttle + 2, 0, 100);
  out.torqueLimiter = 0;
  out.fuelLevel = 62;
  out.exhaustFlap = this.throttle > 40 ? 1 : 0;
  out.launchStatus = 0;
  return out;
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
