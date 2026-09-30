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
    const canSmooth = !closed && !(s.dash && s.dash.length) && pts.length >= 3
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

  var api = { drawStroke: drawStroke };

  if (typeof window !== 'undefined') window.FederwerkInk = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
