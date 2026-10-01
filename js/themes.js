/* Federwerk Theme-System (js/themes.js)
 *
 * Laedt zur Laufzeit genau ein Design-Stylesheet nach und setzt die
 * Design-Tokens der App. Ohne Auswahl bleibt alles beim Standard-
 * "Papier"-Thema aus css/styles.css – dann wird gar nichts nachgeladen.
 *
 * Ablauf:
 *   1. Dieses Skript laeuft synchron im <head> (index.html, present.html,
 *      agent.html) und setzt data-theme/data-scheme VOR dem ersten Paint,
 *      damit die Seite nicht kurz im Standard-Theme aufblitzt.
 *   2. Beim ersten Anzeigen des Auswahl-Dialogs wird der Knopf in die
 *      Kopfzeile gesetzt.
 *   3. Reihenfolge im Dokument bleibt:
 *         css/styles.css -> css/themes/_shared.css -> css/themes/<thema>.css
 *      styles.css hat die schwachsten, das Thema die staerksten Regeln.
 *
 * oeffentliche API (window.FederwerkThemes):
 *   list()            -> verfuegbare Themes inkl. Standard
 *   current()         -> { id, scheme }
 *   apply(id)         -> Theme setzen (id '' = Standard/Papier)
 *   setScheme(s)      -> 'light' | 'dark' | 'auto'
 *   openPicker()      -> Auswahl-Dialog
 */
