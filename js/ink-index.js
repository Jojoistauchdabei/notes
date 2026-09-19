/* Federwerk SPEC-31 light/offline – getippter-Text-Index, kein Fake-OCR.
 *
 * Ehrlichkeit zuerst: echte Handschrift-Erkennung (HTR) ist ohne Modell/Cloud
 * nicht machbar. Dieses Modul behauptet daher NIE, Handschrift zu erkennen.
 * Es indexiert ausschließlich GETIPPTEN Text aus Textboxen (page.texts[].html)
 * plus Titel und #Tags. Stroke-Daten (Handschrift) fließen nur als Anzahl
 * (strokeCount) ein, nie als Treffer.
 *
 * - Rein DOM-frei (kein Zugriff auf Browser-APIs außer einem gegardeten
 *   typeof-Check für Export + navigator.language). Lädt per
 *   plain <script> vor app.js (global GrimoireInkIndex) und per require()
 *   in Node-Tests. Keine Dependencies, kein Cloud, kein Eval.
 * - HTR-Andockpunkt (später, z. B. MyScript-ähnlich):
 *     GrimoireInkIndex.registerHtrProvider('myscript', async (page) => [...woerter]);
 *   Solange KEIN Provider registriert ist, gilt isHtrAvailable() === false und
 *   die UI zeigt HTR_UNAVAILABLE_MSG
 *   („HSR nicht verfügbar (V1: nur getippter Text durchsuchbar)").
 *   queryHtr() ohne Provider löst ehrlich zu [] auf (keine Fake-Treffer).
 * - Suchsprache pro Buch: book.lang (Basis-Code, z. B. „de"), Default aus
 *   navigator.language, Fallback „de". Umstellung später im Buch-Dialog
 *   (z. B. <select>), aktuell per setBookLang(book, lang) – bewusst kein
 *   UI-Bruch in V1.
 */
