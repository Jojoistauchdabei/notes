/* Federwerk – Laserpointer (Präsentations-Werkzeug, nicht persistent).
 *
 * Reine, DOM-freie Logik: Trail-Verwaltung + Ausblend-Alter.
 * Das eigentliche Zeichnen (Glow-Dot auf overlayCanvas) lebt in js/app.js,
 * hier nur Konstanten + testbare Funktionen.
 *
 * Verhalten:
 * - Laser speichert NIE Strokes (kein Snapshot, kein Undo, kein Persist).
 * - Punkte verblassen nach FADE_MS (Default 700ms), Trail max. TRAIL_MAX Punkte.
 * - Farbe: kräftiges Laser-Rot, gut sichtbar auf hellem + dunklem Papier.
 *
 * Kein Build, plain <script> (global `GrimoireLaser`) + Node-export für Tests.
 */
(function () {
  'use strict';

  var COLOR = '#ff2211';
  var COLOR_SOFT = 'rgba(255,60,40,0.35)';
  var DOT_R = 9;
  var FADE_MS = 700;
  var TRAIL_MAX = 24;

  function isLaserTool(t) { return t === 'laser'; }

  function createTrail() { return []; }

  // Punkt: { x, y, t } mit t = ms-Zeitstempel (Date.now()).
  function push(trail, pt) {
    if (!Array.isArray(trail)) trail = [];
    if (!pt || !isFinite(pt.x) || !isFinite(pt.y)) return trail;
    trail.push({ x: +pt.x, y: +pt.y, t: (pt.t == null ? Date.now() : +pt.t) });
    while (trail.length > TRAIL_MAX) trail.shift();
    return trail;
  }

  function prune(trail, now, fadeMs) {
    if (!Array.isArray(trail)) return [];
    var fade = (fadeMs == null ? FADE_MS : +fadeMs);
    if (!(fade > 0)) fade = FADE_MS;
    var n = (now == null ? Date.now() : +now);
    return trail.filter(function (p) { return (n - p.t) <= fade; });
  }

  // 1 (frisch) -> 0 (verblasst), linear.
  function alphaFor(ageMs, fadeMs) {
    var fade = (fadeMs == null ? FADE_MS : +fadeMs);
    if (!(fade > 0)) fade = FADE_MS;
    var a = (+ageMs < 0) ? 0 : +ageMs;
    if (a >= fade) return 0;
    return 1 - a / fade;
  }

  var api = {
    COLOR: COLOR,
    COLOR_SOFT: COLOR_SOFT,
    DOT_R: DOT_R,
    FADE_MS: FADE_MS,
    TRAIL_MAX: TRAIL_MAX,
    isLaserTool: isLaserTool,
    createTrail: createTrail,
    push: push,
    prune: prune,
    alphaFor: alphaFor,
  };

  if (typeof window !== 'undefined') window.GrimoireLaser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
