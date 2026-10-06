/* Federwerk SPEC-25 – reine Helper für Highlighter & Radierer (kein DOM, kein Build).
 *
 * Wird als plain <script> vor app.js geladen (window.GrimoireErase) und ist
 * gleichzeitig per require() in node-Tests nutzbar.
 *
 * Offene SPEC-25-Entscheidung "Stroke-Modus vs. Standard": umgesetzt als
 * eraserMode 'precision' (Teil-Löschung: nur getroffene Punkte entfernen) vs.
 * 'standard'/'stroke' (ganzer Stroke bei Berührung). Persistiert zusammen mit
 * dem Toggle "Nur Highlighter" unter localStorage-Key 'grimoireEraserMode'.
 */
(function () {
  'use strict';

  // Marker-Konstanten (vgl. drawStroke in js/app.js): Alpha 0.35 + Multiply,
  // damit Doppel-Übermalung nicht über 0.35 hinaus abdunkelt.
  var MARKER_ALPHA = 0.35;
  var MARKER_COMPOSITE = 'multiply';

  var ERASER_LS_KEY = 'grimoireEraserMode';
  var ERASER_RADII = { precision: 6, standard: 12, stroke: 14 };

  // Scribble-Erkennung: >=2 Richtungswechsel auf X innerhalb 400ms, kleiner Radius ~40px.
  var SCRIBBLE_MIN_CHANGES = 2;
  var SCRIBBLE_WINDOW_MS = 400;
  var SCRIBBLE_RADIUS = 40;
  var SCRIBBLE_MIN_DX = 4;

  // Undo-Gesten: Tap-Dauer <300ms, kaum Bewegung (<12px), sonst Pinch-Zoom-Verdacht.
  var GESTURE_MAX_DURATION_MS = 300;
  var GESTURE_MAX_MOVE_PX = 12;

  function isMarkerStroke(s) {
    return !!s && (s.tool === 'marker' || s.highlighter === true);
  }

  // Bounding-Box je Stroke, gecacht in einer WeakMap. Bewusst NICHT am Stroke-
  // Objekt: das wuerde (a) in die Persistenz-Keys auslaufen und (b) die
  // deepEqual-Zusicherungen der Tests brechen. WeakMap raeumt sich mit dem
  // Stroke selbst auf. Ohne diese Rejection laeuft der Radierer bei jedem
  // pointermove ueber jeden Punkt jedes Strokes der Seite.
  var bbCache = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;

  function strokeBounds(s) {
    var pts = s && s.points;
    if (!Array.isArray(pts) || !pts.length) return null;
    var hit = bbCache ? bbCache.get(s) : null;
    // Laengenguard: ist der Stroke gewachsen, ist die Box veraltet.
    if (hit && hit.n === pts.length) return hit;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var q = pts[i];
      if (q.x < x0) x0 = q.x;
      if (q.x > x1) x1 = q.x;
      if (q.y < y0) y0 = q.y;
      if (q.y > y1) y1 = q.y;
    }
    hit = { n: pts.length, x0: x0, y0: y0, x1: x1, y1: y1 };
    if (bbCache) bbCache.set(s, hit);
    return hit;
  }

  // Liegt pt (Radius r) ueberhaupt in der Box? 4 Vergleiche statt eines
  // Punktdurchlaufs.
  function boxesNear(pt, bb, r) {
    return pt.x >= bb.x0 - r && pt.x <= bb.x1 + r
      && pt.y >= bb.y0 - r && pt.y <= bb.y1 + r;
  }

  // Zwei Achten-Boxen mit Radius r: schneiden sie sich? (symmetrisch)
  function boxesOverlap(a, b, r) {
    return a.x0 - r <= b.x1 && a.x1 + r >= b.x0
      && a.y0 - r <= b.y1 && a.y1 + r >= b.y0;
  }

  function distToStroke(pt, s, radius) {
    if (!s || !Array.isArray(s.points) || !s.points.length) return false;
    var r = (radius || 0) + (s.size || 0) / 2;
    var pts = s.points;
    var bb = strokeBounds(s);
    if (bb && !boxesNear(pt, bb, r)) return false; // AABB-Rejection
    // Quadrierter Vergleich statt Math.hypot: keine Wurzel, und Math.hypot ist
    // in V8 um ein Vielfaches langsamer (Overflow-/Mehrargument-Behandlung).
    var rr = r * r;
    for (var i = 0; i < pts.length; i++) {
      var q = pts[i];
      var dx = q.x - pt.x, dy = q.y - pt.y;
      if (dx * dx + dy * dy <= rr) return true;
    }
    return false;
  }

  function effectiveRadius(mode, fallbackRadius) {
    if (mode && Object.prototype.hasOwnProperty.call(ERASER_RADII, mode)) return ERASER_RADII[mode];
    return fallbackRadius == null ? ERASER_RADII.standard : fallbackRadius;
  }

  /* Eraser-Filter: gibt { kept, removed } zurück.
   * - highlighterOnly=true: nur Marker-Strokes sind Lösch-Kandidaten (Pen bleibt).
   * - mode 'standard'/'stroke': ganzer Stroke bei Berührung (Stroke-Delete).
   * - mode 'precision': Teil-Löschung – nur getroffene Punkte entfernen; der
   *   (ggf. gekürzte) Stroke bleibt in `kept`, nur komplett leere in `removed`.
   * Rückwärtskompatibel: alte Strokes ohne tool-Flag gelten als Pen (löscht
   * Standard-Modus normal, Highlighter-Only lässt sie in Ruhe).
   */
  function filterStrokesForErase(strokes, pt, radius, opts) {
    opts = opts || {};
    var mode = opts.mode || 'standard';
    var highlighterOnly = !!opts.highlighterOnly;
    var effR = effectiveRadius(mode, radius);
    var kept = [];
    var removed = [];
    (strokes || []).forEach(function (s) {
      if (highlighterOnly && !isMarkerStroke(s)) { kept.push(s); return; }
if (mode === 'precision') {
        var r = effR + (s.size || 0) / 2;
        var runs = [], run = [], hit = false;
        var sb = strokeBounds(s);
        // Precision-Modus laeuft sonst ueber ALLE Punkte ALLER Strokes, obwohl
        // fast keiner in Radierreichweite liegt. Box erst prüfen.
        if (!sb || !boxesNear(pt, sb, r)) { kept.push(s); return; }
        var spts = s.points || [];
        var rr2 = r * r;
        for (var pi = 0; pi < spts.length; pi++) {
          var sq = spts[pi];
          var sdx = sq.x - pt.x, sdy = sq.y - pt.y;
          if (sdx * sdx + sdy * sdy <= rr2) {
            hit = true;
            if (run.length) runs.push(run);
            run = [];
          } else run.push(sq);
        }
        if (run.length) runs.push(run);
        if (!hit) { kept.push(s); return; }
        if (!runs.length) { removed.push(s); return; }
        runs.forEach(function (points) {
          var copy = {};
          for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) copy[k] = s[k];
          copy.points = points;
          copy.closed = false;
          copy.fill = null;
          kept.push(copy);
        });
        return;
      }
      // standard + stroke (+ unbekannte Modi): ganzer Stroke bei Berührung
      if (distToStroke(pt, s, effR)) removed.push(s);
      else kept.push(s);
    });
    return { kept: kept, removed: removed };
  }

  /* Scribble-Erkennung über Trail [{x,y,t}].
   * Positiv wenn: Fenster der letzten SCRIBBLE_WINDOW_MS >=4 Punkte hat,
   * Bounding-Box <= 2*RADIUS (kleiner Radius) und >=2 X-Richtungswechsel
   * (Jitter < MIN_DX ignoriert) mit ausreichender Gesamt-X-Bewegung.
   */
  function isScribbleGesture(trail, opts) {
    opts = opts || {};
    var minChanges = opts.minChanges == null ? SCRIBBLE_MIN_CHANGES : opts.minChanges;
    var windowMs = opts.windowMs == null ? SCRIBBLE_WINDOW_MS : opts.windowMs;
    var radius = opts.radius == null ? SCRIBBLE_RADIUS : opts.radius;
    var minDx = opts.minDx == null ? SCRIBBLE_MIN_DX : opts.minDx;
    if (!Array.isArray(trail) || trail.length < 4) return false;
    var lastT = trail[trail.length - 1].t;
    var win = trail.filter(function (p) { return (lastT - p.t) <= windowMs; });
    if (win.length < 4) return false;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < win.length; i++) {
      var p = win[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if ((maxX - minX) > radius * 2 || (maxY - minY) > radius * 2) return false;
    var changes = 0, lastSign = 0, totalX = 0;
    for (var j = 1; j < win.length; j++) {
      var dx = win[j].x - win[j - 1].x;
      if (Math.abs(dx) < minDx) continue;
      totalX += Math.abs(dx);
      var sign = dx > 0 ? 1 : -1;
      if (lastSign !== 0 && sign !== lastSign) changes++;
      lastSign = sign;
    }
    if (totalX < minDx * 6) return false;
    return changes >= minChanges;
  }

  /* Scribble-Opfer: alle Strokes, die der Trail berührt (Stroke-Delete, ganz),
   * unter Beachtung von highlighterOnly. Gibt Array der zu löschenden Strokes.
   */
  function collectScribbleVictims(strokes, trail, radius, opts) {
    opts = opts || {};
    var effR = effectiveRadius(opts.mode || 'stroke', radius);
    var victims = [];
    var seen = new Set();
    // Box des Trails einmal vorab. Ein Scribble-Trail ist winzig (hoechstens
    // 60 Punkte, Radius ~40px) – fast kein Stroke liegt darin. Ohne diese
    // Vorpruefung ist der Aufruf O(Trail x Strokes x Punkte).
    var tb = null;
    if (Array.isArray(trail) && trail.length) {
      var tx0 = Infinity, ty0 = Infinity, tx1 = -Infinity, ty1 = -Infinity;
      for (var ti = 0; ti < trail.length; ti++) {
        var tp = trail[ti];
        if (tp.x < tx0) tx0 = tp.x;
        if (tp.x > tx1) tx1 = tp.x;
        if (tp.y < ty0) ty0 = tp.y;
        if (tp.y > ty1) ty1 = tp.y;
      }
      tb = { n: trail.length, x0: tx0, y0: ty0, x1: tx1, y1: ty1 };
    }
    (strokes || []).forEach(function (s) {
      if (opts.highlighterOnly && !isMarkerStroke(s)) return;
      if (tb) {
        var sb = strokeBounds(s);
        if (!sb || !boxesOverlap(tb, sb, effR + (s.size || 0) / 2)) return;
      }
      var touched = (trail || []).some(function (pt) { return distToStroke(pt, s, effR); });
      if (touched && !seen.has(s)) { seen.add(s); victims.push(s); }
    });
    return victims;
  }

  /* Zwei-Finger-Tap = undo, Drei-Finger-Tap = redo. Dauer <300ms, kaum
   * Bewegung (<12px), sonst null (z.B. Pinch-Zoom: länger/mehr Bewegung).
   */
  function gestureActionForTap(touchCount, durationMs, moveDistPx) {
    if (durationMs >= GESTURE_MAX_DURATION_MS) return null;
    if (moveDistPx >= GESTURE_MAX_MOVE_PX) return null;
    if (touchCount === 2) return 'undo';
    if (touchCount === 3) return 'redo';
    return null;
  }

  function defaultEraserSettings() {
    return { highlighterOnly: false, mode: 'standard' };
  }

  function loadEraserSettings(storage) {
    var def = defaultEraserSettings();
    try {
      var raw = storage && storage.getItem
        ? storage.getItem(ERASER_LS_KEY)
        : (typeof localStorage !== 'undefined' ? localStorage.getItem(ERASER_LS_KEY) : null);
      if (!raw) return def;
      var p = JSON.parse(raw);
      return {
        highlighterOnly: !!p.highlighterOnly,
        mode: (p.mode === 'precision' || p.mode === 'stroke' || p.mode === 'standard') ? p.mode : 'standard',
      };
    } catch { return def; }
  }

  function saveEraserSettings(settings, storage) {
    var clean = {
      highlighterOnly: !!(settings && settings.highlighterOnly),
      mode: (settings && (settings.mode === 'precision' || settings.mode === 'stroke' || settings.mode === 'standard'))
        ? settings.mode : 'standard',
    };
    try {
      var json = JSON.stringify(clean);
      if (storage && storage.setItem) storage.setItem(ERASER_LS_KEY, json);
      else if (typeof localStorage !== 'undefined') localStorage.setItem(ERASER_LS_KEY, json);
    } catch { /* ignore */ }
    return clean;
  }

  var api = {
    MARKER_ALPHA: MARKER_ALPHA,
    MARKER_COMPOSITE: MARKER_COMPOSITE,
    ERASER_LS_KEY: ERASER_LS_KEY,
    ERASER_RADII: ERASER_RADII,
    SCRIBBLE_MIN_CHANGES: SCRIBBLE_MIN_CHANGES,
    SCRIBBLE_WINDOW_MS: SCRIBBLE_WINDOW_MS,
    SCRIBBLE_RADIUS: SCRIBBLE_RADIUS,
    SCRIBBLE_MIN_DX: SCRIBBLE_MIN_DX,
    GESTURE_MAX_DURATION_MS: GESTURE_MAX_DURATION_MS,
    GESTURE_MAX_MOVE_PX: GESTURE_MAX_MOVE_PX,
    isMarkerStroke: isMarkerStroke,
    distToStroke: distToStroke,
    effectiveRadius: effectiveRadius,
    filterStrokesForErase: filterStrokesForErase,
    isScribbleGesture: isScribbleGesture,
    collectScribbleVictims: collectScribbleVictims,
    gestureActionForTap: gestureActionForTap,
    defaultEraserSettings: defaultEraserSettings,
    loadEraserSettings: loadEraserSettings,
    saveEraserSettings: saveEraserSettings,
  };

  if (typeof window !== 'undefined') window.GrimoireErase = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
