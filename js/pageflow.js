/* Federwerk – Page-Flow (Continuous Scroll: alle Seiten in einem Scroll-Container).
 *
 * DOM-freie, testbare Layout-Logik. Das DOM-Glue (Slots bauen, Seiten mounten,
 * Scrollposition -> aktive Seite) lebt in js/app.js – hier nur reine Funktionen.
 *
 * Modell: die Seiten liegen untereinander in einem Stack mit Luecke `gap`.
 * Slot i hat die Hoehe heights[i] und beginnt bei tops[i]. Der Scroll-Container
 * zeigt [scrollTop, scrollTop + viewH]. `lead` ist die Fokuslinie: die Seite, die
 * sie schneidet, ist die gelesene/aktive Seite.
 *
 * Kein Build, plain <script> (global `GrimoirePageFlow`) + Node-export fuer Tests.
 */
(function () {
  'use strict';

  var DEFAULT_GAP = 18;
  var DEFAULT_LEAD = 12;   // Fokuslinie nahe der Oberkante des Sichtbereichs
  var DEFAULT_OVERSCAN = 600;

  function num(v, fb) {
    var n = Number(v);
    return isFinite(n) ? n : fb;
  }

  function clamp(v, lo, hi) {
    if (!(hi >= lo)) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /* Seitenhoehen normalisieren: positive Zahlen, Rest faellt auf 1 zurueck,
   * damit ein kaputter Seitenwert das Layout nicht mit NaN zerstoert. */
  function normalizeHeights(heights) {
    var out = [];
    if (!heights || typeof heights.length !== 'number') return out;
    for (var i = 0; i < heights.length; i++) {
      var h = num(heights[i], 0);
      out.push(h > 0 ? h : 1);
    }
    return out;
  }

  /* Stack-Geometrie aus Seitenhoehen. Zurueck:
   * { count, gap, tops: number[], height, heights: number[] }
   * height = Summe Hoehen + (count-1)*gap, nie negativ. */
  function buildLayout(heights, gap) {
    var hs = normalizeHeights(heights);
    var g = num(gap, DEFAULT_GAP);
    if (!(g >= 0)) g = DEFAULT_GAP;
    var tops = [];
    var y = 0;
    for (var i = 0; i < hs.length; i++) {
      tops.push(y);
      y += hs[i];
      if (i < hs.length - 1) y += g;
    }
    return { count: hs.length, gap: g, tops: tops, heights: hs, height: hs.length ? y : 0 };
  }

  function maxScrollOf(layout, viewH) {
    var l = layout || buildLayout([]);
    return Math.max(0, l.height - Math.max(0, num(viewH, 0)));
  }

  /* Groesster gueltiger Scroll-Offset (Rand: ganz oben / ganz unten). */
  function clampScroll(scrollTop, layout, viewH) {
    var v = num(scrollTop, 0);
    return clamp(v, 0, maxScrollOf(layout, viewH));
  }

  /* Welche Seite gilt als gelesen/aktiv?
   * Erste Seite, deren Unterkante die Fokuslinie (scrollTop + lead) noch nicht
   * passiert hat – also die oberste sichtbare Seite.
   * Sonderfall Anschlag: steht der Scroll-Container ganz unten (letzte Seite
   * passt nicht mehr auf den Sichtbereich), ist die Fokuslinie praktisch in
   * der letzten Seite, zeigt aber noch die davor. Dann gilt die letzte Seite
   * als aktiv – sonst zeigte die Statuszeile am Dokumentende "Seite 9/12".
   * Ohne Scrollbereich (alles passt auf einen Blick) bleibt Seite 0 aktiv.
   * -1 bei leerem Stack. */
  function pageFromScroll(layout, scrollTop, viewH, lead) {
    var l = layout || buildLayout([]);
    if (!l.count) return -1;
    var top = clampScroll(scrollTop, l, viewH);
    var ld = num(lead, DEFAULT_LEAD);
    if (!(ld >= 0)) ld = DEFAULT_LEAD;
    var line = top + ld;
    var atBottom = maxScrollOf(l, viewH) > 0 && top >= maxScrollOf(l, viewH);
    // Erste Seite, die die Linie noch nicht ganz passiert hat.
    for (var i = 0; i < l.count; i++) {
      if (l.tops[i] + l.heights[i] > line) return atBottom ? l.count - 1 : i;
    }
    return l.count - 1; // Fokus unterhalb des Stacks: letzte Seite
  }

  /* Sichtbarer Slot-Bereich inkl. Overscan (Vorab-Rendern beim Scrollen).
   * Leeres Fenster, wenn nichts gemountet werden soll. */
  function windowRange(layout, scrollTop, viewH, overscan) {
    var l = layout || buildLayout([]);
    if (!l.count) return { start: 0, end: -1 };
    var top = clampScroll(scrollTop, l, viewH);
    var h = Math.max(0, num(viewH, 0));
    var os = Math.max(0, num(overscan, DEFAULT_OVERSCAN));
    var from = top - os;
    var to = top + h + os;
    var start = l.count - 1, end = 0, seen = false;
    for (var i = 0; i < l.count; i++) {
      var b = l.tops[i] + l.heights[i];
      // Strikt: eine Seite, die genau am Rand endet/beginnt, hat keinen
      // sichtbaren Pixel und gehoert nicht ins Mount-Fenster.
      if (b <= from) continue;   // komplett ueberhalb -> spaeter
      if (l.tops[i] >= to) break; // komplett unterhalb -> fertig
      if (!seen) { start = i; seen = true; }
      end = i;
    }
    if (!seen) {
      // Alles ausserhalb (z.B. wildly ueber den Anschlag hinaus): naechste Seite.
      var idx = pageFromScroll(l, top, h, 0);
      return { start: idx, end: idx };
    }
    return { start: start, end: end };
  }

  /* Index der Seite, die den Sichtbereich "am staerksten" fuellt – Basis fuer
   * Tastatur-Navigation (Bild auf/ab) und Sprungziele. Bei Gleichstand gewinnt
   * die oberste sichtbare Seite. */
  function dominantPageIndex(layout, scrollTop, viewH) {
    var l = layout || buildLayout([]);
    if (!l.count) return -1;
    var top = clampScroll(scrollTop, l, viewH);
    var h = Math.max(0, num(viewH, 0));
    var best = -1, bestOv = 0;
    for (var i = 0; i < l.count; i++) {
      var s = l.tops[i], e = l.tops[i] + l.heights[i];
      var ov = Math.min(e, top + h) - Math.max(s, top);
      if (ov > bestOv) { bestOv = ov; best = i; }
    }
    return best < 0 ? 0 : best;
  }

  /* Scroll-Offset, damit Seite `index` an der Fokuslinie landet, geklemmt auf
   * den zulaessigen Bereich. Unveraendert, wenn index ausserhalb liegt. */
  function offsetForPage(layout, index, viewH, lead) {
    var l = layout || buildLayout([]);
    if (!l.count) return 0;
    var i = Math.floor(num(index, -1));
    if (!(i >= 0) || i >= l.count) return clampScroll(0, l, viewH);
    var ld = num(lead, DEFAULT_LEAD);
    if (!(ld >= 0)) ld = DEFAULT_LEAD;
    return clampScroll(l.tops[i] - ld, l, viewH);
  }

  /* Nachbar-Index ohne Wrap (Kanten liefern null) – Tastatur-Blättern. */
  function neighborIndex(pos, dir, total) {
    pos = Math.floor(num(pos, -1));
    total = Math.floor(num(total, 0));
    var d = dir > 0 ? 1 : dir < 0 ? -1 : 0;
    if (!(pos >= 0) || !(total > 0) || d === 0) return null;
    if (pos >= total) pos = total - 1;
    var next = pos + d;
    if (next < 0 || next >= total) return null;
    return next;
  }

  var api = {
    DEFAULT_GAP: DEFAULT_GAP,
    DEFAULT_LEAD: DEFAULT_LEAD,
    DEFAULT_OVERSCAN: DEFAULT_OVERSCAN,
    clamp: clamp,
    normalizeHeights: normalizeHeights,
    buildLayout: buildLayout,
    maxScrollOf: maxScrollOf,
    clampScroll: clampScroll,
    pageFromScroll: pageFromScroll,
    windowRange: windowRange,
    dominantPageIndex: dominantPageIndex,
    offsetForPage: offsetForPage,
    neighborIndex: neighborIndex,
  };

  if (typeof window !== 'undefined') window.GrimoirePageFlow = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
