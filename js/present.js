/* Federwerk – Präsentations-Controller (Steuergerät).
 *
 * Die Haupt-UI bleibt unangetastet: es gibt kein Overlay, keine Vollbild-Umgehung,
 * kein Ausblenden von Header oder Werkzeugleiste. Der Controller liest lediglich
 * mit, welche Seite gerade gelesen wird, und spiegelt sie auf einen zweiten
 * Schirm. Wer im Hauptfenster scrollt oder blättert, steuert damit die Show –
 * dieselbe Gewohnheit wie beim Notizbuch.
 *
 * Transport (js/presentflow.js entscheidet):
 *   'presentation' – Presentation API: der Browser zeigt seinen
 *                    Bildschirmdialog, das Fenster landet auf Monitor/
 *                    Chromecast. Chrome/Edge, seit Chrome 59 auch als Empfänger.
 *   'window'       – zweites Fenster + BroadcastChannel. Für Safari, das die
 *                    Presentation API nicht kann (WebKit-Bug 149168). Das Fenster
 *                    auf den zweiten Monitor ziehen, über AirPlay an den Apple TV
 *                    spiegeln – ab da sieht der Fernseher die Präsentations-UI.
 *
 * Beide Wege sprechen dasselbe Protokoll über denselben Kanal, die Empfängerseite
 * kann den Transport nicht unterscheiden (present.html + js/present-view.js).
 *
 * Nachrichten (t = Typ):
 *   → deck      Folienliste, Startposition, Titel
 *   → slide     die aktuelle Seite, vollständig gerendert-fähig serialisiert
 *   → prefetch  die nächste Seite, nur vorgecacht (nie angezeigt)
 *   → laser     Laserpointer-Position, normiert 0..1
 *   → black     Bildschirm schwarz (Pause)
 *   → bye       Präsentation beendet
 *   ← hello     Empfänger bereit (fragt Deck an)
 *   ← nav       { dir } Blättern vom Empfänger aus
 *   ← black     { on } Schwarz-Taste am Empfänger
 *   ← bye       Empfänger wurde geschlossen
 *
 * Kein Build, plain <script> (global `FederwerkPresent`).
 */
