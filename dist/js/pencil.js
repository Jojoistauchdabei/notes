/* Federwerk Pencil-Engine: Apple-Pencil-Pressure + Text-Default-Stil.
   Reine Helper, DOM-frei (kein DOM auf Top-Level), Browser-global + Node-require. */
var GrimoirePencil = (function () {
  'use strict';

  var TEXT_DEFAULT_KEY = 'grimoireTextDefault';
  var DEFAULT_TEXT_STYLE = Object.freeze({ fontSize: 17, color: '#2a1a0e', align: 'left' });

  /* ---------- Pressure ---------- */

  // Fallback 0.5, wenn 0/unbekannt (Hover, Maus ohne Druck, fehlende Sensorik).
  function normalizePressure(p) {
    if (typeof p !== 'number' || !isFinite(p) || p <= 0) return 0.5;
    if (p > 1) return 1;
    return p;
  }

  // Mapping: base * (0.35 + 0.9 * p), geclampt auf 0.5x..3x der Basis.
  // Basis = penSize (Marker: penSize * 3, siehe js/app.js).
  function pressureWidth(base, p) {
    base = +base;
    if (!(base > 0) || !isFinite(base)) return base;
    var pp = (typeof p === 'number' && isFinite(p)) ? p : 0.5;
    var w = base * (0.35 + 0.9 * pp);
    var lo = base * 0.5, hi = base * 3;
    if (w < lo) w = lo;
    if (w > hi) w = hi;
    return w;
  }

  // Punkt-Normalisierung: fehlendes p -> 0.5, x/y bleiben erhalten.
  function normalizePoint(pt) {
    pt = pt || {};
    return { x: +pt.x || 0, y: +pt.y || 0, p: normalizePressure(pt.p) };
  }

  function normalizePoints(points) {
    return (points || []).map(normalizePoint);
  }

  // true, sobald mindestens ein Punkt Druck trägt (dann variabel zeichnen).
  function strokeHasPressure(points) {
    return !!points && points.some(function (q) { return !!q && typeof q.p === 'number'; });
  }

  /* ---------- Text-Default-Stil ---------- */

  function toHexColor(v) {
    if (typeof v !== 'string') return null;
    v = v.trim();
    var m;
    if ((m = /^#([0-9a-fA-F]{6})$/.exec(v))) return '#' + m[1].toLowerCase();
    if ((m = /^#([0-9a-fA-F]{3})$/.exec(v))) {
      return '#' + m[1].toLowerCase().split('').map(function (c) { return c + c; }).join('');
    }
    if ((m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+)?\s*\)$/.exec(v))) {
      var rgb = [m[1], m[2], m[3]].map(function (n) {
        var h = Math.min(255, Math.max(0, +n)).toString(16);
        return h.length < 2 ? '0' + h : h;
      });
      return '#' + rgb.join('');
    }
    return null;
  }

  // Reiner Sanitizer: ungültige Felder fallen auf Defaults zurück.
  function sanitizeTextStyle(input) {
    var out = { fontSize: DEFAULT_TEXT_STYLE.fontSize, color: DEFAULT_TEXT_STYLE.color, align: DEFAULT_TEXT_STYLE.align };
    if (!input || typeof input !== 'object') return out;
    var fs = +input.fontSize;
    if (isFinite(fs)) out.fontSize = Math.min(96, Math.max(8, Math.round(fs)));
    var c = toHexColor(input.color);
    if (c) out.color = c;
    var a = String(input.align == null ? '' : input.align).toLowerCase().trim();
    if (a === 'center' || a === 'middle') out.align = 'center';
    else if (a === 'right' || a === 'end') out.align = 'right';
    else if (a === 'left' || a === 'start' || a === 'justify') out.align = 'left';
    return out;
  }

  function resolveStore(store) {
    if (store) return store;
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (e) { /* kein Storage (z. B. Node-Test ohne Mock) */ }
    return null;
  }

  function getTextDefault(store) {
    var st = resolveStore(store);
    if (!st) return sanitizeTextStyle(null);
    var raw = null;
    try { raw = st.getItem(TEXT_DEFAULT_KEY); } catch (e) { return sanitizeTextStyle(null); }
    if (!raw) return sanitizeTextStyle(null);
    try { return sanitizeTextStyle(JSON.parse(raw)); } catch (e) { return sanitizeTextStyle(null); }
  }

  function setTextDefault(style, store) {
    var clean = sanitizeTextStyle(style);
    var st = resolveStore(store);
    if (st) {
      try { st.setItem(TEXT_DEFAULT_KEY, JSON.stringify(clean)); } catch (e) { /* Storage voll/readonly */ }
    }
    return clean;
  }

  // Füllt nur fehlende Felder einer Box (bestehende Boxen bleiben unangetastet).
  function applyDefaultToBox(box, style) {
    box = (box && typeof box === 'object') ? box : {};
    var def = sanitizeTextStyle(style);
    if (box.fontSize == null) box.fontSize = def.fontSize;
    if (box.color == null) box.color = def.color;
    if (box.align == null) box.align = def.align;
    return box;
  }

  // Reiner Parser für computed CSS des contenteditable (DOM-frei testbar).
  function editorStyleFromComputed(c) {
    c = c || {};
    return sanitizeTextStyle({ fontSize: parseFloat(c.fontSize), color: c.color, align: c.textAlign });
  }

  return {
    TEXT_DEFAULT_KEY: TEXT_DEFAULT_KEY,
    DEFAULT_TEXT_STYLE: { fontSize: DEFAULT_TEXT_STYLE.fontSize, color: DEFAULT_TEXT_STYLE.color, align: DEFAULT_TEXT_STYLE.align },
    normalizePressure: normalizePressure,
    pressureWidth: pressureWidth,
    normalizePoint: normalizePoint,
    normalizePoints: normalizePoints,
    strokeHasPressure: strokeHasPressure,
    toHexColor: toHexColor,
    sanitizeTextStyle: sanitizeTextStyle,
    getTextDefault: getTextDefault,
    setTextDefault: setTextDefault,
    applyDefaultToBox: applyDefaultToBox,
    editorStyleFromComputed: editorStyleFromComputed
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = GrimoirePencil;
