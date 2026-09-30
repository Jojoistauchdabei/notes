/* Federwerk – Präsentations-Empfänger (present.html).
 *
 * Läuft auf dem zweiten Schirm: externer Monitor, Chromecast oder – über den
 * Fenster-Fallback – das per AirPlay gespiegelte Fenster auf dem Apple TV.
 * Diese Seite kennt das Dokument NICHT und darf es auch nicht: auf dem Fernseher
 * gibt es weder IndexedDB noch die Seiten. Alles kommt als serialisierte
 * Folie über den Kanal aus dem Hauptfenster (js/present.js).
 *
 * Transport ist austauschbar, der Rest ist gleich:
 *   - `navigator.presentation.receiver` → PresentationConnection (Chrome/Edge)
 *   - sonst BroadcastChannel            → zweites Fenster (Safari/Apple TV)
 * Beides liefert `send()` und `onMessage()`; der Rest des Codes kennt den
 * Unterschied nicht.
 *
 * Bedienung: ←/→ blättern, Pos1/Ende springen, B schwarz, L Laser auf dem
 * Schirm, F Vollbild, Esc beendet. Die Leiste blendet nach Ruhe selbst aus.
 *
 * Kein Build, plain <script> (global `FederwerkPresentView`).
 */
(function () {
  'use strict';

  var F = (typeof FederwerkPresentFlow !== 'undefined') ? FederwerkPresentFlow : null;
  var Laser = (typeof GrimoireLaser !== 'undefined') ? GrimoireLaser : null;
  var Ink = (typeof FederwerkInk !== 'undefined') ? FederwerkInk : null;

  /* Höchstzahl Pixel im Canvas-Backing. Ohne Deckel würde eine 2400px-Seite auf
   * einem 4K-Schirm ein 2400×3400-Backing verlangen – der Browser weigert sich
   * dann, das Blatt bleibt schwarz. Dieselbe Größenordnung wie in der App. */
  var MAX_PIXELS = 9e6;
  var DPR_CAP = 2;

  /* Leiste nach 3 s ohne Eingabe aus – bei einer Show stört eine dauerhaft
   * sichtbare Bedienleiste mehr als eine verschwundene. */
  var BAR_HIDE_MS = 3000;

  var conn = null;        // PresentationConnection
  var bc = null;          // BroadcastChannel
  var transport = 'none';

  var deck = null;        // { ids, count, loop, title }
  var slide = null;       // aktuell angezeigte Folie
  var cache = {};         // vorgecachte Nachbarfolien (Prefetch), je Index
  var count = 0;          // Länge von deck.ids, 0 = noch nichts angekommen
  var idx = -1;           // angezeigter Index, -1 = noch nichts
  var black = false;
  var laserEnabled = false;
  var trail = [];
  var laserRaf = 0;
  var barTimer = 0;
  var lastActivity = 0;

  var el = {};
  function $(id) { return document.getElementById(id); }

  /* ------------------------------------------------------------- Transport */

  function isReceiverContext() {
    try { return !!(navigator.presentation && navigator.presentation.receiver); }
    catch { return false; }
  }

  function send(msg) {
    if (!msg) return;
    if (conn) { try { conn.send(msg); } catch { /* Verbindung zu */ } }
    if (bc) { try { bc.postMessage(msg); } catch { /* Kanal zu */ } }
  }

  /* Erst versuchen, über die Presentation API an einen bereits laufenden
   * Steuergerät-Anschluss zu kommen. Schlägt das fehl (kein Receiver im
   * Kontext – der Normalfall im zweiten Fenster), auf den BroadcastChannel. */
  function connect() {
    if (!F) { setWait('Diese Ansicht benötigt js/presentflow.js.'); return; }
    if (isReceiverContext()) {
      try {
        navigator.presentation.receiver.connectionList.then(function (list) {
          if (list && list.connections && list.connections.length) bind(list.connections[0]);
          listenForMore(list);
        }, function () { openChannel(); });
        return;
      } catch { /* weiter unten */ }
    }
    openChannel();
  }

  function listenForMore(list) {
    try {
      if (list && list.addEventListener) {
        list.addEventListener('connectionavailable', function (ev) { bind(ev && ev.connection); });
      }
    } catch { /* ignore */ }
  }

  function bind(c) {
    if (!c) return;
    conn = c;
    transport = 'presentation';
    try {
      c.addEventListener('message', function (ev) { onMessage(ev && ev.data); });
      c.addEventListener('close', function () { setWait('Die Verbindung zum Hauptfenster wurde getrennt.'); teardown(); });
    } catch { /* ignore */ }
    send({ t: 'hello' });
  }

  function openChannel() {
    if (typeof BroadcastChannel !== 'function') {
      setWait('Dieser Browser kann den Kanal nicht öffnen (kein BroadcastChannel).');
      return;
    }
    try { bc = new BroadcastChannel(F.CHANNEL); } catch (e) { setWait('Kanal nicht verfügbar: ' + (e && e.message ? e.message : e)); return; }
    transport = 'window';
    try { bc.addEventListener('message', function (ev) { onMessage(ev && ev.data); }); } catch { /* ignore */ }
    send({ t: 'hello' });
  }

  function teardown() {
    conn = null;
    if (bc) { try { bc.close(); } catch { /* ignore */ } bc = null; }
  }

  /* -------------------------------------------------------------- Nachrichten */

  function onMessage(data) {
    if (!data || typeof data !== 'object') return;
    switch (data.t) {
      case 'deck': onDeck(data); break;
      case 'slide': showSlide(data); break;
      case 'prefetch': if (data.slide && typeof data.slide.k === 'number') cache[data.slide.k] = data.slide; break;
      case 'laser': onLaser(data); break;
      case 'black': setBlack(!!data.on, true); break;
      case 'bye': leave(); break;
      default: break;
    }
    wake();
  }

  function onDeck(d) {
    deck = d;
    count = Array.isArray(d.ids) ? d.ids.length : 0;
    // Der Steuergerät nennt seine Position; eine gecachte Folie sofort zeigen
    // vermeidet das Warten auf das erneute Auflösen von Bildern.
    if (typeof d.index === 'number' && cache[d.index]) showSlide(cache[d.index]);
    else setCount(d.index);
    if (el.title) el.title.textContent = d.title || '';
    if (!slide) el.wait.hidden = !!count;
  }

  function setCount(i) {
    if (el.count) el.count.textContent = count ? (Math.min(i + 1, count) + ' / ' + count) : '– / –';
  }

  function showSlide(s) {
    if (!s || typeof s !== 'object') return;
    slide = s;
    if (typeof s.k === 'number') {
      idx = s.k;
      setCount(idx);
    }
    try { el.wait.hidden = true; } catch { /* ignore */ }
    render(s);
  }

  function leave() {
    try { window.close(); } catch { /* Popup lässt sich nicht selbst schließen */ }
    setWait('Die Präsentation wurde beendet.');
    teardown();
  }

  /* ---------------------------------------------------------------- Rendern */

  /* Maße kommen aus der Leitung und sind damit nicht vertrauenswürdig –
   * `safeDims` lässt Müll durchfallen, statt die Seite zu sprengen. */
  function dimsOf(s) { return (F && F.safeDims(s)) || (F ? F.DEFAULT_DIMS : { w: 1000, h: 1414 }); }

  /* Seite in den Schirm einpassen. Anders als im Hauptfenster (dort leitet
   * `measureFlow` die Breite aus der Höhe ab) wird hier gegen BEIDE Achsen
   * gerechnet – auf einem 16:9-Fernseher darf eine A4-Seite weder oben und
   * unten noch seitlich abgeschnitten werden.
   *
   * `guard` schützt vor der Rechnung mit 0: die Bühne misst `inset: 0`, also
   * den Sichtbereich – solange css/styles.css noch nicht angewendet ist, ist
   * sie 0 hoch und fitPage liefert den Platzhalter 1×1. Genau das passiert, wenn
   * die erste Folie schneller da ist als das Stylesheet. Deshalb wird
   * zurückgestellt und nach dem Laden nachgeholt. */
  function fit(guard) {
    if (!slide) return;
    var d = dimsOf(slide);
    var root = el.root;
    var w = (root && root.clientWidth) || window.innerWidth || 0;
    var h = (root && root.clientHeight) || window.innerHeight || 0;
    if (guard && !(w > 0 && h > 0)) { retryFit(); return; }
    var size = F.fitPage(d, w, h, 24);
    var page = el.page;
    if (!page) return;
    page.style.width = size.w + 'px';
    page.style.height = size.h + 'px';
    sizeCanvas(el.canvas, d);
    sizeCanvas(el.laser, d);
  }

  /* Nachholen, sobald die Bühne wirklich eine Größe hat – in der Praxis kommt
   * das mit dem Stylesheet oder dem ersten Bildlauf. */
  function retryFit() {
    if (fitPending) return;
    fitPending = true;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () {
        fitPending = false;
        var root = el.root;
        if (root && root.clientWidth > 0 && root.clientHeight > 0) fit(false);
        else setTimeout(function () { fitPending = false; fit(false); }, 120);
      });
    } else {
      setTimeout(function () { fitPending = false; fit(false); }, 120);
    }
  }
  var fitPending = false;

  function sizeCanvas(cv, d) {
    if (!cv) return null;
    var dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1);
    var scale = dpr;
    // Backing nie größer als sinnvoll: sonst verlangt eine 2400px-Seite auf
    // einem 4K-Schirm ein 2400×3400-Backing, und der Browser weigert sich –
    // die Seite bleibt dann schwarz.
    var over = (d.w * dpr) * (d.h * dpr);
    if (over > MAX_PIXELS) scale = dpr * Math.sqrt(MAX_PIXELS / over);
    var backW = Math.max(1, Math.round(d.w * scale));
    var backH = Math.max(1, Math.round(d.h * scale));
    if (cv.width !== backW) cv.width = backW;
    if (cv.height !== backH) cv.height = backH;
    var ctx = cv.getContext('2d');
    // Kontext in Seitenkoordinaten: drawStroke rechnet in d.w × d.h, der
    // Laser in dasselbe System. CSS zieht das Element auf die eingepasste
    // Größe – dadurch bleibt die Tinte auf jedem Schirm scharf.
    if (ctx) ctx.setTransform(backW / d.w, 0, 0, backH / d.h, 0, 0);
    return ctx;
  }

  function render(s) {
    var d = dimsOf(s);
    fit(true);

    // Papier-Optik: die Klasse `.stage` plus die Vorlagen-Klassen des Dokuments
    // kommen aus css/styles.css, damit Schirm und Notizbuch gleich aussehen.
    if (el.page) {
      var cls = ['stage', 'present-page'];
      if (Array.isArray(s.paper)) s.paper.forEach(function (c) { if (typeof c === 'string') cls.push(c); });
      el.page.className = cls.join(' ');
    }
    if (el.bg) el.bg.style.backgroundImage = s.bg ? ('url("' + String(s.bg).replace(/"/g, '%22') + '")') : '';

    // Tinte
    if (el.canvas) {
      var ctx = el.canvas.getContext('2d');
      if (ctx) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
        ctx.restore();
      }
      if (Ink && Ink.drawStroke && Array.isArray(s.strokes)) {
        s.strokes.forEach(function (st) { try { Ink.drawStroke(ctx, st); } catch { /* kaputter Strich */ } });
      }
    }

    // Bilder
    if (el.img) {
      el.img.innerHTML = '';
      if (Array.isArray(s.images)) {
        s.images.forEach(function (im) {
          if (!im || !im.src) return;
          var d2 = document.createElement('div');
          d2.className = 'img-item';
          d2.style.left = (Number(im.x) || 0) * 100 + '%';
          d2.style.top = (Number(im.y) || 0) * 100 + '%';
          d2.style.width = (Number(im.w) || 0.3) * 100 + '%';
          d2.style.aspectRatio = 'auto';
          var img = document.createElement('img');
          img.src = im.src;
          img.alt = '';
          img.draggable = false;
          img.style.height = 'auto';
          d2.appendChild(img);
          el.img.appendChild(d2);
        });
      }
    }

    // Textfelder: das HTML kommt bereits vom Steuergerät sanitized.
    if (el.text) {
      el.text.innerHTML = '';
      if (Array.isArray(s.texts)) {
        s.texts.forEach(function (t) {
          if (!t) return;
          var d2 = document.createElement('div');
          d2.className = 'text-box';
          d2.style.left = (Number(t.x) || 0) * 100 + '%';
          d2.style.top = (Number(t.y) || 0) * 100 + '%';
          d2.style.maxWidth = '86%';
          if (t.fontSize) d2.style.fontSize = t.fontSize + 'px';
          if (t.color) d2.style.color = t.color;
          if (t.align) d2.style.textAlign = t.align;
          d2.innerHTML = typeof t.html === 'string' ? t.html : '';
          el.text.appendChild(d2);
        });
      }
    }

    clearLaser();
  }

  /* ----------------------------------------------------------------- Laser */

  function onLaser(d) {
    if (!laserEnabled) return;
    if (!d || !isFinite(d.nx) || !isFinite(d.ny)) return;
    var dim = dimsOf(slide);
    if (Laser) trail = Laser.push(trail, { x: d.nx * dim.w, y: d.ny * dim.h, t: Date.now() });
    else { trail.push({ x: d.nx * dim.w, y: d.ny * dim.h, t: Date.now() }); while (trail.length > 24) trail.shift(); }
    scheduleLaser();
  }

  function scheduleLaser() {
    if (laserRaf) return;
    try { laserRaf = requestAnimationFrame(drawLaser); }
    catch { laserRaf = 0; drawLaser(); }
  }

  function drawLaser() {
    laserRaf = 0;
    var cv = el.laser;
    if (!cv) return;
    var ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.restore();
    var dim = dimsOf(slide);
    var now = Date.now();
    var fade = (Laser && Laser.FADE_MS) || 700;
    if (Laser) trail = Laser.prune(trail, now, fade);
    else trail = trail.filter(function (p) { return (now - p.t) <= fade; });
    if (!trail.length) return;
    var col = (Laser && Laser.COLOR) || '#ff2211';
    var dot = (Laser && Laser.DOT_R) || 9;
    ctx.save();
    ctx.lineWidth = Math.max(3, dim.w * 0.006);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = col;
    for (var i = 1; i < trail.length; i++) {
      var a = Laser ? Laser.alphaFor(now - trail[i].t, fade) : 1 - (now - trail[i].t) / fade;
      if (a <= 0) continue;
      ctx.globalAlpha = a * 0.6;
      ctx.beginPath();
      ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
      ctx.lineTo(trail[i].x, trail[i].y);
      ctx.stroke();
    }
    var head = trail[trail.length - 1];
    var ha = Laser ? Laser.alphaFor(now - head.t, fade) : 1 - (now - head.t) / fade;
    if (ha > 0) {
      ctx.globalAlpha = ha;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(head.x, head.y, dot, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    scheduleLaser(); // bis zum Verblassen weiterzeichnen
  }

  function clearLaser() {
    trail = [];
    if (laserRaf) { try { cancelAnimationFrame(laserRaf); } catch { /* ignore */ } laserRaf = 0; }
    var cv = el.laser;
    if (!cv) return;
    var ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.restore();
  }

  function toggleLaser() {
    laserEnabled = !laserEnabled;
    if (!laserEnabled) clearLaser();
    if (el.laserBtn) el.laserBtn.classList.toggle('picked', laserEnabled);
    wake();
  }

  /* ------------------------------------------------------------ Navigation */

  function nav(dir) {
    if (!count) return;
    // Das Steuergerät ist die Wahrheit: es kennt Dokument und Hauptfenster.
    send({ t: 'nav', dir: dir > 0 ? 1 : -1 });
  }

  function setBlack(v, fromController) {
    black = !!v;
    if (el.root) el.root.classList.toggle('present-black', black);
    if (el.blackBtn) el.blackBtn.classList.toggle('picked', black);
    if (!fromController) send({ t: 'black', on: black });
    wake();
  }

  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) { document.exitFullscreen(); return; }
      var p = document.documentElement;
      if (p.requestFullscreen) p.requestFullscreen();
    } catch { /* Vom Browser abgelehnt: dann bleibt es beim Fenster */ }
  }

  /* ---------------------------------------------------------------- Leiste */

  function wake() {
    lastActivity = Date.now();
    if (el.bar) el.bar.hidden = false;
    el.root && el.root.classList.remove('present-idle');
    if (barTimer) { try { clearTimeout(barTimer); } catch { /* ignore */ } }
    barTimer = setTimeout(function () {
      if (el.bar && count) el.bar.hidden = true;
    }, BAR_HIDE_MS);
  }

  function setWait(html) {
    if (!el.wait) return;
    el.wait.hidden = false;
    el.wait.innerHTML = '<div class="present-wait-card">' + html + '</div>';
  }

  /* ------------------------------------------------------------------ Start */

  function init() {
    el.root = $('presentRoot');
    el.page = $('presentPage');
    el.bg = el.page ? el.page.querySelector('[data-part="bgLayer"]') : null;
    el.canvas = el.page ? el.page.querySelector('[data-part="drawCanvas"]') : null;
    el.img = el.page ? el.page.querySelector('[data-part="imgLayer"]') : null;
    el.text = el.page ? el.page.querySelector('[data-part="textLayer"]') : null;
    el.laser = $('presentLaser');
    el.bar = $('presentBar');
    el.count = $('presentCount');
    el.title = $('presentTitle');
    el.wait = $('presentWait');
    el.prevBtn = $('presentPrevBtn');
    el.nextBtn = $('presentNextBtn');
    el.blackBtn = $('presentBlackBtn');
    el.laserBtn = $('presentLaserBtn');
    el.fullBtn = $('presentFullBtn');
    el.exitBtn = $('presentExitBtn');

    on(el.prevBtn, 'click', function () { nav(-1); });
    on(el.nextBtn, 'click', function () { nav(1); });
    on(el.blackBtn, 'click', function () { setBlack(!black, false); });
    on(el.laserBtn, 'click', toggleLaser);
    on(el.fullBtn, 'click', toggleFullscreen);
    on(el.exitBtn, 'click', leave);

    // Klick irgendwo blättert weiter – wie auf jeder Bühne. Nur die Leiste
    // und echte Textfelder nicht abfangen.
    document.addEventListener('click', function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('.present-bar')) return;
      if (ev.target && ev.target.closest && ev.target.closest('.text-box')) return;
      nav(ev.clientX < window.innerWidth * 0.25 ? -1 : 1);
      wake();
    });

    document.addEventListener('keydown', function (ev) {
      if (/INPUT|TEXTAREA|SELECT/.test((ev.target && ev.target.tagName) || '')) return;
      var k = ev.key;
      if (k === 'ArrowRight' || k === 'PageDown' || k === ' ' || k === 'Spacebar' || k === 'Enter') { ev.preventDefault(); nav(1); }
      else if (k === 'ArrowLeft' || k === 'PageUp' || k === 'Backspace') { ev.preventDefault(); nav(-1); }
      else if (k === 'Home') { ev.preventDefault(); send({ t: 'goto', n: 0 }); }
      else if (k === 'End') { ev.preventDefault(); send({ t: 'goto', n: count - 1 }); }
      else if (k === 'b' || k === 'B' || k === '.') { setBlack(!black, false); }
      else if (k === 'l' || k === 'L') { toggleLaser(); }
      else if (k === 'f' || k === 'F') { toggleFullscreen(); }
      else if (k === 'Escape') { leave(); }
      else return;
      wake();
    });

    document.addEventListener('mousemove', wake);
    document.addEventListener('touchstart', wake, { passive: true });

    window.addEventListener('resize', function () { fit(false); });
    window.addEventListener('orientationchange', function () { fit(false); });
    if (window.screen) {
      try { window.screen.orientation && window.screen.orientation.addEventListener('change', function () { fit(false); }); } catch { /* ignore */ }
    }
    // Seitenwechsel im Hauptfenster erzwingen ein erneutes Einpassen (Schirm
    // drehen, Fenstergröße ändern, Vollbild).
    document.addEventListener('fullscreenchange', function () { fit(false); });

    connect();
    wake();
  }

  function on(node, ev, fn) { if (node) node.addEventListener(ev, fn); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  if (typeof window !== 'undefined') {
    window.FederwerkPresentView = { nav: nav, setBlack: setBlack, toggleLaser: toggleLaser, leave: leave, fit: fit };
  }
})();