(function () {
  'use strict';

  var on = false;          // läuft gerade eine Präsentation
  var mode = 'none';       // 'presentation' | 'window' | 'none'
  var conn = null;         // PresentationConnection (Presentation API)
  var win = null;          // Fensterproxy (Fallback)
  var bc = null;           // BroadcastChannel (Fallback)
  var deck = null;         // { ids, start, count, loop }
  var idx = 0;             // Index in deck.ids
  var ready = false;       // Empfänger hat sich gemeldet
  var lastKey = '';        // zuletzt gesendeter Inhaltsschlüssel (s. contentKey)
  var blackOn = false;
  var laserPending = false;
  var laserRaf = 0;
  var laserLast = null;

  function F() { return (typeof FederwerkPresentFlow !== 'undefined') ? FederwerkPresentFlow : null; }

  /* Was kann dieser Browser? */
  function env() {
    var secure = false;
    try { secure = (typeof isSecureContext !== 'undefined') ? !!isSecureContext : (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1'); }
    catch { secure = false; }
    return {
      secure: secure,
      presentationRequest: (typeof window !== 'undefined' && typeof window.PresentationRequest === 'function'),
      broadcastChannel: (typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function'),
      windowOpen: (typeof window !== 'undefined' && typeof window.open === 'function'),
    };
  }

  function supported() {
    var f = F();
    if (!f) return false;
    try { return f.detectTransport(env()).canLoop; } catch { return false; }
  }

  /* Der Knopf im Hauptfenster. Läuft bereits eine Show → beenden, sonst
   * starten. Kann der Browser es nicht (kein sicherer Kontext, kein
   * PresentationRequest, kein BroadcastChannel), wird das in der Statuszeile
   * gesagt – ein alert() wäre ein Ruck im Vollbild einer laufenden Show. */
  function toggle() {
    if (on) { stop(); return true; }
    var p = start();
    if (p && typeof p.then === 'function') {
      p.then(function (started) { if (!started) flash('Präsentieren geht hier nicht – Seite über https:// öffnen.'); }, function () { /* abort() meldet */ });
      return true;
    }
    flash('Präsentieren geht hier nicht – Seite über https:// öffnen.');
    return false;
  }

  function flash(msg) {
    try {
      var chip = document.getElementById('presentChip');
      if (!chip) return;
      chip.hidden = false;
      chip.textContent = msg;
      if (flashTimer) { try { clearTimeout(flashTimer); } catch { /* ignore */ } }
      flashTimer = setTimeout(function () { flashTimer = 0; syncChrome(); }, 6000);
    } catch { /* Chrome optional */ }
  }
  var flashTimer = 0;

  function isActive() { return on; }
  function currentIndex() { return idx; }

  /* Relative URL der Empfängerseite – nebenbei, muss sie im selben Verzeichnis
   * wie index.html liegen, sonst findet sie der Bildschirmdialog nicht. */
  function receiverUrl() {
    try { return new URL(F().RECEIVER_PAGE, document.baseURI).href; }
    catch { return F().RECEIVER_PAGE; }
  }

  /* ---------------------------------------------------------------- Ausgabe */

  function send(msg) {
    if (!on || !msg) return;
    if (conn) { try { conn.send(msg); } catch { /* Verbindung zu */ } }
    if (bc) { try { bc.postMessage(msg); } catch { /* Kanal zu */ } }
  }

  /* Folienliste aus dem gerade geöffneten Buch der aktiven Pane. */
  function buildDeck() {
    var f = F();
    var b = null;
    try { b = openBook(); } catch { b = null; }
    if (!b || !b.pages || !b.pages.length) return { ids: [], start: 0, count: 0, loop: false, title: '' };
    var from = 0;
    try {
      var pid = activePageId();
      var at = b.pages.findIndex(function (p) { return p && p.id === pid; });
      if (at > 0) from = at;
    } catch { /* Start vorne */ }
    var plan = f.planSlides(b.pages, from, false);
    plan.title = b.title || 'Federwerk';
    return plan;
  }

  /* Bild-/PDF-Bytes für den zweiten Schirm auflösen.
   *
   * Wichtig: `blob:`-URLs sind an das Dokument gebunden, das sie erzeugt hat –
   * im Empfängerfenster wären sie tot. Deshalb wird immer zu einer dataURL
   * aufgelöst (GrimoireStore.dataUrl), auch wenn im Hauptfenster bereits eine
   * funktionierende objectURL existiert. Kostet Base64-Ballast, ist aber der
   * einzige Weg, der über beide Transporte trägt. */
  function assetUrl(ref) {
    if (!ref) return Promise.resolve(null);
    if (typeof ref === 'string' && ref.indexOf('data:') === 0) return Promise.resolve(ref);
    try {
      if (typeof GrimoireStore !== 'undefined' && GrimoireStore.dataUrl) {
        return Promise.resolve(GrimoireStore.dataUrl(ref)).then(function (du) { return du || null; }).catch(function () { return null; });
      }
    } catch { /* Store optional */ }
    return Promise.resolve(null);
  }

  function cleanHtml(html) {
    try {
      if (typeof GrimoireSanitize !== 'undefined' && GrimoireSanitize.sanitizeHtml) return GrimoireSanitize.sanitizeHtml(html);
    } catch { /* Fallback unten */ }
    return String(html == null ? '' : html);
  }

  /* Eine Seite in ein Folien-Paket. Alles, was der Empfänger zum Zeichnen
   * braucht, steckt hier – er kennt das Dokument nicht und darf es nicht
   * kennen (auf dem Apple TV gibt es keine Datenbank). */
  function buildSlide(k) {
    var b = null;
    try { b = openBook(); } catch { b = null; }
    if (!b || !b.pages || !b.pages[k]) return Promise.resolve(null);
    var p = b.pages[k];
    var f = F();
    var dims = f.DEFAULT_DIMS;
    try { dims = pageDimsOf(p, b.paper) || dims; } catch { /* Default A4 */ }
    var paper = [];
    try {
      if (typeof FederwerkPaper !== 'undefined' && FederwerkPaper.cssClasses) paper = FederwerkPaper.cssClasses(b.paper) || [];
    } catch { /* ohne Vorlage: glatt */ }
    return Promise.all([assetUrl(p.bg)])
      .then(function (bg) {
        return {
          t: 'slide',
          k: k,
          n: deck ? deck.count : 0,
          total: b.pages.length,
          title: b.title || '',
          w: dims.w,
          h: dims.h,
          paper: paper,
          bg: bg[0] || null,
          strokes: p.strokes || [],
          texts: (p.texts || []).map(function (t) {
            return { x: t.x, y: t.y, html: cleanHtml(t.html), fontSize: t.fontSize, color: t.color, align: t.align };
          }),
          images: Promise.all((p.images || []).map(function (im) {
            return assetUrl(im.src).then(function (src) { return { x: im.x, y: im.y, w: im.w, src: src }; });
          })),
        };
      })
      .then(function (slide) {
        return slide.images.then(function (imgs) { slide.images = imgs; return slide; });
      });
  }

  /* Inhaltsschlüssel: billiger Fingerabdruck, damit ein Neusenden nur bei
   * echter Änderung passiert. Zählt Striche/Textfelder/Bilder und den Zeitstempel
   * des letzten Strichs – deckt Zeichnen, Radieren, Undo und Import ab. */
  function contentKey() {
    try {
      var p = currentPage();
      if (!p) return '';
      var st = p.strokes || [];
      var tail = st.length ? (st[st.length - 1].updatedAt || 0) : 0;
      return [p.id, st.length, (p.texts || []).length, (p.images || []).length, p.bg || '', tail].join('|');
    } catch { return ''; }
  }

  function sendDeck() {
    if (!on) return;
    send({ t: 'deck', ids: deck.ids, start: deck.start, count: deck.count, loop: deck.loop, title: deck.title, index: idx });
    ready = true;
  }

  /* Aktuelle Seite senden. `prefetch` holt die nächste Seite vor, damit das
   * Blättern auf dem Fernseher nicht erst auf das Auflösen von Bildern wartet.
   * Race: wer bis zum Auflösen weiterblättert, verwirft das Ergebnis (k !== idx). */
  function sendSlide(prefetch) {
    if (!on || !deck || !deck.count) return;
    var k = idx;
    lastKey = contentKey();
    buildSlide(k).then(function (slide) {
      if (!on || !slide || k !== idx) return;
      send(slide);
      if (!prefetch) return;
      var n = F().stepIndex(k, 1, deck.count, deck.loop);
      if (n == null) return;
      buildSlide(n).then(function (next) {
        if (on && next) send({ t: 'prefetch', slide: next });
      });
    });
  }

  /* ------------------------------------------------------------- Steuerung */

  /* Start asynchron, weil die Verfügbarkeit abgefragt wird, bevor der
   * Bildschirmdialog aufgeht: ohne zweiten Schirm würde `start()` in einem
   * leeren Dialog enden (NotFoundError) und der Nutzer wüsste nicht, warum.
   * Stattdessen direkt auf das zweite Fenster ausweichen.
   *
   * Bricht der Dialog ab (Nutzer sagt Nein), wird NICHT automatisch geöffnet –
   * eine Ablehnung ist eine Ablehnung, kein Fehler, den man übergehen darf. */
  function start() {
    if (on) return Promise.resolve(true);
    var f = F();
    if (!f) return Promise.resolve(false);
    var t;
    try { t = f.detectTransport(env()); } catch { return Promise.resolve(false); }
    if (!t.canLoop) return Promise.resolve(false);
    var b = null;
    try { b = openBook(); } catch { b = null; }
    if (!b || !b.pages || !b.pages.length) return Promise.resolve(false);

    on = true;
    mode = t.mode;
    deck = buildDeck();
    deckSig = deckSignature(b);
    idx = deck.count ? deck.start : 0;
    lastKey = ''; blackOn = false; ready = false;
    syncChrome();

    if (t.mode !== 'presentation') return Promise.resolve(openWindowChannel(f));

    return requestPresentation(f)
      .then(function (c) { return adoptConnection(c); })
      .then(function () { return true; }, function (e) { return abort(e); });
  }

  /* Verfügbarkeit prüfen, dann den Dialog öffnen. Fehlt `getAvailability()`
   * (nicht überall vorhanden), wird einfach gefragt – dann kommt eben der
   * Browserdialog und der Nutzer entscheidet. */
  function requestPresentation(f) {
    return Promise.resolve()
      .then(function () {
        var req = new window.PresentationRequest(receiverUrl());
        if (typeof req.getAvailability !== 'function') return null;
        return req.getAvailability().then(function (a) { return a && a.value === false ? false : null; });
      })
      .then(function (noDisplay) {
        if (noDisplay === false) {
          // Kein Bildschirmdialog sinnvoll -> Fenster-Fallback. `start()` ist
          // noch in derselben Nutzer-Interaktion, das Popup wird also nicht
          // blockiert.
          openWindowChannel(f);
          return null;
        }
        return new window.PresentationRequest(receiverUrl()).start();
      });
  }

  function adoptConnection(c) {
    if (!c) return;
    if (!on) { try { c.close(); } catch { /* ignore */ } return; }
    conn = c;
    wireConnection(c);
  }

  /* Fenster-Fallback (Safari -> Apple TV über AirPlay). */
  function openWindowChannel(f) {
    mode = 'window';
    win = window.open(f.RECEIVER_PAGE, 'federwerk-present', 'popup,width=1280,height=720');
    if (!win) return abort(new Error('Popup blockiert'));
    try { bc = new window.BroadcastChannel(f.CHANNEL); } catch (e) { return abort(e); }
    wireChannel();
    try { win.focus(); } catch { /* Popup darf den Fokus nicht erzwingen */ }
    return true;
  }

  /* Start scheitert (Nutzer bricht den Bildschirmdialog ab, Popup-Blocker):
   * vollständig zurückrollen, damit kein „präsentiert“-Zustand ohne Schirm bleibt. */
  function abort(err) {
    voidReset();
    if (err && typeof console !== 'undefined' && console.warn) console.warn('Praesentation nicht gestartet:', err && err.message ? err.message : err);
    syncChrome();
    return false;
  }

  function voidReset() {
    on = false; mode = 'none'; conn = null; win = null; bc = null;
    deck = null; idx = 0; ready = false; lastKey = ''; blackOn = false; deckSig = '';
    if (laserRaf) { try { cancelAnimationFrame(laserRaf); } catch { /* ignore */ } laserRaf = 0; }
    laserLast = null;
  }

  function stop() {
    if (!on) return false;
    send({ t: 'bye' });
    if (conn) { try { conn.close(); } catch { /* ignore */ } }
    if (win) { try { win.close(); } catch { /* ignore */ } }
    if (bc) { try { bc.close(); } catch { /* ignore */ } }
    voidReset();
    syncChrome();
    return true;
  }

  /* Empfänger hat sich gemeldet: Deck + aktuelle Seite nachreichen. */
  function onHello() {
    if (!on) return;
    ready = true;
    sendDeck();
    sendSlide(true);
  }

  function next() { return step(1); }
  function prev() { return step(-1); }

  /* Blättern. Geht über `stepPanePage`, damit Hauptfenster und Schirm an
   * derselben Stelle stehen: derselbe Aufruf, den auch Bild-ab in der Haupt-UI
   * auslöst. Am Rand (kein Rundlauf) gibt es ein kurzes Blinken in der
   * Statuszeile – die Rückmeldung, dass Schluss ist. */
  function step(dir) {
    if (!on || !deck) return false;
    var f = F();
    var n = f.stepIndex(idx, dir, deck.count, deck.loop);
    if (n == null) {
      try { if (typeof flowBoundaryFeedback === 'function') flowBoundaryFeedback(activePaneIdx()); } catch { /* optional */ }
      return false;
    }
    idx = n;
    // Wenn der Empfänger blättert, soll das Hauptfenster mitgehen.
    try {
      var b = openBook();
      var pid = deck.ids[idx];
      var target = b && b.pages
        ? b.pages.find(function (p) { return p && String(p.id) === String(pid); })
        : null;
      if (target) { try { activatePanePage(activePaneIdx(), target.id); } catch { /* ignore */ } }
    } catch { /* Hauptfenster folgt nicht, Schirm schon */ }
    sendSlide(true);
    return true;
  }

  /* Blattsprung (Start/Ende, oder Direktklick im Zähler). */
  function gotoSlide(n) {
    if (!on || !deck || !deck.count) return false;
    var i = F().clamp(Math.floor(Number(n) || 0), 0, deck.count - 1);
    if (i === idx) return false;
    idx = i;
    sendSlide(true);
    return true;
  }

  function setBlack(v) {
    blackOn = !!v;
    send({ t: 'black', on: blackOn });
    syncChrome();
    return blackOn;
  }
  function toggleBlack() { return setBlack(!blackOn); }

  /* ------------------------------------------------------------------ Deck */

  /* Deck gegen das Dokument prüfen. Während einer Show lässt sich die
   * Seitenliste ändern – Doc-Import, Seite löschen, Undo, GoodNotes-Import.
   * Ohne diese Prüfung bliebe `deck.ids` stehen und der Schirm zeigte ab da
   * nichts mehr (die neue Seite stünde in keiner Folie). Deshalb wird das Deck
   * neu gebaut, sobald sich die Seiten-IDs geändert haben, und die Position
   * möglichst gehalten. */
  function deckSignature(b) {
    if (!b || !b.pages) return '';
    return b.pages.map(function (p) { return p && p.id != null ? p.id : ''; }).join('|');
  }

  function syncDeck() {
    if (!on) return false;
    var b = null;
    try { b = openBook(); } catch { b = null; }
    var sig = deckSignature(b);
    if (sig === deckSig) return false;
    var prevId = deck && deck.ids[idx];
    var fresh = buildDeck();
    deck = fresh;
    deckSig = sig;
    // Position halten: dieselbe Seite weiter anzeigen, sonst auf den Anfang.
    var at = prevId == null ? -1 : fresh.ids.indexOf(String(prevId));
    idx = at >= 0 ? at : 0;
    if (idx >= deck.count) idx = Math.max(0, deck.count - 1);
    sendDeck();
    sendSlide(true);
    return true;
  }
  var deckSig = '';

  /* ------------------------------------------------------------- Haken aus app.js */

  /* Wird bei jedem Seitenwechsel gerufen (setActivePageId). Damit steuert das
   * Hauptfenster die Show: scrollen, blättern, Rail-Klick – alles folgt. */
  function onPage(pageId) {
    if (!on || !deck) return;
    syncDeck();
    var at = deck.ids.indexOf(String(pageId));
    if (at < 0 || at === idx) return;
    idx = at;
    sendSlide(true);
  }

  /* Wird nach jedem inhaltlichen Neuzeichnen der aktiven Seite gerufen
   * (renderCanvas): Korrigieren, Löschen, Undo, Import, Live-Übernahme. */
  function onCanvas() {
    if (!on || !deck) return;
    var key = contentKey();
    if (key === lastKey) return;
    syncDeck();
    var p = null;
    try { p = currentPage(); } catch { p = null; }
    if (!p) return;
    var at = deck.ids.indexOf(String(p.id));
    if (at < 0) return;
    if (at !== idx) { idx = at; }
    sendSlide(false);
  }

  /* Wird vom Laserpointer gefüttert (laserPushFor), in Seitenkoordinaten.
   * Normiert auf 0..1, weil der Empfänger die Seite in unbekannter Größe
   * zeigt – Quadrat-Pixel würden auf einem 4K-Fernseher danebenliegen.
   * Pro Frame höchstens eine Nachricht. */
  function onLaser(paneIdx, pos) {
    if (!on) return;
    var d = null;
    try { d = (typeof paneDims === 'function') ? paneDims(paneIdx) : null; } catch { d = null; }
    if (!d || !d.w || !d.h) return;
    laserLast = { nx: pos.x / d.w, ny: pos.y / d.h };
    if (laserPending) return;
    laserPending = true;
    try {
      laserRaf = requestAnimationFrame(function () {
        laserPending = false;
        if (laserLast) send({ t: 'laser', nx: laserLast.nx, ny: laserLast.ny });
      });
    } catch {
      // Kein rAF (Tests): sofort senden.
      laserPending = false;
      if (laserLast) send({ t: 'laser', nx: laserLast.nx, ny: laserLast.ny });
    }
  }

  /* ------------------------------------------------------------- Verdrahtung */

  function handleMessage(data) {
    if (!data || typeof data !== 'object') return;
    switch (data.t) {
      case 'hello': onHello(); break;
      case 'nav': step(Number(data.dir) > 0 ? 1 : -1); break;
      case 'goto': gotoSlide(Number(data.n)); break;
      case 'black': setBlack(!!data.on); break;
      case 'bye': stop(); break;
      default: break; // 'ack' & Co. ignorieren
    }
  }

  function wireConnection(c) {
    try {
      c.addEventListener('message', function (ev) { handleMessage(ev && ev.data); });
      c.addEventListener('close', function () { if (on) { voidReset(); syncChrome(); } });
    } catch { /* Verbindung ohne Events: trotzdem nutzbar */ }
  }

  function wireChannel() {
    try {
      bc.addEventListener('message', function (ev) { handleMessage(ev && ev.data); });
    } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------------ Chrome */

  /* Statuszeile und Toolbar-Button spiegeln den Zustand. Der Hauptbildschirm
   * zeigt nur einen ruhigen Hinweis („präsentiert auf Extern“) – die
   * Bedienung bleibt beim Notizbuch, wie man es vom Blättern gewohnt ist. */
  function syncChrome() {
    try {
      var chip = document.getElementById('presentChip');
      if (chip) {
        chip.hidden = !on;
        chip.textContent = on ? '▶ präsentiert' + (mode === 'window' ? ' (Fenster)' : ' (Extern)') : '';
      }
      var btn = document.getElementById('presentBtn');
      if (btn) {
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.classList.toggle('picked', on);
      }
    } catch { /* Chrome optional */ }
  }

  var api = {
    supported: supported,
    isActive: isActive,
    currentIndex: currentIndex,
    toggle: toggle,
    start: start,
    stop: stop,
    next: next,
    prev: prev,
    gotoSlide: gotoSlide,
    setBlack: setBlack,
    toggleBlack: toggleBlack,
    onPage: onPage,
    onCanvas: onCanvas,
    onLaser: onLaser,
    syncChrome: syncChrome,
  };

  if (typeof window !== 'undefined') {
    window.FederwerkPresent = api;
    // Flach exportiert, damit index.html onclick="presentStart()" schreiben kann –
    // dasselbe Muster wie js/flash-ui.js.
    window.presentStart = start;
    window.presentStop = stop;
    window.presentToggle = toggle;
    window.presentNext = next;
    window.presentPrev = prev;
    window.presentBlack = toggleBlack;
  }
})();
