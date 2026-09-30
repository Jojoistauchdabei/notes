/* Federwerk – Präsentations-Logik (DOM-frei, testbar).
 *
 * Der Präsentationsmodus schickt Seiten an ein zweites Fenster / einen zweiten
 * Schirm (present.html) und lässt sie dort Seite für Seite stehen. Die
 * Geometrie- und Navigations-Entscheidungen liegen hier, damit sie ohne Browser
 * prüfbar sind – dasselbe Muster wie js/pageflow.js für den Continuous Scroll.
 *
 * Zwei Aufgaben, bewusst getrennt:
 *  1. Wie passt eine Seite in den Schirm? `fitPage` misst BEIDE Achsen. Das
 *     ist der Unterschied zu `measureFlow()` in js/app.js, das die Breite aus
 *     der Höhe ableitet und damit bei Querformat (A4 quer) über den Rand
 *     hinausläuft. Auf dem Beamershirm darf nichts abgeschnitten werden.
 *  2. Welcher Transport trägt die Seiten? `detectTransport` bevorzugt die
 *     Presentation API (Chrome/Edge, Chromecast, externer Monitor). Safari
 *     unterstützt sie nicht (WebKit-Bug 149168) – dort übernimmt ein zweites
 *     Fenster plus BroadcastChannel, das der Nutzer auf den zweiten Monitor
 *     zieht und über AirPlay an den Apple TV spiegelt.
 *
 * Kein Build, plain <script> (global `FederwerkPresentFlow`) + Node-Export.
 */
