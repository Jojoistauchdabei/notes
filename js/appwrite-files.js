/* Federwerk Datei-Sync mit Speicheroptimierung (Appwrite Storage).
 *
 * Idee: Bilder/PDFs liegen lokal als `blob:<id>`-Refs (js/store.js, bereits
 * JPEG-komprimiert). Dieses Modul spiegelt sie per Content-Hash in den
 * Appwrite-Bucket `attachments`:
 *
 * - Dedupe: Dateiname = `fw` + SHA-256 (32 Zeichen). Existiert die Datei
 *   remote schon (409 beim Upload), wird nichts doppelt hochgeladen.
 * - Recompress: Bilder werden vor dem Upload auf max. 1600px lange Kante
 *   skaliert; opake Bilder als JPEG (0.82), mit Alpha als WebP/PNG.
 *   Was nicht kleiner wird, wird unverändert hochgeladen.
 * - Orphan-Cleanup: Remote-Dateien ohne lokale Referenz werden (auf
 *   Wunsch) gelöscht; lokale fileMap-Einträge ohne Referenz verfallen.
 * - Offline-first: Fehlgeschlagene Uploads landen in einer Queue und werden
 *   beim nächsten Sync erneut versucht. Kein Build, plain <script>.
 * - DOM-frei ladbar: reine Kernfunktionen sind in Node testbar.
 */
