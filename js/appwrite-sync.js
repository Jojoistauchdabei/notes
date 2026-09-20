/* Federwerk Cloud-Logik (Appwrite TablesDB + Realtime).
 *
 * Ersetzt den WebDAV-Sync durch Appwrite als Cloud:
 *   Gerät A -> lokaler Cache -> Appwrite -> lokaler Cache -> Gerät B
 *
 * - Notizen: lokales Buch <-> Row in Tabelle `notes`
 *   (id, userId, title, content, contentFileId, folderId,
 *    createdAt, updatedAt, deletedAt).
 * - Ordner: Tabelle `folders` <-> lokaler Spiegel (Bücher tragen folderId).
 * - Delta: nur Rows mit updatedAt > lastPull; lokal via Content-Hash.
 * - Tombstones: gelöschte Bücher werden als deletedAt-Row hochgeschoben,
 *   remote gelöschte lokal entfernt.
 * - Konflikt (beide Seiten geändert): Remote gewinnt, lokale Version bleibt
 *   als "(Konflikt)"-Kopie erhalten (wie bisherige Cloud-Logik).
 * - Content > 40 KB wandert als JSON-Datei in den Bucket (bytesMax/Row),
 *   Bild-Refs reisen als `awfile:<hash>` und werden up-/downgeloadet
 *   (js/appwrite-files.js: Dedupe + Recompress).
 * - Realtime: WebSocket-Subscribe auf die Tabellen, triggert Delta-Pull.
 * - DOM-frei ladbar: Entscheidungslogik ist rein und in Node testbar.
 */
