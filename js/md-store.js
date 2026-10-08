/* Federwerk Markdown-Editor - Dokumente (js/md-store.js)
 *
 * Eigene, winzige Persistenz fuer die Markdown-Seite: die Notizbuch-Daten in
 * js/store.js gehoeren zu den Seiten/Buechern der App, Markdown-Dateien sind
 * ein eigener Typ (nur Quelle + Titel, keine Strokes, keine Seitenbilder) und
 * sollen nicht im Buch-Export auftauchen.
 *
 * - IndexedDB `fw-md`, Store `docs` (keyPath id, Index updatedAt).
 * - localStorage als Rueckfall (privater Modus / sehr alter Browser): das
 *   5-MB-Limit gilt hier kaum, Markdown ist klein.
 * - Im Speicher (`_setForceMemory`) fuer Tests ohne Browser-DB.
 */
var FederwerkMarkdownStore = (function () {
  'use strict';

  var DB_NAME = 'fw-md';
  var DB_VER = 1;
  var DOCS = 'docs';
  var LS_KEY = 'fw-md-docs-v1';
  var LS_CURRENT = 'fw-md-current';
  var mem = new Map();
  var forceMemory = false;
  var dbPromise = null;
  var listeners = [];

  function hasIdb() {
    try { return typeof indexedDB !== 'undefined' && !!indexedDB; }
    catch (e) { return false; }
  }
  function useDb() { return hasIdb() && !forceMemory; }

  function openDb() {
    if (dbPromise) return dbPromise;
    if (!useDb()) return (dbPromise = Promise.resolve(null));
    dbPromise = new Promise(function (resolve) {
      try {
        var req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(DOCS)) {
            var os = db.createObjectStore(DOCS, { keyPath: 'id' });
            if (os.createIndex) os.createIndex('updatedAt', 'updatedAt');
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
    return dbPromise;
  }

  function idbReq(req) {
    return new Promise(function (res, rej) {
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
  }

  /* ---------- localStorage-Spiegel ---------- */
  function readLs() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function writeLs(list) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch (e) { /* voll: DB traegt */ }
  }

  /* ---------- reine Helfer ---------- */
  function normalize(doc) {
    if (!doc || typeof doc !== 'object') return null;
    var id = String(doc.id || '');
    if (!id) return null;
    return {
      id: id,
      title: String(doc.title == null ? '' : doc.title).slice(0, 200),
      source: String(doc.source == null ? '' : doc.source),
      createdAt: Number(doc.createdAt) || Date.now(),
      updatedAt: Number(doc.updatedAt) || Number(doc.createdAt) || Date.now()
    };
  }

  /* Neueste zuerst, Titel alphabetisch als Ruecksortierung. */
  function sortDocs(list) {
    return (Array.isArray(list) ? list.slice() : []).sort(function (a, b) {
      var d = (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
      if (d) return d;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
  }

  function newId() {
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function makeDoc(title, source) {
    var now = Date.now();
    return { id: newId(), title: String(title || 'Ohne Titel'), source: String(source || ''), createdAt: now, updatedAt: now };
  }

  /* ---------- Lesen/Schreiben ---------- */
  async function list() {
    var docs;
    if (useDb()) {
      var db = await openDb();
      if (db) {
        try { docs = await idbReq(db.transaction(DOCS, 'readonly').objectStore(DOCS).getAll()); }
        catch (e) { docs = null; }
      }
      if (!docs) docs = readLs();
    } else if (forceMemory) {
      docs = Array.from(mem.values());
    } else {
      docs = readLs();
    }
    return sortDocs((docs || []).map(normalize).filter(Boolean));
  }

  async function get(id) {
    if (!id) return null;
    if (useDb()) {
      var db = await openDb();
      if (db) {
        try { return normalize(await idbReq(db.transaction(DOCS, 'readonly').objectStore(DOCS).get(id))); }
        catch (e) { /* dann localStorage */ }
      }
      var all = readLs();
      for (var i = 0; i < all.length; i++) if (all[i] && all[i].id === id) return normalize(all[i]);
      return null;
    }
    if (forceMemory) return normalize(mem.get(id)) || null;
    var ls = readLs();
    for (var k = 0; k < ls.length; k++) if (ls[k] && ls[k].id === id) return normalize(ls[k]);
    return null;
  }

  async function put(doc) {
    var clean = normalize(doc);
    if (!clean) return null;
    if (useDb()) {
      var db = await openDb();
      if (db) {
        try {
          await idbReq(db.transaction(DOCS, 'readwrite').objectStore(DOCS).put(clean));
          /* Spiegel pflegen: ohne IndexedDB (oder nach einem Datenbank-Reset)
           * waeren die Dokumente sonst weg. Fehlschlaege sind erlaubt. */
          var all = readLs().filter(function (d) { return d && d.id !== clean.id; });
          all.push(clean);
          writeLs(all);
          notify();
          return clean;
        } catch (e) { /* auf localStorage zurueckfallen */ }
      }
    } else if (forceMemory) {
      mem.set(clean.id, clean);
      notify();
      return clean;
    }
    var list2 = readLs().filter(function (d) { return d && d.id !== clean.id; });
    list2.push(clean);
    writeLs(list2);
    notify();
    return clean;
  }

  async function remove(id) {
    if (!id) return false;
    if (useDb()) {
      var db = await openDb();
      if (db) {
        try { await idbReq(db.transaction(DOCS, 'readwrite').objectStore(DOCS).delete(id)); } catch (e) { /* ignore */ }
      }
    } else if (forceMemory) {
      mem.delete(id);
    }
    writeLs(readLs().filter(function (d) { return d && d.id !== id; }));
    if (currentId() === id) setCurrentId(null);
    notify();
    return true;
  }

  /* Anlegen: legt ein leeres Dokument an und speichert es sofort. */
  async function create(title, source) {
    var doc = makeDoc(title, source);
    await put(doc);
    setCurrentId(doc.id);
    return doc;
  }

  async function rename(id, title) {
    var doc = await get(id);
    if (!doc) return null;
    doc.title = String(title == null ? '' : title).slice(0, 200);
    doc.updatedAt = Date.now();
    return put(doc);
  }

  async function duplicate(id) {
    var doc = await get(id);
    if (!doc) return null;
    var copy = makeDoc(doc.title + ' (Kopie)', doc.source);
    await put(copy);
    return copy;
  }

  function currentId() {
    try { return localStorage.getItem(LS_CURRENT) || null; } catch (e) { return null; }
  }
  function setCurrentId(id) {
    try {
      if (id) localStorage.setItem(LS_CURRENT, String(id));
      else localStorage.removeItem(LS_CURRENT);
    } catch (e) { /* ignore */ }
    notify();
  }

  function subscribe(fn) { if (typeof fn === 'function') listeners.push(fn); }
  function notify() {
    listeners.slice().forEach(function (fn) { try { fn(); } catch (e) { /* ein Abonnent darf die anderen nicht blockieren */ } });
  }

  /* Beim Start: ein Dokument anlegen, wenn noch keins existiert (leeres
   * Blatt mit einem Beispiel, damit die Live-Vorschau sofort etwas zeigt). */
  var WELCOME = [
    '# Willkommen im Markdown-Editor',
    '',
    'Hier wird **Markdown** direkt getippt - die Vorschau ist das Dokument selbst.',
    'Die Zeichen `**`, `##` und `[[ ]]` verstecken sich, sobald der Cursor woanders ist.',
    '',
    '## Was geht',
    '',
    '- [ ] Checkliste: Kästchen anklicken (offen -> erledigt -> halb)',
    '- [x] Aufgaben, **fett**, *kursiv*, ~~durchgestrichen~~, `Code`',
    '- [ ] Tabellen, Zitate und verschachtelte Listen',
    '',
    '| Taste | Wirkung |',
    '| --- | --- |',
    '| Strg+E | zwischen Live-Ansicht und Quelltext |',
    '| Strg+S | speichern (passiert auch automatisch) |',
    '',
    '> [!note] Callout',
    '> So sehen Hinweise aus. Quelle: `> [!note] Titel`.',
    '',
    '[[Wikilink]] zeigt auf ein anderes Dokument, ![[bild.png|300]] bindet ein Bild ein.',
    '',
    '```js',
    '// Codeblock mit Syntaxhervorhebung beim Lesen',
    'const grimoire = "Federwerk";',
    '```',
    ''
  ].join('\n');

  async function init() {
    var docs = await list();
    if (!docs.length) {
      var doc = await create('Willkommen im Markdown-Editor', WELCOME);
      return doc;
    }
    var cur = currentId();
    for (var i = 0; i < docs.length; i++) if (docs[i].id === cur) return docs[i];
    setCurrentId(docs[0].id);
    return docs[0];
  }

  return {
    init: init,
    list: list,
    get: get,
    put: put,
    create: create,
    rename: rename,
    duplicate: duplicate,
    remove: remove,
    currentId: currentId,
    setCurrentId: setCurrentId,
    subscribe: subscribe,
    welcome: WELCOME,
    _internals: {
      normalize: normalize,
      sortDocs: sortDocs,
      makeDoc: makeDoc,
      newId: newId,
      _setForceMemory: function (v) { forceMemory = !!v; },
      _reset: function () { mem.clear(); dbPromise = null; listeners.length = 0; }
    }
  };
})();

if (typeof window !== 'undefined') window.FederwerkMarkdownStore = FederwerkMarkdownStore;
if (typeof module !== 'undefined' && module.exports) module.exports = FederwerkMarkdownStore;