(function () {
  'use strict';

  var STORE = 'fw-theme';
  var STORE_SCHEME = 'fw-scheme';
  var SHARED = 'css/themes/_shared.css';
  var THEMES_DIR = 'css/themes/';

  /* id, Anzeigename, Dateiname, Kurzbeschreibung, Farbfelder fuer die
   * Vorschau. Der Standard ('papier') hat keine eigene Datei. */
  var LIST = [
    { id: 'papier', name: 'Papier', file: 'papier', noAdapter: true, desc: 'Federwerks Original: warmes Papier, Ocker, Serifenschrift.', sw: ['#faf6ee', '#8b5a2b', '#c9a87c', '#654321', '#2a1a0e'] },
    { id: '01-crayon', name: 'Buntstift', file: '01-crayon', desc: 'Dicke Konturen, schiefe Ecken, Buntpapier.', sw: ['#fff3cf', '#e2574c', '#f7a325', '#2a6f97', '#2f2a26'] },
    { id: '02-terminal', name: 'Phosphor-Terminal', file: '02-terminal', desc: 'Monospace, Scanlines, Phosphorgruen.', sw: ['#05080a', '#33ff99', '#ffb000', '#1f5c3d', '#0a120e'] },
    { id: '03-zen', name: 'Zen / Mu', file: '03-zen', desc: 'Haarlinien statt Kisten, viel Weissraum.', sw: ['#f6f5f2', '#ffffff', '#8d9187', '#dcdad3', '#3c3f3a'] },
    { id: '04-neobrutalism', name: 'Neo-Brutalismus', file: '04-neobrutalism', desc: '3 Pixel schwarz, harte Schlagschatten, laut.', sw: ['#fdf6e3', '#000000', '#ff4d00', '#0047ff', '#ffe600'] },
    { id: '05-editorial', name: 'Editorial', file: '05-editorial', desc: 'Magazinlayout, Serifenschrift, ein Rot.', sw: ['#f7f3ea', '#1a1713', '#a8232b', '#d9d0bd', '#6b6252'] },
    { id: '06-neonglass', name: 'Neon-Glas', file: '06-neonglass', desc: 'Glasflaechen, Verlaufskanten, Neonlicht.', sw: ['#07070f', '#14162a', '#22d3ee', '#a855f7', '#f472b6'] },
    { id: '07-blueprint', name: 'Blueprint', file: '07-blueprint', desc: 'Konstruktionsplan: Raster, Eckmarken, Cyan.', sw: ['#0a2340', '#123a63', '#7fd4ff', '#ffffff', '#c9e6ff'] },
    { id: '08-botanical', name: 'Botanisch', file: '08-botanical', desc: 'Creme, Blattgruen, Terrakotta, weiche Formen.', sw: ['#f2efe1', '#2f4f3a', '#b5643c', '#8a9a6b', '#d9cfae'] },
    { id: '09-retro90s', name: 'Skeuomorph 90er', file: '09-retro90s', desc: 'Erhabene Knoepfe, Navy-Titelleiste, Tahoma.', sw: ['#c0c0c0', '#000080', '#ffffff', '#008080', '#808080'] },
    { id: '10-swiss', name: 'Swiss / Raster', file: '10-swiss', desc: 'Helvetica, Schwarzweiss, ein Rot, Disziplin.', sw: ['#ffffff', '#000000', '#e30613', '#f2f2f2', '#767676'] },
    { id: '11-feldnotiz', name: 'Feldnotiz', file: '11-feldnotiz', desc: 'Mix 01+02+07+08, sanft: Botanik traegt.', sw: ['#f4efe0', '#2f4030', '#b5643c', '#4a6f8a', '#d9cfb4'] },
    { id: '12-herbarium', name: 'Herbarium', file: '12-herbarium', desc: 'Mix 01+02+07+08, ausgewogen und warm.', sw: ['#f0ebdc', '#2f4f3a', '#b0603a', '#4a6f8a', '#1d3b5c'] },
    { id: '13-feldlabor', name: 'Feldlabor', file: '13-feldlabor', desc: 'Mix 01+02+07+08, krassig: Plan um Papier.', sw: ['#0e2c4c', '#f7f1e2', '#b0603a', '#7fd4ff', '#2f4f3a'] },
    { id: '14-werkbank', name: 'Werkbank', file: '14-werkbank', desc: 'Mix 01+02+07+08, komplett dunkel und warm.', sw: ['#07120c', '#0e1a12', '#e8a15c', '#8fb98a', '#c96f4a'] },
    { id: '15-werkstattpapier', name: 'Werkstattpapier', file: '15-werkstattpapier', desc: 'Mix 01+02+07+08, handwerklich und hell.', sw: ['#fff6d9', '#3f5c3a', '#e2574c', '#2a6f97', '#f0d9a8'] }
  ];

  function byId(id) {
    for (var i = 0; i < LIST.length; i++) if (LIST[i].id === id) return LIST[i];
    return null;
  }

  function readStore(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeStore(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* privatmodus: nur Session */ }
  }

  function savedTheme() {
    var v = readStore(STORE);
    return v && byId(v) ? v : 'papier';
  }
  function savedScheme() {
    var v = readStore(STORE_SCHEME);
    return v === 'light' || v === 'dark' ? v : 'auto';
  }

  /* ---------- URL-Parameter -------------------------------------------
   * ?theme=<id>&scheme=hell|dunkel setzt das Theme nur fuer diesen
   * Seitenaufruf, ohne es zu speichern. Damit laesst sich ein Design
   * verlinken und ansehen, ohne die eigene Auswahl zu veraendern – und
   * so lassen sich die Themes pruefen. */
  function params() {
    var q = {};
    try {
      (location.search || '').replace(/^\?/, '').split('&').forEach(function (pair) {
        if (!pair) return;
        var i = pair.indexOf('=');
        var k = i < 0 ? pair : pair.slice(0, i);
        var v = i < 0 ? '' : pair.slice(i + 1);
        try { q[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) {}
      });
    } catch (e) {}
    return q;
  }
  function paramTheme() {
    var v = params().theme;
    return v && byId(v) ? v : null;
  }
  function paramScheme() {
    var v = (params().scheme || '').toLowerCase();
    if (v === 'hell' || v === 'light') return 'light';
    if (v === 'dunkel' || v === 'dark') return 'dark';
    if (v === 'auto' || v === 'system') return 'auto';
    return null;
  }

  /* ---------- Stylesheets einschleusen ------------------------------- */
  function ensureLink(rel, href, id) {
    var el = document.getElementById(id);
    if (el && el.getAttribute('href') === href) return el;
    if (!el) {
      el = document.createElement('link');
      el.id = id;
      el.rel = rel;
      /* Vor styles.css haetten die Theme-Regeln keine Wirkung – der Knoten
       * wird deshalb ans Ende des <head> gehaengt. */
      document.head.appendChild(el);
    }
    el.setAttribute('href', href);
    return el;
  }

  function dropLink(id) {
    var el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function base() {
    /* Vom <base> bzw. vom aktuellen Verzeichnis ausgehen: die App laeuft
     * sowohl unter / als auch in einem Unterordner. */
    var b = document.querySelector('base[href]');
    if (b && b.href) return b.href;
    var path = location.pathname;
    var dir = path.slice(0, path.lastIndexOf('/') + 1);
    return dir || './';
  }

  function applyTheme(id, opts) {
    var t = byId(id) || byId('papier');
    var root = document.documentElement;

    /* Der Adapter gehoert zu den 15 Design-Themen. Beim Standard-Design
     * "Papier" wuerde er den Look von css/styles.css veraendern, deshalb
     * wird er dort nicht geladen (und wieder entfernt, falls er von einem
     * Design-Thema her noch im Dokument haengt). */
    if (t.noAdapter) dropLink('fw-theme-shared');
    else ensureLink('stylesheet', base() + SHARED, 'fw-theme-shared');
    ensureLink('stylesheet', base() + THEMES_DIR + t.file + '.css', 'fw-theme-css');
    root.setAttribute('data-theme', t.id);

    if (!opts || opts.persist !== false) {
      writeStore(STORE, t.id);
      /* Das Standard-Theme ist die Voreinstellung: dann den Schluessel
       * wegraeumen, damit spaeter neu ausgelieferte Standards greifen. */
      if (t.id === 'papier') { try { localStorage.removeItem(STORE); } catch (e) {} }
    }
    syncButton();
    dispatch();
    return t;
  }

  /* 'auto' wird hier aufgeloest und IMMER als data-scheme="light"|"dark"
   * gesetzt. Grund: styles.css reagiert nur auf prefers-color-scheme, die
   * Theme-Dateien auf data-scheme. Ohne Attribut wuerde die Theme-Datei gar
   * nicht greifen. Beide Ausdruecke liefern dasselbe Ergebnis, wir haben
   * also genau eine Quelle fuer "hell oder dunkel". */
  function systemDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function resolveScheme(s) {
    if (s === 'light' || s === 'dark') return s;
    return systemDark() ? 'dark' : 'light';
  }
  function applyScheme(s) {
    writeStore(STORE_SCHEME, s === 'light' || s === 'dark' ? s : 'auto');
    document.documentElement.setAttribute('data-scheme', resolveScheme(s));
    syncButton();
    dispatch();
  }

  /* Folgt das System, solange der Nutzer nichts erzwungen hat. */
  function watchSystem() {
    if (!window.matchMedia) return;
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () {
      if (activeScheme() !== 'auto') return;
      document.documentElement.setAttribute('data-scheme', systemDark() ? 'dark' : 'light');
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  /* ---------- URL-Parameter schlaegen die gespeicherte Auswahl -------- */
  function activeTheme() {
    return paramTheme() || savedTheme();
  }
  function activeScheme() {
    var p = paramScheme();
    return p || savedScheme();
  }

  var listeners = [];
  function dispatch() {
    var s = current();
    listeners.forEach(function (fn) { try { fn(s); } catch (e) {} });
  }

  function current() {
    var root = document.documentElement;
    return {
      id: root.getAttribute('data-theme') || 'papier',
      /* Die Nutzerwahl; 'auto' heisst "wie das System". */
      scheme: activeScheme(),
      /* Was gerade wirklich aktiv ist. */
      effectiveScheme: root.getAttribute('data-scheme') || 'light'
    };
  }

  /* ---------- Knopf in der Kopfzeile ---------------------------------- */
  var btn = null;
  function syncButton() {
    if (!btn) return;
    var t = byId(current().id) || byId('papier');
    var sc = current().scheme;
    btn.textContent = '\uD83C\uDFA8 ' + t.name + (sc === 'auto' ? '' : sc === 'dark' ? ' \u25D1' : ' \u25D0');
    btn.title = 'Design wechseln (aktuell: ' + t.name + ')';
  }

  function mountButton() {
    if (btn) return;
    /* Die Kopfzeile hat keine eigene id, deshalb ueber die Klasse. Fehlt sie
     * (z. B. present.html), faellt das Theme-Schaltflaeche einfach weg. */
    var host = document.querySelector('.header-buttons');
    if (!host) return;
    var wrap = document.createElement('div');
    wrap.className = 'header-group';
    btn = document.createElement('button');
    btn.className = 'mini-button fw-theme-btn';
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.addEventListener('click', function () { openPicker(); });
    wrap.appendChild(btn);
    host.appendChild(wrap);
    syncButton();
  }

  /* ---------- Auswahl-Dialog ------------------------------------------
   * Nutzt bewusst die vorhandenen Klassen aus styles.css
   * (.editor-overlay/.editor-modal), damit der Dialog in jedem Theme
   * ohne eigenes CSS mitgeht. */
  var modal = null;

  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'editor-overlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Design wählen');
    modal.innerHTML =
      '<div class="editor-modal fw-theme-modal">' +
        '<div class="editor-header"><div class="editor-header-title">Design wählen</div>' +
        '<button class="mini-button fw-theme-close" aria-label="Schließen">✕</button></div>' +
        '<div class="fw-theme-body"></div>' +
        '<div class="editor-footer"><button class="mini-button fw-theme-close">Fertig</button></div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function (ev) { if (ev.target === modal) closePicker(); });
    modal.querySelectorAll('.fw-theme-close').forEach(function (b) {
      b.addEventListener('click', closePicker);
    });
    return modal;
  }

  function swatches(t) {
    return '<span class="fw-theme-sw">' + t.sw.map(function (c) {
      return '<i style="background:' + c + '"></i>';
    }).join('') + '</span>';
  }

  function render() {
    var body = ensureModal().querySelector('.fw-theme-body');
    var cur = current().id;
    var sch = activeScheme();

    var schemeRow = '<div class="fw-theme-schemes" role="group" aria-label="Helligkeit">' +
      [['auto', 'Wie das System'], ['light', 'Hell'], ['dark', 'Dunkel']].map(function (p) {
        return '<button class="mini-button fw-theme-scheme' + (sch === p[0] ? ' picked' : '') +
          '" data-scheme="' + p[0] + '">' + p[1] + '</button>';
      }).join('') + '</div>';

    body.innerHTML = schemeRow +
      '<div class="fw-theme-list">' + LIST.map(function (t) {
        return '<button class="fw-theme-item' + (t.id === cur ? ' picked' : '') + '" data-theme-id="' + t.id + '">' +
          swatches(t) +
          '<span class="fw-theme-meta"><span class="fw-theme-name">' + t.name + '</span>' +
          '<span class="fw-theme-desc">' + t.desc + '</span></span></button>';
      }).join('') + '</div>';

    body.querySelectorAll('[data-theme-id]').forEach(function (b) {
      b.addEventListener('click', function () {
        applyTheme(b.getAttribute('data-theme-id'));
        /* Neu zeichnen: sonst bliebe die Auswahlmarkierung auf dem
         * previously geklickten Feld stehen. Ausserdem wartet das gerade
         * nachgeladene Stylesheet erst noch auf den Abruf. */
        setTimeout(render, 60);
      });
    });
    body.querySelectorAll('[data-scheme]').forEach(function (b) {
      b.addEventListener('click', function () {
        applyScheme(b.getAttribute('data-scheme'));
        render();
      });
    });
  }

  function openPicker() {
    render();
    ensureModal().classList.add('active');
    var first = ensureModal().querySelector('.fw-theme-item.picked');
    if (first) first.focus();
  }
  function closePicker() {
    if (modal) modal.classList.remove('active');
  }
  function togglePicker() {
    if (modal && modal.classList.contains('active')) closePicker();
    else openPicker();
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && modal && modal.classList.contains('active')) closePicker();
  });

  /* ---------- oeffentliche API ---------------------------------------- */
  window.FederwerkThemes = {
    list: function () { return LIST.slice(); },
    current: current,
    apply: function (id) { return applyTheme(id); },
    setScheme: applyScheme,
    openPicker: openPicker,
    togglePicker: togglePicker,
    closePicker: closePicker,
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    /* Nur zum Testen/Verlinken: erzwingt Theme bzw. Helligkeit fuer die
     * aktuelle Seite, ohne in den localStorage zu schreiben. */
    preview: function (id, scheme) {
      if (id !== undefined && byId(id)) applyTheme(id, { persist: false });
      document.documentElement.setAttribute('data-scheme', resolveScheme(scheme === undefined ? 'auto' : scheme));
      syncButton();
      dispatch();
    }
  };

  /* ---------- Boot (laeuft synchron im <head>) ----------------------- */
  applyTheme(activeTheme(), { persist: false });
  document.documentElement.setAttribute('data-scheme', resolveScheme(activeScheme()));
  watchSystem();

  /* Knopf + Eigenes Styling erst nach dem Parsen: beides ist optional,
   * damit diese Datei auch in present.html/agent.html harmlos laeuft. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountButton);
  } else {
    mountButton();
  }
})();
