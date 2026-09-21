/* Federwerk – Ordner-Modell (Bibliothek).
 *
 * DOM-freie, testbare Helpers für Ordner-Support (V2: verschachtelter Baum,
 * OS-artig – parentId aktiv genutzt).
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

  function normParentId(p) {
    return (typeof p === 'string' && p) ? p : null;
  }

  function byNameDe(a, b) {
    return String((a && a.name) || '').localeCompare(String((b && b.name) || ''), 'de');
  }

  function normalizeFolder(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = normName(raw.name);
    if (!name) return null;
    return {
      id: String(raw.id || uid()),
      name,
      parentId: normParentId(raw.parentId),
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Date.now(),
    };
  }

  function byIdMap(folders) {
    const m = new Map();
    for (const f of folders || []) {
      if (f && f.id && !m.has(f.id)) m.set(f.id, f);
    }
    return m;
  }

  // Zyklen-Heilung: Eltern-Ketten ablaufen, bei Rückbezug parentId kappen.
  function healParents(list) {
    const valid = new Set(list.map(f => f.id));
    for (const f of list) {
      if (f.parentId && !valid.has(f.parentId)) f.parentId = null;
      if (f.parentId === f.id) f.parentId = null;
    }
    // Zyklen (A->B->A, A->B->C->A, ...) aufbrechen: pro Ordner Kette prüfen.
    const byId = byIdMap(list);
    for (const f of list) {
      const seen = new Set([f.id]);
      let cur = f.parentId ? byId.get(f.parentId) : null;
      while (cur) {
        if (seen.has(cur.id)) {
          // Kante von f kappen (f wird Wurzel) – minimaler, stabiler Eingriff.
          f.parentId = null;
          break;
        }
        seen.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : null;
      }
    }
    return list;
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
    healParents(cleanFolders);
    state.folders = cleanFolders;
    const validAfter = new Set(state.folders.map(f => f.id));
    for (const b of state.books) {
      if (!b || typeof b !== 'object') continue;
      if (b.folderId != null && (typeof b.folderId !== 'string' || !validAfter.has(b.folderId))) {
        b.folderId = null;
      }
      if (b.folderId === undefined) b.folderId = null;
    }
    // Sortierung: alphabetisch (stabile UI), behält aber createdAt bei
    state.folders.sort(byNameDe);
    return state;
  }

  // parentId optional (3. Arg); Duplikate nur innerhalb desselben Parents.
  function createFolder(folders, name, parentId) {
    const clean = normName(name);
    if (!clean) return null;
    const list = Array.isArray(folders) ? folders : [];
    const pid = normParentId(parentId);
    if (pid) {
      const parentOk = list.some(f => f && f.id === pid);
      if (!parentOk) return null;
    }
    // Duplikate (case-insensitiv) im selben Parent wiederverwenden
    const dup = list.find(f => f
      && String(f.name || '').toLowerCase() === clean.toLowerCase()
      && normParentId(f.parentId) === pid);
    if (dup) return dup;
    const f = { id: uid(), name: clean, parentId: pid, createdAt: Date.now(), updatedAt: Date.now() };
    list.push(f);
    list.sort(byNameDe);
    return f;
  }

  function renameFolder(folders, id, name) {
    const clean = normName(name);
    if (!clean || !Array.isArray(folders)) return false;
    const f = folders.find(x => x && x.id === id);
    if (!f) return false;
    f.name = clean;
    f.updatedAt = Date.now();
    folders.sort(byNameDe);
    return true;
  }

  // Löscht Ordner + Nachfahren; Bücher des gelöschten Teilbaums -> Unsortiert.
  function deleteFolder(state, id) {
    if (!state || !Array.isArray(state.folders)) return false;
    const ix = state.folders.findIndex(f => f && f.id === id);
    if (ix < 0) return false;
    const doomed = new Set([id]);
    for (const d of getDescendants(state.folders, id)) {
      if (d && d.id) doomed.add(d.id);
    }
    state.folders = state.folders.filter(f => !(f && doomed.has(f.id)));
    // Bücher nicht löschen – nur ent-ordnen ("Unsortiert")
    for (const b of state.books || []) {
      if (b && typeof b.folderId === 'string' && doomed.has(b.folderId)) b.folderId = null;
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

  /* ---------- Baum-Helfer (V2, rein & testbar) ---------- */

  // Direkte Kinder eines Parents (sortiert).
  function childrenOf(folders, parentId) {
    const pid = normParentId(parentId);
    return (Array.isArray(folders) ? folders : [])
      .filter(f => f && normParentId(f.parentId) === pid)
      .slice()
      .sort(byNameDe);
  }

  // Verschachtelter Baum: [{...folder, children:[...]}], Wurzeln sortiert.
  function buildTree(folders) {
    const list = Array.isArray(folders) ? folders : [];
    const byParent = new Map(); // pidKey -> [folders]
    for (const f of list) {
      if (!f || !f.id) continue;
      const key = normParentId(f.parentId) || '\0root';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(f);
    }
    for (const arr of byParent.values()) arr.sort(byNameDe);
    const visit = (pid) => {
      const kids = byParent.get(pid || '\0root') || [];
      return kids.map(f => Object.assign({}, f, { children: visit(f.id) }));
    };
    return visit(null);
  }

  // Alle Nachfahren (transitiv) eines Ordners, Dokument-Reihenfolge (BFS).
  function getDescendants(folders, id) {
    const list = Array.isArray(folders) ? folders : [];
    if (!id) return [];
    const kids = new Map();
    for (const f of list) {
      if (!f || !f.id) continue;
      const key = normParentId(f.parentId) || '\0root';
      if (!kids.has(key)) kids.set(key, []);
      kids.get(key).push(f);
    }
    const out = [];
    const queue = (kids.get(String(id)) || []).slice();
    const seen = new Set([String(id)]);
    while (queue.length) {
      const cur = queue.shift();
      if (!cur || seen.has(cur.id) && out.includes(cur)) continue;
      if (seen.has(cur.id) && cur.id !== String(id)) {
        // bereits besucht (Zyklus-Schutz)
        continue;
      }
      seen.add(cur.id);
      out.push(cur);
      const next = kids.get(cur.id) || [];
      for (const n of next) queue.push(n);
    }
    return out;
  }

  function isDescendant(folders, id, ancestorId) {
    if (!id || !ancestorId || id === ancestorId) return false;
    const list = Array.isArray(folders) ? folders : [];
    const byId = byIdMap(list);
    let cur = byId.get(String(id));
    const seen = new Set();
    while (cur && cur.parentId) {
      if (seen.has(cur.id)) return false; // Zyklus-Schutz
      seen.add(cur.id);
      if (cur.parentId === ancestorId) return true;
      cur = byId.get(cur.parentId);
    }
    return false;
  }

  // Pfad Wurzel -> ... -> Ordner (inklusive). Leer wenn unbekannt.
  function getPath(folders, id) {
    const list = Array.isArray(folders) ? folders : [];
    const byId = byIdMap(list);
    const node = byId.get(String(id));
    if (!node) return [];
    const chain = [node];
    const seen = new Set([node.id]);
    let cur = node;
    while (cur.parentId) {
      const p = byId.get(cur.parentId);
      if (!p || seen.has(p.id)) break;
      seen.add(p.id);
      chain.unshift(p);
      cur = p;
    }
    return chain;
  }

  // Ordner in anderen Ordner verschieben (Zirkel-Schutz: nicht in sich/Descendant).
  // newParentId null/'' = auf Wurzel-Ebene.
  function moveFolder(folders, id, newParentId) {
    if (!Array.isArray(folders)) return false;
    const node = folders.find(f => f && f.id === id);
    if (!node) return false;
    const pid = normParentId(newParentId);
    if (pid === id) return false;
    if (pid) {
      const parent = folders.find(f => f && f.id === pid);
      if (!parent) return false;
      if (isDescendant(folders, pid, id)) return false;
    }
    node.parentId = pid;
    node.updatedAt = Date.now();
    folders.sort(byNameDe);
    return true;
  }

  // Flache Liste in Baum-Reihenfolge sortieren (in place): nach vollem Pfad.
  function sortTree(folders) {
    if (!Array.isArray(folders)) return folders;
    const byId = byIdMap(folders);
    const pathKey = (f) => getPath(folders, f.id).map(x => String(x.name || '').toLowerCase()).join('\0');
    // Falls getPath wegen defekter Refs leer ist, Fallback auf Namen.
    const withKey = folders.map(f => ({ f, k: (byId.has(f.id) && f) ? (pathKey(f) || String(f.name || '').toLowerCase()) : '' }));
    withKey.sort((a, b) => String(a.k).localeCompare(String(b.k), 'de'));
    for (let i = 0; i < withKey.length; i++) folders[i] = withKey[i].f;
    return folders;
  }

  function folderName(folders, folderId) {
    if (folderId == null) return 'Unsortiert';
    const f = (Array.isArray(folders) ? folders : []).find(x => x && x.id === folderId);
    return f ? f.name : 'Unsortiert';
  }

  // Pfad-Label "Arbeit / Uni" für Breadcrumb/Titel.
  function folderPathName(folders, folderId, sep) {
    if (folderId == null) return 'Unsortiert';
    const p = getPath(folders, folderId);
    if (!p.length) return 'Unsortiert';
    return p.map(f => f.name || 'Ordner').join(sep || ' / ');
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

  // Zähler inkl. Teilbaum: byId[id] = direkt + alle Nachfahren.
  function countSubtree(books, folders) {
    const direct = countByFolder(books);
    const out = { all: direct.all, unsorted: direct.unsorted, byId: {} };
    const list = Array.isArray(folders) ? folders : [];
    const kids = new Map();
    for (const f of list) {
      if (!f || !f.id) continue;
      const key = normParentId(f.parentId) || '\0root';
      if (!kids.has(key)) kids.set(key, []);
      kids.get(key).push(f.id);
    }
    const memo = new Map();
    const sum = (id, stack) => {
      if (memo.has(id)) return memo.get(id);
      if (stack && stack.has(id)) return 0; // Zyklus-Schutz
      const st = stack || new Set();
      st.add(id);
      let n = direct.byId[id] || 0;
      for (const c of kids.get(String(id)) || []) n += sum(c, st);
      st.delete(id);
      memo.set(id, n);
      return n;
    };
    for (const f of list) {
      if (f && f.id) out.byId[f.id] = sum(f.id, new Set());
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

  // Filter inkl. Unterordner (OS-artig): Ordner zeigt rekursiv den Teilbaum.
  function filterBooksTree(books, folderFilter, folders) {
    const list = Array.isArray(books) ? books : [];
    if (!folderFilter || folderFilter === 'all') return list;
    if (folderFilter === 'unsorted') {
      return list.filter(b => !b || !b.folderId);
    }
    const ids = new Set([String(folderFilter)]);
    for (const d of getDescendants(folders, folderFilter)) {
      if (d && d.id) ids.add(d.id);
    }
    return list.filter(b => b && typeof b.folderId === 'string' && ids.has(b.folderId));
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
    healParents(out);
    out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    return out;
  }

  // Merge: Cloud-Mirror + lokale Ordner (neueste updatedAt gewinnt, lokale
  // Namen ohne Remote bleiben erhalten). Für den Sync-Glue in app.js.
  // parentId wird mitgesynct; danach Refs geheilt (Geister-Eltern, Zyklen).
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
    const merged = Object.keys(byId).map(id => normalizeFolder({
      id, name: byId[id].name, parentId: byId[id].parentId,
      updatedAt: byId[id].updatedAtMs, createdAt: byId[id].createdAt,
    })).filter(Boolean);
    healParents(merged);
    merged.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    return merged;
  }

  const api = {
    ensureFolders, normalizeFolder, createFolder, renameFolder, deleteFolder,
    moveBook, folderName, folderPathName, countByFolder, countSubtree,
    filterBooks, filterBooksTree, toMirror, fromMirror, mergeFolders,
    childrenOf, buildTree, getDescendants, isDescendant, getPath,
    moveFolder, sortTree,
  };

  if (typeof window !== 'undefined') window.GrimoireFolders = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
