/* Federwerk – Strich-Renderer (geteilt).
 *
 * Ein einziger Renderer fuer Tinte: die Buehne (js/app.js), die Rail-Thumbnails,
 * die Vorschau, den PNG-Export UND die Praesentations-Seite (present.html).
 * Letztere laedt nur dieses Skript plus den Bleistift-Helfer – nicht die ganze
 * App. Deshalb liegt drawStroke hier statt in app.js; app.js delegiert nur noch.
 *
 * Bewusst unveraendert uebernommen: die Reihenfolge von Glaettung (Chaikin),
 * Druckbreite und Fuellung ist das geprueffte Verhalten (SPEC-25, siehe
 * tests/highlighter-eraser.test.js).
 *
 * Kein Build, plain <script> (global `FederwerkInk`) + Node-export fuer Tests.
 */
(function () {
  'use strict';

  /* ---------- Punkt-Normalisierung + Glättung ----------
   * Dieselben Regeln wie GrimoirePencil.normalizePoint/normalizePressure,
   * hier lokal, damit die Live-Vorschau auch ohne den Bleistift-Helfer genau
   * dieselbe Ausgabe erzeugt. */
  function press(p) {
    if (typeof p !== 'number' || !isFinite(p) || p <= 0) return 0.5;
    if (p > 1) return 1;
    return p;
  }
  function num(v) { return +v || 0; }
  function normPoint(pt) {
    pt = pt || {};
    return { x: num(pt.x), y: num(pt.y), p: press(pt.p) };
  }
  // Ein Chaikin-Schnittpunkt: a mit wa, b mit wb (Summe 1).
  function cut(a, b, wa, wb) {
    return {
      x: num(a.x) * wa + num(b.x) * wb,
      y: num(a.y) * wa + num(b.y) * wb,
      p: press(press(a.p) * wa + press(b.p) * wb)
    };
  }

  /* Live-Vorschau mit inkrementeller Glättung.
   *
   * drawStroke glättet seine Punkte bei jedem Aufruf neu. Die Vorschau ruft ihn
   * pro pointermove auf – bei einem Strich mit N Bildern also O(N^2)
   * Allokationen (normalizePoints + Chaikin legen pro Bild ~3N Objekte an).
   *
   * `liveStroke()` haelt die geglättete Liste und haengt nur das Neue an:
   * Chaikin ist ein lokaler Filter, out[i] haengt ausschliesslich an roh[0..i].
   * Nach einer Verlaengerung von n auf m Punkte bleiben die Eintraege 0..2n-2
   * exakt gleich, nur Index 2n-1 (bisher der Roh-Endpunkt) wird zum
   * Schnittpunkt und der echte Endpunkt wandert ans neue Ende. Jeder bereits
   * gezeichnete Pfadabschnitt bleibt damit unveraendert – das Ergebnis ist
   * punkweise identisch zu einem vollstaendigen chaikinSmooth(raw). */
  function liveStroke() {
    var pts = [];
    var n = 0;
    function rebuild(src, m) {
      pts.length = 0;
      if (m <= 0) return;
      pts.push(normPoint(src[0]));
      for (var j = 0; j < m - 1; j++) {
        pts.push(cut(src[j], src[j + 1], 0.75, 0.25), cut(src[j], src[j + 1], 0.25, 0.75));
      }
      if (m > 1) pts.push(normPoint(src[m - 1]));
    }
    return {
      // Rohe Eingabepunkte -> geglättete Punkte (dieselbe Liste, neu gefuellt).
      update: function (raw) {
        var src = raw || [];
        var m = src.length;
        if (m < 3) {
          // Chaikin ist bei <3 Punkten die Identitaet.
          pts.length = 0;
          for (var q = 0; q < m; q++) pts.push(normPoint(src[q]));
          n = 0; // beim 3. Punkt wird der volle Aufbau einmal erzwungen
          return pts;
        }
        if (n < 3 || pts.length < 2 * n - 1) { rebuild(src, m); n = m; return pts; }
        var w = 2 * n - 1;              // stabile Praefix-Laenge
        for (var i = n - 1; i < m - 1; i++) {
          pts[w++] = cut(src[i], src[i + 1], 0.75, 0.25);
          pts[w++] = cut(src[i], src[i + 1], 0.25, 0.75);
        }
        pts[w++] = normPoint(src[m - 1]);
        pts.length = w;
        n = m;
        return pts;
      },
      reset: function () { pts = []; n = 0; },
      points: function () { return pts; },
      sourceCount: function () { return n; }
    };
  }

  function drawStroke(c, s) {
    if (!s.points.length) return;
    c.save();
    c.strokeStyle = s.color;
    c.lineWidth = s.size;
    c.lineCap = 'round'; c.lineJoin = 'round';
    if (s.tool === 'marker') { c.globalAlpha = 0.35; c.globalCompositeOperation = 'multiply'; }
    if (s.alpha != null && s.alpha < 1) c.globalAlpha *= s.alpha;
    if (s.dash && s.dash.length) { try { c.setLineDash(s.dash); } catch { /* ignore */ } }
    // Cleaner-Look: Punkte vor dem Rendern leicht glätten (Chaikin, 1x),
    // aber Altbestand/Shapes unverfälscht lassen bei closed/fill/dash.
    let pts = s.points;
    const closed = !!s.closed || (!!s.fill && pts.length > 2);
    // `presmoothed`: die Punkte sind bereits geglättet (liveStroke), sonst
    // würde der Renderer sie ein zweites Mal glätten.
    const canSmooth = !s.presmoothed && !closed && !(s.dash && s.dash.length) && pts.length >= 3
      && typeof GrimoirePencil !== 'undefined' && GrimoirePencil.chaikinSmooth;
    if (canSmooth) {
      try { pts = GrimoirePencil.chaikinSmooth(pts, 1); } catch { pts = s.points; }
    }
    // Pressure-Stift: Punkte mit p -> segweise variable Breite (round caps),
    // gerendert als Midpoint-Quadratics statt LineTo-Polygon (cleaner, ruhiger);
    // Punkte ohne p (Altbestand, Shapes, Fills, Dashes) -> single size wie bisher.
    const usePressure = !closed && !(s.dash && s.dash.length) && pts.some(q => q && typeof q.p === 'number');
    if (usePressure) {
      const wOf = q => {
        let pp = 0.5;
        try {
          pp = (typeof GrimoirePencil !== 'undefined' && GrimoirePencil.normalizePressure)
            ? GrimoirePencil.normalizePressure(q.p)
            : ((typeof q.p === 'number' && q.p > 0) ? Math.min(1, q.p) : 0.5);
        } catch { pp = 0.5; }
        try {
          if (typeof GrimoirePencil !== 'undefined' && GrimoirePencil.pressureWidth) return GrimoirePencil.pressureWidth(s.size, pp);
        } catch { /* Fallback unten */ }
        return Math.min(s.size * 3, Math.max(s.size * 0.5, s.size * (0.35 + 0.9 * pp)));
      };
      if (pts.length === 1) {
        c.fillStyle = s.color;
        c.beginPath(); c.arc(pts[0].x, pts[0].y, wOf(pts[0]) / 2, 0, 7); c.fill();
        c.restore();
        return;
      }
      if (pts.length === 2) {
        c.lineWidth = (wOf(pts[0]) + wOf(pts[1])) / 2;
        c.beginPath();
        c.moveTo(pts[0].x, pts[0].y);
        c.lineTo(pts[1].x, pts[1].y);
        c.stroke();
        c.restore();
        return;
      }
      // Midpoint-Quadratics mit variabler Breite: pro Segment ein Pfad,
      // Breite = Mittel der Endpunkt-Breiten (weich, ohne Stufen).
      let prevMx = (pts[0].x + pts[1].x) / 2, prevMy = (pts[0].y + pts[1].y) / 2;
      c.lineWidth = (wOf(pts[0]) + wOf(pts[1])) / 2;
      c.beginPath();
      c.moveTo(pts[0].x, pts[0].y);
      c.lineTo(prevMx, prevMy);
      c.stroke();
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
        c.lineWidth = (wOf(pts[i]) + wOf(pts[i + 1])) / 2;
        c.beginPath();
        c.moveTo(prevMx, prevMy);
        c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
        c.stroke();
        prevMx = mx; prevMy = my;
      }
      c.restore();
      return;
    }
    // Ohne Pressure: ebenfalls Midpoint-Quadratics (sichtbar runder als LineTo).
    if (!closed && !(s.dash && s.dash.length) && pts.length > 2) {
      c.beginPath();
      c.moveTo(pts[0].x, pts[0].y);
      c.lineTo((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
      for (let i = 1; i < pts.length - 1; i++) {
        c.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
      }
      c.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      if (pts.length === 1) {
        c.fillStyle = s.color;
        c.beginPath(); c.arc(pts[0].x, pts[0].y, s.size / 2, 0, 7); c.fill();
      } else {
        c.stroke();
      }
      c.restore();
      return;
    }
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
    if (pts.length === 1) {
      c.fillStyle = s.color;
      c.beginPath(); c.arc(pts[0].x, pts[0].y, s.size / 2, 0, 7); c.fill();
    } else {
      if (closed) c.closePath();
      if (s.fill) {
        c.fillStyle = s.fill;
        const ga = c.globalAlpha;
        c.globalAlpha = ga * (s.fillAlpha == null ? 1 : s.fillAlpha);
        c.fill();
        c.globalAlpha = ga;
      }
      c.stroke();
    }
    c.restore();
  }

  var api = { drawStroke: drawStroke, liveStroke: liveStroke };

  if (typeof window !== 'undefined') window.FederwerkInk = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
