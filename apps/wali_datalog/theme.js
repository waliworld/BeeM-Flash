'use strict';
//
// theme.js — colour palette for the dashboard.
//
// On the head unit, ctx.theme() provides bg/text/dim/accent/warn/crit/cold.
// We keep our own superset so the look is identical in the simulator and on
// the car; main.js can overlay any values ctx.theme() returns.
//
// LAMBO — strict black / yellow / red. Two accents only:
//   YELLOW is the brand / active / selection / caution accent,
//   RED is danger and anything important the user must not miss.
// There is NO orange and no green. Emphasis is shown with BOLD + slightly larger
// text (and solid fills), not by switching a label to a different hue.
var LAMBO = {
  bg: '#000000',        // dark black
  panel: '#0c0c0c',     // card
  panel2: '#141414',    // raised card / tile
  panel3: '#1c1c1c',    // control / button face
  line: '#2a2a2a',      // hairline
  text: '#ffffff',      // bright white
  dim: '#b2b2b2',       // secondary
  faint: '#6a6a6a',     // tertiary / disabled
  accent: '#ffe600',    // bright yellow — brand / active / selection / caution
  accentHi: '#fff23d',  // yellow highlight
  accentDim: '#4a4300',  // yellow at rest (inactive accent fill)
  ink: '#000000',       // text drawn ON yellow
  good: '#ffffff',      // positive/confirmed — white; emphasised with bold, not a new hue
  warn: '#ffe600',      // caution — yellow (no orange)
  crit: '#ff2a1f',      // danger / important — bright red
  cold: '#7a7a7a',      // below-range
  rec: '#ff2a1f'        // recording dot — red
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