(function () {
  'use strict';

  const ROWMAP_KEY = 'federwerkRowMapV1';   // bookId -> {rowId, hash, remoteUpdatedAtMs, createdAtMs}
  const LASTPULL_KEY = 'federwerkLastPullV1'; // {notes: iso|null, folders: iso|null}
  const FOLDERS_KEY = 'federwerkFoldersV1';   // id -> {name, parentId, updatedAtMs, deleted?}
  const FOLDERMETA_KEY = 'federwerkFolderMetaV1'; // id -> {hash, remoteUpdatedAtMs}
  const OFFLOAD_BYTES = 40000;
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
  // Appwrite Row-ID: ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$ – sonst mappen.
  function rowIdForBook(id) {
    const s = String(id || '');
    if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/.test(s)) return s;
    const clean = s.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[^a-z0-9]+/, '');
    return ('b' + (clean || 'book')).slice(0, 36);
  }
  function isAwFileRef(s) { return typeof s === 'string' && s.startsWith(AWFILE) && s.length > AWFILE.length + 31; }
  function hashFromAwRef(s) { return isAwFileRef(s) ? s.slice(AWFILE.length).toLowerCase() : null; }
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
      const h = hashFromAwRef(val);
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
    return JSON.stringify({ v: 1, pages: book.pages || [] });
  }
  function parseContentJson(json) {
    try {
      const p = JSON.parse(json || '');
      if (p && Array.isArray(p.pages)) return p.pages;
    } catch { /* ignore */ }
    return null;
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
      try { return require('./appwrite-files.js'); } catch { /* ignore */ }
    }
    throw new Error('FederwerkFiles fehlt (js/appwrite-files.js einbinden)');
  }
  async function tablesRest(cfg, method, path, body) {
    if (typeof fetch === 'undefined') throw new Error('kein fetch');
    const r = await fetch(cfg.endpoint + path, {
      method,
      headers: { 'X-Appwrite-Project': cfg.projectId, 'Content-Type': 'application/json' },
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204 || r.status === 205) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error((j && j.message) || ('HTTP ' + r.status));
      e.status = r.status; e.body = j;
      throw e;
    }
    return j;
  }
  function q(params) {
    return '?' + params.map(p => 'queries[]=' + encodeURIComponent(p)).join('&');
  }
  async function listRows(cfg, table, queries) {
    const out = [];
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const params = ['limit(100)', ...(queries || [])];
      if (cursor) params.push(`cursorAfter("${cursor}")`);
      const j = await tablesRest(cfg, 'GET', `/tablesdb/${cfg.databaseId}/tables/${table}/rows${q(params)}`);
      const rows = (j && (j.rows || j.documents)) || [];
      for (const r of rows) out.push(r);
      if (rows.length < 100) break;
      cursor = rows[rows.length - 1].$id;
    }
    return out;
  }
  async function upsertRow(cfg, table, rowId, data, userId) {
    const perms = [`read("user:${userId}")`, `update("user:${userId}")`, `delete("user:${userId}")`];
    try {
      return await tablesRest(cfg, 'POST', `/tablesdb/${cfg.databaseId}/tables/${table}/rows`,
        { rowId, data, permissions: perms });
    } catch (e) {
      if (e && e.status === 409) {
        return tablesRest(cfg, 'PUT', `/tablesdb/${cfg.databaseId}/tables/${table}/rows/${rowId}`, { data });
      }
      throw e;
    }
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
  function afterChange() {
    try {
      if (typeof window === 'undefined') return;
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
      if (typeof val !== 'string' || out[val] || isAwFileRef(val)) return;
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
      await F.uploadEntry(cfg, e.hash, e.bytes, e.mime);
      delete e.bytes; // Speicher wieder frei
    }
  }
  // Materialisiert awfile-Refs lokal (lädt + legt Blob an). Gibt {hash -> neue blob-Ref}.
  async function materializeRefs(F, cfg, store, hashes) {
    const out = {};
    for (const h of hashes || []) {
      if (!h) continue;
      try {
        const { bytes, mime } = await F.downloadEntry(cfg, F.fileIdForHash(h));
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
  async function contentToPayload(F, cfg, book, hashedByRef) {
    const map = {};
    for (const ref of Object.keys(hashedByRef)) map[ref] = hashedByRef[ref].hash;
    const { pages } = rewriteRefs(book.pages, map, 'push');
    const json = JSON.stringify({ v: 1, pages });
    const bytes = new TextEncoder().encode(json);
    if (bytes.length > OFFLOAD_BYTES) {
      const hash = await F.sha256Hex(bytes);
      await F.uploadEntry(cfg, hash, bytes, 'application/json');
      return { content: '', contentFileId: F.fileIdForHash(hash) };
    }
    return { content: json, contentFileId: null };
  }
  async function payloadToPages(F, cfg, store, row) {
    let json = row.content || '';
    if (!json && row.contentFileId) {
      try {
        const dl = await F.downloadEntry(cfg, row.contentFileId);
        json = new TextDecoder().decode(dl.bytes);
      } catch { return null; }
    }
    const pages = parseContentJson(json);
    if (!pages) return null;
    // awfile-Refs einsammeln + materialisieren
    const need = new Set();
    const scan = (v) => { const h = hashFromAwRef(v); if (h) need.add(h); };
    for (const p of pages) {
      if (Array.isArray(p.images)) for (const im of p.images) if (im) scan(im.src);
      if (typeof p.bg === 'string') scan(p.bg);
    }
    const refByHash = await materializeRefs(F, cfg, store, [...need]);
    const { pages: out } = rewriteRefs(pages, refByHash, 'pull');
    return out;
  }

  const Sync = {
    ROWMAP_KEY, LASTPULL_KEY, FOLDERS_KEY, OFFLOAD_BYTES,
    msToIso, isoToMs, rowIdForBook, isAwFileRef, hashFromAwRef,
    rewriteRefs, bookContentJson, parseContentJson, folderHash,
    planRows, makeConflictTitle, rowToNoteMeta,
    loadRowMap, saveRowMap, loadLastPull, saveLastPull,
    loadFolders, saveFolders, loadFolderMeta, saveFolderMeta,

    async syncNow(progress) {
      const F = filesApi();
      const cfg = F.loadConfig();
      const say = typeof progress === 'function' ? progress : () => {};
      const me = await F.session();
      if (!me) throw new Error('Bitte zuerst in den Appwrite-Einstellungen einloggen.');
      const userId = me.$id;
      const store = getStore();
      const books = getBooks();
      const byId = {};
      for (const b of books) byId[b.id] = b;
      let map = loadRowMap();
      const lastPull = loadLastPull();
      const summary = { pushed: 0, pulled: 0, downloaded: 0, conflicts: [], deleted: 0, errors: [] };

      // --- Remote-Delta holen ---
      say('Frage Cloud-Stand ab …');
      const userQ = [`equal("userId", "${userId}")`];
      if (lastPull.notes) userQ.push(`greaterThan("updatedAt", "${lastPull.notes}")`);
      const rows = await listRows(cfg, 'notes', [...userQ, 'orderAsc("updatedAt")']);
      const remote = {};
      let maxSeen = lastPull.notes || null;
      for (const r of rows) {
        const bid = Object.keys(map).find(k => (map[k] || {}).rowId === r.$id) || r.$id;
        remote[bid] = Object.assign(rowToNoteMeta(r), { row: r });
        if (!maxSeen || r.updatedAt > maxSeen) maxSeen = r.updatedAt;
      }
      const local = {};
      for (const b of books) {
        local[b.id] = { hash: '', updatedAtMs: b.updatedAt || 0 };
      }
      const F2 = F;
      const contentHashOf = async (b) => {
        const hashed = await hashRefsInPages(b.pages, store, F2);
        const rmap = {};
        for (const ref of Object.keys(hashed)) rmap[ref] = hashed[ref].hash;
        const { pages } = rewriteRefs(b.pages, rmap, 'push');
        return F2.sha256Hex(new TextEncoder().encode(JSON.stringify({ v: 1, pages })));
      };
      // Content-Hash aller lokalen Bücher (Buchzahl klein, Hash schnell).
      for (const b of books) {
        try { local[b.id].hash = await contentHashOf(b); }
        catch (e) { summary.errors.push('hash ' + b.id + ': ' + e.message); local[b.id].hash = 'err'; }
      }
      const localClean = {};
      for (const k of Object.keys(local)) if (local[k]) localClean[k] = local[k];
      const plan = planRows(localClean, remote, map);

      const touchMeta = (id, patch) => { map[id] = Object.assign({}, map[id], patch); };

      // --- Adopt: beidseitig ohne Meta -> Inhalt vergleichen ---
      for (const { id } of plan.adopt) {
        const r = remote[id].row;
        try {
          const pages = await payloadToPages(F, cfg, store, r);
          const rh = pages ? await F.sha256Hex(new TextEncoder().encode(JSON.stringify({ v: 1, pages }))) : 'unlesbar';
          if (rh === localClean[id].hash) {
            touchMeta(id, { rowId: r.$id, hash: rh, remoteUpdatedAtMs: remote[id].updatedAtMs });
          } else {
            plan.conflict.push({ id });
          }
        } catch (e) { summary.errors.push('adopt ' + id + ': ' + e.message); }
      }
      // --- Pull ---
      for (const { id } of plan.pull) {
        const r = remote[id].row;
        try {
          const pages = await payloadToPages(F, cfg, store, r);
          if (!pages) throw new Error('Inhalt unlesbar');
          const b = byId[id];
          b.title = r.title || b.title;
          b.folderId = r.folderId || null;
          b.pages = pages;
          b.updatedAt = remote[id].updatedAtMs;
          if (store && store.extractBook) await store.extractBook(b).catch(() => {});
          touchMeta(id, { rowId: r.$id, hash: localClean[id] ? await contentHashOf(b) : undefined, remoteUpdatedAtMs: remote[id].updatedAtMs });
          summary.pulled++;
        } catch (e) { summary.errors.push('pull ' + id + ': ' + e.message); }
      }
      // --- Konflikt: Remote gewinnt, lokal als Kopie ---
      for (const { id } of plan.conflict) {
        const r = remote[id].row;
        try {
          const pages = await payloadToPages(F, cfg, store, r);
          if (!pages) throw new Error('Inhalt unlesbar');
          const b = byId[id];
          const copy = JSON.parse(JSON.stringify(b));
          copy.id = 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          copy.title = makeConflictTitle(b.title, Date.now());
          books.unshift(copy);
          map[copy.id] = { rowId: rowIdForBook(copy.id), hash: undefined, remoteUpdatedAtMs: 0 };
          b.title = r.title || b.title;
          b.folderId = r.folderId || null;
          b.pages = pages;
          b.updatedAt = remote[id].updatedAtMs;
          if (store && store.extractBook) await store.extractBook(b).catch(() => {});
          touchMeta(id, { rowId: r.$id, remoteUpdatedAtMs: remote[id].updatedAtMs });
          try { touchMeta(id, { hash: await contentHashOf(b) }); } catch { /* ignore */ }
          summary.conflicts.push(b.title);
        } catch (e) { summary.errors.push('konflikt ' + id + ': ' + e.message); }
      }
      // --- Download (nur remote vorhanden) ---
      for (const { id } of plan.download) {
        const r = remote[id].row;
        try {
          const pages = await payloadToPages(F, cfg, store, r);
          if (!pages) throw new Error('Inhalt unlesbar');
          const nb = {
            id: r.$id && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/.test(r.$id) ? r.$id : rowIdForBook(id),
            title: r.title || 'Importiert', paper: 'grid', updatedAt: remote[id].updatedAtMs,
            folderId: r.folderId || null, pages,
          };
          if (store && store.extractBook) await store.extractBook(nb).catch(() => {});
          books.unshift(nb);
          byId[nb.id] = nb;
          try {
            touchMeta(nb.id, { rowId: r.$id, hash: await contentHashOf(nb), remoteUpdatedAtMs: remote[id].updatedAtMs });
          } catch { touchMeta(nb.id, { rowId: r.$id, remoteUpdatedAtMs: remote[id].updatedAtMs }); }
          summary.downloaded++;
        } catch (e) { summary.errors.push('download ' + id + ': ' + e.message); }
      }
      // --- Push (neu / geändert / revived) ---
      for (const { id, reason } of plan.push) {
        const b = byId[id];
        if (!b) continue;
        say(`Lade hoch (${reason}) …`);
        try {
          const rowId = (map[id] && map[id].rowId) || rowIdForBook(id);
          const hashed = await hashRefsInPages(b.pages, store, F);
          await ensureUploaded(F, cfg, hashed);
          const payload = await contentToPayload(F, cfg, b, hashed);
          const nowIso = msToIso(Date.now());
          const m = map[id] || {};
          const data = {
            userId,
            title: b.title || '',
            content: payload.content,
            contentFileId: payload.contentFileId,
            folderId: b.folderId || null,
            createdAt: m.createdAtMs ? msToIso(m.createdAtMs) : nowIso,
            updatedAt: nowIso,
            deletedAt: null,
          };
          await upsertRow(cfg, 'notes', rowId, data, userId);
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
          const rowId = (map[id] && map[id].rowId) || rowIdForBook(id);
          const nowIso = msToIso(Date.now());
          const m = map[id] || {};
          await upsertRow(cfg, 'notes', rowId, {
            userId, title: '(gelöscht)', content: '', contentFileId: null, folderId: null,
            createdAt: m.createdAtMs ? msToIso(m.createdAtMs) : nowIso,
            updatedAt: nowIso, deletedAt: nowIso,
          }, userId);
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
      try { await Sync.syncFolders(cfg, userId, say); }
      catch (e) { summary.errors.push('folders: ' + e.message); }

      if (maxSeen) { lastPull.notes = maxSeen; saveLastPull(lastPull); }
      saveRowMap(map);
      afterChange();
      return summary;
    },

    async syncFolders(cfg, userId, say) {
      say = typeof say === 'function' ? say : () => {};
      const mirror = loadFolders();
      const fmeta = loadFolderMeta();
      const rows = await listRows(cfg, 'folders', [`equal("userId", "${userId}")`, 'orderAsc("updatedAt")']);
      const remote = {};
      for (const r of rows) remote[r.$id] = r;
      // Pull: remote neuer/ unbekannt
      for (const rid of Object.keys(remote)) {
        const r = remote[rid];
        const rms = isoToMs(r.updatedAt);
        const m = fmeta[rid];
        const cur = mirror[rid];
        const curHash = cur ? folderHash(cur) : undefined;
        if (!m || rms > (m.remoteUpdatedAtMs || 0)) {
          if (r.name == null) continue;
          if (!cur || (m && curHash === m.hash)) {
            mirror[rid] = { name: r.name || '', parentId: r.parentId || null, updatedAtMs: rms };
            fmeta[rid] = { hash: folderHash(mirror[rid]), remoteUpdatedAtMs: rms };
          } else {
            // beidseitig geändert -> remote gewinnt (Ordner sind billig)
            mirror[rid] = { name: r.name || '', parentId: r.parentId || null, updatedAtMs: rms };
            fmeta[rid] = { hash: folderHash(mirror[rid]), remoteUpdatedAtMs: rms };
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
          await tablesRest(cfg, 'PUT', `/tablesdb/${cfg.databaseId}/tables/folders/rows/${fid}`,
            { data: { name: cur.name || '(gelöscht)', parentId: null, deletedAt: nowIso, updatedAt: nowIso } }).catch(() => null);
          delete mirror[fid]; delete fmeta[fid];
          continue;
        }
        const h = folderHash(cur);
        if (m.hash !== h) {
          const nowIso = msToIso(Date.now());
          await upsertRow(cfg, 'folders', rowIdForBook(fid), {
            userId, name: cur.name || '', parentId: cur.parentId || null, updatedAt: nowIso,
          }, userId);
          fmeta[fid] = { hash: h, remoteUpdatedAtMs: isoToMs(nowIso) };
        }
      }
      void referenced;
      saveFolders(mirror); saveFolderMeta(fmeta);
    },

    /* ---------- Realtime ---------- */
    _rt: { ws: null, onChange: null, retry: null, connected: false },
    rtChannels(cfg) {
      return [
        `databases.${cfg.databaseId}.tables.notes.rows`,
        `databases.${cfg.databaseId}.tables.folders.rows`,
      ];
    },
    startRealtime(onChange) {
      const F = filesApi();
      const cfg = F.loadConfig();
      Sync.stopRealtime();
      const st = Sync._rt;
      st.onChange = typeof onChange === 'function' ? onChange : null;
      if (typeof WebSocket === 'undefined') throw new Error('kein WebSocket');
      const url = cfg.endpoint.replace(/^http/, 'ws') + `/realtime?project=${cfg.projectId}`;
      const ws = new WebSocket(url);
      st.ws = ws;
      let deb = null;
      const fire = () => {
        clearTimeout(deb);
        deb = setTimeout(() => { try { st.onChange && st.onChange(); } catch { /* ignore */ } }, 2500);
      };
      ws.onopen = () => {
        st.connected = true;
        try { ws.send(JSON.stringify({ type: 'subscribe', data: { channels: Sync.rtChannels(cfg) } })); }
        catch { /* ignore */ }
      };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m && m.type === 'event') fire();
        } catch { /* ignore */ }
      };
      ws.onerror = () => { /* still, weiter manuell */ };
      ws.onclose = () => {
        st.connected = false;
        st.ws = null;
        clearTimeout(st.retry);
        st.retry = setTimeout(() => {
          if (st.onChange) { try { Sync.startRealtime(st.onChange); } catch { /* ignore */ } }
        }, 15000);
      };
      return true;
    },
    stopRealtime() {
      const st = Sync._rt;
      clearTimeout(st.retry);
      st.onChange = null;
      try { if (st.ws) st.ws.close(); } catch { /* ignore */ }
      st.ws = null; st.connected = false;
    },
    rtStatus() { return Sync._rt.connected ? 'verbunden' : 'aus'; },
  };

  /* ---------- UI-Glue (nur Browser) ---------- */
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const UI = {
      _el(id) { try { return document.getElementById(id); } catch { return null; } },
      _say(t) { const el = UI._el('awDbStatus'); if (el) el.textContent = t; },
      async syncNow() {
        UI._say('☁ Notizen werden synchronisiert …');
        try {
          const r = await Sync.syncNow(s => UI._say('☁ ' + s));
          let s = `☁ Notizen fertig: ⬆${r.pushed} ⬇${r.pulled + r.downloaded}`;
          if (r.conflicts.length) s += ` | ⚠ Konflikt: ${r.conflicts.join(', ')} (als Kopie behalten)`;
          if (r.deleted) s += ` | 🗑 ${r.deleted} gelöscht`;
          if (r.errors.length) s += ` | ⚠ ${r.errors.length} Fehler`;
          UI._say(s);
          const fw = window.FederwerkFilesUI;
          if (fw && fw.refresh) fw.refresh(false);
        } catch (e) {
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
            UI._say('☁ Realtime an – Änderungen stoßen Sync an.');
          } else {
            Sync.stopRealtime();
            UI._say('☁ Realtime aus – nur manueller Sync.');
          }
        } catch (e) { UI._say('☁ Realtime-Fehler: ' + e.message); }
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
