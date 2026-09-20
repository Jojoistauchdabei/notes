/* Federwerk – Ordner-Modell (Bibliothek).
 *
 * DOM-freie, testbare Helpers für Ordner-Support (V1: flache Liste, kein
 * Verschachteln in der UI – parentId ist für später reserviert).
 *
 * - Ordner: { id, name, parentId|null, createdAt, updatedAt }
 * - Buch: trägt optional folderId (string|null). null = "Unsortiert".
 * - State: { books: [...], folders: [...] }. Altbestände ohne folders
 *   werden via ensureFolders() migriert (leere Liste, Bücher -> null).
 * - Kein Build, plain <script> (global `GrimoireFolders`) + Node-export.
 */
(function () {
  'use strict';

  function uid() {
    try {
      if (typeof window !== 'undefined' && window.crypto && window.crypto.randomUUID) {
        return window.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      }
    } catch { /* fallback */ }
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function normName(n) {
    return String(n == null ? '' : n).trim().slice(0, 60);
  }

  function normalizeFolder(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = normName(raw.name);
    if (!name) return null;
    return {
      id: String(raw.id || uid()),
      name,
      parentId: (typeof raw.parentId === 'string' && raw.parentId) ? raw.parentId : null,
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Date.now(),
    };
  }

  // State-Migration: folders-Array sicherstellen, folderId auf Büchern heilen.
  function ensureFolders(state) {
    if (!state || typeof state !== 'object') return { books: [], folders: [] };
    if (!Array.isArray(state.folders)) state.folders = [];
    if (!Array.isArray(state.books)) state.books = [];
    const valid = new Set();
    const cleanFolders = [];
    for (const f of state.folders) {
      const n = normalizeFolder(f);
      if (!n || valid.has(n.id)) continue;
      valid.add(n.id);
      cleanFolders.push(n);
    }
    // reservierte parentIds heilen (kein Selbst-/Geister-Eltern in V1)
    for (const f of cleanFolders) {
      if (f.parentId && !valid.has(f.parentId)) f.parentId = null;
      if (f.parentId === f.id) f.parentId = null;
    }
    state.folders = cleanFolders;
    for (const b of state.books) {
      if (!b || typeof b !== 'object') continue;
      if (b.folderId != null && (typeof b.folderId !== 'string' || !valid.has(b.folderId))) {
        b.folderId = null;
      }
      if (b.folderId === undefined) b.folderId = null;
    }
    // Sortierung: alphabetisch (stabile UI), behält aber createdAt bei
    state.folders.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    return state;
  }

  function createFolder(folders, name) {
    const clean = normName(name);
    if (!clean) return null;
    const list = Array.isArray(folders) ? folders : [];
    // Duplikate (case-insensitiv) wiederverwenden statt doppelt anlegen
    const dup = list.find(f => String(f.name || '').toLowerCase() === clean.toLowerCase());
    if (dup) return dup;
    const f = { id: uid(), name: clean, parentId: null, createdAt: Date.now(), updatedAt: Date.now() };
    list.push(f);
    list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'de'));
    return f;
  }

  function renameFolder(folders, id, name) {
    const clean = normName(name);
    if (!clean || !Array.isArray(folders)) return false;
    const f = folders.find(x => x && x.id === id);
    if (!f) return false;
    f.name = clean;
    f.updatedAt = Date.now();
    folders.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'de'));
    return true;
  }

  function deleteFolder(state, id) {
    if (!state || !Array.isArray(state.folders)) return false;
    const ix = state.folders.findIndex(f => f && f.id === id);
    if (ix < 0) return false;
    state.folders.splice(ix, 1);
    // Bücher nicht löschen – nur ent-ordnen ("Unsortiert")
    for (const b of state.books || []) {
      if (b && b.folderId === id) b.folderId = null;
    }
    return true;
  }

  function moveBook(books, bookId, folderIdOrNull, folders) {
    if (!Array.isArray(books)) return false;
    const b = books.find(x => x && x.id === bookId);
    if (!b) return false;
    if (folderIdOrNull == null || folderIdOrNull === '' || folderIdOrNull === 'unsorted') {
      b.folderId = null;
      b.updatedAt = Date.now();
      return true;
    }
    if (Array.isArray(folders) && !folders.some(f => f && f.id === folderIdOrNull)) return false;
    b.folderId = folderIdOrNull;
    b.updatedAt = Date.now();
    return true;
  }

  function folderName(folders, folderId) {
    if (folderId == null) return 'Unsortiert';
    const f = (Array.isArray(folders) ? folders : []).find(x => x && x.id === folderId);
    return f ? f.name : 'Unsortiert';
  }

  function countByFolder(books) {
    const out = { all: 0, unsorted: 0, byId: {} };
    for (const b of books || []) {
      out.all++;
      const fid = (b && typeof b.folderId === 'string' && b.folderId) ? b.folderId : null;
      if (!fid) out.unsorted++;
      else out.byId[fid] = (out.byId[fid] || 0) + 1;
    }
    return out;
  }

  function filterBooks(books, folderFilter) {
    const list = Array.isArray(books) ? books : [];
    if (!folderFilter || folderFilter === 'all') return list;
    if (folderFilter === 'unsorted') {
      return list.filter(b => !b || !b.folderId);
    }
    return list.filter(b => b && b.folderId === folderFilter);
  }

  // Sync-Brücke: state.folders <-> federwerkFoldersV1-Mirror {id:{name,parentId,updatedAtMs,deleted?}}
  function toMirror(folders) {
    const out = {};
    for (const f of folders || []) {
      if (!f || !f.id) continue;
      out[f.id] = { name: f.name || '', parentId: f.parentId || null, updatedAtMs: Number(f.updatedAt) || Date.now() };
    }
    return out;
  }

  function fromMirror(mirror) {
    const out = [];
    const m = (mirror && typeof mirror === 'object') ? mirror : {};
    for (const id of Object.keys(m)) {
      const e = m[id];
      if (!e || e.deleted) continue;
      const n = normalizeFolder({ id, name: e.name, parentId: e.parentId, updatedAt: e.updatedAtMs, createdAt: e.updatedAtMs });
      if (n) out.push(n);
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    return out;
  }

  // Merge: Cloud-Mirror + lokale Ordner (neueste updatedAt gewinnt, lokale
  // Namen ohne Remote bleiben erhalten). Für den Sync-Glue in app.js.
  function mergeFolders(localFolders, mirror) {
    const byId = {};
    for (const f of localFolders || []) {
      if (f && f.id) byId[f.id] = { name: f.name, parentId: f.parentId || null, updatedAtMs: Number(f.updatedAt) || 0, createdAt: Number(f.createdAt) || 0 };
    }
    const m = (mirror && typeof mirror === 'object') ? mirror : {};
    for (const id of Object.keys(m)) {
      const e = m[id];
      if (!e) continue;
      if (e.deleted) { delete byId[id]; continue; }
      const rms = Number(e.updatedAtMs) || 0;
      const cur = byId[id];
      if (!cur || rms >= (cur.updatedAtMs || 0)) {
        byId[id] = { name: e.name || '', parentId: e.parentId || null, updatedAtMs: rms, createdAt: cur ? cur.createdAt : rms };
      }
    }
    return Object.keys(byId).map(id => normalizeFolder({
      id, name: byId[id].name, parentId: byId[id].parentId,
      updatedAt: byId[id].updatedAtMs, createdAt: byId[id].createdAt,
    })).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  const api = {
    ensureFolders, normalizeFolder, createFolder, renameFolder, deleteFolder,
    moveBook, folderName, countByFolder, filterBooks, toMirror, fromMirror, mergeFolders,
  };

  if (typeof window !== 'undefined') window.GrimoireFolders = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
