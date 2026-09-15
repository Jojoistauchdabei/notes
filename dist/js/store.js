/* Grimoire Store – IndexedDB-Persistenz + Bild-Blob-Store.
 *
 * Problem: Bilder und PDF-Hintergründe lagen als dataURL direkt im
 * localStorage-JSON (Key 'grimoire-dnd-v1', ~5MB-Limit) -> "Speicher voll".
 *
 * Lösung: Bild-Bytes wandern in IndexedDB (Store 'blobs'), im State steht nur
 * noch eine kurze Referenz `blob:<id>` (in im.src bzw. page.bg). Der State
 * selbst (klein) liegt in IndexedDB ('kv') + als Backup weiter in localStorage.
 *
 * - Offline-first, kein Server. Kein Build, plain <script>.
 * - Legacy (dataURL inline), Cloud-JSON und Exporte funktionieren weiter:
 *   inlineBook() löst Refs zu dataURLs auf, extractBook() lagert ein.
 * - Ohne IndexedDB (sehr alt/privat): Fallback = altes Inline-Verhalten.
 * - Kein GC in v1: geteilte Blobs (Duplizieren) + Multi-Tab machen Löschen
 *   unsicher; Blobs sind klein (max 800-1000px JPEG), verwaiste Reste ok.
 */
