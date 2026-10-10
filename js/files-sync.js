/* Federwerk Datei-Sync mit Speicheroptimierung (eigener Server, server/files.js).
 *
 * Idee: Bilder/PDFs liegen lokal als `blob:<id>`-Refs (js/store.js, bereits
 * JPEG-komprimiert). Dieses Modul spiegelt sie per Content-Hash auf den
 * Server, der sie unter ihrem SHA-256 ablegt:
 *
 * - Dedupe: Dateiname = `fw` + SHA-256 (32 Zeichen). Der Server erkennt den
 *   Inhalt selbst wieder (Antwortfeld `deduplicated`), es wird nichts doppelt
 *   gespeichert.
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
  const REALTIME_KEY = 'federwerkRealtimeV1';
  // DEFAULTS ist leer: der Server liegt unter demselben Origin wie die App.
  // Das ist Absicht - dadurch greifen die Service-Worker-Regeln auch fuer die
  // API und der Browser haengt das Session-Cookie ohne Sonderbehandlung an.
  const DEFAULTS = {};
  // Datei-Prefix und Endung bleiben unveraendert. Der Server legt Dateien
  // unter <sha256>.<ext> ab, aber der lokale Dedupe- und Referenz-Algorithmus
  // rechnet weiter mit `fw` + 32 Hex. Die beiden Welten muessen nicht gleich
  // sein, solange der Client nie daraus einen Pfad baut - und das tut er nicht.
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
  // Stabile Datei-ID (34 Zeichen, alphanumerisch) fuer den lokalen Abgleich.
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
  // Reine Registrierungs-Validierung (testbar, DOM-frei).
  function validateRegister(input) {
    const errors = [];
    const i = input || {};
    const name = String(i.name == null ? '' : i.name).trim();
    const email = String(i.email == null ? '' : i.email).trim();
    const password = String(i.password == null ? '' : i.password);
    const confirm = String(i.confirm == null ? '' : i.confirm);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push('Bitte eine gültige E-Mail-Adresse angeben.');
    }
    if (!password || password.length < 8) {
      errors.push('Passwort muss mindestens 8 Zeichen haben.');
    }
    if (confirm !== password) {
      errors.push('Passwörter stimmen nicht überein.');
    }
    if (name.length > 128) {
      errors.push('Name ist zu lang (max. 128 Zeichen).');
    }
    return { ok: errors.length === 0, errors };
  }
  // Reiner Passwort-Stärke-Hinweis (testbar, DOM-frei). Score 0–4.
  function passwordStrength(pw) {
    pw = String(pw == null ? '' : pw);
    if (!pw) return { score: 0, label: '—', hint: 'Mind. 8 Zeichen.' };
    let score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
    score = Math.max(0, Math.min(4, score));
    const labels = ['sehr schwach', 'schwach', 'mittel', 'stark', 'sehr stark'];
    const hints = [
      'Mind. 8 Zeichen wählen.',
      'Länger + Groß-/Kleinschreibung mischen.',
      'Noch Ziffern und Sonderzeichen ergänzen.',
      'Gut – länger oder Sonderzeichen für sehr stark.',
      'Sehr stark.',
    ];
    return { score, label: labels[score], hint: hints[score] };
  }

  /* ---------- Konfiguration ---------- */

  // Der Server spricht unter eigenem Origin mit uns; die Basis steht in
  // js/api.js. Hier bleibt nur, was die Oberflaeche anzeigt.
  function loadConfig() {
    const a = api();
    return { base: a.cfg().base, realtime: !!lsGet(REALTIME_KEY, false) };
  }
  function saveConfig(patch) {
    if (patch && 'realtime' in patch) lsSet(REALTIME_KEY, !!patch.realtime);
    return loadConfig();
  }
  function loadMap() { return lsGet(MAP_KEY, {}); }
  function saveMap(m) { lsSet(MAP_KEY, m || {}); }
  function loadQueue() { return lsGet(QUEUE_KEY, []); }
  function saveQueue(q) { lsSet(QUEUE_KEY, q || []); }

  // Session-Secret und Cookie-Fallback sind ersatzlos entfallen: der Server
  // nutzt ein HttpOnly-Cookie, das der Browser selbst mitschickt. Die
  // Lesefunktionen bleiben als No-op, weil Aufrufer (Sync, Liveshare, MCP)
  // sie noch referenzieren - ein stiller Fehlschlag waere schlimmer als ein
  // leeres Objekt.
  function loadSession() { return null; }
  function saveSession() { /* kein Secret mehr im localStorage */ }
  function clearSession() { /* Cookie wird serverseitig geloescht */ }
  function loadFallback() { return null; }
  function saveFallback() { /* entfallen */ }
  function clearFallback() { /* entfallen */ }
  // Es gibt keine Header mehr zu setzen. Die Funktion bleibt als leeres
  // Objekt, damit Aufrufer nicht brechen; ein echter Header waere sogar
  // schaedlich - jeder zusaetzliche Auth-Header macht den Request von der
  // Same-Origin-Regel des Servers abhaengig.
  function authHeaders() { return {}; }

  /* ---------- Transport ---------- */

  function needBrowser() {
    if (typeof fetch === 'undefined') throw new Error('kein fetch');
  }
  function api() {
    if (typeof window !== 'undefined' && window.FederwerkApi) return window.FederwerkApi;
    if (typeof require === 'function') {
      try { return require('./api.js'); } catch { /* ignore */ }
    }
    throw new Error('FederwerkApi fehlt (js/api.js einbinden)');
  }
  async function rest(method, path, body) {
    needBrowser();
    return api().call(method, path, body);
  }
  // Query-Bauer existiert nicht mehr: der eigene Server kennt nur
  // ?since= / ?limit= / ?after= statt eines JSON-Query-Dialekts.
  const Q = null;
  function q() { return ''; }

  /* Alle Dateien des Nutzers als Map {sha256 -> {size, mime}}.
   *
   * Frueher ueber Cursor-Seiten mit 50 Durchlaeufen. Jetzt liefert der Server
   * die Liste in einem Rutsch - SQLite laeuft in derselben Ausgabe wie der
   * Prozess, ein Paging waere nur Aufwand ohne Gegenwert. */
  async function listAllFiles() {
    const items = await api().listFiles();
    const map = {};
    for (const f of items) map[f.sha256] = { size: f.size || 0, mime: f.mime || '' };
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
  // Nutzt die zentrale Lib (js/optimize.js, Aufgabe 4), fällt ohne sie auf
  // das bisherige Verhalten zurück (max 1600px, JPEG 0.82/WebP 0.85, Alpha-Detect).
  async function optimizeImage(bytes, mime) {
    mime = normalizeMime(mime);
    try {
      const O = (typeof window !== 'undefined' && window.FederwerkOptimize) || null;
      if (O && O.optimizeImageAdaptive && hasCanvas()) {
        const out = await O.optimizeImageAdaptive(bytes, mime, { context: 'page' });
        if (out && out.bytes) return out;
      }
    } catch { /* Fallback unten */ }
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
  /* Upload. Der Server dedupliziert selbst ueber den SHA-256 des Inhalts und
   * meldt es im Feld deduplicated - es gibt kein 409-Signal mehr, mit dem man
   * einen zweiten Hochladen unterdruecken muesste. Und weil der Name serverseitig
   * der Hash ist, prueft er den Inhalt: passt er nicht, kommt 422. */
  async function uploadEntry(hash, bytes, mime) {
    const opt = await optimizeImage(bytes, mime);
    const r = await api().putFile(hash, opt.mime, opt.bytes);
    return {
      fileId: fileIdForHash(hash),
      dedup: !!r.deduplicated,
      optimized: opt.optimized,
      size: opt.bytes.length,
    };
  }
  async function downloadEntry(sha256) {
    needBrowser();
    const r = await api().getFile(sha256);
    return { bytes: r.bytes, mime: normalizeMime(r.mime) };
  }

  const Files = {
    DEFAULTS, FILE_PREFIX, MAX_LONG_EDGE, Q,
    loadConfig, saveConfig, loadMap, saveMap, loadQueue, saveQueue,
    loadSession, saveSession, clearSession, authHeaders,
    loadFallback, saveFallback, clearFallback,
    normalizeMime, extForMime, fileIdForHash, hashFromFileId, sha256Hex,
    dataUrlToBytes, bytesToBase64, base64ToBytes, pickTarget,
    planFileSync, findOrphans, storageReport, queueAdd, queueNext,
    validateRegister, passwordStrength,
    collectLocalEntries, optimizeImage, uploadEntry, downloadEntry, listAllFiles,

    /* ---- Auth ----
     * Die Antwort ist {user} - die Aufrufer
     * in UI, Sync und Liveshare brauchen nur, dass es funktioniert hat. */
    async session() {
      try { return await api().session(); }
      catch (e) { if (e && e.status === 401) return null; throw e; }
    },
    async loginEmail(email, password) {
      return api().login(email, password);
    },
    // Registrieren + Auto-Login. Der Server meldet bei vorhandener Adresse 409;
    // dann wird der Anmeldeversuch trotzdem versucht, damit ein erneuter
    // Registrierungsklick den Nutzer nicht mit einer Fehlermeldung abschreckt,
    // dem die Ursache ("gibt es schon") nichts sagt.
    async registerAccount(input) {
      const i = input || {};
      const name = String(i.name == null ? '' : i.name).trim();
      const email = String(i.email == null ? '' : i.email).trim();
      const password = String(i.password == null ? '' : i.password);
      if (!email || !password) throw new Error('E-Mail und Passwort erforderlich.');
      if (password.length < 8) throw new Error('Passwort muss mindestens 8 Zeichen haben.');
      try {
        return await api().register(email, password, name ? name.slice(0, 128) : '');
      } catch (e) {
        if (e && e.status === 409) return Files.loginEmail(email, password);
        throw e;
      }
    },
    async logout() {
      try { await api().logout(); } catch { /* Cookie ist danach ohnehin weg */ }
      clearSession();
      clearFallback();
    },
    // Voller Datei-Sync: Upload fehlender, Download fehlender, Map+Queue pflegen.
    async syncNow(progress) {
      const cfg = loadConfig();
      const say = typeof progress === 'function' ? progress : () => {};
      const me = await Files.session();
      if (!me) throw new Error('Bitte zuerst in den Server-Einstellungen einloggen.');
      const books = (typeof window !== 'undefined' && window.state && Array.isArray(window.state.books))
        ? window.state.books : [];
      const store = (typeof window !== 'undefined' && window.GrimoireStore) ? window.GrimoireStore : null;
      say('Sammle lokale Dateien …');
      const local = await collectLocalEntries(books, store);
      say('Frage Remote-Stand ab …');
      const remote = await listAllFiles();
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
          const r = await uploadEntry(qe.hash, bytes, mime);
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
          const r = await uploadEntry(hash, bytes, mime);
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
          const { bytes, mime } = await downloadEntry(fid);
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
      const remote = await listAllFiles();
      const orphans = findOrphans(Object.keys(local), Object.keys(remote));
      let deleted = 0, freed = 0;
      if (!dryRun) {
        for (const fid of orphans) {
          try {
            freed += (remote[fid] && remote[fid].size) || 0;
            await rest('DELETE', '/api/files/' + encodeURIComponent(fid));
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
      _authTab: 'login',
      _el(id) { try { return document.getElementById(id); } catch { return null; } },
      _say(t) { const el = UI._el('cloudStatus'); if (el) el.textContent = t; },
      _msg(t, isErr) {
        const el = UI._el('cloudMsg');
        if (el) { el.textContent = t; el.style.color = isErr ? 'var(--cloud-err, #a33)' : ''; }
      },
      switchAuthTab(tab) {
        UI._authTab = tab === 'register' ? 'register' : 'login';
        const isReg = UI._authTab === 'register';
        const tL = UI._el('cloudTabLogin'), tR = UI._el('cloudTabRegister');
        if (tL) { tL.classList.toggle('active', !isReg); tL.setAttribute('aria-selected', String(!isReg)); }
        if (tR) { tR.classList.toggle('active', isReg); tR.setAttribute('aria-selected', String(isReg)); }
        const pL = UI._el('cloudLoginPane'), pR = UI._el('cloudRegisterPane');
        if (pL) pL.hidden = isReg;
        if (pR) pR.hidden = !isReg;
        const bL = UI._el('cloudBtnLogin'), bR = UI._el('cloudBtnRegister');
        if (bL) bL.style.display = isReg ? 'none' : '';
        if (bR) bR.style.display = isReg ? '' : 'none';
        UI._msg('');
        UI.updatePwStrength();
      },
      updatePwStrength() {
        const pwEl = UI._el('cloudRegPass');
        const hint = UI._el('cloudPwHint');
        if (!hint) return;
        try {
          const s = Files.passwordStrength(pwEl ? pwEl.value : '');
          hint.textContent = pwEl && pwEl.value ? `Stärke: ${s.label} – ${s.hint}` : 'Mind. 8 Zeichen, am besten lang + gemischt.';
          hint.dataset.score = String(s.score);
        } catch { /* ignore */ }
      },
      refresh(showLogin) {
        try {
          const base = Files.loadConfig().base || location.origin;
          UI._say(`Server: ${base}`);
          if (showLogin) {
            Files.session().then(
              me => UI._say(me ? `Angemeldet als ${me.email || me.name || me.id}` : 'Nicht angemeldet – bitte in ⚙ einloggen.'),
              () => UI._say('Server offline oder nicht erreichbar.')
            );
          }
        } catch { /* ignore */ }
      },
      openSettings() {
        const cfg = Files.loadConfig();
        // Die alten Felder (Endpoint, Projekt, Datenbank, Bucket, Guard) sind
        // entfallen: es gibt nur noch eine Basis-URL, und die steht in js/api.js.
        // Die Elemente werden nicht mehr befüllt, damit das vorhandene ⚙-Fenster
        // weiter bedienbar bleibt, ohne dass hier Felder erfunden werden.
        const set = (id, v) => { const el = UI._el(id); if (el) el.value = v || ''; };
        set('cloudEndpoint', cfg.base);
        const rt = UI._el('cloudRealtime'); if (rt) rt.checked = !!cfg.realtime;
        UI._msg('');
        const ov = UI._el('cloudOverlay');
        if (ov) ov.classList.add('active');
        UI.switchAuthTab(UI._authTab || 'login');
        UI.refresh(true);
      },
      closeSettings() { const ov = UI._el('cloudOverlay'); if (ov) ov.classList.remove('active'); },
      save() {
        const get = id => { const el = UI._el(id); return el ? el.value.trim() : ''; };
        const base = get('cloudEndpoint');
        if (base) {
          try {
            localStorage.setItem('federwerkApiV1', JSON.stringify({ base }));
          } catch { /* ignore */ }
        }
        Files.saveConfig({ realtime: !!(UI._el('cloudRealtime') || {}).checked });
        UI._msg(`Gespeichert: ${base || location.origin}`);
        UI.refresh(true);
      },
      async login() {
        const get = id => { const el = UI._el(id); return el ? el.value : ''; };
        UI._msg('Logge ein …');
        try {
          await Files.loginEmail(get('cloudEmail'), get('cloudPass'));
          const pw = UI._el('cloudPass'); if (pw) pw.value = '';
          UI._msg('Eingeloggt.');
          UI.refresh(true);
        } catch (e) { UI._msg('Login fehlgeschlagen: ' + e.message, true); }
      },
      async register() {
        const get = id => { const el = UI._el(id); return el ? el.value : ''; };
        const input = {
          name: get('cloudRegName'),
          email: get('cloudRegEmail'),
          password: get('cloudRegPass'),
          confirm: get('cloudRegPass2'),
        };
        const v = Files.validateRegister(input);
        if (!v.ok) {
          UI._msg('Registrierung prüfen: ' + v.errors.join(' '), true);
          return;
        }
        UI._msg('Registriere …');
        try {
          await Files.registerAccount({ name: input.name, email: input.email, password: input.password });
          for (const id of ['cloudRegPass', 'cloudRegPass2']) {
            const el = UI._el(id); if (el) el.value = '';
          }
          UI.updatePwStrength();
          UI._msg('Konto erstellt – eingeloggt.');
          UI.refresh(true);
          UI.closeSettings();
        } catch (e) { UI._msg('Registrierung fehlgeschlagen: ' + e.message, true); }
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
        let ok = true;
        try {
          ok = (typeof FederwerkDialog !== 'undefined' && FederwerkDialog.confirm)
            ? await FederwerkDialog.confirm('Verwaiste Remote-Dateien wirklich löschen?', { title: 'Orphans löschen', danger: true }).catch(() => false)
            : (typeof confirm !== 'undefined' ? confirm('Verwaiste Remote-Dateien wirklich löschen?') : true);
        } catch { ok = false; }
        if (!ok) return;
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