(function () {
  'use strict';

  /* BroadcastChannel-Name. Muss in Controller (js/present.js) und Empfänger
   * (js/present-view.js) identisch sein – daher hier als Konstante, nicht
   * an zwei Stellen getippt. */
  var CHANNEL = 'federwerk-present';

  var RECEIVER_PAGE = 'present.html';

  /* Seitenmaß-Default (A4 wie in app.js), falls ein Wert aus der Leitung
   * kaputt ist. */
  var DEFAULT_DIMS = { w: 1000, h: 1414 };

  /* Accepted-Seitenmaße. Gleiche Grenzen wie `pageDimsOf()` in js/app.js –
   * eine Seite kleiner als 200px oder größer als 2400px ist ein Fehler, kein
   * Format, und darf den Empfänger nicht mit einem 1×1-Elementzelt treffen. */
  var MIN_DIM = 200;
  var MAX_DIM = 2400;

  function num(v, fb) {
    var n = Number(v);
    return isFinite(n) ? n : fb;
  }

  function clamp(v, lo, hi) {
    if (!(hi >= lo)) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /* Maße aus der Leitung validieren. `d` kommt ungeprüft über den Kanal, also
   * null bei Müll – der Aufrufer fällt dann auf DEFAULT_DIMS zurück. */
  function safeDims(d) {
    if (!d || typeof d !== 'object') return null;
    var w = Math.round(num(d.w, 0));
    var h = Math.round(num(d.h, 0));
    if (!isFinite(w) || !isFinite(h)) return null;
    if (w < MIN_DIM || h < MIN_DIM) return null;
    if (w > MAX_DIM || h > MAX_DIM) return null;
    return { w: w, h: h };
  }

  /* Seite in den Sichtbereich einpassen: contain, Seitenverhältnis exakt.
   *
   * Anders als `measureFlow()` (nur aus der Höhe abgeleitet) wird hier
   * min(breite, hoehe) gebildet – sonst läuft eine Querformat-Seite seitlich
   * aus dem Bild. `pad` ist der Rand ringsum in CSS-Pixeln, `maxW` ein
   * optionaler Deckel (sehr breite Schirme sollen die Seite nicht riesig
   * ziehen, das sieht bei Papier aus wie ein Fehler).
   *
   * → { w, h } in CSS-Pixeln, nie kleiner als 1, damit ein 0-Sichtbereich
   *   (Element noch nicht im Layout) nicht durch 0 teilt. */
  function fitPage(dims, viewW, viewH, pad, maxW) {
    var d = safeDims(dims) || DEFAULT_DIMS;
    var p = Math.max(0, num(pad, 0));
    var vw = Math.max(0, num(viewW, 0)) - 2 * p;
    var vh = Math.max(0, num(viewH, 0)) - 2 * p;
    if (vw <= 0 || vh <= 0) return { w: 1, h: 1 };
    var s = Math.min(vw / d.w, vh / d.h);
    var cap = num(maxW, 0);
    if (cap > 0) s = Math.min(s, cap / d.w);
    if (!(s > 0) || !isFinite(s)) s = 0.01;
    return { w: Math.max(1, Math.floor(d.w * s)), h: Math.max(1, Math.floor(d.h * s)) };
  }

  /* Nächste/vorige Folie.
   *   loop=false → null am Rand (PowerPoint bricht am Ende ab, kein Rundlauf).
   *   loop=true  → am Ende zurück auf 0 (Ausstellungs-Automat).
   * dir=0 oder ungültige Eingabe → der Index selbst (nichts tun). */
  function stepIndex(i, dir, count, loop) {
    var n = Math.floor(num(count, 0));
    if (!(n > 0)) return null;
    var cur = Math.floor(num(i, 0));
    if (cur < 0) cur = 0;
    if (cur >= n) cur = n - 1;
    var d = dir > 0 ? 1 : dir < 0 ? -1 : 0;
    if (d === 0) return cur;
    var next = cur + d;
    if (next < 0 || next >= n) {
      if (!loop) return null;
      next = ((next % n) + n) % n;
    }
    return next;
  }

  /* Folienliste aus dem Dokument.
   *
   * `from` = Index der gerade gelesenen Seite: die Präsentation startet dort,
   * weil man beim Zeigen in der Mitte des Dokuments ist und nicht vorne
   * beginnt. `from` außerhalb (leeres Dokument, kaputter Aufruf) → 0.
   * Liegt `pages` nicht als Array vor, kommt eine leere Liste zurück, damit
   * der Controller ohne Sonderfall abbrechen kann. */
  function planSlides(pages, from, loop) {
    var src = (pages && typeof pages.length === 'number') ? pages : [];
    if (!src.length) return { ids: [], start: 0, count: 0, loop: !!loop };
    var start = Math.floor(num(from, 0));
    if (!(start >= 0) || start >= src.length) start = 0;
    var ids = [];
    for (var i = 0; i < src.length; i++) {
      var p = src[i];
      ids.push(p && p.id != null ? String(p.id) : '');
    }
    return { ids: ids, start: start, count: ids.length, loop: !!loop };
  }

  /* Transportweg wählen.
   *
   * `env` ist absichtlich ein schlichter Deskriptor statt echter navigator-/
   * window-Objekte – so ist jeder Zweig ohne Browser prüfbar.
   *
   *   secure            – HTTPS/localhost; Presentation API ist Secure-Context-only
   *   presentationRequest – window.PresentationRequest vorhanden
   *   broadcastChannel  – window.BroadcastChannel vorhanden (Fenster-Fallback)
   *   windowOpen        – window.open vorhanden
   *   receiver          – läuft diese Seite selbst als Empfänger?
   *
   * Reihenfolge ist Absicht: Presentation API zuerst, weil nur sie den
   * Bildschirmdialog des Browsers zeigt und den Nutzer gar nicht selbst
   * umfenstern muss. */
  function detectTransport(env) {
    var e = env || {};
    var secure = !!e.secure;
    var canPresent = secure && !!e.presentationRequest;
    var canWindow = secure && !!e.broadcastChannel && !!e.windowOpen;
    var mode = e.receiver ? 'receiver' : (canPresent ? 'presentation' : (canWindow ? 'window' : 'none'));
    return {
      canPresent: canPresent,
      canWindow: canWindow,
      canLoop: canPresent || canWindow,
      mode: mode,
      page: RECEIVER_PAGE,
      channel: CHANNEL,
    };
  }

  var api = {
    CHANNEL: CHANNEL,
    RECEIVER_PAGE: RECEIVER_PAGE,
    DEFAULT_DIMS: DEFAULT_DIMS,
    MIN_DIM: MIN_DIM,
    MAX_DIM: MAX_DIM,
    clamp: clamp,
    safeDims: safeDims,
    fitPage: fitPage,
    stepIndex: stepIndex,
    planSlides: planSlides,
    detectTransport: detectTransport,
  };

  if (typeof window !== 'undefined') window.FederwerkPresentFlow = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