(function () {
  'use strict';

  const MAP_KEY = 'federwerkFileMapV1';   // hash -> {fileId, mime, size, at}
  const QUEUE_KEY = 'federwerkFileQueueV1'; // [{hash, ref, tries}]
  const CFG_KEY = 'federwerkAppwriteV1';
  // Session-Secret (aus Login-Antwort). Fällt im Tauri-WebView der
  // Third-Party-Cookie weg, trägt der `X-Appwrite-Session`-Header die Auth.
  const SESSION_KEY = 'federwerkAwSessionV1'; // {secret, userId, at}

  const DEFAULTS = {
    endpoint: 'https://fra.cloud.appwrite.io/v1',
    projectId: '6ab0067c00244c28560a',
    databaseId: 'federwerk',
    bucketId: 'attachments',
  };
  const FILE_PREFIX = 'fw';
  const MAX_LONG_EDGE = 1600;
  const JPEG_Q = 0.82;
  const WEBP_Q = 0.85;

  // Injizierbarer Speicher (Tests nutzen Memory statt localStorage).
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

  function normalizeMime(m) {
    m = String(m || '').toLowerCase().split(';')[0].trim();
    if (m === 'image/jpg') return 'image/jpeg';
    return m;
  }
  function extForMime(mime) {
    switch (normalizeMime(mime)) {
      case 'image/jpeg': return 'jpg';
      case 'image/png': return 'png';
      case 'image/webp': return 'webp';
      case 'image/gif': return 'gif';
      case 'application/pdf': return 'pdf';
      case 'application/json': return 'json';
      default: return 'bin';
    }
  }
  // Stabile, Appwrite-taugliche Datei-ID (34 Zeichen, alphanumerisch).
  function fileIdForHash(hash) {
    const h = String(hash || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    if (h.length < 32) throw new Error('hash zu kurz');
    return FILE_PREFIX + h.slice(0, 32);
  }
  // Inverse für Orphan-Abgleich: Datei-ID -> Hash-Präfix (oder null).
  function hashFromFileId(fileId) {
    const m = /^fw([0-9a-f]{32})$/i.exec(String(fileId || ''));
    return m ? m[1].toLowerCase() : null;
  }
  async function sha256Hex(bytes) {
    const c = (typeof crypto !== 'undefined' && crypto.subtle)
      || (typeof require === 'function' && require('crypto').webcrypto.subtle);
    if (!c) throw new Error('kein subtle crypto');
    const d = await c.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function base64ToBytes(b64) {
    const bin = (typeof atob !== 'undefined') ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let bin = '';
    const CH = 8192;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin);
  }
  function dataUrlToBytes(du) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(du || '');
    if (!m) throw new Error('kein dataURL');
    const mime = normalizeMime(m[1] || 'image/jpeg');
    const bytes = m[2] ? base64ToBytes(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3]));
    return { mime, bytes };
  }
  // Reine Upload-Entscheidung (ohne Pixel): was lohnt Recompress?
  function pickTarget(mime, size) {
    mime = normalizeMime(mime);
    if (mime === 'application/pdf' || mime === 'image/gif') return { mime, recompress: false, reason: 'keep' };
    if (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp') {
      if ((size || 0) >= 200 * 1024) return { mime, recompress: true, reason: 'large' };
      return { mime, recompress: false, reason: 'small' };
    }
    return { mime, recompress: false, reason: 'unknown' };
  }
  // Abgleich lokal vs. remote. local: {hash: {size, ref}}, remote: {fileId: {size}}.
  function planFileSync(local, remote) {
    local = local || {}; remote = remote || {};
    const upload = [], download = [], upToDate = [], remoteExtra = [];
    const seenRemote = new Set();
    for (const hash of Object.keys(local)) {
      let fid = null;
      try { fid = fileIdForHash(hash); } catch { continue; }
      seenRemote.add(fid);
      if (remote[fid]) upToDate.push(hash);
      else upload.push(hash);
    }
    for (const fid of Object.keys(remote)) if (!seenRemote.has(fid)) remoteExtra.push(fid);
    // Remote-Extras ohne lokale Entsprechung sind Download-Kandidaten,
    // sofern sie nicht als Orphans erkannt werden (entscheidet der Aufrufer).
    for (const fid of remoteExtra) download.push(fid);
    return { upload, download, upToDate, remoteExtra };
  }
  // Remote-Dateien ohne lokale Referenz (Orphans) zum Löschen vorschlagen.
  function findOrphans(referencedHashes, remoteFileIds) {
    const ref = new Set((referencedHashes || []).map(h => String(h).toLowerCase().slice(0, 32)));
    return (remoteFileIds || []).filter(fid => {
      const h = hashFromFileId(fid);
      return h ? !ref.has(h) : false; // nur fw-Dateien anfassen, Fremdes nie
    });
  }
  function storageReport(local, remote) {
    local = local || {}; remote = remote || {};
    let localBytes = 0, remoteBytes = 0;
    for (const k of Object.keys(local)) localBytes += (local[k] && local[k].size) || 0;
    for (const k of Object.keys(remote)) remoteBytes += (remote[k] && remote[k].size) || 0;
    const plan = planFileSync(local, remote);
    return {
      localCount: Object.keys(local).length, localBytes,
      remoteCount: Object.keys(remote).length, remoteBytes,
      missingUpload: plan.upload.length, missingDownload: plan.download.length,
      upToDate: plan.upToDate.length,
    };
  }
  function queueAdd(q, item) {
    q = Array.isArray(q) ? q.slice() : [];
    if (!q.some(e => e && e.hash === item.hash)) q.push({ hash: item.hash, ref: item.ref, tries: 0 });
    return q;
  }
  function queueNext(q) {
    q = Array.isArray(q) ? q.slice() : [];
    const item = q.shift() || null;
    return { item, rest: q };
  }

  /* ---------- Konfiguration ---------- */

  function loadConfig() { return Object.assign({}, DEFAULTS, lsGet(CFG_KEY, {})); }
  function saveConfig(patch) {
    const cfg = Object.assign(loadConfig(), patch || {});
    lsSet(CFG_KEY, cfg);
    return cfg;
  }
  function loadMap() { return lsGet(MAP_KEY, {}); }
  function saveMap(m) { lsSet(MAP_KEY, m || {}); }
  function loadQueue() { return lsGet(QUEUE_KEY, []); }
  function saveQueue(q) { lsSet(QUEUE_KEY, q || []); }
  function loadSession() { return lsGet(SESSION_KEY, null); }
  function saveSession(s) { if (s) lsSet(SESSION_KEY, s); }
  function clearSession() {
    const s = ls();
    if (!s) return;
    try { s.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }
  // Header-Bauer (rein, testbar): Secret ergänzt Cookie-Auth (Tauri-Fix).
  function authHeaders(cfg, session) {
    const h = { 'X-Appwrite-Project': cfg.projectId };
    const sec = (session && session.secret) || (loadSession() || {}).secret;
    if (sec) h['X-Appwrite-Session'] = sec;
    return h;
  }

  /* ---------- Appwrite REST (Browser) ---------- */

  function needBrowser() {
    if (typeof fetch === 'undefined') throw new Error('kein fetch');
  }
  async function rest(cfg, method, path, opts) {
    needBrowser();
    opts = opts || {};
    const headers = authHeaders(cfg, opts.session);
    if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const r = await fetch(cfg.endpoint + path, {
      method, headers, credentials: 'include',
      body: opts.body instanceof FormData ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined),
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
  async function listAllFiles(cfg) {
    const out = [];
    let cursor = null;
    for (let page = 0; page < 50; page++) {
      const params = ['limit(100)', 'orderAsc("$createdAt")'];
      if (cursor) params.push(`cursorAfter("${cursor}")`);
      const j = await rest(cfg, 'GET', `/storage/buckets/${cfg.bucketId}/files${q(params)}`);
      const files = (j && j.files) || [];
      for (const f of files) out.push({ fileId: f.$id, size: f.sizeOriginal || 0, mime: f.mimeType || '' });
      if (files.length < 100) break;
      cursor = files[files.length - 1].$id;
    }
    const map = {};
    for (const f of out) map[f.fileId] = { size: f.size, mime: f.mime };
    return map;
  }

  /* ---------- Bild-Optimierung (Browser, Canvas) ---------- */

  function hasCanvas() {
    try {
      return typeof document !== 'undefined' && !!document.createElement
        && typeof createImageBitmap !== 'undefined';
    } catch { return false; }
  }
  function blobToBytes(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer().then(ab => new Uint8Array(ab));
    return new Promise((resolve, reject) => {
      try {
        const r = new FileReader();
        r.onload = () => resolve(new Uint8Array(r.result));
        r.onerror = () => reject(new Error('read'));
        r.readAsArrayBuffer(blob);
      } catch (e) { reject(e); }
    });
  }
  function canvasToBytes(canvas, mime, quality) {
    return new Promise((resolve) => {
      try {
        if (canvas.toBlob) canvas.toBlob(async b => {
          if (!b) { resolve(null); return; }
          try { resolve({ bytes: await blobToBytes(b), mime: b.type || mime }); }
          catch { resolve(null); }
        }, mime, quality);
        else resolve(null);
      } catch { resolve(null); }
    });
  }
  // Skaliert + transkodiert; gibt Original zurück, wenn nichts zu holen ist.
  async function optimizeImage(bytes, mime) {
    mime = normalizeMime(mime);
    if (!hasCanvas()) return { bytes, mime, optimized: false, reason: 'no-canvas' };
    const plan = pickTarget(mime, bytes.length);
    if (!plan.recompress && bytes.length < 200 * 1024) return { bytes, mime, optimized: false, reason: plan.reason };
    try {
      const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
      const sc = Math.min(1, MAX_LONG_EDGE / Math.max(bmp.width || 1, bmp.height || 1));
      const w = Math.max(1, Math.round(bmp.width * sc)), h = Math.max(1, Math.round(bmp.height * sc));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      // Alpha? (Stichprobe, max ~20k Pixel lesen)
      let opaque = true;
      try {
        const step = Math.max(1, Math.floor((w * h) / 20000));
        const d = ctx.getImageData(0, 0, w, h).data;
        for (let i = 3; i < d.length; i += 4 * step) { if (d[i] < 250) { opaque = false; break; } }
      } catch { opaque = mime !== 'image/png' && mime !== 'image/webp'; }
      const order = opaque ? ['image/jpeg'] : ['image/webp', 'image/png'];
      for (const tm of order) {
        const q = tm === 'image/jpeg' ? JPEG_Q : WEBP_Q;
        const out = await canvasToBytes(canvas, tm, q);
        if (out && out.bytes && out.bytes.length < bytes.length) {
          return { bytes: out.bytes, mime: normalizeMime(out.mime), optimized: true, reason: opaque ? 'jpeg' : 'alpha', w, h };
        }
        if (tm === 'image/png') break; // PNG-Fallback: kein Recompress möglich
      }
      // Herunterskaliert, aber nicht kleiner? Dann ggf. skalierte Version nehmen.
      if (sc < 1) {
        const out = await canvasToBytes(canvas, 'image/jpeg', JPEG_Q);
        if (out && out.bytes && out.bytes.length < bytes.length) {
          return { bytes: out.bytes, mime: 'image/jpeg', optimized: true, reason: 'scaled', w, h };
        }
      }
      return { bytes, mime, optimized: false, reason: 'no-gain' };
    } catch { return { bytes, mime, optimized: false, reason: 'error' }; }
  }

  /* ---------- Sync-Logik ---------- */

  async function resolveLocalBytes(refOrDataUrl, store) {
    if (typeof refOrDataUrl === 'string' && refOrDataUrl.startsWith('data:')) {
      return dataUrlToBytes(refOrDataUrl);
    }
    if (store && store.dataUrl) {
      const du = await store.dataUrl(refOrDataUrl);
      return dataUrlToBytes(du);
    }
    throw new Error('unauflösbar');
  }
  // books: [{pages:[{images:[{src}], bg}]}] – store: GrimoireStore-artig.
  async function collectLocalEntries(books, store) {
    const refs = [];
    for (const b of books || []) {
      if (!b || !Array.isArray(b.pages)) continue;
      for (const p of b.pages) {
        if (Array.isArray(p.images)) for (const im of p.images) if (im && im.src) refs.push(im.src);
        if (p.bg) refs.push(p.bg);
      }
    }
    const entries = {};
    for (const ref of refs) {
      try {
        const { mime, bytes } = await resolveLocalBytes(ref, store);
        const hash = await sha256Hex(bytes);
        if (!entries[hash]) entries[hash] = { hash, size: bytes.length, mime, ref };
      } catch { /* einzelne defekte Refs überspringen */ }
    }
    return entries;
  }
  async function uploadEntry(cfg, hash, bytes, mime) {
    const fileId = fileIdForHash(hash);
    const opt = await optimizeImage(bytes, mime);
    const name = fileId + '.' + extForMime(opt.mime);
    const fd = new FormData();
    fd.append('fileId', fileId);
    fd.append('file', new File([opt.bytes], name, { type: opt.mime }));
    try {
      await rest(cfg, 'POST', `/storage/buckets/${cfg.bucketId}/files`, { body: fd });
      return { fileId, dedup: false, optimized: opt.optimized, size: opt.bytes.length };
    } catch (e) {
      if (e && e.status === 409) return { fileId, dedup: true, optimized: false, size: opt.bytes.length };
      throw e;
    }
  }
  async function downloadEntry(cfg, fileId) {
    needBrowser();
    const headers = authHeaders(cfg);
    const r = await fetch(`${cfg.endpoint}/storage/buckets/${cfg.bucketId}/files/${fileId}/view`, {
      headers, credentials: 'include',
    });
    if (!r.ok) throw new Error('Download HTTP ' + r.status);
    const ab = await r.arrayBuffer();
    return { bytes: new Uint8Array(ab), mime: normalizeMime(r.headers.get('content-type') || '') };
  }

  const Files = {
    DEFAULTS, FILE_PREFIX, MAX_LONG_EDGE,
    loadConfig, saveConfig, loadMap, saveMap, loadQueue, saveQueue,
    loadSession, saveSession, clearSession, authHeaders,
    normalizeMime, extForMime, fileIdForHash, hashFromFileId, sha256Hex,
    dataUrlToBytes, bytesToBase64, base64ToBytes, pickTarget,
    planFileSync, findOrphans, storageReport, queueAdd, queueNext,
    collectLocalEntries, optimizeImage, uploadEntry, downloadEntry, listAllFiles,

    async session() {
      const cfg = loadConfig();
      try { return await rest(cfg, 'GET', '/account'); }
      catch (e) {
        if (e && e.status === 401) { clearSession(); return null; }
        throw e;
      }
    },
    async loginEmail(email, password) {
      const cfg = loadConfig();
      const j = await rest(cfg, 'POST', '/account/sessions/email', { body: { email, password } });
      // Secret sichern: trägt im Tauri-WebView die Auth, wenn Cookies blockiert sind.
      if (j && j.secret) saveSession({ secret: j.secret, userId: j.userId || null, at: new Date().toISOString() });
      return j;
    },
    async logout() {
      const cfg = loadConfig();
      try { await rest(cfg, 'DELETE', '/account/sessions/current'); } catch { /* ignore */ }
      clearSession();
    },
    // Voller Datei-Sync: Upload fehlender, Download fehlender, Map+Queue pflegen.
    async syncNow(progress) {
      const cfg = loadConfig();
      const say = typeof progress === 'function' ? progress : () => {};
      const me = await Files.session();
      if (!me) throw new Error('Bitte zuerst in den Appwrite-Einstellungen einloggen.');
      const books = (typeof window !== 'undefined' && window.state && Array.isArray(window.state.books))
        ? window.state.books : [];
      const store = (typeof window !== 'undefined' && window.GrimoireStore) ? window.GrimoireStore : null;
      say('Sammle lokale Dateien …');
      const local = await collectLocalEntries(books, store);
      say('Frage Remote-Stand ab …');
      const remote = await listAllFiles(cfg);
      const plan = planFileSync(local, remote);
      const map = loadMap();
      let up = 0, down = 0, dedup = 0, opt = 0;
      const errors = [];
      let queue = loadQueue();
      // Queue zuerst (alte Versuche)
      for (const qe of queue.slice()) {
        const e = local[qe.hash];
        if (!e) continue;
        try {
          const { mime, bytes } = await resolveLocalBytes(e.ref, store);
          const r = await uploadEntry(cfg, qe.hash, bytes, mime);
          map[qe.hash] = { fileId: r.fileId, mime, size: r.size, at: new Date().toISOString() };
          queue = queue.filter(x => x.hash !== qe.hash);
          up++; if (r.dedup) dedup++; if (r.optimized) opt++;
        } catch (err) { errors.push('queue ' + qe.hash.slice(0, 8) + ': ' + err.message); }
      }
      for (const hash of plan.upload) {
        const e = local[hash];
        say(`Lade hoch ${up + 1}/${plan.upload.length} …`);
        try {
          const { mime, bytes } = await resolveLocalBytes(e.ref, store);
          const r = await uploadEntry(cfg, hash, bytes, mime);
          map[hash] = { fileId: r.fileId, mime, size: r.size, at: new Date().toISOString() };
          queue = queue.filter(x => x.hash !== hash);
          up++; if (r.dedup) dedup++; if (r.optimized) opt++;
        } catch (err) {
          errors.push('upload ' + hash.slice(0, 8) + ': ' + err.message);
          queue = queueAdd(queue, { hash, ref: e.ref });
        }
      }
      for (const fid of plan.download) {
        if (!hashFromFileId(fid)) continue; // Fremddateien nicht anfassen
        say(`Lade herunter ${down + 1}/${plan.download.length} …`);
        try {
          const { bytes, mime } = await downloadEntry(cfg, fid);
          const hash = await sha256Hex(bytes);
          map[hash] = { fileId: fid, mime, size: bytes.length, at: new Date().toISOString() };
          if (store && store.putBlob) {
            const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
            await store.putBlob(blob).catch(() => null);
          }
          down++;
        } catch (err) { errors.push('download ' + fid + ': ' + err.message); }
      }
      // fileMap: verwaiste Einträge (weder lokal noch remote) vergessen
      const refHashes = new Set(Object.keys(local));
      for (const fid of Object.keys(remote)) {
        const h = hashFromFileId(fid);
        if (h) refHashes.add(h);
      }
      for (const h of Object.keys(map)) {
        try { if (!refHashes.has(h) && !refHashes.has(fileIdForHash(h).slice(2))) delete map[h]; }
        catch { /* ignore */ }
      }
      saveMap(map); saveQueue(queue);
      return {
        uploaded: up, downloaded: down, dedupHits: dedup, optimized: opt,
        upToDate: plan.upToDate.length, queued: queue.length, errors,
        report: storageReport(local, remote),
      };
    },
    // Orphan-Cleanup: dryRun=true listet nur.
    async cleanupOrphans(dryRun) {
      const cfg = loadConfig();
      const me = await Files.session();
      if (!me) throw new Error('Bitte zuerst einloggen.');
      const books = (typeof window !== 'undefined' && window.state && Array.isArray(window.state.books))
        ? window.state.books : [];
      const store = (typeof window !== 'undefined' && window.GrimoireStore) ? window.GrimoireStore : null;
      const local = await collectLocalEntries(books, store);
      const remote = await listAllFiles(cfg);
      const orphans = findOrphans(Object.keys(local), Object.keys(remote));
      let deleted = 0, freed = 0;
      if (!dryRun) {
        for (const fid of orphans) {
          try {
            freed += (remote[fid] && remote[fid].size) || 0;
            await rest(cfg, 'DELETE', `/storage/buckets/${cfg.bucketId}/files/${fid}`);
            deleted++;
          } catch { /* weiter */ }
        }
      } else {
        for (const fid of orphans) freed += (remote[fid] && remote[fid].size) || 0;
      }
      return { orphans, deleted, freedBytes: freed, checked: Object.keys(remote).length };
    },
    _internals: {
      _setLsBackend(b) { lsBackend = b; },
      _resetLs() { lsBackend = null; },
    },
  };

  /* ---------- UI-Glue (nur Browser) ---------- */
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const UI = {
      _el(id) { try { return document.getElementById(id); } catch { return null; } },
      _say(t) { const el = UI._el('awStatus'); if (el) el.textContent = t; },
      _msg(t, isErr) {
        const el = UI._el('awMsg');
        if (el) { el.textContent = t; el.style.color = isErr ? '#a33' : ''; }
      },
      refresh(showLogin) {
        try {
          const cfg = Files.loadConfig();
          UI._say(`Appwrite-Dateien: ${cfg.databaseId} / ${cfg.bucketId} @ ${cfg.endpoint.replace('https://', '')}`);
          if (showLogin) {
            Files.session().then(
              me => UI._say(me ? `Appwrite: eingeloggt als ${me.email || me.name || me.$id}` : 'Appwrite: nicht eingeloggt – bitte in ⚙ einloggen.'),
              () => UI._say('Appwrite: offline oder nicht erreichbar.')
            );
          }
        } catch { /* ignore */ }
      },
      openSettings() {
        const cfg = Files.loadConfig();
        const set = (id, v) => { const el = UI._el(id); if (el) el.value = v || ''; };
        set('awEndpoint', cfg.endpoint); set('awProject', cfg.projectId);
        set('awDatabase', cfg.databaseId); set('awBucket', cfg.bucketId);
        const rt = UI._el('awRealtime'); if (rt) rt.checked = !!cfg.realtime;
        UI._msg('');
        const ov = UI._el('awOverlay');
        if (ov) ov.classList.add('active');
        UI.refresh(true);
      },
      closeSettings() { const ov = UI._el('awOverlay'); if (ov) ov.classList.remove('active'); },
      save() {
        const get = id => { const el = UI._el(id); return el ? el.value.trim() : ''; };
        const cfg = Files.saveConfig({
          endpoint: get('awEndpoint') || DEFAULTS.endpoint,
          projectId: get('awProject') || DEFAULTS.projectId,
          databaseId: get('awDatabase') || DEFAULTS.databaseId,
          bucketId: get('awBucket') || DEFAULTS.bucketId,
        });
        UI._msg(`Gespeichert: ${cfg.databaseId} / ${cfg.bucketId}.`);
        UI.refresh(true);
      },
      async login() {
        const get = id => { const el = UI._el(id); return el ? el.value : ''; };
        UI._msg('Logge ein …');
        try {
          await Files.loginEmail(get('awEmail'), get('awPass'));
          const pw = UI._el('awPass'); if (pw) pw.value = '';
          UI._msg('Eingeloggt.');
          UI.refresh(true);
        } catch (e) { UI._msg('Login fehlgeschlagen: ' + e.message, true); }
      },
      async logout() {
        await Files.logout();
        UI._msg('Ausgeloggt.');
        UI.refresh(true);
      },
      async syncNow() {
        UI._say('☁ Dateien werden synchronisiert …');
        try {
          const r = await Files.syncNow(s => UI._say('☁ ' + s));
          let s = `☁ Dateien fertig: ⬆${r.uploaded} ⬇${r.downloaded} ✓(${r.upToDate})`;
          if (r.dedupHits) s += `, ${r.dedupHits}× Dedupe`;
          if (r.optimized) s += `, ${r.optimized}× optimiert`;
          if (r.queued) s += `, ${r.queued} in Queue`;
          if (r.errors.length) s += ` | ⚠ ${r.errors.length} Fehler (Konsole)`;
          UI._say(s + ' · ' + new Date().toLocaleTimeString('de-DE'));
          if (r.errors.length && typeof console !== 'undefined') console.warn(r.errors);
        } catch (e) {
          UI._say('☁ Datei-Sync fehlgeschlagen: ' + e.message);
          if (typeof alert !== 'undefined') alert('Datei-Sync fehlgeschlagen:\n' + e.message);
        }
      },
      async dryRun() {
        UI._msg('Prüfe verwaiste Dateien …');
        try {
          const r = await Files.cleanupOrphans(true);
          const kb = Math.round(r.freedBytes / 1024);
          UI._msg(`${r.checked} geprüft, ${r.orphans.length} verwaist (${kb} KB würden frei).`);
        } catch (e) { UI._msg('Fehler: ' + e.message, true); }
      },
      async cleanup() {
        if (typeof confirm !== 'undefined' && !confirm('Verwaiste Remote-Dateien wirklich löschen?')) return;
        UI._msg('Lösche verwaiste Dateien …');
        try {
          const r = await Files.cleanupOrphans(false);
          const kb = Math.round(r.freedBytes / 1024);
          UI._msg(`${r.deleted} gelöscht, ${kb} KB frei.`);
        } catch (e) { UI._msg('Fehler: ' + e.message, true); }
      },
    };
    window.FederwerkFilesUI = UI;
    document.addEventListener('DOMContentLoaded', () => UI.refresh(false));
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = Files;
  else if (typeof window !== 'undefined') window.FederwerkFiles = Files;
})();