(function () {
  'use strict';

  const DB_NAME = 'grimoire-db', DB_VER = 1, KV = 'kv', BLOBS = 'blobs';
  const STATE_KEY = 'state';
  const LS_KEY = 'grimoire-dnd-v1'; // Backup + Legacy-Quelle für Migration
  const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  let dbPromise = null;
  const memBlobs = new Map(); // nur Tests / No-IDB-Laufzeit (flüchtig)
  let forceMemBlobs = false;  // Tests: Blob-Pfade ohne indexedDB üben
  const urlCache = new Map(); // ref -> objectURL/dataURL (sync Lese-Cache)
  const inflight = new Map(); // ref -> Promise
  const subs = [];
  let saveTimer = null;

  const Store = {
    init, saveSoon, saveNow,
    putBlob, putDataUrl,
    url, dataUrl,
    inlineBook, extractBook,
    subscribe,
    get available() { return hasIdb(); },
    _internals: {},
  };
  Store._internals = {
    isBlobRef, isDataUrl, dataUrlToBytes, bytesToDataUrl,
    collectRefs, stripRuntime, parseLegacy, memBlobs,
    _setForceMemBlobs(v) { forceMemBlobs = !!v; },
    _reset() { memBlobs.clear(); urlCache.clear(); inflight.clear(); dbPromise = null; },
  };

  function hasIdb() {
    try { return typeof indexedDB !== 'undefined' && !!indexedDB; }
    catch { return false; }
  }
  function useBlobs() { return hasIdb() || forceMemBlobs; }
  function bid() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /* ---------- reine Helfer (testbar) ---------- */
  function isBlobRef(s) { return typeof s === 'string' && s.startsWith('blob:') && s.length > 5; }
  function blobId(ref) { return ref.slice(5); }
  function isDataUrl(s) { return typeof s === 'string' && s.startsWith('data:image/'); }

  function dataUrlToBytes(du) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(du || '');
    if (!m) throw new Error('kein dataURL');
    const mime = m[1] || 'image/jpeg';
    let bytes;
    if (m[2]) {
      const bin = (typeof atob !== 'undefined')
        ? atob(m[3])
        : Buffer.from(m[3], 'base64').toString('binary');
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(m[3]));
    }
    return { mime, bytes };
  }
  function bytesToDataUrl(bytes, mime) {
    mime = mime || 'image/jpeg';
    if (typeof Buffer !== 'undefined') {
      return 'data:' + mime + ';base64,' + Buffer.from(bytes).toString('base64');
    }
    let bin = '';
    const CH = 8192;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return 'data:' + mime + ';base64,' + btoa(bin);
  }
  // Alle Bild-Referenzen eines Buchs einsammeln (src + bg)
  function collectRefs(book) {
    const refs = [];
    if (!book || !Array.isArray(book.pages)) return refs;
    for (const p of book.pages) {
      if (Array.isArray(p.images)) for (const im of p.images) if (im && im.src) refs.push(im.src);
      if (p.bg) refs.push(p.bg);
    }
    return refs;
  }
  // Laufzeit-Keys (beginnend mit _) aus Persistenz-JSON entfernen
  function stripRuntime(state) {
    return JSON.parse(JSON.stringify(state, (k, v) => (k && k[0] === '_' ? undefined : v)));
  }
  function parseLegacy(raw) {
    if (!raw) return null;
    try {
      const p = JSON.parse(raw);
      if (p && Array.isArray(p.books)) return p;
    } catch { /* ignore */ }
    return null;
  }

  /* ---------- IndexedDB ---------- */
  function openDb() {
    if (dbPromise) return dbPromise;
    if (!hasIdb()) return (dbPromise = Promise.resolve(null));
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
          if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
    return dbPromise;
  }
  function idbReq(r) {
    return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
  async function kvGet(key) {
    const db = await openDb();
    if (!db) return null;
    try {
      return await idbReq(db.transaction(KV, 'readonly').objectStore(KV).get(key)) ?? null;
    } catch { return null; }
  }
  async function kvSet(key, val) {
    const db = await openDb();
    if (!db) return false;
    try {
      await idbReq(db.transaction(KV, 'readwrite').objectStore(KV).put(val, key));
      return true;
    } catch { return false; }
  }
  async function blobGet(id) {
    if (forceMemBlobs || !hasIdb()) return memBlobs.get(id) || null;
    const db = await openDb();
    if (!db) return memBlobs.get(id) || null;
    try {
      return await idbReq(db.transaction(BLOBS, 'readonly').objectStore(BLOBS).get(id)) || null;
    } catch { return memBlobs.get(id) || null; }
  }
  async function blobPut(id, rec) {
    if (forceMemBlobs || !hasIdb()) { memBlobs.set(id, rec); return; }
    const db = await openDb();
    if (!db) { memBlobs.set(id, rec); return; }
    try {
      await idbReq(db.transaction(BLOBS, 'readwrite').objectStore(BLOBS).put(rec, id));
    } catch { memBlobs.set(id, rec); }
  }

  /* ---------- Blob-API ---------- */
  // Blob (File/Canvas) einlagern -> 'blob:<id>' (oder dataURL-Fallback ohne IDB)
  async function putBlob(blob) {
    try {
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const mime = blob.type || 'image/jpeg';
      if (!useBlobs()) return bytesToDataUrl(bytes, mime); // Legacy-Inline
      const id = bid();
      await blobPut(id, { mime, bytes });
      return 'blob:' + id;
    } catch {
      return null;
    }
  }
  // dataURL einlagern -> 'blob:<id>' (oder Original ohne IDB / bei Nicht-Bild)
  async function putDataUrl(du) {
    if (!isDataUrl(du)) return du;
    if (!useBlobs()) return du; // Legacy-Inline
    try {
      const { mime, bytes } = dataUrlToBytes(du);
      const id = bid();
      await blobPut(id, { mime, bytes });
      return 'blob:' + id;
    } catch { return du; }
  }

  // Synchroner URL-Cache für Renderer; lädt im Hintergrund nach + notified.
  function url(ref) {
    if (!ref) return '';
    if (!isBlobRef(ref)) return ref;
    const hit = urlCache.get(ref);
    if (hit) return hit;
    ensureUrl(ref);
    return '';
  }
  function ensureUrl(ref) {
    if (inflight.has(ref)) return inflight.get(ref);
    const p = (async () => {
      try {
        const rec = await blobGet(blobId(ref));
        if (!rec) return '';
        let u = '';
        if (typeof URL !== 'undefined' && URL.createObjectURL && rec.bytes) {
          try {
            const blob = (typeof Blob !== 'undefined')
              ? new Blob([rec.bytes], { type: rec.mime })
              : null;
            if (blob) u = URL.createObjectURL(blob);
          } catch { /* ignore */ }
        }
        if (!u && rec.bytes) u = bytesToDataUrl(rec.bytes, rec.mime);
        if (u) { urlCache.set(ref, u); notify(); }
        return u;
      } finally { inflight.delete(ref); }
    })();
    inflight.set(ref, p);
    return p;
  }
  // dataURL auflösen (Export, PNG, Cloud-Push)
  async function dataUrl(ref) {
    if (!ref) return '';
    if (!isBlobRef(ref)) return ref;
    const hit = urlCache.get(ref);
    if (hit && hit.startsWith('data:')) return hit;
    const rec = await blobGet(blobId(ref));
    if (!rec || !rec.bytes) return '';
    return bytesToDataUrl(rec.bytes, rec.mime);
  }
  function subscribe(fn) { if (typeof fn === 'function') subs.push(fn); }
  function notify() { subs.forEach((fn) => { try { fn(); } catch { /* ignore */ } }); }

  /* ---------- Buch-Transformation ---------- */
  // Export-Format: alle blob:-Refs -> dataURL (portabel für JSON/Cloud)
  async function inlineBook(book) {
    const copy = JSON.parse(JSON.stringify(book));
    if (!Array.isArray(copy.pages)) return copy;
    for (const p of copy.pages) {
      if (Array.isArray(p.images)) {
        for (const im of p.images) {
          if (im && isBlobRef(im.src)) im.src = await dataUrl(im.src);
        }
      }
      if (isBlobRef(p.bg)) p.bg = await dataUrl(p.bg);
    }
    return copy;
  }
  // Import-Format: alle dataURLs -> blob:-Refs (in place, gibt book zurück)
  async function extractBook(book) {
    if (!book || !Array.isArray(book.pages)) return book;
    for (const p of book.pages) {
      if (Array.isArray(p.images)) {
        for (const im of p.images) {
          if (im && isDataUrl(im.src)) im.src = await putDataUrl(im.src);
        }
      }
      if (isDataUrl(p.bg)) p.bg = await putDataUrl(p.bg);
    }
    return book;
  }

  /* ---------- State-Persistenz ---------- */
  async function saveNow(state) {
    const clean = stripRuntime(state);
    const json = JSON.stringify(clean);
    await kvSet(STATE_KEY, json); // IDB (falls verfügbar)
    try { localStorage.setItem(LS_KEY, json); } catch { /* Quota: IDB trägt */ }
  }
  function saveSoon(state) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveNow(state).catch(() => {}); }, 400);
  }

  // Boot: IDB -> Legacy-LS (+Migration) -> frisch. Migriert dataURLs zu Blobs.
  async function init() {
    await openDb();
    const fromIdb = parseLegacy(await kvGet(STATE_KEY));
    if (fromIdb) return withDefaults(fromIdb);
    let legacy = null;
    try { legacy = parseLegacy(localStorage.getItem(LS_KEY)); } catch { legacy = null; }
    if (legacy) {
      const state = withDefaults(legacy);
      let migrated = 0;
      for (const b of state.books) {
        const before = collectRefs(b).filter(isDataUrl).length;
        await extractBook(b);
        migrated += before;
      }
      await saveNow(state);
      state._migratedImages = migrated;
      return state;
    }
    return null; // Aufrufer legt Starter-Buch an
  }
  function withDefaults(s) {
    s.openBookId = s.openBookId || null;
    s.openPageId = s.openPageId || null;
    if (!Array.isArray(s.books)) s.books = [];
    return s;
  }

  if (typeof window !== 'undefined') window.GrimoireStore = Store;
  if (typeof module !== 'undefined' && module.exports) module.exports = Store;
})();
