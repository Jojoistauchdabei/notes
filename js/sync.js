/* Federwerk Sync-Logik (eigener Server, server/).
 *
 *   Gerät A -> lokaler Cache -> Server (SQLite) -> lokaler Cache -> Gerät B
 *
 * - Notizen: lokales Buch <-> Dokument (id, title, folderId, content,
 *   createdAt, updatedAt, deletedAt).
 *   content ist ein v1/v2-Envelope: Notebooks `{v:1, pages}`, Decks
 *   `{v:2, pages, kind, cards, deckOptions, reviewLog}` (bookEnvelope/
 *    parseEnvelope; der Hash (hashableBook) deckt Titel, Ordner, Seiten UND
 *    Deckfelder ab, damit Kartenänderungen syncen. Nach dem Update auf die
 *    v2-Hashbasis schiebt der erste Sync jedes Buch einmal hoch (einmalig).
 * - Ordner: /api/folders <-> lokaler Spiegel (Bücher tragen folderId).
 * - Notizen: vollständiger Bestand für sichere Lösch-Erkennung; lokal via
 *   Content-Hash.
 * - Tombstones: gelöschte Bücher werden mit deletedAt hochgeschoben, remote
 *   gelöschte lokal entfernt.
 * - Konflikt (beide Seiten geändert): Remote gewinnt, lokale Version bleibt
 *   als "(Konflikt)"-Kopie erhalten.
 * - Bild-Refs reisen als `awfile:<hash>` und werden up-/downgeloadet
 *   (js/files-sync.js: Dedupe + Recompress). Der Inhalt eines Dokuments liegt
 *   dagegen immer inline; die frühere Auslagerung großer Inhalte in eine
 *   eigene Datei ist ersatzlos entfallen (siehe contentToPayload).
 * - Realtime: SSE-Kanal meldet "da ist etwas neu" und triggert einen Pull.
 * - DOM-frei ladbar: Entscheidungslogik ist rein und in Node testbar.
 */
