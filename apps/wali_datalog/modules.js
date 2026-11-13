'use strict';
//
// modules.js — the vehicle's diagnostic module map for the whole-car code scan.
//
// Each entry is an on-board controller and its DoIP logical (diagnostic) address.
// A fault-code scan walks this list and reads codes from each module in turn.
//
// These are BMW's 1-BYTE diagnostic addresses (the ISO-TP / UDS-over-TASU scheme
// the head unit actually uses). The earlier 16-bit DoIP logical addresses
// (0x1000, 0x1800…) never matched a module over TASU, so the scan saw "no
// response" everywhere even though the DME answers us (confirmed on-car: a 22 F1
// read to 0x12 returns the VIN). Names/addresses follow BMW's published G-series
// control-unit map (cross-checked against the MIT idrive7-apps ecus.js table).
// They vary a little by chassis/equipment, so they can still be OVERRIDDEN per
// vehicle via config (`config.modules`, or a `modules.json` on the unit). Reading
// codes is read-only and goes nowhere until the vehicle link is up.
//
var DEFAULTS = [
  { key: 'dme',   name: 'DME (engine)',               address: 0x12, verified: true, primary: true },
  { key: 'egs',   name: 'EGS (transmission)',         address: 0x18, verified: true },
  { key: 'bdc',   name: 'BDC (body / gateway)',       address: 0x10, verified: true },
  { key: 'dsc',   name: 'DSC (stability / brakes)',   address: 0x29, verified: true },
  { key: 'eps',   name: 'EPS (steering)',             address: 0x30, verified: true },
  { key: 'fem',   name: 'FEM / body domain',          address: 0x40, verified: true },
  { key: 'kombi', name: 'KOMBI (instrument cluster)', address: 0x60, verified: true },
  { key: 'frr',   name: 'FRR (front radar / ACC)',    address: 0x21, verified: false }
];

// Normalize a user config entry { key?, name?, address } (address may be a number
// or a "0x…"/decimal string). Returns a clean module or null.
function norm(e) {
  if (!e) return null;
  var addr = e.address;
  if (typeof addr === 'string') { var s = addr.trim(); addr = s.slice(0, 2).toLowerCase() === '0x' ? parseInt(s, 16) : parseInt(s, 10); }
  if (typeof addr !== 'number' || !isFinite(addr)) return null;
  return {
    key: e.key || ('mod_' + addr.toString(16)),
    name: e.name || ('Module 0x' + addr.toString(16)),
    address: addr,
    verified: e.verified === true,
    primary: e.primary === true
  };
}

// list(config) -> the module list to scan. If config.modules is provided it
// REPLACES the defaults (so the owner's verified map wins); config.extraModules
// is appended to the defaults. Deduped by address.
function list(config) {
  config = config || {};
  var base = Array.isArray(config.modules) && config.modules.length
    ? config.modules.map(norm).filter(Boolean)
    : DEFAULTS.slice();
  if (Array.isArray(config.extraModules)) base = base.concat(config.extraModules.map(norm).filter(Boolean));
  var seen = {}, out = [];
  for (var i = 0; i < base.length; i++) {
    var a = base[i].address;
    if (seen[a]) continue;
    seen[a] = true; out.push(base[i]);
  }
  return out;
}

module.exports = { DEFAULTS: DEFAULTS, list: list, norm: norm };
