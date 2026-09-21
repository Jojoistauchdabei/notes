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

  /* ---------- Cleaner-Stroke-Algorithmus (Stiftgefühl) ----------
   * Ziel: ruhigere Linie ohne Zacken, aber ohne spürbaren Lag.
   * Bausteine (alle DOM-frei, testbar):
   *  1) One-Euro-Filter pro Achse (x/y/p) -> entfernt hochfrequentes Zittern,
   *     folgt schnellen Bewegungen trotzdem (beta-Anteil).
   *  2) Mindest-Distanz (Jitter-Falle) -> Micro-Rauschen < minDistance wird
   *     geschluckt, kein Punkte-Müll bei ruhiger Hand.
   *  3) Pressure-EMA -> weiche Breitenübergänge statt Sprünge.
   *  4) Chaikin-Corner-Cutting + Midpoint-Quadratics beim Rendern ->
   *     runde, "cleanere" Kurven statt LineTo-Polygon.
   * App-Flow: pro Stroke ein createStabilizer(), jeder (coalesced)
   * Pointer-Punkt durch push() jagen, Rendern via smoothPolyline(). */

  var INPUT_PREFS_KEY = 'grimoireInputPrefs';
  var DEFAULT_INPUT_PREFS = Object.freeze({ fingerDraw: false, penOnly: true });

  function sanitizeInputPrefs(input) {
    var out = { fingerDraw: DEFAULT_INPUT_PREFS.fingerDraw, penOnly: DEFAULT_INPUT_PREFS.penOnly };
    if (!input || typeof input !== 'object') return out;
    out.fingerDraw = !!input.fingerDraw;
    // penOnly=true heißt: Touch wird als Scroll/Pinch behandelt (Palm-Rejection an).
    out.penOnly = input.penOnly !== false;
    return out;
  }

  function getInputPrefs(store) {
    var st = resolveStore(store);
    if (!st) return sanitizeInputPrefs(null);
    var raw = null;
    try { raw = st.getItem(INPUT_PREFS_KEY); } catch (e) { return sanitizeInputPrefs(null); }
    if (!raw) return sanitizeInputPrefs(null);
    try { return sanitizeInputPrefs(JSON.parse(raw)); } catch (e) { return sanitizeInputPrefs(null); }
  }

  function setInputPrefs(prefs, store) {
    var clean = sanitizeInputPrefs(prefs);
    var st = resolveStore(store);
    if (st) {
      try { st.setItem(INPUT_PREFS_KEY, JSON.stringify(clean)); } catch (e) { /* ignore */ }
    }
    return clean;
  }

  // Kleiner Low-Pass-Baustein für den One-Euro-Filter.
  function createLowPass() {
    var last = null;
    return {
      filter: function (value, alpha) {
        if (last == null) { last = value; return value; }
        last = alpha * value + (1 - alpha) * last;
        return last;
      },
      reset: function () { last = null; },
      last: function () { return last; }
    };
  }

  function oneEuroAlpha(cutoff, freq) {
    var te = 1 / (freq > 0 ? freq : 120);
    var tau = 1 / (2 * Math.PI * (cutoff > 0 ? cutoff : 1));
    return 1 / (1 + tau / te);
  }

  // One-Euro-Filter für einen Skalar (x, y oder p getrennt instanziieren).
  function createOneEuro(opts) {
    opts = opts || {};
    var minCutoff = (typeof opts.minCutoff === 'number' && opts.minCutoff > 0) ? opts.minCutoff : 1.1;
    var beta = (typeof opts.beta === 'number' && opts.beta >= 0) ? opts.beta : 0.025;
    var dcutoff = (typeof opts.dcutoff === 'number' && opts.dcutoff > 0) ? opts.dcutoff : 1.0;
    var freq = (typeof opts.freq === 'number' && opts.freq > 0) ? opts.freq : 120;
    var xF = createLowPass(), dxF = createLowPass();
    var lastT = null, lastX = null;
    return {
      filter: function (value, t) {
        var now = (typeof t === 'number' && isFinite(t)) ? t : ((lastT == null) ? 0 : lastT + 1000 / freq);
        var dt = (lastT == null) ? (1000 / freq) : Math.max(1, now - lastT);
        var f = 1000 / dt;
        var d = (lastX == null) ? 0 : (value - lastX) * f;
        var dHat = dxF.filter(d, oneEuroAlpha(dcutoff, f));
        var cutoff = minCutoff + beta * Math.abs(dHat);
        var out = xF.filter(value, oneEuroAlpha(cutoff, f));
        lastT = now; lastX = value;
        return out;
      },
      reset: function () { xF.reset(); dxF.reset(); lastT = null; lastX = null; }
    };
  }

  // Stabilizer für einen Stroke: frisst Jitter, glättet x/y/p.
  // push({x,y,p}, tMs) -> geglätteter Punkt oder null (Jitter-Falle).
  function createStabilizer(opts) {
    opts = opts || {};
    var fx = createOneEuro({ minCutoff: opts.minCutoff || 1.4, beta: opts.beta != null ? opts.beta : 0.03, dcutoff: opts.dcutoff || 1.0, freq: opts.freq || 120 });
    var fy = createOneEuro({ minCutoff: opts.minCutoff || 1.4, beta: opts.beta != null ? opts.beta : 0.03, dcutoff: opts.dcutoff || 1.0, freq: opts.freq || 120 });
    var fp = createOneEuro({ minCutoff: 0.9, beta: 0.01, dcutoff: 1.0, freq: opts.freq || 120 });
    var minDistance = (typeof opts.minDistance === 'number' && opts.minDistance >= 0) ? opts.minDistance : 0.9;
    var pressureAlpha = (typeof opts.pressureAlpha === 'number' && opts.pressureAlpha > 0 && opts.pressureAlpha <= 1) ? opts.pressureAlpha : 0.4;
    var lastOut = null, lastP = 0.5, hasAny = false;
    return {
      push: function (pt, t) {
        pt = normalizePoint(pt || {});
        var tMs = (typeof t === 'number' && isFinite(t)) ? t : Date.now();
        var sx = fx.filter(pt.x, tMs);
        var sy = fy.filter(pt.y, tMs);
        var spRaw = fp.filter(pt.p, tMs);
        var sp = lastP + pressureAlpha * (spRaw - lastP);
        lastP = sp;
        if (!hasAny) {
          hasAny = true;
          lastOut = { x: sx, y: sy, p: normalizePressure(sp) };
          return lastOut;
        }
        var dx = sx - lastOut.x, dy = sy - lastOut.y;
        if (dx * dx + dy * dy < minDistance * minDistance) return null;
        lastOut = { x: sx, y: sy, p: normalizePressure(sp) };
        return lastOut;
      },
      reset: function () { fx.reset(); fy.reset(); fp.reset(); lastOut = null; lastP = 0.5; hasAny = false; }
    };
  }

  // Chaikin-Corner-Cutting (1 Iteration ≈ sichtbar cleaner, Endpunkte bleiben).
  // p wird mit interpoliert -> keine Breitenstufen.
  function chaikinSmooth(points, iterations) {
    var pts = normalizePoints(points || []);
    var n = (typeof iterations === 'number' && iterations > 0) ? Math.min(3, Math.floor(iterations)) : 1;
    if (pts.length < 3) return pts;
    for (var k = 0; k < n; k++) {
      var out = [pts[0]];
      for (var i = 0; i < pts.length - 1; i++) {
        var a = pts[i], b = pts[i + 1];
        out.push({
          x: a.x * 0.75 + b.x * 0.25,
          y: a.y * 0.75 + b.y * 0.25,
          p: normalizePressure(a.p * 0.75 + b.p * 0.25)
        });
        out.push({
          x: a.x * 0.25 + b.x * 0.75,
          y: a.y * 0.25 + b.y * 0.75,
          p: normalizePressure(a.p * 0.25 + b.p * 0.75)
        });
      }
      out.push(pts[pts.length - 1]);
      pts = out;
    }
    return pts;
  }

  // Midpoint-Quadratic-Segmente für butterweiches Rendern (rein, testbar).
  // Gibt { move, curves: [{cpx,cpy,x,y}] } zurück; Punkte <2 -> nur move/dot.
  function midpointSegments(points) {
    var pts = normalizePoints(points || []);
    if (!pts.length) return { move: null, curves: [] };
    if (pts.length === 1) return { move: pts[0], curves: [] };
    if (pts.length === 2) {
      return {
        move: pts[0],
        curves: [{ cpx: (pts[0].x + pts[1].x) / 2, cpy: (pts[0].y + pts[1].y) / 2, x: pts[1].x, y: pts[1].y, p: pts[1].p }]
      };
    }
    var curves = [];
    var move = pts[0];
    var i;
    for (i = 1; i < pts.length - 1; i++) {
      var mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      curves.push({ cpx: pts[i].x, cpy: pts[i].y, x: mx, y: my, p: normalizePressure((pts[i].p + pts[i + 1].p) / 2) });
    }
    curves.push({ cpx: pts[pts.length - 1].x, cpy: pts[pts.length - 1].y, x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, p: pts[pts.length - 1].p });
    return { move: move, curves: curves };
  }

  // Coalesced Events einsammeln (High-Freq-Punkte vom OS, sonst [ev]).
  function collectCoalesced(ev) {
    if (!ev) return [];
    try {
      if (typeof ev.getCoalescedEvents === 'function') {
        var list = ev.getCoalescedEvents();
        if (list && list.length) return list;
      }
    } catch (e) { /* Fallback unten */ }
    return [ev];
  }

  /* ---------- Pencil-vs-Finger (Schreiben vs. Scrollen) ----------
   * Regel (Default, penOnly=true):
   *  - Apple Pencil / Pen (pointerType 'pen')  -> IMMER schreiben (Ink),
   *  - Maus ('mouse', linke Taste)             -> schreiben,
   *  - Finger ('touch')                        -> SCROLLEN (kein Ink),
   *    außer Nutzer aktiviert "Finger zeichnen" (fingerDraw=true).
   * Palm-Rejection: Touch kurz nach Pen-Kontakt wird ignoriert. */

  function getPointerProfile(ev) {
    ev = ev || {};
    var t = String(ev.pointerType || (typeof ev.type === 'string' && ev.type.indexOf('touch') === 0 ? 'touch' : 'mouse')).toLowerCase();
    if (t !== 'pen' && t !== 'touch' && t !== 'mouse') t = 'mouse';
    return {
      type: t,
      isPen: t === 'pen',
      isTouch: t === 'touch',
      isMouse: t === 'mouse',
      pressure: normalizePressure(ev.pressure),
      tiltX: (typeof ev.tiltX === 'number') ? ev.tiltX : 0,
      tiltY: (typeof ev.tiltY === 'number') ? ev.tiltY : 0,
      buttons: (typeof ev.buttons === 'number') ? ev.buttons : 1,
      button: (typeof ev.button === 'number') ? ev.button : 0
    };
  }

  function shouldInkForPointer(evOrProfile, prefs) {
    var prof = (evOrProfile && evOrProfile.isPen != null && evOrProfile.type)
      ? evOrProfile : getPointerProfile(evOrProfile);
    var p = sanitizeInputPrefs(prefs);
    if (prof.isPen) return true;
    if (prof.isTouch) return !!p.fingerDraw;
    // Maus: nur linke Taste / primärer Button (Rechtsklick = Kontext, kein Ink).
    if (prof.button === 2) return false;
    if (prof.buttons != null && prof.buttons !== 0 && !(prof.buttons & 1)) return false;
    return true;
  }

  // Palm-Guard: merkt sich letzten Pen-Kontakt; Touch in der Sperrzeit = Handballen.
  function createPalmGuard(timeoutMs) {
    var timeout = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 1200;
    var lastPen = 0;
    return {
      markPen: function (now) { lastPen = (typeof now === 'number' && isFinite(now)) ? now : Date.now(); },
      isPalmTouch: function (now) {
        var t = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
        return (t - lastPen) < timeout;
      },
      lastPen: function () { return lastPen; }
    };
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
    editorStyleFromComputed: editorStyleFromComputed,
    INPUT_PREFS_KEY: INPUT_PREFS_KEY,
    DEFAULT_INPUT_PREFS: { fingerDraw: DEFAULT_INPUT_PREFS.fingerDraw, penOnly: DEFAULT_INPUT_PREFS.penOnly },
    sanitizeInputPrefs: sanitizeInputPrefs,
    getInputPrefs: getInputPrefs,
    setInputPrefs: setInputPrefs,
    createLowPass: createLowPass,
    createOneEuro: createOneEuro,
    createStabilizer: createStabilizer,
    chaikinSmooth: chaikinSmooth,
    midpointSegments: midpointSegments,
    collectCoalesced: collectCoalesced,
    getPointerProfile: getPointerProfile,
    shouldInkForPointer: shouldInkForPointer,
    createPalmGuard: createPalmGuard
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = GrimoirePencil;
