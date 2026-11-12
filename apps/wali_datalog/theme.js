'use strict';
//
// theme.js — colour palette for the dashboard.
//
// On the head unit, ctx.theme() provides bg/text/dim/accent/warn/crit/cold.
// We keep our own superset so the look is identical in the simulator and on
// the car; main.js can overlay any values ctx.theme() returns.
//
var DARK = {
  bg: '#0b0f14',
  panel: '#151b23',
  panel2: '#1b232c',
  line: '#2a3643',
  text: '#eef3f8',
  dim: '#8aa0b3',
  faint: '#54657a',
  accent: '#36c2ff',
  accentDim: '#17506b',
  good: '#39d98a',
  warn: '#ffb020',
  crit: '#ff4d4f',
  cold: '#4a90e2',
  rec: '#ff3b30'
};

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

module.exports = { DARK: DARK, level: level, levelColor: levelColor };