(function () {
  'use strict';

  var HTR_UNAVAILABLE_MSG = 'HSR nicht verfügbar (V1: nur getippter Text durchsuchbar)';

  /* ---------- HTML -> Text ohne DOM ---------- */
  function decodeEntities(s) {
    return String(s)
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0*39;|&#x27;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, function (m, n) {
        try { return String.fromCharCode(parseInt(n, 10)); } catch (e) { return m; }
      })
      .replace(/&#x([0-9a-fA-F]+);/g, function (m, n) {
        try { return String.fromCharCode(parseInt(n, 16)); } catch (e) { return m; }
      })
      // absichtlich zuletzt (kein Doppel-Dekodieren)
      .replace(/&amp;/g, '&');
  }

  // stripHtml-Kopie ohne DOM (für buildPageText aus texts[].html).
  // Bildet <li> auf „- " und Task-Checkboxen (<input data-marker>) auf
  // „[ ]"/„[x]" ab, damit extractTasks auch Editor-HTML ehrlich zählt
  // (reines Strippen würde Marker/Bullets verlieren und 0 liefern).
  function stripHtml(h) {
    if (h == null) return '';
    var s = String(h);
    s = s.replace(/<input[^>]*>/gi, function (im) {
      var dm = /data-marker="([ xX\/])"/.exec(im);
      var mk = dm ? dm[1].toLowerCase() : (/checked/i.test(im) ? 'x' : ' ');
      if (mk === 'X') mk = 'x';
      return '[' + mk + '] ';
    });
    s = s.replace(/<li[^>]*>/gi, '- ');
    s = s.replace(/<(br|hr)[^>]*>/gi, '\n');
    s = s.replace(/<\/(p|div|li|ul|ol|h[1-6]|blockquote|section|article|header|footer|tr)[^>]*>/gi, '\n');
    s = s.replace(/<[^>]*>/g, '');
    s = decodeEntities(s);
    return s.replace(/\r\n?/g, '\n');
  }

  // Plain-Text einer Seite aus allen Textboxen (leere Boxen werden übersprungen)
  function buildPageText(page) {
    if (!page || !Array.isArray(page.texts)) return '';
    var parts = [];
    for (var i = 0; i < page.texts.length; i++) {
      var t = page.texts[i];
      var html = (t && typeof t.html === 'string') ? t.html
        : (typeof t === 'string' ? t : '');
      var txt = stripHtml(html).trim();
      if (txt) parts.push(txt);
    }
    return parts.join('\n');
  }

  function buildBookText(book) {
    if (!book || !Array.isArray(book.pages)) return '';
    var parts = [];
    for (var i = 0; i < book.pages.length; i++) {
      var t = buildPageText(book.pages[i]);
      if (t) parts.push(t);
    }
    return parts.join('\n');
  }

  /* ---------- Tags: #tag, nested a/b ---------- */
  // - Führendes # braucht Wortgrenze (kein a#b, keine E-Mail).
  // - Erstes Zeichen: Buchstabe/Umlaut/_ (keine reinen Zahlen wie „#1").
  // - Nested: „#quest/haupt" ist EIN Tag „quest/haupt" (Eltern nicht extra).
  // - Rückgabe: kleingeschrieben, ohne #, Duplikate raus, sortiert.
  var TAG_RE = /(^|[\s\(\[\{>"'“„‚«])#([A-Za-z_äöüÄÖÜß][A-Za-z0-9_äöüÄÖÜß\-]*(?:\/[A-Za-z0-9_äöüÄÖÜß][A-Za-z0-9_äöüÄÖÜß\-]*)*)/g;

  function extractTags(text) {
    if (text == null) return [];
    var src = String(text);
    var seen = Object.create(null);
    var m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(src)) !== null) {
      var raw = m[2] || '';
      // hängende Bindestriche je Segment entfernen („#tag-" -> „tag")
      var cleaned = raw.split('/').map(function (seg) {
        return seg.replace(/-+$/g, '');
      }).filter(function (seg) { return !!seg; }).join('/');
      if (!cleaned) continue;
      seen[cleaned.toLowerCase()] = true;
    }
    return Object.keys(seen).sort();
  }

  /* ---------- Tasks: offen/erledigt zählen ---------- */
  // Erwartet Plain-/Markdown-Text (z. B. aus buildPageText): „- [ ]" offen,
  // „- [x]/[X]" erledigt. „- [/]" (halb) wird bewusst ignoriert (weder/noch).
  // Hinweis: Editor-HTML-Tasklisten verlieren beim Strippen den Marker
  // (<input>), zählen dann ehrlich 0 – kein Raten.
  var TASK_RE = /^\s*(?:[-*+]|\d+[.)])\s*\[([ xX])\]/;

  function extractTasks(text) {
    if (text == null) return { open: 0, done: 0 };
    var lines = String(text).split('\n');
    var open = 0, done = 0;
    for (var i = 0; i < lines.length; i++) {
      var m = TASK_RE.exec(lines[i]);
      if (!m) continue;
      if (m[1] === ' ') open++;
      else if (m[1] === 'x' || m[1] === 'X') done++;
    }
    return { open: open, done: done };
  }

  /* ---------- Suchsprache pro Buch ---------- */
  function defaultLang() {
    try {
      if (typeof navigator !== 'undefined' && navigator &&
          typeof navigator.language === 'string' && navigator.language.trim()) {
        var base = navigator.language.trim().split(/[-_]/)[0].toLowerCase();
        if (/^[a-z]{2,3}$/.test(base)) return base;
      }
    } catch (e) { /* ignore -> Fallback */ }
    return 'de';
  }

  function getBookLang(book) {
    if (book && typeof book.lang === 'string') {
      var raw = book.lang.trim();
      if (raw) {
        var base = raw.split(/[-_]/)[0].toLowerCase();
        if (/^[a-z]{2,3}$/.test(base)) return base;
      }
    }
    return defaultLang();
  }

  // Setzt book.lang (Basis-Code, kleingeschrieben). Ungültiges -> keine
  // Änderung, Rückgabe ist die geltende Sprache.
  function setBookLang(book, lang) {
    if (!book || typeof book !== 'object') return defaultLang();
    if (typeof lang !== 'string') return getBookLang(book);
    var base = lang.trim().split(/[-_]/)[0].toLowerCase();
    if (!/^[a-z]{2,3}$/.test(base)) return getBookLang(book);
    book.lang = base;
    return base;
  }

  /* ---------- Buch-Index (Kennzahlen, kein Volltext-Dump) ---------- */
  function indexBook(book) {
    var b = book || {};
    var pages = Array.isArray(b.pages) ? b.pages : [];
    var title = (typeof b.title === 'string' && b.title) ? b.title : 'Unbenannt';
    var strokeCount = 0;
    var textParts = [];
    var seen = Object.create(null);
    var tasksOpen = 0, tasksDone = 0;
    for (var i = 0; i < pages.length; i++) {
      var p = pages[i] || {};
      if (Array.isArray(p.strokes)) strokeCount += p.strokes.length;
      var t = buildPageText(p);
      if (t) textParts.push(t);
      var tags = extractTags(t);
      for (var j = 0; j < tags.length; j++) seen[tags[j]] = true;
      var tk = extractTasks(t);
      tasksOpen += tk.open;
      tasksDone += tk.done;
    }
    var combined = textParts.join('\n');
    return {
      title: title,
      pageCount: pages.length,
      strokeCount: strokeCount,
      tags: Object.keys(seen).sort(),
      tasksOpen: tasksOpen,
      tasksDone: tasksDone,
      textLen: combined.length,
      updatedAt: (typeof b.updatedAt === 'number') ? b.updatedAt : 0,
      lang: getBookLang(b),
    };
  }

  /* ---------- HTR-Provider-Registry (Hook, default: leer) ---------- */
  var htrProviders = Object.create(null);

  function registerHtrProvider(name, fn) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('registerHtrProvider: name erforderlich');
    if (typeof fn !== 'function') throw new Error('registerHtrProvider: fn muss eine Funktion sein');
    var key = name.trim();
    htrProviders[key] = fn;
    return key;
  }

  function unregisterHtrProvider(name) {
    var key = String(name || '').trim();
    if (key && Object.prototype.hasOwnProperty.call(htrProviders, key)) {
      delete htrProviders[key];
      return true;
    }
    return false;
  }

  function getHtrProviderNames() {
    return Object.keys(htrProviders);
  }

  function isHtrAvailable() {
    return Object.keys(htrProviders).length > 0;
  }

  // Ehrliche Abfrage: ohne Provider -> [] (keine Fake-Treffer). Fehler im
  // Provider -> [] statt Crash. Rückgabe: nur nicht-leere Strings.
  function queryHtr(page, name) {
    var fn = null;
    if (typeof name === 'string' && name.trim() &&
        Object.prototype.hasOwnProperty.call(htrProviders, name.trim())) {
      fn = htrProviders[name.trim()];
    } else {
      var keys = Object.keys(htrProviders);
      if (keys.length) fn = htrProviders[keys[0]];
    }
    if (!fn) return Promise.resolve([]);
    try {
      return Promise.resolve(fn(page)).then(function (v) {
        if (!Array.isArray(v)) return [];
        return v.filter(function (x) { return typeof x === 'string' && !!x; });
      }, function () { return []; });
    } catch (e) {
      return Promise.resolve([]);
    }
  }

  function _resetHtrProviders() {
    for (var k in htrProviders) {
      if (Object.prototype.hasOwnProperty.call(htrProviders, k)) delete htrProviders[k];
    }
  }

  /* ---------- Suche über Titel + getippten Text + Tags ---------- */
  function effectiveQuery(q) {
    var norm = String(q == null ? '' : q).trim().toLowerCase();
    if (!norm) return '';
    var eff = norm.replace(/^#+/, '').trim();
    return eff;
  }

  // null = kein Treffer; sonst { kind: 'title'|'tag'|'text', snippet }.
  // Priorität: Titel > Tag > Text (nur getippter Text, nie Handschrift).
  function matchBook(book, query) {
    var eff = effectiveQuery(query);
    if (!eff) return { kind: 'none', snippet: '' };
    var b = book || {};
    var title = (typeof b.title === 'string') ? b.title : '';
    if (title.toLowerCase().indexOf(eff) !== -1) {
      return { kind: 'title', snippet: title.slice(0, 120) };
    }
    var pages = Array.isArray(b.pages) ? b.pages : [];
    var combined = [];
    var tagHit = null;
    for (var i = 0; i < pages.length; i++) {
      var t = buildPageText(pages[i]);
      if (!t) continue;
      combined.push(t);
      if (!tagHit) {
        var tags = extractTags(t);
        for (var j = 0; j < tags.length; j++) {
          if (tags[j].indexOf(eff) !== -1) { tagHit = tags[j]; break; }
        }
      }
    }
    if (tagHit) return { kind: 'tag', snippet: '#' + tagHit };
    var full = combined.join('\n');
    var at = full.toLowerCase().indexOf(eff);
    if (at !== -1) {
      var start = Math.max(0, at - 30);
      var end = Math.min(full.length, at + eff.length + 30);
      var snippet = full.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 120);
      return { kind: 'text', snippet: snippet };
    }
    return null;
  }

  function searchBooks(books, query) {
    if (!Array.isArray(books)) return [];
    var raw = String(query == null ? '' : query).trim();
    if (!raw) {
      return books.map(function (b) { return { book: b, match: 'none', snippet: '' }; });
    }
    var out = [];
    for (var i = 0; i < books.length; i++) {
      var m = matchBook(books[i], raw);
      if (m) out.push({ book: books[i], match: m.kind, snippet: m.snippet });
    }
    return out;
  }

  var api = {
    HTR_UNAVAILABLE_MSG: HTR_UNAVAILABLE_MSG,
    stripHtml: stripHtml,
    buildPageText: buildPageText,
    buildBookText: buildBookText,
    extractTags: extractTags,
    extractTasks: extractTasks,
    defaultLang: defaultLang,
    getBookLang: getBookLang,
    setBookLang: setBookLang,
    indexBook: indexBook,
    matchBook: matchBook,
    searchBooks: searchBooks,
    registerHtrProvider: registerHtrProvider,
    unregisterHtrProvider: unregisterHtrProvider,
    getHtrProviderNames: getHtrProviderNames,
    isHtrAvailable: isHtrAvailable,
    queryHtr: queryHtr,
    _resetHtrProviders: _resetHtrProviders,
  };

  if (typeof window !== 'undefined') window.GrimoireInkIndex = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