(function () {
  'use strict';

  const ROWMAP_KEY = 'federwerkRowMapV1';   // bookId -> {rowId, hash, remoteUpdatedAtMs, createdAtMs}
  const LASTPULL_KEY = 'federwerkLastPullV1'; // {notes: iso|null, folders: iso|null}
  const FOLDERS_KEY = 'federwerkFoldersV1';   // id -> {name, parentId, updatedAtMs, deleted?}
  const FOLDERMETA_KEY = 'federwerkFolderMetaV1'; // id -> {hash, remoteUpdatedAtMs}
  const CONFLICTS_KEY = 'federwerkConflictsV1'; // [{id, title, at, sourceId}] – unbestätigte Konflikt-Kopien
  const CONFLICTS_MAX = 50;
  // Frueher 40000: alles Groessere ging als eigene Datei hoch, weil das
  // Cloud-Backend Inhalte auf 64 KB begrenzte. Der eigene Server kennt diese
  // Grenze nicht - Inhalte gehen immer inline (siehe contentToPayload). Die
  // Konstante bleibt als Export bestehen, weil Tests und Aufrufer sie lesen.
  const OFFLOAD_BYTES = Infinity;
  // Marke fuer Bild-Refs im Dokumentinhalt (siehe rewriteRefs). Der Wert ist
  // historisch und steckt in bereits geschriebenen Dokumenten - er bleibt
  // deshalb woertlich, auch wenn das Backend, dem er seinen Namen verdankt,
  // nicht mehr existiert.
  const AWFILE = 'awfile:';

  let lsBackend = null;
  function ls() {
    if (lsBackend) return lsBackend;
    try { if (typeof localStorage !== 'undefined') return localStorage; } catch { /* ignore */ }
    return null;
  }
  function lsGet(key, fallback) {
    const s = ls();
    if (!s) return fallback;
    try { const v = s.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  }
  function lsSet(key, val) {
    const s = ls();
    if (!s) return;
    try { s.setItem(key, JSON.stringify(val)); } catch { /* ignore */ }
  }

  /* ---------- reine Helfer (testbar) ---------- */

  function msToIso(ms) {
    try { return new Date(ms).toISOString(); } catch { return new Date(0).toISOString(); }
  }
  function isoToMs(iso) {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? t : 0;
  }
  // Dokument-ID: ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$ – sonst mappen.
  // Lokale Buch-IDs duerfen beliebig aussehen ("Buch mit Leerzeichen!"), der
  // Server will ^[A-Za-z0-9_.:-]{1,64}$. Die engere Regel hier bleibt: einmal
  // vergebene IDs sollen stabil bleiben, ein erneuter Sync darf nichts
  // umbenennen.
  function docIdForBook(id) {
    const s = String(id || '');
    if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/.test(s)) return s;
    const clean = s.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[^a-z0-9]+/, '');
    return ('b' + (clean || 'book')).slice(0, 36);
  }
  function isFileRef(s) { return typeof s === 'string' && s.startsWith(AWFILE) && s.length > AWFILE.length + 31; }
  function hashFromFileRef(s) { return isFileRef(s) ? s.slice(AWFILE.length).toLowerCase() : null; }
  // Klont Seiten und ersetzt Bild-Refs: push (ref->hash) bzw. pull (hash->ref).
  function rewriteRefs(pages, map, dir) {
    const out = JSON.parse(JSON.stringify(pages || []));
    const missing = [];
    const rep = (val) => {
      if (typeof val !== 'string') return val;
      if (dir === 'push') {
        if (map[val]) return AWFILE + map[val];
        return val;
      }
      const h = hashFromFileRef(val);
      if (!h) return val;
      if (map[h]) return map[h];
      missing.push(h);
      return null; // nicht materialisierbar -> Aufrufer entfernt Eintrag
    };
    for (const p of out) {
      if (Array.isArray(p.images)) {
        for (const im of p.images) if (im) im.src = rep(im.src);
        p.images = p.images.filter(im => im && im.src);
      }
      if (typeof p.bg === 'string') {
        const nb = rep(p.bg);
        p.bg = nb || null;
      }
    }
    return { pages: out, missing: [...new Set(missing)] };
  }
  function bookContentJson(book) {
    return JSON.stringify(bookEnvelope(book));
  }
  function parseContentJson(json) {
    try {
      const p = JSON.parse(json || '');
      if (p && Array.isArray(p.pages)) return p.pages;
    } catch { /* ignore */ }
    return null;
  }
  // Karteikarten-Deck im Sync (v2-Envelope, wie MCP/mcpserver/content.js):
  // Notebooks reisen weiter als schlankes v1 ({v:1, pages}), Decks als
  // {v:2, pages, kind, cards, deckOptions, reviewLog}. Alte Clients lesen v2
  // (Seiten laden, Deckfelder ignorieren), schreiben sie aber ohne Deckfelder
  // zurück – gemischte Client-Stände können Karten verlieren, daher Clients
  // möglichst gemeinsam aktualisieren. Heilt tolerant (fremde Keys bleiben).
  const REVIEW_LOG_MAX = 1000;
  function isDeckBook(b) {
    return !!(b && (b.kind === 'flashcards' || b.kind === 'deck'));
  }
  function num(v, fb) {
    const n = Number(v);
    return isFinite(n) ? n : fb;
  }
  function normDeckCards(cards) {
    if (!Array.isArray(cards)) return [];
    const out = [];
    for (const c of cards) {
      if (!c || typeof c !== 'object') continue;
      out.push(Object.assign({}, c, {
        id: typeof c.id === 'string' && c.id ? c.id : undefined,
        front: typeof c.front === 'string' ? c.front : String(c.front == null ? '' : c.front),
        back: typeof c.back === 'string' ? c.back : String(c.back == null ? '' : c.back),
      }));
    }
    return out;
  }
  function normDeckOptions(o) {
    o = (o && typeof o === 'object') ? o : {};
    return {
      newPerDay: Math.max(1, Math.min(500, Math.round(num(o.newPerDay, 20)))),
      maxReviewsPerDay: Math.max(1, Math.min(2000, Math.round(num(o.maxReviewsPerDay, 100)))),
    };
  }
  function normReviewLog(log) {
    if (!Array.isArray(log)) return [];
    const grades = { again: 1, hard: 1, good: 1, easy: 1 };
    const out = [];
    for (const e of log) {
      if (!e || typeof e !== 'object') continue;
      const t = Number(e.t);
      if (!isFinite(t) || !grades[e.g]) continue;
      out.push({ t: Math.round(t), g: e.g, id: typeof e.id === 'string' ? e.id : '' });
    }
    return out.length > REVIEW_LOG_MAX ? out.slice(out.length - REVIEW_LOG_MAX) : out;
  }
  // Envelope eines Buchs (pages optional überschrieben, z. B. nach Ref-Rewrite).
  function bookEnvelope(b, pages) {
    const pg = pages !== undefined ? pages : ((b && b.pages) || []);
    const bb = b || {};
    const hasDeckData = (Array.isArray(bb.cards) && bb.cards.length > 0)
      || (bb.deckOptions && typeof bb.deckOptions === 'object')
      || (Array.isArray(bb.reviewLog) && bb.reviewLog.length > 0);
    if (!isDeckBook(bb) && !hasDeckData) return { v: 1, pages: pg };
    return {
      v: 2, pages: pg, kind: 'flashcards',
      cards: normDeckCards(bb.cards),
      deckOptions: normDeckOptions(bb.deckOptions),
      reviewLog: normReviewLog(bb.reviewLog),
    };
  }
  // Tolerant: v1/v2/Altbestand/Müll -> {pages|null, kind, cards, deckOptions, reviewLog}.
  function parseEnvelope(json) {
    const out = { pages: null, kind: 'notebook', cards: [], deckOptions: null, reviewLog: [] };
    let p = null;
    try { p = JSON.parse(json || ''); } catch { return out; }
    if (!p || typeof p !== 'object') return out;
    if (Array.isArray(p.pages)) out.pages = p.pages;
    else return out;
    if (p.kind === 'flashcards' || p.kind === 'deck') out.kind = 'flashcards';
    if (Array.isArray(p.cards)) out.cards = p.cards;
    if (p.deckOptions && typeof p.deckOptions === 'object') out.deckOptions = p.deckOptions;
    if (Array.isArray(p.reviewLog)) out.reviewLog = p.reviewLog;
    return out;
  }
  // Übernimmt Remote-Envelope ins lokale Buch (kind immer, Deckfelder nur bei
  // Decks – ein Notebook-Envelope löscht lokale Karten nie stillschweigend).
  function applyEnvelopeToBook(b, env) {
    b.kind = env && env.kind === 'flashcards' ? 'flashcards' : 'notebook';
    if (b.kind === 'flashcards' && env) {
      b.cards = normDeckCards(env.cards);
      b.deckOptions = normDeckOptions(env.deckOptions);
      b.reviewLog = normReviewLog(env.reviewLog);
    }
    return b;
  }
  // Hash-Basis für Änderungserkennung (Titel + Ordner + Seiten + Deckfelder).
  function hashableBook(b) {
    const deck = isDeckBook(b);
    return {
      v: 2, title: b.title || '', folderId: b.folderId || null, pages: b.pages || [],
      kind: deck ? 'flashcards' : 'notebook',
      cards: deck ? normDeckCards(b.cards) : [],
      deckOptions: deck ? normDeckOptions(b.deckOptions) : null,
      reviewLog: deck ? normReviewLog(b.reviewLog) : [],
    };
  }
  function folderHash(f) {
    return JSON.stringify([f.name || '', f.parentId || null, f.deleted ? 1 : 0]);
  }
  // Entscheidungslogik. local/remote keyed by BOOK-ID (Mapping macht Aufrufer).
  // local: {id:{hash, updatedAtMs}}, remote: {id:{updatedAtMs, deletedAtMs|null}},
  // meta: {id:{rowId, hash, remoteUpdatedAtMs}}.
  function planRows(local, remote, meta) {
    local = local || {}; remote = remote || {}; meta = meta || {};
    const push = [], pull = [], conflict = [], pushDelete = [], localDelete = [],
      download = [], metaDrop = [], adopt = [];
    const ids = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(meta)]);
    for (const id of ids) {
      const l = local[id] || null, r = remote[id] || null, m = meta[id] || null;
      if (l && !r && !m) { push.push({ id, reason: 'new' }); continue; }
      if (l && !r && m) {
        if (m.hash !== undefined && m.hash !== l.hash) push.push({ id, reason: 'revive' });
        else localDelete.push({ id });
        continue;
      }
      if (!l && r && !r.deletedAtMs && !m) { download.push({ id }); continue; }
      if (!l && r && !r.deletedAtMs && m) { pushDelete.push({ id }); continue; }
      if (!l && (!r || r.deletedAtMs) && m) { metaDrop.push({ id }); continue; }
      if (!l && !r && m) { metaDrop.push({ id }); continue; }
      if (!l && !r) continue;
      // beide Seiten vorhanden
      if (r.deletedAtMs) {
        if (m && m.hash !== undefined && m.hash !== l.hash) push.push({ id, reason: 'revive' });
        else localDelete.push({ id });
        continue;
      }
      if (!m) { adopt.push({ id }); continue; } // Inhaltvergleich macht Aufrufer
      const lc = m.hash !== l.hash;
      const rc = r.updatedAtMs > (m.remoteUpdatedAtMs || 0);
      if (!lc && !rc) continue;
      if (!lc && rc) { pull.push({ id }); continue; }
      if (lc && !rc) { push.push({ id, reason: 'changed' }); continue; }
      conflict.push({ id });
    }
    return { push, pull, conflict, pushDelete, localDelete, download, metaDrop, adopt };
  }
  function makeConflictTitle(title, at) {
    let d = '';
    try { d = new Date(at).toLocaleString('de-DE'); } catch { /* ignore */ }
    return `${title || 'Notizen'} (Konflikt ${d})`;
  }
  function isConflictTitle(title) {
    return /\(Konflikt /.test(String(title || ''));
  }
  // Registry unbestätigter Konflikt-Kopien (localStorage, rein + testbar).
  // Die Kopie selbst bleibt ein normales Buch; die Registry merkt nur vor,
  // dass der Nutzer den Konflikt noch nicht zur Kenntnis genommen hat
  // (Badge in der Bibliothek statt stillem Duplikat).
  function loadConflicts() {
    const v = lsGet(CONFLICTS_KEY, []);
    return Array.isArray(v) ? v.filter(e => e && e.id) : [];
  }
  function saveConflicts(list) {
    lsSet(CONFLICTS_KEY, Array.isArray(list) ? list.slice(0, CONFLICTS_MAX) : []);
  }
  function recordConflictCopies(entries) {
    const cur = loadConflicts();
    const seen = new Set(cur.map(e => e.id));
    for (const e of entries || []) {
      if (!e || !e.id || seen.has(e.id)) continue;
      seen.add(e.id);
      cur.unshift({ id: e.id, title: e.title || '', at: e.at || Date.now(), sourceId: e.sourceId || null });
    }
    saveConflicts(cur);
    return cur;
  }
  function resolveConflictCopy(id) {
    saveConflicts(loadConflicts().filter(e => e.id !== id));
  }
  function clearConflictCopies() { saveConflicts([]); }
  // Lebende Konflikt-Kopien: Registry-Einträge, deren Buch noch existiert,
  // plus Fallback über den Titel (z. B. andere Geräte ohne Registry).
  function listLiveConflictCopies(books) {
    const ids = new Set(loadConflicts().map(e => e.id));
    const out = [];
    for (const b of books || []) {
      if (!b || !b.id) continue;
      if (ids.has(b.id) || isConflictTitle(b.title)) out.push(b);
    }
    return out;
  }

  /* ---------- Meta-Speicher ---------- */

  function loadRowMap() { return lsGet(ROWMAP_KEY, {}); }
  function saveRowMap(m) { lsSet(ROWMAP_KEY, m || {}); }
  function loadLastPull() { return lsGet(LASTPULL_KEY, { notes: null, folders: null }); }
  function saveLastPull(v) { lsSet(LASTPULL_KEY, v || { notes: null, folders: null }); }
  function loadFolders() { return lsGet(FOLDERS_KEY, {}); }
  function saveFolders(f) { lsSet(FOLDERS_KEY, f || {}); }
  function loadFolderMeta() { return lsGet(FOLDERMETA_KEY, {}); }
  function saveFolderMeta(m) { lsSet(FOLDERMETA_KEY, m || {}); }

  /* ---------- Tabellen-REST (Browser) ---------- */

  function filesApi() {
    if (typeof window !== 'undefined' && window.FederwerkFiles) return window.FederwerkFiles;
    if (typeof require === 'function') {
      try { return require('./files-sync.js'); } catch { /* ignore */ }
    }
    throw new Error('FederwerkFiles fehlt (js/files-sync.js einbinden)');
  }
  function api() {
    if (typeof window !== 'undefined' && window.FederwerkApi) return window.FederwerkApi;
    if (typeof require === 'function') {
      try { return require('./api.js'); } catch { /* ignore */ }
    }
    throw new Error('FederwerkApi fehlt (js/api.js einbinden)');
  }

  /* ---- Zeilen-Normalisierung ----
   *
   * Der Server spricht {id, title, folderId, content, createdAt, updatedAt,
   * deletedAt} mit Zeitstempeln in Millisekunden. Die Sync-Logik darunter
   * rechnet mit ISO-Zeitstempeln.
   *
   * Diese Anpassung liegt bewusst HIER und nicht in der Logik: planRows(),
   * die Last-Write-Entscheidung und die Konfliktbehandlung sind rein und
   * getestet. Sie auf eine andere Feldform umzubauen waere Aenderungsrisiko
   * ohne Gegenwert - die Protokollseite ist trotzdem vollstaendig neu (eigene
   * Routen, Cookie-Auth, kein Query-Dialekt, SSE statt Realtime-WS). */
  function msToIsoLocal(ms) {
    const n = Number(ms);
    if (!n) return null;
    return new Date(n).toISOString();
  }
  function toRow(d) {
    return {
      id: d.id,
      title: d.title || '',
      folderId: d.folderId || null,
      content: d.content || '',
      createdAt: msToIsoLocal(d.createdAt),
      updatedAt: msToIsoLocal(d.updatedAt),
      deletedAt: d.deletedAt ? msToIsoLocal(d.deletedAt) : null,
    };
  }

  // Der Server kennt nur ?since= und ?limit=. Der Sync braucht ohnehin den
  // vollstaendigen Bestand (sonst liesse sich "unveraendert" nicht von "lokal
  // geloescht" unterscheiden), also genau eine Anfrage.
  async function listRemote(table) {
    if (table === 'folders') return (await api().listFolders()).map(toRow);
    return (await api().listDocs(0, 1000)).map(toRow);
  }
  async function putRemote(table, rowId, data) {
    if (table === 'folders') {
      return api().putFolder({
        id: rowId,
        name: data.name || '',
        parentId: data.parentId || null,
        updatedAt: isoToMs(data.updatedAt) || Date.now(),
        deletedAt: data.deletedAt ? isoToMs(data.deletedAt) : null,
      });
    }
    return api().putDoc({
      id: rowId,
      title: data.title || '',
      folderId: data.folderId || null,
      content: data.content || '',
      createdAt: isoToMs(data.createdAt) || Date.now(),
      updatedAt: isoToMs(data.updatedAt) || Date.now(),
      deletedAt: data.deletedAt ? isoToMs(data.deletedAt) : null,
    });
  }
  function rowToNoteMeta(row) {
    return {
      updatedAtMs: isoToMs(row.updatedAt),
      deletedAtMs: row.deletedAt ? isoToMs(row.deletedAt) : null,
      title: row.title || '',
    };
  }

  /* ---------- Sync-Fluss ---------- */

  function getBooks() {
    try {
      if (typeof window !== 'undefined' && window.state && Array.isArray(window.state.books)) return window.state.books;
    } catch { /* ignore */ }
    return [];
  }
  function getStore() {
    try { if (typeof window !== 'undefined' && window.GrimoireStore) return window.GrimoireStore; }
    catch { /* ignore */ }
    return null;
  }
  function afterChange(changed) {
    try {
      if (typeof window === 'undefined') return;
      // Ohne erkennbare Aenderung ist der Vollneubau reine Arbeit: persistNow()
      // serialisiert das ganze Dokument und renderAll() baut Rail, Layers und
      // Thumbnails neu auf. Das passierte bei jedem 5-Sekunden-Poll.
      if (changed === false) return;
      if (typeof window.persistNow === 'function') window.persistNow();
      if (typeof window.renderAll === 'function') window.renderAll();
      else if (typeof window.renderLibrary === 'function') window.renderLibrary();
    } catch { /* ignore */ }
  }
  // Sammelt {ref -> hash} für alle auflösbaren Bild-Refs der Seiten.
  async function hashRefsInPages(pages, store, F) {
    const out = {};
    const jobs = [];
    const visit = (val) => {
      if (typeof val !== 'string' || out[val] || isFileRef(val)) return;
      jobs.push((async () => {
        try {
          let bytes = null, mime = '';
          if (val.startsWith('data:')) {
            const d = F.dataUrlToBytes(val);
            bytes = d.bytes; mime = d.mime;
          } else if (store && store.dataUrl) {
            const du = await store.dataUrl(val);
            if (!du) return;
            const d = F.dataUrlToBytes(du);
            bytes = d.bytes; mime = d.mime;
          }
          if (bytes) out[val] = { hash: await F.sha256Hex(bytes), bytes, mime };
        } catch { /* unauflösbar -> bleibt wie-is */ }
      })());
    };
    for (const p of pages || []) {
      if (Array.isArray(p.images)) for (const im of p.images) if (im) visit(im.src);
      if (typeof p.bg === 'string') visit(p.bg);
    }
    await Promise.all(jobs);
    return out;
  }
  // Stellt sicher, dass alle Hashes im Bucket liegen (Dedupe via 409).
  async function ensureUploaded(F, cfg, hashed) {
    for (const h of Object.keys(hashed)) {
      const e = hashed[h];
      if (!e || !e.bytes) continue;
      await F.uploadEntry(e.hash, e.bytes, e.mime);
      delete e.bytes; // Speicher wieder frei
    }
  }
  // Materialisiert awfile-Refs lokal (lädt + legt Blob an). Gibt {hash -> neue blob-Ref}.
  async function materializeRefs(F, cfg, store, hashes) {
    const out = {};
    for (const h of hashes || []) {
      if (!h) continue;
      try {
        const { bytes, mime } = await F.downloadEntry(h);
        if (store && store.putBlob && typeof Blob !== 'undefined') {
          const ref = await store.putBlob(new Blob([bytes], { type: mime || 'application/octet-stream' }));
          if (ref) out[h] = ref;
        } else if (store && store.putDataUrl) {
          const ref = await store.putDataUrl(F.bytesToBase64(bytes) && ('data:' + (mime || 'image/jpeg') + ';base64,' + F.bytesToBase64(bytes)));
          if (ref) out[h] = ref;
        }
      } catch { /* fehlt weiter -> Aufrufer droppt Eintrag */ }
    }
    return out;
  }
  /* Inhalt wird immer inline gespeichert.
   *
   * Frueher gab es OFFLOAD_BYTES: alles Groessere wurde als eigene Datei in
   * den Bucket gelegt, weil das Cloud-Backend Inhalte auf 64 KB begrenzt
   * hatte. Der eigene Server hat diese Grenze nicht - SQLite nimmt
   * mehrfarbige Megabyte-JSON direkt. Datei-Upload beim Push und Nachladeweg
   * beim Pull sind damit ersatzlos entfallen. */
  async function contentToPayload(F, cfg, book, hashedByRef) {
    const map = {};
    for (const ref of Object.keys(hashedByRef)) map[ref] = hashedByRef[ref].hash;
    const { pages } = rewriteRefs(book.pages, map, 'push');
    return { content: JSON.stringify(bookEnvelope(book, pages)) };
  }
  async function payloadToEnvelope(F, cfg, store, row) {
    const env = parseEnvelope(row.content || '');
    if (!env.pages) return null;
    // awfile-Refs einsammeln + materialisieren
    const need = new Set();
    const scan = (v) => { const h = hashFromFileRef(v); if (h) need.add(h); };
    for (const p of env.pages) {
      if (Array.isArray(p.images)) for (const im of p.images) if (im) scan(im.src);
      if (typeof p.bg === 'string') scan(p.bg);
    }
    const refByHash = await materializeRefs(F, cfg, store, [...need]);
    const { pages: out } = rewriteRefs(env.pages, refByHash, 'pull');
    env.pages = out;
    return env;
  }
  async function payloadToPages(F, cfg, store, row) {
    const env = await payloadToEnvelope(F, cfg, store, row);
    return env ? env.pages : null;
  }

  const Sync = {
    ROWMAP_KEY, LASTPULL_KEY, FOLDERS_KEY, OFFLOAD_BYTES,
    msToIso, isoToMs, docIdForBook, isFileRef, hashFromFileRef,
    rewriteRefs, bookContentJson, parseContentJson, folderHash,
    isDeckBook, bookEnvelope, parseEnvelope, applyEnvelopeToBook, hashableBook,
    normDeckCards, normDeckOptions, normReviewLog,
    planRows, makeConflictTitle, rowToNoteMeta,
    loadRowMap, saveRowMap, loadLastPull, saveLastPull,
    loadFolders, saveFolders, loadFolderMeta, saveFolderMeta,
    CONFLICTS_KEY, isConflictTitle,
    loadConflicts, saveConflicts, recordConflictCopies,
    resolveConflictCopy, clearConflictCopies, listLiveConflictCopies,

    async syncNow(progress) {
      const F = filesApi();
      const cfg = F.loadConfig();
      const say = typeof progress === 'function' ? progress : () => {};
      const me = await F.session();
      if (!me) throw new Error('Bitte zuerst in den Server-Einstellungen einloggen.');
      const store = getStore();
      const books = getBooks();
      const byId = {};
      for (const b of books) byId[b.id] = b;
      let map = loadRowMap();
      const lastPull = loadLastPull();
      const summary = { pushed: 0, pulled: 0, downloaded: 0, conflicts: [], conflictCopies: [], deleted: 0, errors: [] };

      // --- Vollständigen Remote-Bestand holen ---
      // Eine reine Delta-Abfrage kann nicht zwischen „unverändert“ und
      // „lokal gelöscht“ unterscheiden. Der vollständige, paginierte Bestand
      // ist nötig, damit Löschungen als Tombstones synchronisiert werden.
      say('Frage Cloud-Stand ab …');
      const rows = await listRemote('notes');
      const remote = {};
      let maxSeen = lastPull.notes || null;
      for (const r of rows) {
        const bid = books.find(b => b && b.cloudRowId === r.id)?.id
          || Object.keys(map).find(k => (map[k] || {}).rowId === r.id) || r.id;
        remote[bid] = Object.assign(rowToNoteMeta(r), { row: r });
        if (!maxSeen || r.updatedAt > maxSeen) maxSeen = r.updatedAt;
      }
      const local = {};
      for (const b of books) {
        local[b.id] = { hash: '', updatedAtMs: b.updatedAt || 0 };
      }
      // A fresh browser has no local row map. Reconnect same-title documents
      // so the same document is reused instead of creating a duplicate.
      for (const rid of Object.keys(remote)) {
        if (local[rid]) continue;
        const title = remote[rid].title;
        const matches = books.filter(b => b && b.title === title && !map[b.id]);
        if (matches.length === 1) {
          const bid = matches[0].id;
          remote[bid] = remote[rid];
          delete remote[rid];
          map[bid] = { rowId: remote[bid].row.id, remoteUpdatedAtMs: remote[bid].updatedAtMs };
        }
      }
      const F2 = F;
      const contentHashOf = async (b) => {
        const hashed = await hashRefsInPages(b.pages, store, F2);
        const rmap = {};
        for (const ref of Object.keys(hashed)) rmap[ref] = hashed[ref].hash;
        const { pages } = rewriteRefs(b.pages, rmap, 'push');
        return F2.sha256Hex(new TextEncoder().encode(JSON.stringify(hashableBook(Object.assign({}, b, { pages })))));
      };
      // Content-Hash aller lokalen Bücher (Buchzahl klein, Hash schnell).
      for (const b of books) {
        try { local[b.id].hash = await contentHashOf(b); }
        catch (e) { summary.errors.push('hash ' + b.id + ': ' + e.message); local[b.id].hash = 'err'; }
      }
      const localClean = {};
      for (const k of Object.keys(local)) if (local[k]) localClean[k] = local[k];
      const plan = planRows(localClean, remote, map);
      // Collaboration mode: the newest complete document wins. The old
      // conflict-copy behavior remains available through the pure planner.
      const lastWritePull = [];
      const lastWritePush = [];
      const unresolved = [];
      for (const item of plan.conflict) {
        const localTime = localClean[item.id] ? localClean[item.id].updatedAtMs : 0;
        const remoteTime = remote[item.id] ? remote[item.id].updatedAtMs : 0;
        if (localTime > remoteTime) lastWritePush.push({ id: item.id, reason: 'last-write-local' });
        else lastWritePull.push(item);
      }
      plan.push.push(...lastWritePush);
      plan.pull.push(...lastWritePull);
      plan.conflict = unresolved;

      const touchMeta = (id, patch) => { map[id] = Object.assign({}, map[id], patch); };

      // --- Adopt: beidseitig ohne Meta -> Inhalt vergleichen ---
      for (const { id } of plan.adopt) {
        const r = remote[id].row;
        try {
          const env = await payloadToEnvelope(F, cfg, store, r);
          const rh = env ? await F.sha256Hex(new TextEncoder().encode(JSON.stringify(hashableBook({
            title: remote[id].title || '', folderId: remote[id].row.folderId || null,
            pages: env.pages, kind: env.kind, cards: env.cards,
            deckOptions: env.deckOptions, reviewLog: env.reviewLog,
          })))) : 'unlesbar';
          if (rh === localClean[id].hash) {
            touchMeta(id, { rowId: r.id, hash: rh, remoteUpdatedAtMs: remote[id].updatedAtMs });
          } else {
            plan.conflict.push({ id });
          }
        } catch (e) { summary.errors.push('adopt ' + id + ': ' + e.message); }
      }
      // --- Pull ---
      for (const { id } of plan.pull) {
        const r = remote[id].row;
        try {
          const env = await payloadToEnvelope(F, cfg, store, r);
          if (!env) throw new Error('Inhalt unlesbar');
          const b = byId[id];
          b.title = r.title || b.title;
          b.folderId = r.folderId || null;
          b.pages = env.pages;
          applyEnvelopeToBook(b, env);
          b.updatedAt = remote[id].updatedAtMs;
          if (store && store.extractBook) await store.extractBook(b).catch(() => {});
          touchMeta(id, { rowId: r.id, hash: localClean[id] ? await contentHashOf(b) : undefined, remoteUpdatedAtMs: remote[id].updatedAtMs });
          summary.pulled++;
        } catch (e) { summary.errors.push('pull ' + id + ': ' + e.message); }
      }
      // --- Konflikt: Remote gewinnt, lokal als Kopie ---
      for (const { id } of plan.conflict) {
        const r = remote[id].row;
        try {
          const env = await payloadToEnvelope(F, cfg, store, r);
          if (!env) throw new Error('Inhalt unlesbar');
          const b = byId[id];
          const copy = JSON.parse(JSON.stringify(b));
          copy.id = 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          copy.title = makeConflictTitle(b.title, Date.now());
          books.unshift(copy);
          // Registry fürs Konflikt-Badge (aktive Nutzerwarnung statt stiller Kopie).
          try { recordConflictCopies([{ id: copy.id, title: copy.title, at: Date.now(), sourceId: id }]); } catch { /* Anzeige-Only */ }
          map[copy.id] = { rowId: docIdForBook(copy.id), hash: undefined, remoteUpdatedAtMs: 0 };
          b.title = r.title || b.title;
          b.folderId = r.folderId || null;
          b.pages = env.pages;
          applyEnvelopeToBook(b, env);
          b.updatedAt = remote[id].updatedAtMs;
          if (store && store.extractBook) await store.extractBook(b).catch(() => {});
          touchMeta(id, { rowId: r.id, remoteUpdatedAtMs: remote[id].updatedAtMs });
          try { touchMeta(id, { hash: await contentHashOf(b) }); } catch { /* ignore */ }
          summary.conflicts.push(b.title);
          summary.conflictCopies.push({ id: copy.id, title: copy.title });
        } catch (e) { summary.errors.push('konflikt ' + id + ': ' + e.message); }
      }
      // --- Download (nur remote vorhanden) ---
      for (const { id } of plan.download) {
        const r = remote[id].row;
        try {
          const env = await payloadToEnvelope(F, cfg, store, r);
          if (!env) throw new Error('Inhalt unlesbar');
          const nb = {
            id: r.id && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/.test(r.id) ? r.id : docIdForBook(id),
            title: r.title || 'Importiert', paper: 'grid', updatedAt: remote[id].updatedAtMs,
            folderId: r.folderId || null, pages: env.pages,
            cloudRowId: r.id,
          };
          applyEnvelopeToBook(nb, env);
          if (store && store.extractBook) await store.extractBook(nb).catch(() => {});
          books.unshift(nb);
          byId[nb.id] = nb;
          try {
            touchMeta(nb.id, { rowId: r.id, hash: await contentHashOf(nb), remoteUpdatedAtMs: remote[id].updatedAtMs });
          } catch { touchMeta(nb.id, { rowId: r.id, remoteUpdatedAtMs: remote[id].updatedAtMs }); }
          summary.downloaded++;
        } catch (e) { summary.errors.push('download ' + id + ': ' + e.message); }
      }
      // --- Push (neu / geändert / revived) ---
      for (const { id, reason } of plan.push) {
        const b = byId[id];
        if (!b) continue;
        say(`Lade hoch (${reason}) …`);
        try {
          const rowId = (byId[id] && byId[id].cloudRowId) || (map[id] && map[id].rowId) || docIdForBook(id);
          const hashed = await hashRefsInPages(b.pages, store, F);
          await ensureUploaded(F, cfg, hashed);
          const payload = await contentToPayload(F, cfg, b, hashed);
          const nowIso = msToIso(Date.now());
          const m = map[id] || {};
          const data = {
            title: b.title || '',
            content: payload.content,
            folderId: b.folderId || null,
            createdAt: m.createdAtMs ? msToIso(m.createdAtMs) : nowIso,
            updatedAt: nowIso,
            deletedAt: null,
          };
          await putRemote('notes', rowId, data);
          b.cloudRowId = rowId;
          touchMeta(id, {
            rowId, hash: await contentHashOf(b),
            remoteUpdatedAtMs: isoToMs(nowIso),
            createdAtMs: m.createdAtMs || Date.now(),
          });
          summary.pushed++;
        } catch (e) { summary.errors.push('push ' + id + ': ' + e.message); }
      }
      // --- Push-Delete (lokal gelöscht -> Tombstone) ---
      for (const { id } of plan.pushDelete) {
        try {
          const rowId = (map[id] && map[id].rowId) || docIdForBook(id);
          const nowIso = msToIso(Date.now());
          const m = map[id] || {};
          await putRemote('notes', rowId, {
            title: '(gelöscht)', content: '', folderId: null,
            createdAt: m.createdAtMs ? msToIso(m.createdAtMs) : nowIso,
            updatedAt: nowIso, deletedAt: nowIso,
          });
          touchMeta(id, { rowId, remoteUpdatedAtMs: isoToMs(nowIso) });
          summary.deleted++;
        } catch (e) { summary.errors.push('tombstone ' + id + ': ' + e.message); }
      }
      // --- Lokal löschen (remote gelöscht) ---
      for (const { id } of plan.localDelete) {
        const ix = books.findIndex(b => b.id === id);
        if (ix >= 0) books.splice(ix, 1);
        delete map[id];
        summary.deleted++;
      }
      for (const { id } of plan.metaDrop) delete map[id];

      // --- Ordner-Spiegel ---
      try { await Sync.syncFolders(cfg, say); }
      catch (e) { summary.errors.push('folders: ' + e.message); }

      if (maxSeen) { lastPull.notes = maxSeen; saveLastPull(lastPull); }
      saveRowMap(map);
      // Leerer Plan = Remote ist identisch zu lokal. Nichts zu uebernehmen,
      // nichts neu zu rendern. (Feldnamen aus planRows(), s. Return oben.)
      const idle = plan.push.length === 0 && plan.pull.length === 0
        && plan.adopt.length === 0 && plan.conflict.length === 0
        && plan.pushDelete.length === 0 && plan.localDelete.length === 0
        && plan.download.length === 0 && summary.downloaded === 0;
      afterChange(!idle);
      return summary;
    },

    async syncFolders(cfg, say) {
      say = typeof say === 'function' ? say : () => {};
      const mirror = loadFolders();
      const fmeta = loadFolderMeta();
      const localChanged = new Set();
      const localFolderIds = new Set();
      // Lokale Ordner aus state.folders (neue Bibliotheks-UI) in den Mirror übernehmen,
      // damit sie hochgesynct werden – state ist führend für Namen.
      try {
        if (typeof window !== 'undefined' && window.state && Array.isArray(window.state.folders)) {
          for (const f of window.state.folders) {
            if (!f || !f.id || !f.name) continue;
            localFolderIds.add(String(f.id));
            const cur = mirror[f.id];
            const nu = { name: f.name, parentId: f.parentId || null, updatedAtMs: Number(f.updatedAt) || Date.now() };
            const m = fmeta[f.id];
            if (!m || folderHash(nu) !== m.hash) {
              mirror[f.id] = nu;
              localChanged.add(f.id);
            }
          }
        }
      } catch { /* Mirror bleibt */ }
      // Ordner haben ihr eigenes updated_at (der Server legt es selbst an) -
      // attribute in the table schema.
      const rows = await listRemote('folders');
      const remote = {};
      for (const r of rows) {
        // Lokale Ordner-IDs sind die fachliche ID; der Server verwendet daraus
        // abgeleitete Row-IDs. So bleiben auch ältere/ungültige IDs zuordenbar.
        const localId = Object.keys(mirror).find(fid =>
          (fmeta[fid] && fmeta[fid].rowId === r.id) || docIdForBook(fid) === r.id
        ) || r.id;
        remote[localId] = r;
      }
      // A folder removed locally must not survive in the cloud mirror.
      for (const fid of Object.keys(mirror)) {
        if (localFolderIds.has(String(fid))) continue;
        const rowId = (fmeta[fid] && fmeta[fid].rowId) || docIdForBook(fid);
        if (remote[fid] || rows.some(r => r.id === rowId)) {
          await api().deleteFolder(rowId);
          delete remote[fid];
        }
        delete mirror[fid];
        delete fmeta[fid];
      }
      // Pull: remote neuer/ unbekannt
      for (const rid of Object.keys(remote)) {
        const r = remote[rid];
        const rms = isoToMs(r.$updatedAt || r.updatedAt);
        const m = fmeta[rid];
        const cur = mirror[rid];
        const curHash = cur ? folderHash(cur) : undefined;
        if (localChanged.has(rid)) continue;
        if (!m || rms > (m.remoteUpdatedAtMs || 0)) {
          if (r.name == null) continue;
          if (!cur || (m && curHash === m.hash)) {
            mirror[rid] = { name: r.name || '', parentId: r.parentId || null, updatedAtMs: rms };
            fmeta[rid] = { hash: folderHash(mirror[rid]), remoteUpdatedAtMs: rms, rowId: r.id };
          } else {
            // beidseitig geändert -> remote gewinnt (Ordner sind billig)
            mirror[rid] = { name: r.name || '', parentId: r.parentId || null, updatedAtMs: rms };
            fmeta[rid] = { hash: folderHash(mirror[rid]), remoteUpdatedAtMs: rms, rowId: r.id };
          }
        }
      }
      // Push: lokal neu/geändert (Bücher-Referenzen einsammeln)
      const books = getBooks();
      const referenced = new Set();
      for (const b of books) if (b && b.folderId) referenced.add(b.folderId);
      for (const fid of Object.keys(mirror)) {
        const cur = mirror[fid];
        const m = fmeta[fid] || {};
        if (cur.deleted) {
          if (!remote[fid]) { delete mirror[fid]; delete fmeta[fid]; continue; }
          const nowIso = msToIso(Date.now());
          const rowId = m.rowId || docIdForBook(fid);
          await api().deleteFolder(rowId).catch(() => null);
          delete mirror[fid]; delete fmeta[fid];
          continue;
        }
        const h = folderHash(cur);
        if (m.hash !== h) {
          const nowIso = msToIso(Date.now());
          await putRemote('folders', docIdForBook(fid), {
            name: cur.name || '', parentId: cur.parentId || null,
          });
          fmeta[fid] = { hash: h, remoteUpdatedAtMs: isoToMs(nowIso), rowId: docIdForBook(fid) };
        }
      }
      void referenced;
      saveFolders(mirror); saveFolderMeta(fmeta);
      // Mirror zurück in state.folders spiegeln + UI aktualisieren
      try {
        if (typeof window !== 'undefined' && window.state) {
          const F = (typeof window.GrimoireFolders !== 'undefined') ? window.GrimoireFolders
            : (typeof require === 'function' ? require('./folders.js') : null);
          if (F && F.fromMirror) {
            const next = F.fromMirror(mirror);
            window.state.folders = next;
            if (typeof window.persistNow === 'function') { try { window.persistNow(); } catch { /* ignore */ } }
            else if (typeof window.renderLibrary === 'function') { try { window.renderLibrary(); } catch { /* ignore */ } }
            else if (typeof window.refreshFoldersFromMirror === 'function') { try { window.refreshFoldersFromMirror(); } catch { /* ignore */ } }
          }
        }
      } catch { /* UI-Refresh optional */ }
    },

    /* ---------- Realtime: SSE statt WebSocket ---------- */
    _rt: { es: null, onChange: null, poll: null, connected: false },
    rtChannels() { return ['docs', 'folders']; },
    startRealtime(onChange) {
      Sync.stopRealtime();
      const st = Sync._rt;
      st.onChange = typeof onChange === 'function' ? onChange : null;

      // Der Kanal traegt keine Daten, nur "da ist etwas neu". Was sich geaendert
      // hat, holt der regulaere Pull - damit ist eine Fehlmeldung im Kanal
      // harmlos und ein Datenleck ueber den Kanal ausgeschlossen.
      const fire = () => {
        clearTimeout(st.deb);
        st.deb = setTimeout(() => { try { st.onChange && st.onChange(); } catch { /* manueller Sync bleibt moeglich */ } }, 2500);
      };
      st.fire = fire;

      const handle = api().subscribe(Sync.rtChannels(), null, fire);
      st.es = handle.es;

      // Fallback-Poll laeuft nur, solange der Kanal NICHT steht. Sonst macht er
      // exakt dieselbe Arbeit zweimal: kompletter Zeilenabruf plus SHA-256 ueber
      // jedes Buch-JSON, gefolgt von persistNow() und renderAll().
      clearInterval(st.poll);
      st.poll = setInterval(() => {
        if (st.connected) return;
        if (st.onChange) { try { st.onChange(); } catch { /* ignore */ } }
      }, 5000);

      st.connected = true;
      // SSE verbindet sich selbst und wird selbst wieder verbunden; wir
      // beobachten nur den Zustand fuer die Statusanzeige und den Poll.
      const pollStatus = setInterval(() => {
        const rs = st.es && st.es.readyState;
        const connected = rs === 1;
        if (connected === st.connected) return;
        st.connected = connected;
        if (connected) clearInterval(st.poll);
        else {
          clearInterval(st.poll);
          st.poll = setInterval(() => {
            if (st.onChange) { try { st.onChange(); } catch { /* ignore */ } }
          }, 5000);
        }
      }, 2000);
      st.pollStatus = pollStatus;

      return true;
    },
    stopRealtime() {
      const st = Sync._rt;
      clearTimeout(st.deb);
      clearInterval(st.poll);
      clearInterval(st.pollStatus);
      st.onChange = null;
      try { if (st.es) st.es.close(); } catch { /* ignore */ }
      st.es = null; st.connected = false;
    },
    rtStatus() { return Sync._rt.connected ? 'verbunden' : 'aus'; },
  };

  /* ---------- UI-Glue (nur Browser) ---------- */
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const UI = {
      _errors: [],
      _el(id) { try { return document.getElementById(id); } catch { return null; } },
      _say(t) { const el = UI._el('cloudDbStatus'); if (el) el.textContent = t; },
      _log(message) {
        UI._errors.push(new Date().toLocaleTimeString('de-DE') + ' ' + message);
        if (UI._errors.length > 50) UI._errors.shift();
        const el = UI._el('cloudDiagnosticsLog');
        if (el) el.textContent = UI._errors.join('\n');
      },
      async syncNow() {
        UI._say('☁ Notizen werden synchronisiert …');
        try {
          const r = await Sync.syncNow(s => UI._say('☁ ' + s));
          let s = `☁ Notizen fertig: ⬆${r.pushed} ⬇${r.pulled + r.downloaded}`;
          if (r.conflicts.length) s += ` | ⚠ Konflikt: ${r.conflicts.join(', ')} (als Kopie behalten – siehe Badge in der Bibliothek)`;
          if (r.deleted) s += ` | 🗑 ${r.deleted} gelöscht`;
          if (r.errors.length) s += ` | ⚠ ${r.errors.length} Fehler`;
          for (const e of r.errors) UI._log(e);
          UI._say(s);
          try { if (typeof window !== 'undefined' && typeof window.renderConflictBanner === 'function') window.renderConflictBanner(); } catch { /* Anzeige-Only */ }
          try { if (typeof window !== 'undefined' && typeof window.renderLibrary === 'function') window.renderLibrary(); } catch { /* Anzeige-Only */ }
          const fw = window.FederwerkFilesUI;
          if (fw && fw.refresh) fw.refresh(false);
        } catch (e) {
          UI._log('Sync: ' + (e && e.message ? e.message : e));
          UI._say('☁ Sync fehlgeschlagen: ' + e.message);
          if (typeof alert !== 'undefined') alert('Notizen-Sync fehlgeschlagen:\n' + e.message);
        }
      },
      toggleRealtime(on) {
        try {
          const F = window.FederwerkFiles;
          const cfg = F ? F.loadConfig() : {};
          if (F) F.saveConfig({ realtime: !!on });
          if (on) {
            Sync.startRealtime(() => UI.syncNow());
            UI._say('☁ Live-Sync an – Realtime + 5-Sekunden-Fallback aktiv.');
          } else {
            Sync.stopRealtime();
            UI._say('☁ Realtime aus – nur manueller Sync.');
          }
        } catch (e) { UI._say('☁ Realtime-Fehler: ' + e.message); }
      },
      openDiagnostics() {
        const el = UI._el('cloudDiagnosticsOverlay');
        if (el) el.classList.add('active');
        UI.runDiagnostics();
      },
      closeDiagnostics() {
        const el = UI._el('cloudDiagnosticsOverlay');
        if (el) el.classList.remove('active');
      },
      clearDiagnostics() {
        UI._errors = [];
        const el = UI._el('cloudDiagnosticsLog');
        if (el) el.textContent = '';
        const summary = UI._el('cloudDiagnosticsSummary');
        if (summary) summary.textContent = 'Protokoll gelöscht.';
      },
      async runDiagnostics() {
        const summary = UI._el('cloudDiagnosticsSummary');
        const lines = [
          `Server: ${api().cfg().base || location.origin}`,
          `Realtime: ${Sync.rtStatus()}`,
          `Lokale Bücher: ${getBooks().length}`,
        ];
        try {
          const health = await api().health();
          lines.push(`Server antwortet: ${health.version || '?'} (Hash-Prüfung ${health.filesVerified ? 'an' : 'aus'})`);
          const me = await api().session();
          lines.push(me ? `Session: OK (${me.email || me.id})` : 'Session: FEHLT – zuerst einloggen');
          if (me) {
            const docs = await api().listDocs(0, 1000);
            const folders = await api().listFolders();
            const files = await api().listFiles();
            lines.push(`Dokumente: ${docs.length}, Ordner: ${folders.length}, Dateien: ${files.length}`);
          }
          lines.push('Hinweis: Der Live-Kanal meldet nur „da ist etwas neu“. Der Abruf läuft dann regulär über den Pull.');
        } catch (e) {
          lines.push('FEHLER: ' + (e && e.message ? e.message : String(e)));
          UI._log('Diagnose: ' + (e && e.message ? e.message : String(e)));
        }
        if (summary) summary.textContent = lines.join('\n');
        const log = UI._el('cloudDiagnosticsLog');
        if (log) log.textContent = UI._errors.join('\n');
      },
      boot() {
        try {
          const F = window.FederwerkFiles;
          if (F && F.loadConfig().realtime) {
            Sync.startRealtime(() => UI.syncNow());
          }
        } catch { /* stiller Start, kein Realtime */ }
      },
    };
    window.FederwerkSyncUI = UI;
    document.addEventListener('DOMContentLoaded', () => setTimeout(() => UI.boot(), 1500));
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = Sync;
  else if (typeof window !== 'undefined') window.FederwerkSync = Sync;
})();
