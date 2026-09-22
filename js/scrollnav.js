/* Federwerk – Scroll-Navigation (Wheel blättert Seiten, pro Pane).
 *
 * DOM-freie, testbare Entscheidungslogik: ob ein Wheel-Event einen
 * Seitenwechsel auslösen darf und in welche Richtung. Das DOM-Glue
 * (Listener auf .stage-wrap/.stage, setPanePageAndRender, Toggle-Button)
 * lebt in js/app.js – hier nur reine Funktionen.
 *
 * Regeln (s. Task):
 * - Nur vertikaler Scroll (deltaY dominiert) löst aus, kein Touch/Pointer.
 * - Pinch-Zoom (ctrlKey/metaKey + Wheel) wird NIE gehandelt (Browser-Zoom).
 * - Akkumulations-Schwelle (Default 40px) + Cooldown (Default 600ms):
 *   ein Wheel-Schub = genau eine Seite, Trackpad-Rauschen springt nicht doppelt.
 * - Am Anfang/Ende: kein Wrap (neighborIndex -> null, UI gibt Feedback).
 * - An/Aus-Persistenz unter federwerkScrollNavV1 (Default AN).
 *
 * Kein Build, plain <script> (global `GrimoireScrollNav`) + Node-export für Tests.
 */
(function () {
  'use strict';

  var LS_KEY = 'federwerkScrollNavV1';
  var DEFAULT_COOLDOWN_MS = 600;
  var DEFAULT_THRESHOLD_PX = 40;
  var DEFAULT_SWIPE_THRESHOLD_PX = 90;  // Zwei-Finger-Swipe (CSS-px, Touch)
  var DEFAULT_SWIPE_COOLDOWN_MS = 500;
  var SWIPE_ENGAGE_PX = 24; // erst ab dieser Bewegung gilt es als Swipe (Tap bleibt Tap)
  var LINE_PX = 16;   // DOM_DELTA_LINE -> px (Näherung)
  var PAGE_PX = 500;  // DOM_DELTA_PAGE -> px (Näherung)

  function num(v, fb) {
    var n = Number(v);
    return isFinite(n) ? n : fb;
  }

  /* Wheel-Deltas auf px normieren (deltaMode 0 = px, 1 = Zeilen, 2 = Seiten). */
  function normalizeWheel(ev) {
    ev = ev || {};
    var dx = num(ev.deltaX, 0);
    var dy = num(ev.deltaY, 0);
    var mode = num(ev.deltaMode, 0);
    if (mode === 1) { dx *= LINE_PX; dy *= LINE_PX; }
    else if (mode === 2) { dx *= PAGE_PX; dy *= PAGE_PX; }
    return { dx: dx, dy: dy };
  }

  /* Vertikal dominant: |deltaY| > |deltaX| und deltaY != 0. */
  function isVerticalDominant(dx, dy) {
    if (!isFinite(dx) || !isFinite(dy)) return false;
    if (dy === 0) return false;
    return Math.abs(dy) > Math.abs(dx);
  }

  /* Darf dieses Wheel-Event die Scroll-Navigation auslösen?
   * Zurück: { handle, dx, dy, reason } mit reason 'vertical' | 'zoom' | 'horizontal'. */
  function shouldHandleWheel(ev) {
    ev = ev || {};
    if (ev.ctrlKey || ev.metaKey) return { handle: false, dx: 0, dy: 0, reason: 'zoom' };
    var n = normalizeWheel(ev);
    if (!isVerticalDominant(n.dx, n.dy)) return { handle: false, dx: n.dx, dy: n.dy, reason: 'horizontal' };
    return { handle: true, dx: n.dx, dy: n.dy, reason: 'vertical' };
  }

  function optsOf(o) {
    o = o || {};
    var cooldown = num(o.cooldownMs, DEFAULT_COOLDOWN_MS);
    if (!(cooldown >= 0)) cooldown = DEFAULT_COOLDOWN_MS;
    var threshold = num(o.threshold, DEFAULT_THRESHOLD_PX);
    if (!(threshold > 0)) threshold = DEFAULT_THRESHOLD_PX;
    return { cooldownMs: cooldown, threshold: threshold };
  }

  /* Reine Flip-Entscheidung: deltaY gegen akkumulierten Reststand acc.
   * now/lastFlip in ms (z. B. Date.now()). Zurück: { flip: 1|-1|0, acc }.
   * flip=1 -> nächste Seite (runter), flip=-1 -> vorherige (hoch).
   * Innerhalb des Cooldowns: kein Flip, acc wird zurückgesetzt. */
  function shouldFlip(deltaY, acc, now, lastFlip, opts) {
    var o = optsOf(opts);
    acc = num(acc, 0);
    now = num(now, 0);
    lastFlip = num(lastFlip, -Infinity);
    var d = num(deltaY, 0);
    if (isFinite(lastFlip) && (now - lastFlip) < o.cooldownMs) return { flip: 0, acc: 0 };
    if (!d) return { flip: 0, acc: acc };
    // Richtungswechsel: neu sammeln (kein Hin-und-Her-Aufschaukeln).
    if (acc !== 0 && ((acc > 0) !== (d > 0))) acc = 0;
    acc += d;
    if (Math.abs(acc) >= o.threshold) return { flip: acc > 0 ? 1 : -1, acc: 0 };
    return { flip: 0, acc: acc };
  }

  /* Pro-Pane-Laufzeitstand (acc-Sammler + letzter Flip-Zeitpunkt). */
  function createPaneState() { return { acc: 0, lastFlip: -Infinity }; }

  /* Zwei-Finger-Swipe einrasten? Erst ab SWIPE_ENGAGE_PX und nur vertikal
   * dominant – Pinch/horizontales Pannen bleibt beim Browser. */
  function swipeEngage(totalDx, totalDy, slop) {
    var s = num(slop, SWIPE_ENGAGE_PX);
    if (!(s > 0)) s = SWIPE_ENGAGE_PX;
    var dx = num(totalDx, 0), dy = num(totalDy, 0);
    if (!isFinite(dx) || !isFinite(dy)) return false;
    if (Math.abs(dy) < s) return false;
    return Math.abs(dy) > Math.abs(dx);
  }

  /* Touch-Laufzeitstand (eigener acc, damit Wheel und Swipe sich nicht
   * gegenseitig den Reststand klauen). */
  function createSwipeState() { return { acc: 0, lastFlip: -Infinity }; }

  function swipeOptsOf(o) {
    o = o || {};
    var cooldown = num(o.cooldownMs, DEFAULT_SWIPE_COOLDOWN_MS);
    if (!(cooldown >= 0)) cooldown = DEFAULT_SWIPE_COOLDOWN_MS;
    var threshold = num(o.threshold, DEFAULT_SWIPE_THRESHOLD_PX);
    if (!(threshold > 0)) threshold = DEFAULT_SWIPE_THRESHOLD_PX;
    return { cooldownMs: cooldown, threshold: threshold };
  }

  /* Ein Swipe-Delta (CSS-px, vorzeichenbehaftet, + = runter) gegen den
   * Touch-State fahren (mutiert st). Zurück: { flip: 1|-1|0, acc }. */
  function stepSwipe(st, dyPx, now, opts) {
    if (!st || typeof st !== 'object') st = createSwipeState();
    if (typeof st.acc !== 'number' || !isFinite(st.acc)) st.acc = 0;
    if (typeof st.lastFlip !== 'number') st.lastFlip = -Infinity;
    var o = swipeOptsOf(opts);
    var t = (now == null) ? Date.now() : num(now, Date.now());
    var r = shouldFlip(num(dyPx, 0), st.acc, t, st.lastFlip, o);
    st.acc = r.acc;
    if (r.flip) st.lastFlip = t;
    return { flip: r.flip, acc: st.acc };
  }

  /* Ein Wheel-Event gegen einen Pane-State fahren (mutiert st).
   * Zurück: { handled, flip, acc }. handled=true heißt: Event wurde als
   * vertikaler Scroll erkannt (app.js ruft dann preventDefault). */
  function stepWheel(st, ev, now, opts) {
    if (!st || typeof st !== 'object') st = createPaneState();
    if (typeof st.acc !== 'number' || !isFinite(st.acc)) st.acc = 0;
    if (typeof st.lastFlip !== 'number') st.lastFlip = -Infinity;
    var gate = shouldHandleWheel(ev);
    if (!gate.handle) return { handled: false, flip: 0, acc: st.acc, dy: gate.dy };
    var t = (now == null) ? Date.now() : num(now, Date.now());
    var r = shouldFlip(gate.dy, st.acc, t, st.lastFlip, opts);
    st.acc = r.acc;
    if (r.flip) st.lastFlip = t;
    return { handled: true, flip: r.flip, acc: st.acc, dy: gate.dy };
  }

  /* Nachbar-Index ohne Wrap: pos + dir, oder null an den Rändern. */
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

  /* Toggle-Persistenz (storage injizierbar, z. B. localStorage oder Mock). */
  function loadEnabled(storage) {
    try {
      if (!storage || typeof storage.getItem !== 'function') return true;
      var raw = storage.getItem(LS_KEY);
      if (raw == null) return true;
      var s = String(raw).trim().toLowerCase();
      if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
      return true;
    } catch (e) { return true; }
  }

  function saveEnabled(storage, v) {
    try {
      if (storage && typeof storage.setItem === 'function') storage.setItem(LS_KEY, v ? '1' : '0');
    } catch (e) { /* ignore */ }
    return !!v;
  }

  var api = {
    LS_KEY: LS_KEY,
    DEFAULT_COOLDOWN_MS: DEFAULT_COOLDOWN_MS,
    DEFAULT_THRESHOLD_PX: DEFAULT_THRESHOLD_PX,
    DEFAULT_SWIPE_THRESHOLD_PX: DEFAULT_SWIPE_THRESHOLD_PX,
    DEFAULT_SWIPE_COOLDOWN_MS: DEFAULT_SWIPE_COOLDOWN_MS,
    SWIPE_ENGAGE_PX: SWIPE_ENGAGE_PX,
    normalizeWheel: normalizeWheel,
    isVerticalDominant: isVerticalDominant,
    shouldHandleWheel: shouldHandleWheel,
    shouldFlip: shouldFlip,
    createPaneState: createPaneState,
    stepWheel: stepWheel,
    swipeEngage: swipeEngage,
    createSwipeState: createSwipeState,
    stepSwipe: stepSwipe,
    neighborIndex: neighborIndex,
    loadEnabled: loadEnabled,
    saveEnabled: saveEnabled,
  };

  if (typeof window !== 'undefined') window.GrimoireScrollNav = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
