/* Grimoire Cloud – Option 1: WebDAV (Nextcloud/ownCloud), 100% Browser, kein eigener Server.
 *
 * Warum das im Browser geht:
 * WebDAV ist nur HTTP (GET/PUT/DELETE/MKCOL/PROPFIND). fetch() kann das alles.
 * Kein Build, kein Proxy nötig. Einzige Voraussetzung: der Cloud-Server muss
 * CORS für deine Grimoire-URL erlauben (siehe Hinweise im Einstellungs-Dialog).
 *
 * Datei-Layout in der Cloud (ein Ordner, ein JSON pro Buch):
 *   <baseUrl>/<folder>/grimoire-index.json
 *   <baseUrl>/<folder>/<bookId>.json
 *
 * Sync-Strategie v1: Last-Write-Wins pro Buch anhand updatedAt.
 * Lokal bleibt Master (localStorage), Cloud ist Backup + Geräte-Sync.
 */
(function () {
  'use strict';

  const CFG_KEY = 'grimoire-cloud-v1';
  const MAP_KEY = 'grimoire-cloud-map-v1'; // bookId -> { file, remoteUpdatedAt, lastSync }

  const Cloud = {
    get config() { return loadConfig(); },
    loadConfig, saveConfig, clearConfig, isConfigured,
    testConnection, ensureFolder,
    pushBook, pullBook, deleteRemoteBook, deleteRemoteBookById, forgetLocalBook,
    pushAll, pullAll, syncAll, pruneMap,
    listRemoteFiles, bookFileName, parsePropfind,
    joinUrl, normalizeBaseUrl, sanitize,
    isSyncing() { return syncInProgress; },
    _internals: {},
  };
  Cloud._internals = { loadMap, saveMap, folderUrl, authHeader, resolveFile, decideBook, checkHttp };

  /* ---------- Config ---------- */
  function defaultConfig() {
    return { baseUrl: '', username: '', password: '', folder: 'Grimoire', autoSync: false };
  }
  function loadConfig() {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      if (!raw) return defaultConfig();
      return Object.assign(defaultConfig(), JSON.parse(raw));
    } catch { return defaultConfig(); }
  }
  function saveConfig(cfg) {
    localStorage.setItem(CFG_KEY, JSON.stringify(Object.assign(defaultConfig(), cfg)));
  }
  function clearConfig() {
    localStorage.removeItem(CFG_KEY);
    localStorage.removeItem(MAP_KEY);
  }
  function isConfigured() {
    const c = loadConfig();
    return !!(c.baseUrl && c.username && c.password);
  }
  function loadMap() {
    try { return JSON.parse(localStorage.getItem(MAP_KEY) || '{}'); }
    catch { return {}; }
  }
  function saveMap(m) { localStorage.setItem(MAP_KEY, JSON.stringify(m)); }

  /* ---------- URL / Auth-Helfer (rein, testbar) ---------- */
  function normalizeBaseUrl(u) {
    u = String(u || '').trim().replace(/\/+$/, '');
    // Typische Nextcloud-Eingaben tolerieren:
    // "https://cloud.de" -> ".../remote.php/dav/files/USER" muss der User ergänzen,
    // wir hängen nichts automatisch an, nur trailing slash entfernen.
    return u;
  }
  function sanitize(s) {
    return String(s || 'buch').replace(/[^\wäöüÄÖÜß-]+/gi, '_').slice(0, 80) || 'buch';
  }
  function joinUrl() {
    const parts = Array.from(arguments).map((p, i) => {
      p = String(p || '');
      if (i === 0) return p.replace(/\/+$/, '');
      return p.replace(/^\/+|\/+$/g, '');
    }).filter(Boolean);
    return parts.join('/');
  }
  function folderUrl(cfg) {
    return joinUrl(normalizeBaseUrl(cfg.baseUrl), cfg.folder);
  }
  function bookFileName(book) {
    return sanitize(book.title) + '__' + book.id + '.json';
  }
  // Stabiler Dateiname: einmal vergeben, bei Rename wiederverwenden,
  // sonst bleiben bei jedem Umbenennen Leichen in der Cloud zurück.
  function resolveFile(book, map) {
    map = map || loadMap();
    if (map[book.id] && map[book.id].file) return map[book.id].file;
    // Fremdgerät-Fall: Datei mit passender __<id>.json-Endung wiederverwenden
    if (book._remoteFile) return book._remoteFile;
    return bookFileName(book);
  }
  // Konflikt-Entscheidung pro Buch (rein, testbar):
  // map.lastSyncLocal = lokale updatedAt beim letzten Sync (gemeinsamer Stand).
  // - nur remote geändert -> remote-newer (übernehmen)
  // - nur lokal geändert / nichts geändert -> same (lokal gewinnt ggf. per Push)
  // - beide geändert + remote neuer -> conflict (nichts überschreiben, Kopie anlegen)
  // - beide geändert + lokal neuer/gleich -> same (lokal gewinnt, Push löst auf)
  function decideBook(local, remote, mapEntry) {
    const rUp = (remote && remote.updatedAt) || 0;
    const lUp = (local && local.updatedAt) || 0;
    const last = (mapEntry && mapEntry.lastSyncLocal) || 0;
    if (!local) return 'remote-new';
    if (!remote) return 'local-only';
    if (rUp === lUp) return 'same';
    const remoteChanged = rUp > last;
    const localChanged = lUp > last;
    if (remoteChanged && !localChanged) return 'remote-newer';
    if (!remoteChanged) return 'same';
    if (!localChanged) return 'remote-newer';
    return rUp > lUp ? 'conflict' : 'same';
  }
  function authHeader(cfg) {
    // Basic Auth mit App-Passwort (Nextcloud: Einstellungen -> Sicherheit -> App-Passwörter)
    return 'Basic ' + btoa(unescape(encodeURIComponent(cfg.username + ':' + cfg.password)));
  }
  function headers(cfg, extra) {
    return Object.assign({ 'Authorization': authHeader(cfg) }, extra || {});
  }

  async function checkHttp(res, label) {
    if (res.ok) return res;
    let body = '';
    try { body = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    const err = new Error(label + ': HTTP ' + res.status + ' ' + res.statusText + (body ? ' – ' + body : ''));
    err.status = res.status;
    throw err;
  }

  /* ---------- WebDAV-Calls ---------- */
  async function ensureFolder(cfg) {
    cfg = cfg || loadConfig();
    // MKCOL legt genau einen Ordner an. Existiert er -> 405/409/301 = ok.
    const res = await fetch(folderUrl(cfg), { method: 'MKCOL', headers: headers(cfg) });
    if (res.status === 405 || res.status === 409 || res.status === 301 || res.ok) return true;
    await checkHttp(res, 'Ordner anlegen (MKCOL)');
    return true;
  }

  async function testConnection(cfg) {
    cfg = cfg || loadConfig();
    if (!cfg.baseUrl || !cfg.username || !cfg.password) {
      throw new Error('Bitte Server-URL, Benutzername und App-Passwort ausfüllen.');
    }
    await ensureFolder(cfg);
    // Schreibtest: kleine Datei hochladen, lesen, löschen.
    const probe = joinUrl(folderUrl(cfg), '.grimoire-probe.txt');
    const h = headers(cfg, { 'Content-Type': 'text/plain' });
    await checkHttp(await fetch(probe, { method: 'PUT', headers: h, body: 'grimoire-ok ' + new Date().toISOString() }), 'Schreibtest (PUT)');
    await checkHttp(await fetch(probe, { method: 'GET', headers: headers(cfg) }), 'Lesetest (GET)');
    await fetch(probe, { method: 'DELETE', headers: headers(cfg) }).catch(() => {});
    return true;
  }

  // PROPFIND Depth:1 -> Dateiliste. Antwort ist XML mit <d:href>.
  async function listRemoteFiles(cfg) {
    cfg = cfg || loadConfig();
    const res = await fetch(folderUrl(cfg) + '/', {
      method: 'PROPFIND',
      headers: headers(cfg, { 'Depth': '1', 'Content-Type': 'application/xml' }),
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>',
    });
    await checkHttp(res, 'Dateiliste (PROPFIND)');
    const xml = await res.text();
    return parsePropfind(xml, folderUrl(cfg));
  }

  // Reine Funktion -> unit-testbar, toleriert d:/D:/ohne Namespace.
  function parsePropfind(xml, baseUrl) {
    const files = [];
    const base = String(baseUrl || '').split('/').filter(Boolean).pop() || '';
    const hrefs = xml.match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href[^>]*>/gi) || [];
    for (const h of hrefs) {
      const m = h.match(/>([^<]+)</);
      if (!m) continue;
      let name;
      try { name = decodeURIComponent(m[1]); } catch { name = m[1]; }
      name = name.split('?')[0];
      const last = name.split('/').filter(Boolean).pop() || '';
      if (!last || last === base || last === (base + '/')) continue;
      if (!/\.json$/i.test(last)) continue;
      files.push(last);
    }
    return [...new Set(files)];
  }

  async function pushBook(book, cfg) {
    cfg = cfg || loadConfig();
    await ensureFolder(cfg);
    const map = loadMap();
    const file = resolveFile(book, map);
    const url = joinUrl(folderUrl(cfg), encodeURIComponent(file));
    // blob:-Refs vor Upload zu portablen dataURLs auflösen (falls Store da)
    const S = (typeof window !== 'undefined' && window.GrimoireStore) ? window.GrimoireStore : null;
    const payload = (S && S.inlineBook) ? await S.inlineBook(book) : book;
    const res = await fetch(url, {
      method: 'PUT',
      headers: headers(cfg, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    await checkHttp(res, 'Hochladen ' + file);
    map[book.id] = { file, remoteUpdatedAt: book.updatedAt || Date.now(), lastSync: Date.now(), lastSyncLocal: book.updatedAt || 0 };
    saveMap(map);
    return file;
  }

  async function pullBook(file, cfg) {
    cfg = cfg || loadConfig();
    const url = joinUrl(folderUrl(cfg), encodeURIComponent(file));
    const res = await fetch(url, { method: 'GET', headers: headers(cfg) });
    await checkHttp(res, 'Herunterladen ' + file);
    return await res.json();
  }

  async function deleteRemoteBook(book, cfg) {
    return deleteRemoteBookById(book && book.id, (book && book._remoteFile) || null, cfg);
  }

  async function deleteRemoteBookById(bookId, fileHint, cfg) {
    if (!bookId) return false;
    cfg = cfg || loadConfig();
    if (!isConfigured() && !(cfg.baseUrl && cfg.username && cfg.password)) { forgetLocalBook(bookId); return false; }
    const map = loadMap();
    const file = (map[bookId] && map[bookId].file) || fileHint || null;
    if (file) {
      try {
        await fetch(joinUrl(folderUrl(cfg), encodeURIComponent(file)), {
          method: 'DELETE', headers: headers(cfg),
        });
      } catch { /* offline -> Datei bleibt, kein harter Fehler */ }
    }
    forgetLocalBook(bookId);
    return true;
  }

  function forgetLocalBook(bookId) {
    const map = loadMap();
    if (map[bookId]) { delete map[bookId]; saveMap(map); }
  }

  function pruneMap(localIds) {
    const map = loadMap();
    let changed = false;
    for (const id of Object.keys(map)) {
      if (!localIds.includes(id)) { delete map[id]; changed = true; }
    }
    if (changed) saveMap(map);
    return map;
  }

  /* ---------- Sync (Last-Write-Wins pro Buch, mit Konflikt-Kopie) ---------- */
  let syncInProgress = false;
  function guardSync() {
    if (syncInProgress) {
      const err = new Error('Sync läuft bereits – bitte kurz warten.');
      err.code = 'SYNC_BUSY';
      throw err;
    }
    syncInProgress = true;
  }
  function unguardSync() { syncInProgress = false; }
  function localBooks() {
    // app.js hält `state` global; kein Import nötig (keine Module im Projekt).
    if (typeof window !== 'undefined' && window.state && Array.isArray(window.state.books)) {
      return window.state.books;
    }
    try {
      const raw = localStorage.getItem('grimoire-dnd-v1');
      return (raw && JSON.parse(raw).books) || [];
    } catch { return []; }
  }

  function persistLocal() {
    if (typeof window !== 'undefined' && typeof window.persistNow === 'function') {
      window.persistNow();
    } else {
      // Fallback falls cloud.js ohne app.js getestet wird
      const books = localBooks();
      localStorage.setItem('grimoire-dnd-v1', JSON.stringify({ books, openBookId: null, openPageId: null }));
    }
  }

  async function pushAll(onProgress) {
    guardSync();
    try {
      const cfg = loadConfig();
      const books = localBooks();
      const out = [];
      for (let i = 0; i < books.length; i++) {
        if (onProgress) onProgress(i + 1, books.length, 'Hochladen: ' + books[i].title);
        const file = await pushBook(books[i], cfg);
        out.push(books[i].title + ' -> ' + file);
      }
      pruneMap(books.map(b => b.id));
      return out;
    } finally { unguardSync(); }
  }

  // Ordnet eine Remote-Datei einem lokalen Buch zu: erst per id, dann per Dateiname-Endung __<id>.json
  function matchLocal(S, remote, file) {
    if (remote && remote.id) {
      const byId = S.books.find(b => b.id === remote.id);
      if (byId) return byId;
    }
    const m = String(file || '').match(/__([^_\/]+)\.json$/i);
    if (m) {
      const byFile = S.books.find(b => b.id === m[1]);
      if (byFile) { byFile._remoteFile = file; return byFile; }
    }
    return null;
  }

  async function pullAll(onProgress) {
    guardSync();
    try {
      const cfg = loadConfig();
      // Zugriff auf echten State, damit Referenzen/UI stimmen
      const S = (typeof window !== 'undefined' && window.state) ? window.state : { books: localBooks() };
      const files = await listRemoteFiles(cfg);
      const map = loadMap();
      const added = [], updated = [], kept = [], conflicts = [];
      for (let i = 0; i < files.length; i++) {
        if (onProgress) onProgress(i + 1, files.length, 'Herunterladen: ' + files[i]);
        let remote;
        try {
          remote = await pullBook(files[i], cfg);
        } catch { continue; } // einzelne defekte Datei überspringen
        if (!remote || !Array.isArray(remote.pages)) continue;
        // Cloud-JSON trägt portable dataURLs -> in Blob-Store auslagern
        const GS = (typeof window !== 'undefined' && window.GrimoireStore) ? window.GrimoireStore : null;
        if (GS && GS.extractBook) { try { await GS.extractBook(remote); } catch { /* weiter mit inline */ } }
        const local = matchLocal(S, remote, files[i]);
        const decision = decideBook(local, remote, map[remote.id]);
        if (decision === 'remote-new') {
          S.books.unshift(remote);
          added.push(remote.title);
        } else if (decision === 'remote-newer') {
          const idx = S.books.indexOf(local);
          S.books[idx] = remote;
          updated.push(remote.title);
        } else if (decision === 'conflict') {
          // Nichts überschreiben: Remote als Kopie behalten, User entscheidet später.
          const copy = JSON.parse(JSON.stringify(remote));
          copy.id = 'cloud-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
          copy.title = (remote.title || 'Buch') + ' (Cloud-Konflikt)';
          copy.updatedAt = Date.now();
          S.books.unshift(copy);
          conflicts.push(remote.title || files[i]);
          kept.push(local.title);
        }
        map[remote.id] = { file: files[i], remoteUpdatedAt: remote.updatedAt || Date.now(), lastSync: Date.now(), lastSyncLocal: (local && local.updatedAt) || remote.updatedAt || 0 };
      }
      saveMap(map);
      persistLocal();
      if (typeof window !== 'undefined' && typeof window.renderLibrary === 'function') window.renderLibrary();
      return { added, updated, kept, conflicts };
    } finally { unguardSync(); }
  }

  async function syncAll(onProgress) {
    // 1. Remote-Stand holen (mit Konflikt-Kopien)  2. alles Lokale hochladen
    const pulled = await pullAll(onProgress);
    const pushed = await pushAll(onProgress);
    return { pulled, pushed };
  }

  // Browser-Global exportieren (Projekt nutzt plain <script>, keine Module)
  if (typeof window !== 'undefined') window.GrimoireCloud = Cloud;
  if (typeof module !== 'undefined' && module.exports) module.exports = Cloud;
})();
