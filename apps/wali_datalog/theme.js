'use strict';
//
// theme.js — colour palette for the dashboard.
//
// On the head unit, ctx.theme() provides bg/text/dim/accent/warn/crit/cold.
// We keep our own superset so the look is identical in the simulator and on
// the car; main.js can overlay any values ctx.theme() returns.
//
// LAMBO — the Beta 2 look: minimalist, hard sleek lines, dark, bold type,
// yellow-on-black (Lamborghini "Giallo" yellow). Yellow is reserved for the
// brand, the active tab, selection and primary actions; status uses amber/red.
var LAMBO = {
  bg: '#0a0a0a',        // near-black background
  panel: '#121212',     // card
  panel2: '#181818',    // raised card / tile
  panel3: '#1f1f1f',    // control / button face
  line: '#2b2b2b',      // hairline
  text: '#f6f6f4',      // bold near-white
  dim: '#9a9a97',       // secondary
  faint: '#5c5c5a',     // tertiary / disabled
  accent: '#ffd400',    // Giallo yellow — brand / active / primary
  accentDim: '#3a3200',  // yellow at rest (inactive accent fill)
  ink: '#0a0a0a',       // text drawn ON yellow
  good: '#8bd450',      // confirmed / ok (yellow-green, used sparingly)
  warn: '#ff9f0a',      // warning
  crit: '#ff3b30',      // critical / danger
  cold: '#8a8a88',      // below-range
  rec: '#ff3b30'        // recording dot
};

// Kept as an alias so existing references to DARK resolve to the new look.
var DARK = LAMBO;

// Pick a status colour for a channel value against its warn/crit thresholds.
function level(ch, metricValue) {
  if (!ch || typeof metricValue !== 'number' || !isFinite(metricValue)) return 'ok';
  if (typeof ch.crit === 'number' && metricValue >= ch.crit) return 'crit';
  if (typeof ch.warn === 'number' && metricValue >= ch.warn) return 'warn';
  return 'ok';
}

function levelColor(t, lvl) {
  if (lvl === 'crit') return t.crit;
  if (lvl === 'warn') return t.warn;
  if (lvl === 'good') return t.good;
  return t.text;
}

module.exports = { DARK: DARK, LAMBO: LAMBO, level: level, levelColor: levelColor };
