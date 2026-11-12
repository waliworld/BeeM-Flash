'use strict';
//
// modules.js — the vehicle's diagnostic module map for the whole-car code scan.
//
// Each entry is an on-board controller and its DoIP logical (diagnostic) address.
// A fault-code scan walks this list and reads codes from each module in turn.
//
// IMPORTANT — these addresses are COMMUNITY-REFERENCE DEFAULTS, not verified for
// every chassis. BMW diagnostic addresses vary by platform (F- vs G-series) and
// equipment. They are marked `verified: false` and are meant to be CONFIRMED and
// OVERRIDDEN per vehicle via config (`config.modules` in app.json, or a
// `modules.json` the owner drops on the unit). Nothing is sent to an address
// until the user has enabled the vehicle connection (enetgate.js); reading codes
// is read-only. The one address the app otherwise uses (the DME/engine
// controller) is the primary, most-exercised entry.
//
// Reference addresses below follow the commonly-published BMW DoIP scheme
// (tester 0x0Exx; the ZGW/body gateway at 0x0010; powertrain/chassis/body
// controllers in the 0x10xx–0x40xx range). Treat them as a starting point to
// verify on your own car, e.g. by confirming each answers a 0x19 read.
//
var DEFAULTS = [
  { key: 'dme',  name: 'DME / DDE (engine)',        address: 0x1000, verified: false, primary: true },
  { key: 'egs',  name: 'EGS (transmission)',        address: 0x1800, verified: false },
  { key: 'zgw',  name: 'ZGW (body gateway)',        address: 0x0010, verified: false },
  { key: 'dsc',  name: 'DSC (stability / brakes)',  address: 0x2900, verified: false },
  { key: 'eps',  name: 'EPS (steering)',            address: 0x4600, verified: false },
  { key: 'frm',  name: 'FEM / BDC (body)',          address: 0x4000, verified: false },
  { key: 'kombi', name: 'KOMBI (instrument cluster)', address: 0x0060, verified: false },
  { key: 'acc',  name: 'ACC / driver assistance',   address: 0x0064, verified: false }
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
