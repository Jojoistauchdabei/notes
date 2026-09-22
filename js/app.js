/* Federwerk – Handschrift-Notizbuch im Papier-Stil. LocalStorage, kein Server. */
/* Seitenformat: Default A4 (210:297), Canvas 1000×1414 – jede Seite darf per
 * page.size = { w, h } ein eigenes Format tragen (Quer/Quadrat/Bildformat). */
const LS_KEY = 'grimoire-dnd-v1';
const CANVAS_W = 1000, CANVAS_H = 1414;

/* Effektive Seitenmaße (immer gültig): `page.size` gewinnt (eigene Formate
 * wie Bild/PDF/Quer/Quadrat), sonst Buch-Papiervorlage, sonst A4-Default.
 * Nutzt FederwerkPaper.effectiveDims wenn verfügbar (Buch-Template-System),
 * sonst eigenes size bzw. A4 (Altbestand, GoodNotes-A4-Mapping). */
function pageDimsOf(page, paperId) {
  try {
    if (typeof FederwerkPaper !== 'undefined' && FederwerkPaper.effectiveDims) {
      const d = FederwerkPaper.effectiveDims(page, paperId);
      if (d) {
        const w = Math.round(Number(d.w)), h = Math.round(Number(d.h));
        if (isFinite(w) && isFinite(h) && w >= 200 && w <= 2400 && h >= 200 && h <= 2400) return { w, h };
      }
    }
  } catch { /* Fallback unten */ }
  try {
    if (typeof PagesImport !== 'undefined' && PagesImport.pageDims) return PagesImport.pageDims(page);
  } catch { /* Fallback unten */ }
  const s = page && page.size;
  const w = Math.round(Number(s && s.w)), h = Math.round(Number(s && s.h));
  if (isFinite(w) && isFinite(h) && w >= 200 && w <= 2400 && h >= 200 && h <= 2400) return { w, h };
  return { w: CANVAS_W, h: CANVAS_H };
}
/* Maße der Seite in Pane idx (inkl. Buch-Vorlagen-Fallback). */
function paneDims(idx) {
  try {
    const b = paneBook(idx);
    return pageDimsOf(panePage(idx), b && b.paper);
  } catch { return { w: CANVAS_W, h: CANVAS_H }; }
}
/* Overlay einer Pane-Seite vollständig löschen (maße der aktuellen Seite). */
function clearOverlayFor(idx) {
  try {
    const oc = overlayEl(idx); if (!oc) return;
    const d = paneDims(idx);
    oc.getContext('2d').clearRect(0, 0, d.w, d.h);
  } catch { /* ignore */ }
}
/* Natürliche Bildmaße einer dataURL (für Bild-/PDF-Seitenformate). */
function naturalSizeOfDataUrl(url) {
  return new Promise(resolve => {
    try {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
      img.onerror = () => resolve(null);
      img.src = url;
    } catch { resolve(null); }
  });
}

let state = { books: [], folders: [], openBookId: null, openPageId: null };
// Cloud-Sync (js/appwrite-files.js, js/appwrite-sync.js) liest window.state.
// Top-level `let` landet bei klassischen <script>s NICHT auf window – daher
// als Getter/Setter spiegeln (überlebt auch Reassignments wie `state = p`).
try {
  if (typeof window !== 'undefined' && !Object.getOwnPropertyDescriptor(window, 'state')) {
    Object.defineProperty(window, 'state', {
      configurable: true,
      enumerable: true,
      get() { return state; },
      set(v) { state = v; },
    });
  }
} catch { /* ignore */ }
// Ordner-Filter (UI-only, in localStorage gemerkt)
let activeFolderId = 'all';
try {
  const af = (typeof localStorage !== 'undefined') ? localStorage.getItem('federwerkActiveFolderV1') : null;
  if (af) activeFolderId = af;
} catch { /* ignore */ }
function setActiveFolderId(v) {
  activeFolderId = (!v) ? 'all' : v;
  try { if (typeof localStorage !== 'undefined') localStorage.setItem('federwerkActiveFolderV1', activeFolderId); } catch { /* ignore */ }
}
let tool = 'pen', penColor = '#2a1a0e', penSize = 3;
// SPEC-25: Radierer-Modi + "Nur Highlighter" (persistiert, localStorage grimoireEraserMode)
let eraserMode = 'standard', eraserHighlighterOnly = false;
try {
  if (typeof GrimoireErase !== 'undefined') {
    const es = GrimoireErase.loadEraserSettings(typeof localStorage !== 'undefined' ? localStorage : null);
    eraserMode = es.mode; eraserHighlighterOnly = es.highlighterOnly;
  } else {
    const raw = localStorage.getItem('grimoireEraserMode');
    if (raw) { const p = JSON.parse(raw); if (p.mode) eraserMode = p.mode; eraserHighlighterOnly = !!p.highlighterOnly; }
  }
} catch { /* ignore */ }
function saveEraserPrefs() {
  try {
    if (typeof GrimoireErase !== 'undefined') GrimoireErase.saveEraserSettings({ mode: eraserMode, highlighterOnly: eraserHighlighterOnly }, typeof localStorage !== 'undefined' ? localStorage : null);
    else localStorage.setItem('grimoireEraserMode', JSON.stringify({ mode: eraserMode, highlighterOnly: eraserHighlighterOnly }));
  } catch { /* ignore */ }
}
function setEraserMode(v) { eraserMode = (v === 'precision' || v === 'stroke') ? v : 'standard'; saveEraserPrefs(); syncToolbar(); }
function setEraserHighlighterOnly(v) { eraserHighlighterOnly = !!v; saveEraserPrefs(); syncToolbar(); }
/* ---------- Eingabe: Apple Pencil vs. Finger/Maus ----------
 * Apple Pencil schreibt immer. Finger und Maus scrollen standardmäßig; der
 * eine Schreib-Button schaltet Finger/Maus-Eingabe zum Zeichnen frei.
 * Palm-Rejection: Touch kurz nach Pen-Kontakt wird ignoriert. */
let inputPrefs = { fingerDraw: false, penOnly: true };
try {
  if (typeof GrimoirePencil !== 'undefined' && GrimoirePencil.getInputPrefs) {
    inputPrefs = GrimoirePencil.getInputPrefs(typeof localStorage !== 'undefined' ? localStorage : null);
  }
} catch { /* Default bleibt */ }
let palmGuard = (typeof GrimoirePencil !== 'undefined' && GrimoirePencil.createPalmGuard)
  ? GrimoirePencil.createPalmGuard(1200) : null;
let penActive = false;
function saveInputPrefs() {
  try {
    if (typeof GrimoirePencil !== 'undefined' && GrimoirePencil.setInputPrefs) {
      inputPrefs = GrimoirePencil.setInputPrefs(inputPrefs, typeof localStorage !== 'undefined' ? localStorage : null);
    } else {
      localStorage.setItem('grimoireInputPrefs', JSON.stringify(inputPrefs));
    }
  } catch { /* ignore */ }
}
function setFingerDraw(v) {
  inputPrefs.fingerDraw = !!v;
  saveInputPrefs(); syncToolbar(); applyStageTouchAction();
}
function applyStageTouchAction() {
  // Finger scrollt nativ (pan-y), Stift zeichnet trotzdem (Pointer Events).
  // Nur wenn "Finger zeichnen" an ist, wird Scrollen auf der Seite gesperrt.
  // Laserpointer sperrt immer (Zeigen statt Scrollen, speichert nichts).
  try {
    const laserOn = (typeof GrimoireLaser !== 'undefined' && GrimoireLaser.isLaserTool)
      ? GrimoireLaser.isLaserTool(tool) : tool === 'laser';
    const mode = (laserOn || inputPrefs.fingerDraw) ? 'none' : 'pan-x pan-y';
    ['stage', 'stageB'].forEach(id => {
      const el = $(id);
      if (!el) return;
      el.style.touchAction = mode;
      el.classList.toggle('finger-ink', !!inputPrefs.fingerDraw);
      el.classList.toggle('tool-laser', !!laserOn);
      if (laserOn) el.style.cursor = 'none';
    });
  } catch { /* ignore */ }
}
/* ---------- Scroll-Navigation: Wheel über der Seite blättert (pro Pane) ----------
 * Nur Wheel (kein Touch/Pointer-Move): Zeichnen + Two-Finger-Tap bleiben
 * unberührt. Pinch-Zoom (ctrlKey+Wheel) wird nie gehandelt. Default AN,
 * persistiert unter federwerkScrollNavV1 (s. js/scrollnav.js). */
let scrollNavEnabled = true;
let scrollNavPane = { 0: null, 1: null };
try {
  if (typeof GrimoireScrollNav !== 'undefined') {
    scrollNavEnabled = GrimoireScrollNav.loadEnabled(typeof localStorage !== 'undefined' ? localStorage : null);
  } else if (typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem('federwerkScrollNavV1');
    if (raw != null) scrollNavEnabled = !(raw === '0' || raw === 'false');
  }
} catch { scrollNavEnabled = true; }
function isScrollNavEnabled() { return !!scrollNavEnabled; }
function setScrollNavEnabled(v) {
  scrollNavEnabled = !!v;
  try {
    if (typeof GrimoireScrollNav !== 'undefined') GrimoireScrollNav.saveEnabled(typeof localStorage !== 'undefined' ? localStorage : null, scrollNavEnabled);
    else if (typeof localStorage !== 'undefined') localStorage.setItem('federwerkScrollNavV1', scrollNavEnabled ? '1' : '0');
  } catch { /* ignore */ }
  syncToolbar();
}
function toggleScrollNav(ev) {
  if (ev) { try { ev.stopPropagation(); } catch { /* ignore */ } }
  setScrollNavEnabled(!isScrollNavEnabled());
}
let undoStack = [], redoStack = [];
let drawing = null, selectedBox = null, selectedImg = null;
let saveTimer = null;
// SPEC-25: Scribble-Trail (Radierer) für Scribble-Erase
let eraseTrail = null;

/* ---------- Split-Screen: 2 Dokumente in einem Fenster ---------- */
// Aktiver Pane besitzt die globalen undo/selected/drawing-Stapel; beim Wechsel
// werden sie in paneUI geparkt (sequentielles Editieren, kein Parallel-Draw).
let split = (typeof GrimoireSplit !== 'undefined')
  ? GrimoireSplit.createSplitState()
  : { enabled: false, active: 0, ratio: 0.5, panes: [{ bookId: null, pageId: null }, { bookId: null, pageId: null }] };
let paneUI = [
  { undo: [], redo: [], selBox: null, selImg: null },
  { undo: [], redo: [], selBox: null, selImg: null },
];
let editorPaneIdx = 0;
function splitApi() { return (typeof GrimoireSplit !== 'undefined') ? GrimoireSplit : null; }
function activePaneIdx() { return (split && split.active === 1) ? 1 : 0; }
function splitEnabled() { const api = splitApi(); return api ? api.isEnabled(split) : !!split.enabled; }
function paneSuffix(i) { return i === 1 ? 'B' : ''; }
function eid(base, idx) { return base + paneSuffix(idx == null ? activePaneIdx() : idx); }
function paneBookId(i) {
  const p = split && split.panes && split.panes[i === 1 ? 1 : 0];
  if (p && p.bookId) return p.bookId;
  if ((i || 0) === 0) return state.openBookId;
  return null;
}
function panePageId(i) {
  const p = split && split.panes && split.panes[i === 1 ? 1 : 0];
  if (p && p.pageId) return p.pageId;
  if ((i || 0) === 0) return state.openPageId;
  return null;
}
function paneBook(i) {
  const id = paneBookId(i);
  return state.books.find(b => b.id === id) || null;
}
function panePage(i) {
  const b = paneBook(i); if (!b) return null;
  const pid = panePageId(i);
  return b.pages.find(p => p.id === pid) || b.pages[0] || null;
}
function syncSplitToState() {
  // Pane 0 bleibt die Quelle für state.open* (Kompat: Export, Cloud, alte Pfade).
  try {
    if (split && split.panes && split.panes[0]) {
      if (split.panes[0].bookId) state.openBookId = split.panes[0].bookId;
      if (split.panes[0].pageId) state.openPageId = split.panes[0].pageId;
    }
    const api = splitApi();
    if (api) state.split = api.serialize(split);
  } catch { /* ignore */ }
}

const $ = id => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stripHtml = h => { const d = document.createElement('div'); d.innerHTML = h || ''; return d.textContent || ''; };
// 1px-Platzhalter, bis Blob-URLs aus IndexedDB aufgelöst sind
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/* ---------- Persistenz ---------- */
function ensureFoldersLocal() {
  try {
    if (typeof GrimoireFolders !== 'undefined' && GrimoireFolders.ensureFolders) {
      GrimoireFolders.ensureFolders(state);
    } else {
      if (!Array.isArray(state.folders)) state.folders = [];
      const valid = new Set(state.folders.map(f => f && f.id));
      for (const b of state.books) {
        if (b && b.folderId != null && !valid.has(b.folderId)) b.folderId = null;
      }
    }
  } catch { if (!Array.isArray(state.folders)) state.folders = []; }
  // Cloud-Mirror (federwerkFoldersV1) mit lokalem Stand zusammenführen,
  // damit alte Sync-Ordner nicht verloren gehen.
  try {
    if (typeof GrimoireFolders !== 'undefined' && typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem('federwerkFoldersV1');
      if (raw) {
        const mirror = JSON.parse(raw);
        const merged = GrimoireFolders.mergeFolders(state.folders, mirror);
        // Nur übernehmen, wenn Merge mehr weiß (kein Datenverlust bei leerem Mirror)
        if (merged.length >= 0 && (merged.length !== state.folders.length || JSON.stringify(merged) !== JSON.stringify(state.folders))) {
          // Wenn lokaler Stand leer, aber Mirror voll -> Mirror übernehmen
          if (!state.folders.length && merged.length) state.folders = merged;
        }
      }
    }
  } catch { /* Mirror optional */ }
  if (activeFolderId !== 'all' && activeFolderId !== 'unsorted') {
    const ok = (state.folders || []).some(f => f.id === activeFolderId);
    if (!ok) setActiveFolderId('all');
  }
}
function pushFoldersToMirror() {
  try {
    if (typeof GrimoireFolders === 'undefined' || typeof localStorage === 'undefined') return;
    const mirror = GrimoireFolders.toMirror(state.folders || []);
    localStorage.setItem('federwerkFoldersV1', JSON.stringify(mirror));
  } catch { /* ignore */ }
}
function pullFoldersFromMirror() {
  try {
    if (typeof GrimoireFolders === 'undefined' || typeof localStorage === 'undefined') return false;
    const raw = localStorage.getItem('federwerkFoldersV1');
    if (!raw) return false;
    const merged = GrimoireFolders.mergeFolders(state.folders || [], JSON.parse(raw));
    if (JSON.stringify(merged) !== JSON.stringify(state.folders || [])) {
      state.folders = merged;
      ensureFoldersLocal();
      return true;
    }
  } catch { /* ignore */ }
  return false;
}
function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) { const p = JSON.parse(raw); if (p && Array.isArray(p.books)) state = p; }
  } catch { /* ignore */ }
  ensureFoldersLocal();
  if (!state.books.length) {
    const b = newBook('Mein erstes Federwerk-Buch', true);
    state.books.push(b);
    state.openBookId = b.id; state.openPageId = b.pages[0].id;
    persistNow();
  }
}
function persistNow() {
  try {
    syncSplitToState();
    ensureFoldersLocal();
    pushFoldersToMirror();
    if (typeof GrimoireStore !== 'undefined') {
      GrimoireStore.saveNow(state).catch(() => setSaveStatus('⚠ Speichern fehlgeschlagen'));
      setSaveStatus('💾 gespeichert');
    } else {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
      setSaveStatus('💾 gespeichert');
    }
  } catch {
    setSaveStatus('⚠ Speicher voll (Bilder verkleinern)');
  }
}
function persistSoon() {
  setSaveStatus('● speichern…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 400);
}
function setSaveStatus(t) { const el = $('statusSave'); if (el) el.textContent = t; }

/* ---------- Modell ---------- */
function newPage() { return { id: uid(), strokes: [], texts: [], images: [], bg: null }; }
function newBook(title, withStarter) {
  const b = { id: uid(), title: title || 'Neues Buch', paper: 'grid-a4', updatedAt: Date.now(), folderId: null, pages: [newPage()] };
  // Neues Buch landet im aktiven Ordner (falls einer gewählt ist)
  try {
    if (activeFolderId && activeFolderId !== 'all' && activeFolderId !== 'unsorted') {
      const ok = (state.folders || []).some(f => f.id === activeFolderId);
      if (ok) b.folderId = activeFolderId;
    }
  } catch { /* ignore */ }
  // SPEC-31 light: Suchsprache pro Buch (book.lang, Default Gerätesprache/'de').
  // V1 bewusst ohne UI-Bruch (kein Dialog-Feld); Umstellung später hier im
  // Buch-Flow, aktuell per GrimoireInkIndex.setBookLang(book, 'en').
  try { b.lang = (typeof GrimoireInkIndex !== 'undefined' && GrimoireInkIndex.defaultLang) ? GrimoireInkIndex.defaultLang() : 'de'; } catch { b.lang = 'de'; }
  if (withStarter) {
    b.pages[0].texts.push({ id: uid(), x: 0.08, y: 0.05, html: '<h2>Willkommen im Federwerk</h2><p>• <b>Stift/Marker:</b> auf der Seite malen (Maus, Touch, Stylus)<br>• <b>Text:</b> Tool „T Text“ → auf Seite klicken → Doppelklick öffnet den großen Texteditor<br>• <b>Bild:</b> über 🖼 einfügen, in Auswahl-Modus ✥ verschieben &amp; skalieren<br>• <b>Radierer:</b> Striche antippen zum Löschen</p>' });
  }
  return b;
}
function openBook() { return paneBook(activePaneIdx()) || state.books.find(b => b.id === state.openBookId) || null; }
function currentPage() {
  const p = panePage(activePaneIdx());
  if (p) return p;
  const b = openBook(); if (!b) return null;
  return b.pages.find(x => x.id === state.openPageId) || b.pages[0] || null;
}
function touchBook() { const b = openBook(); if (b) b.updatedAt = Date.now(); }
function touchPaneBook(i) { const b = paneBook(i); if (b) b.updatedAt = Date.now(); }

/* ---------- Bibliothek ---------- */
function showLibrary() {
  $('viewLibrary').classList.add('active');
  $('viewBook').classList.remove('active');
  renderLibrary();
}
function openBookView(id, pageId, paneIdx) {
  const api = splitApi();
  const target = (paneIdx === 1 || paneIdx === 0) ? paneIdx : activePaneIdx();
  const b = state.books.find(x => x.id === id);
  if (!b) return;
  const pid = pageId || (b.pages[0] && b.pages[0].id);
  parkActiveUI();
  if (api) api.setPaneDoc(split, target, id, pid);
  else { split.panes[target] = { bookId: id, pageId: pid }; }
  if (paneUI[target]) { paneUI[target].undo = []; paneUI[target].redo = []; paneUI[target].selBox = null; paneUI[target].selImg = null; }
  if (target === 0) { state.openBookId = id; state.openPageId = pid; }
  setActivePane(target, true);
  $('viewLibrary').classList.remove('active');
  $('viewBook').classList.add('active');
  syncSplitToState();
  syncToolbar(); renderAll(); persistSoon();
}
function openBookInPane(id, paneIdx) {
  if (!id) return;
  const b = state.books.find(x => x.id === id);
  if (!b) return;
  openBookView(id, b.pages[0] && b.pages[0].id, paneIdx === 1 ? 1 : 0);
}
/* Bibliothek: Buch direkt im rechten Split-Bereich öffnen (ohne Fenster) */
function openBookInSplit(id, ev) {
  if (ev) ev.stopPropagation();
  const b = state.books.find(x => x.id === id);
  if (!b) return;
  const api = splitApi();
  if (!splitEnabled()) {
    if (api) api.enableSplit(split, id, b.pages[0] && b.pages[0].id);
    else { split.enabled = true; split.panes[1] = { bookId: id, pageId: b.pages[0] && b.pages[0].id }; }
    if (paneUI[1]) { paneUI[1].undo = []; paneUI[1].redo = []; paneUI[1].selBox = null; paneUI[1].selImg = null; }
    if (!paneBookId(0)) {
      if (api) api.setPaneDoc(split, 0, state.openBookId, state.openPageId);
      else split.panes[0] = { bookId: state.openBookId, pageId: state.openPageId };
    }
    syncSplitToState();
    $('viewLibrary').classList.remove('active');
    $('viewBook').classList.add('active');
    applySplitLayout(); renderAll(); persistSoon();
    setActivePane(1, true);
  } else {
    openBookView(id, b.pages[0] && b.pages[0].id, 1);
  }
}
function createNotebook() {
  const b = newBook('Neues Buch ' + (state.books.length + 1));
  state.books.unshift(b);
  persistNow(); renderLibrary();
  openBookView(b.id);
}
function deleteBook(id, ev) {
  if (ev) ev.stopPropagation();
  if (!confirm('Buch wirklich löschen?')) return;
  state.books = state.books.filter(b => b.id !== id);
  // Split-Panes auf Fallback umhängen (sonst leere Bereiche)
  try {
    const api = splitApi();
    const fb = state.books[0] || null;
    const fallback = fb ? { bookId: fb.id, pageId: fb.pages[0] && fb.pages[0].id } : { bookId: null, pageId: null };
    if (api) api.handleBookDeleted(split, id, fallback);
    else split.panes.forEach(p => { if (p && p.bookId === id) { p.bookId = fallback.bookId; p.pageId = fallback.pageId; } });
    if (state.openBookId === id) { state.openBookId = fallback.bookId; state.openPageId = fallback.pageId; }
    syncSplitToState();
  } catch { /* ignore */ }
  persistNow(); renderLibrary(); renderAll();
  // Hinweis: Cloud-Tombstone übernimmt der Appwrite-Sync per Meta-Diff.
}
function duplicateBook(id, ev) {
  if (ev) ev.stopPropagation();
  const src = state.books.find(b => b.id === id); if (!src) return;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid(); copy.title = src.title + ' (Kopie)';
  copy.pages.forEach(p => { p.id = uid(); });
  copy.updatedAt = Date.now();
  if (typeof copy.folderId !== 'string') copy.folderId = src.folderId || null;
  state.books.unshift(copy);
  persistNow(); renderLibrary();
}

/* ---------- Ordner (Bibliothek) ---------- */
function folderList() {
  ensureFoldersLocal();
  return state.folders || [];
}
function setActiveFolder(id, ev) {
  if (ev) { try { ev.stopPropagation(); } catch { /* ignore */ } }
  setActiveFolderId(id || 'all');
  renderLibrary();
}
function createFolderUI(parentId) {
  const pid = (typeof parentId === 'string' && parentId) ? parentId : null;
  let pname = '';
  if (pid) {
    const pf = (state.folders || []).find(x => x && x.id === pid);
    if (!pf) return;
    pname = ' in „' + (pf.name || '') + '“';
  }
  let name = '';
  try { name = prompt('Neuer Ordner' + pname + ' – Name:', ''); } catch { name = ''; }
  if (name === null) return;
  name = String(name || '').trim();
  if (!name) return;
  try {
    if (typeof GrimoireFolders !== 'undefined') {
      const f = GrimoireFolders.createFolder(state.folders, name, pid);
      if (!f) return;
      expandFolder(f.id, true);
      if (pid) expandFolder(pid, true);
      persistNow();
      setActiveFolderId(f.id);
      renderLibrary();
    }
  } catch (e) { alert('Ordner konnte nicht angelegt werden.'); }
}
function createSubfolderUI(id, ev) {
  if (ev) ev.stopPropagation();
  createFolderUI(id);
}
function renameFolderUI(id, ev) {
  if (ev) ev.stopPropagation();
  startFolderRename(id);
}
function promptRenameFolder(id) {
  const f = (state.folders || []).find(x => x && x.id === id);
  if (!f) return;
  let name = '';
  try { name = prompt('Ordner umbenennen:', f.name || ''); } catch { return; }
  if (name === null) return;
  name = String(name || '').trim();
  if (!name) return;
  try {
    if (typeof GrimoireFolders !== 'undefined') GrimoireFolders.renameFolder(state.folders, id, name);
    else f.name = name;
    persistNow(); renderLibrary();
  } catch { /* ignore */ }
}
// Inline-Rename (Doppelklick/Enter/F2): ersetzt Label durch Input im Tree.
function startFolderRename(id) {
  const f = (state.folders || []).find(x => x && x.id === id);
  if (!f) return;
  const nav = $('folderNav');
  const row = nav ? nav.querySelector('[data-folder="' + id + '"] .folder-label') : null;
  if (!row) { promptRenameFolder(id); return; } // Fallback (z.B. mobil/Chips)
  if (row.querySelector('input')) return;
  const old = f.name || '';
  row.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = old;
  input.maxLength = 60;
  input.className = 'folder-rename';
  input.setAttribute('aria-label', 'Ordner umbenennen');
  row.appendChild(input);
  input.focus();
  try { input.setSelectionRange(0, input.value.length); } catch { /* ignore */ }
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const v = String(input.value || '').trim();
    if (save && v && v !== old) {
      try {
        if (typeof GrimoireFolders !== 'undefined') GrimoireFolders.renameFolder(state.folders, id, v);
        else f.name = v;
        persistNow();
      } catch { /* ignore */ }
    }
    renderLibrary();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('click', (e) => { e.stopPropagation(); });
  input.addEventListener('dblclick', (e) => { e.stopPropagation(); });
}
function deleteFolderUI(id, ev) {
  if (ev) ev.stopPropagation();
  const f = (state.folders || []).find(x => x && x.id === id);
  if (!f) return;
  let extra = '';
  try {
    if (typeof GrimoireFolders !== 'undefined') {
      const n = GrimoireFolders.getDescendants(state.folders || [], id).length;
      if (n) extra = ' (inkl. ' + n + ' Unterordner)';
    }
  } catch { /* ignore */ }
  if (!confirm('Ordner „' + (f.name || '') + '“' + extra + ' löschen? Bücher bleiben erhalten (werden zu „Unsortiert“).')) return;
  try {
    if (typeof GrimoireFolders !== 'undefined') GrimoireFolders.deleteFolder(state, id);
    else {
      state.folders = (state.folders || []).filter(x => x && x.id !== id);
      for (const b of state.books) if (b && b.folderId === id) b.folderId = null;
    }
    pruneExpanded();
    if (activeFolderId === id) setActiveFolderId('all');
    else {
      // Falls aktiver Ordner ein gelöschter Nachfahre war -> Alle
      const ok = (activeFolderId === 'all' || activeFolderId === 'unsorted')
        || (state.folders || []).some(x => x && x.id === activeFolderId);
      if (!ok) setActiveFolderId('all');
    }
    persistNow(); renderLibrary();
  } catch { /* ignore */ }
}
function moveFolderUI(id, newParentId, ev) {
  if (ev) { try { ev.stopPropagation(); } catch { /* ignore */ } }
  try {
    let ok = false;
    if (typeof GrimoireFolders !== 'undefined') ok = GrimoireFolders.moveFolder(state.folders || [], id, newParentId || null);
    else {
      const f = (state.folders || []).find(x => x && x.id === id);
      if (f) { f.parentId = newParentId || null; f.updatedAt = Date.now(); ok = true; }
    }
    if (!ok) { alert('Ordner kann nicht hierher verschoben werden (Zirkel-Schutz).'); return false; }
    if (newParentId) expandFolder(newParentId, true);
    persistNow(); renderLibrary();
    return true;
  } catch { /* ignore */ return false; }
}
function moveBookToFolder(bookId, folderId, ev) {
  if (ev) ev.stopPropagation();
  try {
    let ok = false;
    if (typeof GrimoireFolders !== 'undefined') ok = GrimoireFolders.moveBook(state.books, bookId, folderId || null, state.folders);
    else {
      const b = state.books.find(x => x.id === bookId);
      if (b) { b.folderId = folderId || null; b.updatedAt = Date.now(); ok = true; }
    }
    if (ok) { persistNow(); renderLibrary(); }
  } catch { /* ignore */ }
}
/* Auf/Zu-Persistenz (localStorage federwerkFolderExpandedV1: Array expandierter Ids) */
const FOLDER_EXPANDED_KEY = 'federwerkFolderExpandedV1';
let folderExpanded = null; // null = lazy laden
function loadExpanded() {
  if (folderExpanded instanceof Set) return folderExpanded;
  folderExpanded = new Set();
  try {
    if (typeof localStorage === 'undefined') return folderExpanded;
    const raw = localStorage.getItem(FOLDER_EXPANDED_KEY);
    if (!raw) {
      // Erststart: alles aufklappen (wird beim Rendern mit allen Ids befüllt)
      folderExpanded = new Set(['*all*']);
      return folderExpanded;
    }
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) for (const id of arr) folderExpanded.add(String(id));
    else folderExpanded.add('*all*');
  } catch { folderExpanded = new Set(['*all*']); }
  return folderExpanded;
}
function saveExpanded() {
  try {
    if (typeof localStorage === 'undefined' || !(folderExpanded instanceof Set)) return;
    localStorage.setItem(FOLDER_EXPANDED_KEY, JSON.stringify(Array.from(folderExpanded)));
  } catch { /* ignore */ }
}
function isFolderExpanded(id) {
  const s = loadExpanded();
  if (s.has('*all*')) return true;
  return s.has(String(id));
}
function expandFolder(id, on) {
  const s = loadExpanded();
  s.delete('*all*');
  // Alle aktuell bekannten Ordner als explizit expanded merken, damit
  // Zuklappen einzelner Knoten persistent bleibt.
  try {
    for (const f of state.folders || []) {
      if (f && f.id && on !== false) { /* nur Ziel unten */ }
    }
  } catch { /* ignore */ }
  if (on === false) s.delete(String(id));
  else s.add(String(id));
  saveExpanded();
}
function toggleFolderExpanded(id, ev) {
  if (ev) { try { ev.stopPropagation(); } catch { /* ignore */ } }
  const s = loadExpanded();
  if (s.has('*all*')) {
    // Von "alle offen" auf explizite Menge wechseln (alle außer diesem)
    s.delete('*all*');
    for (const f of state.folders || []) if (f && f.id && f.id !== id) s.add(f.id);
  } else {
    expandFolder(id, !s.has(String(id)) ? true : false);
    return;
  }
  saveExpanded();
  renderLibrary();
}
function pruneExpanded() {
  try {
    const s = loadExpanded();
    if (s.has('*all*')) return;
    const valid = new Set((state.folders || []).map(f => f && f.id));
    for (const id of Array.from(s)) if (!valid.has(id)) s.delete(id);
    saveExpanded();
  } catch { /* ignore */ }
}
/* Drag & Drop (HTML5): Bücher + Ordner auf Ordner ziehen */
function bookDragStart(ev, bookId) {
  try {
    ev.dataTransfer.setData('text/federwerk-book', String(bookId));
    ev.dataTransfer.setData('text/plain', 'book:' + String(bookId));
    ev.dataTransfer.effectAllowed = 'move';
  } catch { /* ignore */ }
}
function folderDragStart(ev, folderId) {
  try {
    ev.dataTransfer.setData('text/federwerk-folder', String(folderId));
    ev.dataTransfer.setData('text/plain', 'folder:' + String(folderId));
    ev.dataTransfer.effectAllowed = 'move';
  } catch { /* ignore */ }
  try { ev.stopPropagation(); } catch { /* ignore */ }
}
function folderDragOver(ev) {
  try {
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    ev.preventDefault();
    const row = ev.currentTarget;
    if (row && row.classList) row.classList.add('drop-target');
  } catch { /* ignore */ }
}
function folderDragLeave(ev) {
  try {
    const row = ev.currentTarget;
    if (row && row.classList) row.classList.remove('drop-target');
  } catch { /* ignore */ }
}
function folderDropOnto(ev, targetFolderId) {
  try { ev.preventDefault(); ev.stopPropagation(); } catch { /* ignore */ }
  try {
    const row = ev.currentTarget;
    if (row && row.classList) row.classList.remove('drop-target');
  } catch { /* ignore */ }
  let bookId = '', folderId = '';
  try {
    bookId = ev.dataTransfer.getData('text/federwerk-book') || '';
    folderId = ev.dataTransfer.getData('text/federwerk-folder') || '';
    if (!bookId && !folderId) {
      const plain = ev.dataTransfer.getData('text/plain') || '';
      if (plain.indexOf('book:') === 0) bookId = plain.slice(5);
      else if (plain.indexOf('folder:') === 0) folderId = plain.slice(7);
    }
  } catch { /* ignore */ }
  if (bookId) { moveBookToFolder(bookId, targetFolderId || null, null); return; }
  if (folderId) {
    if (folderId === targetFolderId) return;
    moveFolderUI(folderId, targetFolderId || null, null);
  }
}
/* Kontextmenü: Rechtsklick + Long-Press (Touch) */
let folderMenuEl = null;
let folderMenuFor = null;
let longPressTimer = null;
function hideFolderMenu() {
  try { if (folderMenuEl && folderMenuEl.parentNode) folderMenuEl.parentNode.removeChild(folderMenuEl); } catch { /* ignore */ }
  folderMenuEl = null; folderMenuFor = null;
  try { document.removeEventListener('click', hideFolderMenu, true); } catch { /* ignore */ }
}
function showFolderMenu(x, y, folderId) {
  hideFolderMenu();
  folderMenuFor = folderId || null;
  const menu = document.createElement('div');
  menu.className = 'folder-menu';
  menu.setAttribute('role', 'menu');
  const items = [];
  if (folderId) {
    const f = (state.folders || []).find(v => v && v.id === folderId);
    const nm = f ? f.name : 'Ordner';
    items.push({ label: '✎ Umbenennen', fn: () => startFolderRename(folderId) });
    items.push({ label: '📁 Neuer Unterordner', fn: () => createFolderUI(folderId) });
    items.push({ label: '⇉ Verschieben → Unsortiert-Ebene (Root)', fn: () => moveFolderUI(folderId, null, null) });
    items.push({ label: '🗑 Löschen („' + String(nm || '').slice(0, 24) + '“)', danger: true, fn: () => deleteFolderUI(folderId, null) });
  } else {
    items.push({ label: '📁 Neuer Ordner', fn: () => createFolderUI(null) });
  }
  items.push({ label: '📚 Alle Bücher', fn: () => setActiveFolder('all', null) });
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'folder-menu-item' + (it.danger ? ' danger' : '');
    b.setAttribute('role', 'menuitem');
    b.textContent = it.label;
    b.addEventListener('click', (e) => { e.stopPropagation(); hideFolderMenu(); it.fn(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const w = menu.offsetWidth || 200, h = menu.offsetHeight || 120;
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + 'px';
  folderMenuEl = menu;
  setTimeout(() => {
    try { document.addEventListener('click', hideFolderMenu, true); } catch { /* ignore */ }
  }, 0);
  try {
    const first = menu.querySelector('button');
    if (first) first.focus();
  } catch { /* ignore */ }
}
function folderRowKeydown(ev, folderId) {
  const nav = $('folderNav');
  const rows = nav ? Array.from(nav.querySelectorAll('[data-folderrow]')) : [];
  const ix = rows.findIndex(r => r.getAttribute('data-folderrow') === String(folderId));
  const focusRow = (i) => {
    if (i < 0) i = 0;
    if (i >= rows.length) i = rows.length - 1;
    const el = rows[i];
    if (el) {
      const btn = el.querySelector('.folder-item--main, .folder-item');
      if (btn) btn.focus();
    }
  };
  if (ev.key === 'ArrowDown') { ev.preventDefault(); focusRow(ix + 1); }
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); focusRow(ix - 1); }
  else if (ev.key === 'ArrowRight') {
    ev.preventDefault();
    expandFolder(folderId, true); renderLibrary();
    focusRow(ix);
  }
  else if (ev.key === 'ArrowLeft') {
    ev.preventDefault();
    expandFolder(folderId, false); renderLibrary();
    focusRow(ix);
  }
  else if (ev.key === 'Enter') {
    // Enter auf eingeklapptem Knoten: aufklappen + auswählen; sonst Rename via F2/Enter?
    // OS-Konvention hier: Enter wählt aus, F2 benennt um (Enter rename nur wenn bereits aktiv).
    ev.preventDefault();
    if (document.activeElement && nav && nav.contains(document.activeElement)) {
      if (activeFolderId === folderId) startFolderRename(folderId);
      else setActiveFolder(folderId, null);
    }
  }
  else if (ev.key === 'F2') { ev.preventDefault(); startFolderRename(folderId); }
  else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); deleteFolderUI(folderId, null); }
}
function bindFolderNavEvents() {
  const nav = $('folderNav');
  if (!nav || nav._osBound) return;
  nav._osBound = true;
  nav.addEventListener('contextmenu', (e) => {
    const row = e.target && e.target.closest ? e.target.closest('[data-folderrow]') : null;
    e.preventDefault();
    showFolderMenu(e.clientX, e.clientY, row ? row.getAttribute('data-folderrow') : null);
  });
  nav.addEventListener('touchstart', (e) => {
    const row = e.target && e.target.closest ? e.target.closest('[data-folderrow]') : null;
    if (!row) return;
    const id = row.getAttribute('data-folderrow');
    const t = (e.touches && e.touches[0]) || null;
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      showFolderMenu(t ? t.clientX : 40, t ? t.clientY : 120, id);
    }, 550);
  }, { passive: true });
  nav.addEventListener('touchend', () => clearTimeout(longPressTimer), { passive: true });
  nav.addEventListener('touchmove', () => clearTimeout(longPressTimer), { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && folderMenuEl) hideFolderMenu();
  });
}
function folderDepth(id) {
  try {
    if (typeof GrimoireFolders !== 'undefined' && GrimoireFolders.getPath) {
      return Math.max(0, GrimoireFolders.getPath(state.folders || [], id).length - 1);
    }
  } catch { /* ignore */ }
  return 0;
}
function folderOptionsHtml(selectedId) {
  let ordered = (state.folders || []).slice();
  try {
    if (typeof GrimoireFolders !== 'undefined' && GrimoireFolders.sortTree) {
      ordered = GrimoireFolders.sortTree(ordered.slice());
    } else {
      ordered.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'de'));
    }
  } catch { /* ignore */ }
  const opts = ['<option value="">Unsortiert</option>'].concat(
    ordered.map(f => {
      let depth = 0;
      try { depth = folderDepth(f.id); } catch { depth = 0; }
      const indent = depth ? new Array(depth + 1).join('— ') : '';
      return '<option value="' + f.id + '"' + (f.id === selectedId ? ' selected' : '') + '>' + esc('📁 ' + indent + (f.name || '')) + '</option>';
    })
  );
  return opts.join('');
}
function refreshFoldersFromMirror() {
  try {
    if (pullFoldersFromMirror()) { persistSoon(); renderLibrary(); return true; }
  } catch { /* ignore */ }
  return false;
}
function renameBook(v) { const b = openBook(); if (!b) return; b.title = v || 'Unbenannt'; touchBook(); persistSoon(); syncPaneChrome(activePaneIdx()); syncBookSelects(); }
// SPEC-31: book.lang bleibt beim Umbenennen erhalten; Sprachwechsel später
// im Buch-Dialog (z. B. <select>), V1 nur per GrimoireInkIndex.setBookLang().
/* ---------- Papier-Vorlagen (js/paper-templates.js, Buch-weit) ----------
 * book.paper = Template-ID (kanonisch, z. B. 'grid-a4'). Legacy-IDs
 * ('' | 'lined' | 'grid') werden beim Setzen/Laden normalisiert, rendern
 * aber auch unnormalisiert korrekt (FederwerkPaper.resolve als Fallback).
 * Maße: Template-Wechsel schreibt page.size auf template-folgende Seiten
 * (Seiten mit eigenem Bild-/PDF-Format bleiben unangetastet); Strokes
 * werden proportional umgerechnet. KEIN pro-Seite-Template-Override
 * (bewusst: ein Design pro Buch, ein Format pro Seite via page.size). */
function paperApi() {
  try { if (typeof FederwerkPaper !== 'undefined' && FederwerkPaper.normalizeId) return FederwerkPaper; } catch { /* ignore */ }
  return null;
}
function stampPageSizeForBook(p, bookPaper) {
  const P = paperApi();
  if (!P) return;
  try {
    const s = P.sizeForTemplateId(bookPaper);
    if (s) p.size = s;
    else delete p.size;
  } catch { /* Format-Stempel optional */ }
}
function setPaper(v) {
  const b = openBook(); if (!b) return;
  const P = paperApi();
  const id = P ? P.normalizeId(v) : (v || '');
  const oldDims = P ? P.dimsFor(b.paper) : { w: CANVAS_W, h: CANVAS_H };
  const newDims = P ? P.dimsFor(id) : { w: CANVAS_W, h: CANVAS_H };
  b.paper = id;
  // Maße auf template-folgende Seiten übertragen (PDF-/Bildseiten behalten
  // ihr Format); Strokes proportional mitnehmen wie bei setPageSize.
  if (P && (oldDims.w !== newDims.w || oldDims.h !== newDims.h) && Array.isArray(b.pages)) {
    try { snapshot(true); } catch { /* History optional */ }
    const targetSize = P.sizeForTemplateId(id); // null = A4-Default -> nicht persistieren
    b.pages.forEach(p => {
      if (!p) return;
      let follows = true;
      try { follows = P.followsTemplate(p, oldDims); } catch { follows = true; }
      if (!follows) return;
      let from = null;
      try { from = P.sanitizeSize(p.size); } catch { from = null; }
      from = from || { w: CANVAS_W, h: CANVAS_H };
      if (from.w === newDims.w && from.h === newDims.h) {
        if (p.size && !targetSize) { try { delete p.size; } catch { /* ignore */ } }
        else if (targetSize) { try { p.size = { w: targetSize.w, h: targetSize.h }; } catch { /* ignore */ } }
        return;
      }
      try {
        if (typeof PagesImport !== 'undefined' && PagesImport.retargetStrokes) {
          p.strokes = PagesImport.retargetStrokes(p.strokes, from, newDims) || [];
        }
      } catch { /* Inhalt bleibt, nur Format wechselt */ }
      if (targetSize) { try { p.size = { w: targetSize.w, h: targetSize.h }; } catch { /* ignore */ } }
      else { try { delete p.size; } catch { /* ignore */ } }
    });
  }
  touchBook(); persistSoon(); renderAll();
}
/* Buch-Vorlagenmaße (für __auto-Fallback und Persistenz-Entscheidung). */
function bookTemplateDims() {
  try {
    const P = paperApi();
    if (P && P.dimsFor) {
      const b = openBook();
      const d = P.dimsFor(b && b.paper);
      if (d) {
        const w = Math.round(Number(d.w)), h = Math.round(Number(d.h));
        if (isFinite(w) && isFinite(h) && w >= 200 && w <= 2400 && h >= 200 && h <= 2400) return { w, h };
      }
    }
  } catch { /* A4 unten */ }
  return { w: CANVAS_W, h: CANVAS_H };
}
/* ---------- Seitenformat (unterschiedlich große Seiten in einem Dokument) ----------
 * v: '__auto' (Buchvorlage folgen, size löschen), Preset-Key
 * ('a4p'|'a4l'|'square'), {w,h} oder '__custom' (No-op, nur Anzeige).
 * Persistiert wird size nur bei Abweichung von der Buchvorlage (sonst
 * folgen = löschen) – Altbestand bleibt schlank. Beschriebene Seiten werden
 * proportional umgerechnet (Strokes; Texte/Bilder sind normiert und folgen
 * automatisch). GoodNotes-Seiten bleiben A4 (Import-Mapping ist fix A4). */
function setPageSize(v) {
  const b = openBook(); const p = currentPage(); if (!b || !p) return;
  if (v === '__custom') { syncPaneChrome(activePaneIdx()); return; }
  const tpl = bookTemplateDims();
  let target = null; // null = folgen (__auto)
  if (v !== '__auto' && v != null) {
    try {
      if (typeof PagesImport !== 'undefined' && PagesImport.PAGE_FORMATS && typeof v === 'string' && PagesImport.PAGE_FORMATS[v]) {
        const pr = PagesImport.PAGE_FORMATS[v];
        target = { w: pr.w, h: pr.h };
      } else if (typeof PagesImport !== 'undefined' && PagesImport.sanitizePageSize) {
        target = PagesImport.sanitizePageSize(v) || { w: CANVAS_W, h: CANVAS_H };
      }
    } catch { target = { w: CANVAS_W, h: CANVAS_H }; }
    if (!target) target = { w: CANVAS_W, h: CANVAS_H };
  }
  const from = pageDimsOf(p, b.paper);
  const to = target || tpl;
  if (from.w === to.w && from.h === to.h) {
    // Maße stimmen schon: ggf. auf Folgen normalisieren (Ballast löschen)
    if (!target) {
      if (p.size) { snapshot(true); delete p.size; touchBook(); persistSoon(); renderAll(); }
      else syncPaneChrome(activePaneIdx());
    } else if (target.w === tpl.w && target.h === tpl.h) {
      if (p.size) { snapshot(true); delete p.size; touchBook(); persistSoon(); renderAll(); }
      else syncPaneChrome(activePaneIdx());
    } else {
      if (!p.size || p.size.w !== target.w || p.size.h !== target.h) {
        snapshot(true); p.size = { w: target.w, h: target.h }; touchBook(); persistSoon(); renderAll();
      } else syncPaneChrome(activePaneIdx());
    }
    return;
  }
  snapshot(true);
  try {
    if (typeof PagesImport !== 'undefined' && PagesImport.retargetStrokes) {
      p.strokes = PagesImport.retargetStrokes(p.strokes, from, to) || [];
    }
  } catch { /* Inhalt bleibt, nur Format wechselt */ }
  if (!target || (target.w === tpl.w && target.h === tpl.h)) delete p.size;
  else p.size = { w: target.w, h: target.h };
  touchBook(); persistSoon(); renderAll();
}

/* ---------- Split-Steuerung (2 Dokumente, 1 Fenster) ---------- */
function parkActiveUI() {
  const i = activePaneIdx();
  if (paneUI[i]) { paneUI[i].undo = undoStack; paneUI[i].redo = redoStack; paneUI[i].selBox = selectedBox; paneUI[i].selImg = selectedImg; }
}
function unparkActiveUI() {
  const i = activePaneIdx();
  const ui = paneUI[i] || { undo: [], redo: [], selBox: null, selImg: null };
  undoStack = ui.undo || []; redoStack = ui.redo || [];
  selectedBox = ui.selBox || null; selectedImg = ui.selImg || null;
}
function setActivePane(i, silent) {
  const next = (i === 1) ? 1 : 0;
  if (split && split.active === next && !silent) { applySplitLayout(); return next; }
  if (!splitEnabled() && next === 1) return 0;
  parkActiveUI();
  if (splitApi()) splitApi().setActive(split, next);
  else split.active = next;
  drawing = null; eraseTrail = null;
  try { if (typeof stopLaser === 'function') stopLaser(); } catch { /* ignore */ }
  try { clearOverlayFor(0); } catch { /* ignore */ }
  try { clearOverlayFor(1); } catch { /* ignore */ }
  unparkActiveUI();
  editorPaneIdx = next;
  syncSplitToState();
  applySplitLayout(); syncToolbar(); renderAll();
  if (!silent) persistSoon();
  return next;
}
function toggleSplit(ev) {
  if (ev) { try { ev.stopPropagation(); } catch { /* ignore */ } }
  const api = splitApi();
  if (!splitEnabled()) {
    // Zweites Dokument: anderes Buch als Pane 0, sonst aktuelles dupliziert
    const other = state.books.find(b => b.id !== paneBookId(0)) || paneBook(0);
    const bid = other ? other.id : null;
    const bObj = other || null;
    const pid = bObj ? (bObj.pages[0] && bObj.pages[0].id) : null;
    if (api) api.enableSplit(split, bid, pid);
    else { split.enabled = true; split.panes[1] = { bookId: bid, pageId: pid }; }
    if (paneUI[1]) { paneUI[1].undo = []; paneUI[1].redo = []; paneUI[1].selBox = null; paneUI[1].selImg = null; }
    syncSplitToState(); applySplitLayout(); renderAll(); persistSoon();
    setActivePane(1, true);
  } else {
    closeSplit(ev);
  }
}
function closeSplit(ev) {
  if (ev) { try { ev.stopPropagation(); } catch { /* ignore */ } }
  const api = splitApi();
  parkActiveUI();
  // Offenen Pane behalten: wer aktiv ist, überlebt
  const keep = activePaneIdx();
  if (api) api.disableSplit(split, keep);
  else { split.enabled = false; split.active = 0; }
  // Falls Pane 1 aktiv war, dessen Doku nach Pane 0 übernehmen (disableSplit tut das)
  if (keep === 0 && split.panes && split.panes[0]) { state.openBookId = split.panes[0].bookId; state.openPageId = split.panes[0].pageId; }
  else if (split.panes && split.panes[0]) { state.openBookId = split.panes[0].bookId; state.openPageId = split.panes[0].pageId; }
  if (keep === 1 && paneUI[1]) { paneUI[0] = { undo: paneUI[1].undo || [], redo: paneUI[1].redo || [], selBox: paneUI[1].selBox || null, selImg: paneUI[1].selImg || null }; }
  unparkActiveUI();
  // Nach dem Zusammenführen liegt alles in Pane 0
  if (split.active !== 0) { split.active = 0; unparkActiveUI(); }
  drawing = null; eraseTrail = null;
  syncSplitToState(); applySplitLayout(); syncToolbar(); renderAll(); persistSoon();
}
function swapSplitPanes(ev) {
  if (ev) { try { ev.stopPropagation(); } catch { /* ignore */ } }
  if (!splitEnabled()) return;
  parkActiveUI();
  const api = splitApi();
  if (api) api.swapPanes(split);
  else { const t = split.panes[0]; split.panes[0] = split.panes[1]; split.panes[1] = t; split.active = split.active === 1 ? 0 : 1; }
  { const t = paneUI[0]; paneUI[0] = paneUI[1]; paneUI[1] = t; } // Undo-Verlauf wandert mit dem Dokument
  if (split.panes[0]) { state.openBookId = split.panes[0].bookId; state.openPageId = split.panes[0].pageId; }
  unparkActiveUI();
  syncSplitToState(); renderAll(); persistSoon();
}
function setSplitRatio(r) {
  const api = splitApi();
  const v = api ? api.setRatio(split, Number(r)) : Math.min(0.8, Math.max(0.2, Number(r) || 0.5));
  split.ratio = v;
  applySplitLayout(); persistSoon();
  return v;
}
function syncBookSelects() {
  ['bookSelect', 'bookSelectB'].forEach((id, i) => {
    const sel = $(id); if (!sel) return;
    if (document.activeElement === sel) return; // offenes Dropdown nicht zerlegen
    const cur = paneBookId(i);
    sel.innerHTML = state.books.map(b => '<option value="' + b.id + '"' + (b.id === cur ? ' selected' : '') + '>' + esc(b.title || 'Unbenannt') + '</option>').join('')
      || '<option value="">– keine Bücher –</option>';
    sel.value = cur || '';
  });
}
function syncPaneChrome(i) {
  const b = paneBook(i);
  const t = $(i === 1 ? 'bookTitleB' : 'bookTitle');
  const ps = $(i === 1 ? 'paperSelectB' : 'paperSelect');
  if (t && document.activeElement !== t) t.value = b ? (b.title || '') : '';
  if (ps) {
    // Optionen aus dem Vorlagen-Katalog nachziehen (Single Source of Truth:
    // js/paper-templates.js; statische <optgroup>s in index.html als Fallback)
    try {
      const P = paperApi();
      if (P && P.groups && (!ps.dataset.paperBuilt || ps.options.length < P.TEMPLATES.length)) {
        ps.innerHTML = P.groups().map(g =>
          '<optgroup label="' + esc(g.label) + '">' + g.items.map(o =>
            '<option value="' + esc(o.id) + '">' + esc(o.name) + '</option>').join('') + '</optgroup>'
        ).join('');
        ps.dataset.paperBuilt = '1';
      }
    } catch { /* statische Optionen bleiben */ }
    let cur = (b && b.paper) || '';
    try { const P = paperApi(); if (P) cur = P.normalizeId(cur); } catch { /* Rohwert */ }
    ps.value = cur;
  }
  // Seitenformat-Select: eigenes Format (Preset/Custom) oder Buchvorlage (auto).
  // Ohne eigenes size folgt die Seite der Vorlage -> '__auto' zeigen.
  const fs = $(i === 1 ? 'pageFormatB' : 'pageFormat');
  if (fs && document.activeElement !== fs) {
    try {
      const p = panePage(i);
      let own = null;
      try {
        if (typeof PagesImport !== 'undefined' && PagesImport.sanitizePageSize) own = PagesImport.sanitizePageSize(p && p.size);
        else if (p && p.size) own = { w: Math.round(Number(p.size.w)), h: Math.round(Number(p.size.h)) };
      } catch { own = null; }
      let customOpt = fs.querySelector('option[data-custom="1"]');
      if (!own) {
        if (customOpt) customOpt.remove();
        fs.value = '__auto';
      } else {
        const m = (typeof PagesImport !== 'undefined' && PagesImport.matchPageFormat)
          ? PagesImport.matchPageFormat(own) : null;
        if (!m) {
          const label = 'Bildformat ' + own.w + '×' + own.h;
          if (!customOpt) {
            customOpt = document.createElement('option');
            customOpt.setAttribute('data-custom', '1');
            fs.insertBefore(customOpt, fs.firstChild);
          }
          customOpt.value = '__custom';
          customOpt.textContent = label;
          fs.value = '__custom';
        } else {
          if (customOpt) customOpt.remove();
          fs.value = m;
        }
      }
    } catch { /* Format-Select optional */ }
  }
}
function applySplitLayout() {
  const on = splitEnabled();
  const p0 = $('pane0'), p1 = $('pane1'), div = $('splitDivider');
  const tgl = $('splitToggle'), swp = $('splitSwap'), cls = $('splitClose'), rw = $('splitRatioWrap');
  if (p1) p1.style.display = on ? '' : 'none';
  if (div) div.style.display = on ? '' : 'none';
  if (swp) swp.style.display = on ? '' : 'none';
  if (cls) cls.style.display = on ? '' : 'none';
  if (rw) rw.style.display = on ? '' : 'none';
  if (tgl) tgl.classList.toggle('picked', on);
  const ratio = (split && typeof split.ratio === 'number') ? split.ratio : 0.5;
  if (p0) p0.style.flexGrow = String(Math.round(ratio * 100));
  if (p1) p1.style.flexGrow = String(Math.round((1 - ratio) * 100));
  const ratioInput = $('splitRatio');
  if (ratioInput) ratioInput.value = String(Math.round(ratio * 100));
  [0, 1].forEach(i => {
    const el = $(i === 1 ? 'pane1' : 'pane0');
    if (el) el.classList.toggle('active', activePaneIdx() === i && (i === 0 || on));
  });
  syncBookSelects();
  syncPaneChrome(0); syncPaneChrome(1);
}

/* SPEC-31 light/offline (ehrlich, kein Fake-OCR):
 * Bibliothekssuche nutzt GrimoireInkIndex (Titel + getippter Text + Tags).
 * Handschrift-Strokes sind NICHT durchsuchbar (kein Modell/Cloud) – Badges
 * melden daher nur „Titel"/„Text"/„Tag", nie „Handschrift".
 * HTR-Andockpunkt (später, z. B. MyScript-ähnlich):
 *   GrimoireInkIndex.registerHtrProvider('myscript', async (page) => [...woerter]);
 * Solange kein Provider registriert ist, gilt isHtrAvailable() === false und
 * die UI zeigt HTR_UNAVAILABLE_MSG („HSR nicht verfügbar (V1: nur getippter
 * Text durchsuchbar)"). Keine Cloud, keine Dependencies. */
function renderFolderList() {
  ensureFoldersLocal();
  pruneExpanded();
  bindFolderNavEvents();
  const nav = $('folderNav');
  const chips = $('folderChips');
  const direct = (typeof GrimoireFolders !== 'undefined')
    ? GrimoireFolders.countByFolder(state.books || [])
    : { all: (state.books || []).length, unsorted: (state.books || []).filter(b => !b || !b.folderId).length, byId: {} };
  let counts = direct;
  try {
    if (typeof GrimoireFolders !== 'undefined' && GrimoireFolders.countSubtree) {
      counts = GrimoireFolders.countSubtree(state.books || [], state.folders || []);
    }
  } catch { counts = direct; }
  const folders = folderList();
  const item = (id, label, count, emoji, drop) => {
    const active = (activeFolderId === id) ? ' active' : '';
    const dz = drop ? ' ondragover="folderDragOver(event)" ondragleave="folderDragLeave(event)" ondrop="folderDropOnto(event,\'' + drop + '\')"' : '';
    return '<button type="button" class="folder-item' + active + '" data-folder="' + id + '" onclick="setActiveFolder(\'' + id + '\',event)" aria-pressed="' + (active ? 'true' : 'false') + '"' + dz + '>'
      + '<span class="folder-emoji" aria-hidden="true">' + emoji + '</span>'
      + '<span class="folder-label">' + esc(label) + '</span>'
      + '<span class="folder-count" aria-label="' + count + ' Bücher">' + count + '</span>'
      + '</button>';
  };
  const kidsOf = (pid) => {
    try {
      if (typeof GrimoireFolders !== 'undefined' && GrimoireFolders.childrenOf) {
        return GrimoireFolders.childrenOf(folders, pid);
      }
    } catch { /* ignore */ }
    return folders.filter(f => (f.parentId || null) === (pid || null));
  };
  const renderNode = (f, depth) => {
    const c = counts.byId[f.id] || 0;
    const active = (activeFolderId === f.id) ? ' active' : '';
    const kids = kidsOf(f.id);
    const hasKids = kids.length > 0;
    const open = hasKids ? isFolderExpanded(f.id) : true;
    const arrow = hasKids
      ? '<button type="button" class="folder-toggle" onclick="toggleFolderExpanded(\'' + f.id + '\',event)" aria-label="' + (open ? 'Einklappen' : 'Ausklappen') + '" aria-expanded="' + (open ? 'true' : 'false') + '" tabindex="-1">' + (open ? '▾' : '▸') + '</button>'
      : '<span class="folder-toggle folder-toggle--leaf" aria-hidden="true">•</span>';
    const emoji = hasKids && open ? '📂' : '📁';
    let html = '<div class="folder-node" style="--depth:' + depth + '">'
      + '<div class="folder-row' + active + '" data-folderrow="' + f.id + '" role="treeitem" aria-selected="' + (active ? 'true' : 'false') + '" aria-expanded="' + (hasKids ? (open ? 'true' : 'false') : 'false') + '" aria-level="' + (depth + 1) + '" aria-label="' + esc(f.name || 'Ordner') + '"'
      + ' draggable="true" ondragstart="folderDragStart(event,\'' + f.id + '\')" ondragover="folderDragOver(event)" ondragleave="folderDragLeave(event)" ondrop="folderDropOnto(event,\'' + f.id + '\')" onkeydown="folderRowKeydown(event,\'' + f.id + '\')">'
      + arrow
      + '<button type="button" class="folder-item folder-item--main' + active + '" data-folder="' + f.id + '" onclick="setActiveFolder(\'' + f.id + '\',event)" ondblclick="startFolderRename(\'' + f.id + '\')" aria-pressed="' + (active ? 'true' : 'false') + '" title="' + esc(folderPathTitle(f.id)) + '">'
      + '<span class="folder-emoji" aria-hidden="true">' + emoji + '</span>'
      + '<span class="folder-label">' + esc(f.name || 'Ordner') + '</span>'
      + '<span class="folder-count">' + c + '</span>'
      + '</button>'
      + '<span class="folder-row-actions">'
      + '<button type="button" class="folder-mini" onclick="createSubfolderUI(\'' + f.id + '\',event)" title="Unterordner anlegen" aria-label="Unterordner in ' + esc(f.name || '') + ' anlegen">＋</button>'
      + '<button type="button" class="folder-mini" onclick="renameFolderUI(\'' + f.id + '\',event)" title="Ordner umbenennen" aria-label="Ordner ' + esc(f.name || '') + ' umbenennen">✎</button>'
      + '<button type="button" class="folder-mini" onclick="deleteFolderUI(\'' + f.id + '\',event)" title="Ordner löschen (Bücher bleiben)" aria-label="Ordner ' + esc(f.name || '') + ' löschen">🗑</button>'
      + '</span></div>';
    if (hasKids && open) {
      html += '<div class="folder-children" role="group">' + kids.map(k => renderNode(k, depth + 1)).join('') + '</div>';
    }
    html += '</div>';
    return html;
  };
  const roots = kidsOf(null);
  const treeBtns = roots.map(f => renderNode(f, 0)).join('');
  if (nav) {
    nav.setAttribute('role', 'tree');
    nav.setAttribute('aria-label', 'Ordner-Baum');
    nav.innerHTML = '<div class="folder-row" data-folderrow="__all" role="treeitem" aria-selected="' + (activeFolderId === 'all' ? 'true' : 'false') + '" aria-level="1">'
      + item('all', 'Alle', counts.all, '📚', '') + '</div>'
      + '<div class="folder-row" data-folderrow="__unsorted" role="treeitem" aria-selected="' + (activeFolderId === 'unsorted' ? 'true' : 'false') + '" aria-level="1">'
      + item('unsorted', 'Unsortiert', direct.unsorted, '📄', '') + '</div>'
      + (treeBtns || '<div class="folder-empty">Noch keine Ordner – lege oben einen an.</div>');
  }
  if (chips) {
    const chip = (id, label, count) => '<button type="button" class="chip' + (activeFolderId === id ? ' active' : '') + '" onclick="setActiveFolder(\'' + id + '\',event)">' + esc(label) + ' · ' + count + '</button>';
    let flat = folders.slice();
    try {
      if (typeof GrimoireFolders !== 'undefined' && GrimoireFolders.sortTree) flat = GrimoireFolders.sortTree(flat);
    } catch { /* ignore */ }
    chips.innerHTML = chip('all', 'Alle', counts.all)
      + chip('unsorted', 'Unsortiert', direct.unsorted)
      + flat.map(f => chip(f.id, chipLabel(f.id), counts.byId[f.id] || 0)).join('');
  }
  const title = $('libraryFolderTitle');
  if (title) {
    renderBreadcrumb(title, folders);
  }
}
function folderPathTitle(id) {
  try {
    if (typeof GrimoireFolders !== 'undefined' && GrimoireFolders.folderPathName) {
      return GrimoireFolders.folderPathName(state.folders || [], id);
    }
  } catch { /* ignore */ }
  const f = (state.folders || []).find(x => x && x.id === id);
  return f ? f.name : '';
}
function chipLabel(id) {
  try {
    if (typeof GrimoireFolders !== 'undefined' && GrimoireFolders.folderPathName) {
      const p = GrimoireFolders.folderPathName(state.folders || [], id);
      return p.length > 28 ? '…' + p.slice(-27) : p;
    }
  } catch { /* ignore */ }
  const f = (state.folders || []).find(x => x && x.id === id);
  return (f && f.name) || 'Ordner';
}
function renderBreadcrumb(title, folders) {
  let label = 'Alle Bücher';
  if (activeFolderId === 'unsorted') label = 'Unsortiert';
  else if (activeFolderId !== 'all') {
    let path = [];
    try {
      if (typeof GrimoireFolders !== 'undefined' && GrimoireFolders.getPath) {
        path = GrimoireFolders.getPath(folders, activeFolderId);
      } else {
        const f = folders.find(x => x.id === activeFolderId);
        if (f) path = [f];
      }
    } catch { path = []; }
    if (!path.length) {
      title.textContent = 'Alle Bücher';
      return;
    }
    title.innerHTML = '';
    const mkBtn = (id, text, cls) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'crumb' + (cls ? ' ' + cls : '');
      b.textContent = text;
      b.setAttribute('onclick', "setActiveFolder('" + id + "',event)");
      return b;
    };
    title.appendChild(mkBtn('all', 'Alle', ''));
    path.forEach((f, i) => {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = ' / ';
      sep.setAttribute('aria-hidden', 'true');
      title.appendChild(sep);
      const last = i === path.length - 1;
      title.appendChild(mkBtn(f.id, (last ? '📁 ' : '') + (f.name || 'Ordner'), last ? 'crumb--current' : ''));
    });
    return;
  }
  title.textContent = label;
}
function renderLibrary() {
  ensureFoldersLocal();
  renderFolderList();
  const searchEl = $('librarySearch');
  const rawQ = ((searchEl && searchEl.value) || '');
  const q = rawQ.toLowerCase();
  const grid = $('libraryGrid');
  if (!grid) return;
  // Ordner-Filter zuerst (dann Suche darüber) – inkl. Unterordner (OS-artig)
  let scoped = state.books || [];
  try {
    if (typeof GrimoireFolders !== 'undefined' && GrimoireFolders.filterBooksTree) scoped = GrimoireFolders.filterBooksTree(state.books, activeFolderId, state.folders);
    else if (typeof GrimoireFolders !== 'undefined') scoped = GrimoireFolders.filterBooks(state.books, activeFolderId);
    else if (activeFolderId === 'unsorted') scoped = scoped.filter(b => !b || !b.folderId);
    else if (activeFolderId !== 'all') scoped = scoped.filter(b => b && b.folderId === activeFolderId);
  } catch { scoped = state.books || []; }
  const useIndex = (typeof GrimoireInkIndex !== 'undefined' && GrimoireInkIndex.searchBooks);
  const useQuery = (typeof GrimoireSearch !== 'undefined' && GrimoireSearch.parseQuery && GrimoireSearch.rankBooks);
  const searched = !!rawQ.trim();
  // SPEC-07 light: Query-Sprache (OR/-/""/file:/path:/tag:/task-todo:/task-done:)
  // filtert + rankt; Badge/Snippet-Anzeige weiter via InkIndex. Reine
  // Text-Einfachqueries laufen weiter über den Index (unverändert).
  // Syntaxfehler -> Index-/Fallback-Ergebnis, kein Crash.
  let parsed = null, queryLang = false;
  try {
    if (searched && useQuery) {
      parsed = GrimoireSearch.parseQuery(rawQ);
      queryLang = !!(parsed && !parsed.isEmpty &&
        (parsed.groups.length > 1 || parsed.terms.some(t => t.field !== 'text' || t.negated || t.phrase)));
    }
  } catch { parsed = null; queryLang = false; }
  let matches;
  if (queryLang) {
    let ranked = [];
    try { ranked = GrimoireSearch.rankBooks(scoped, parsed); } catch { ranked = []; }
    matches = ranked.map(r => {
      let kind = 'none', snippet = '';
      try {
        if (useIndex && GrimoireInkIndex.matchBook) {
          const t = parsed.terms.find(x => !x.negated && x.field === 'text' && x.value);
          const mm = GrimoireInkIndex.matchBook(r.book, t ? t.value : '');
          if (mm && mm.kind && mm.kind !== 'none') { kind = mm.kind; snippet = mm.snippet || ''; }
        }
      } catch { /* Anzeige-Only: Badge bleibt aus */ }
      return { book: r.book, match: kind, snippet };
    });
  } else if (useIndex) {
    try { matches = GrimoireInkIndex.searchBooks(scoped, rawQ); }
    catch { matches = scoped.map(b => ({ book: b, match: 'none', snippet: '' })); }
  } else {
    // Fallback ohne Index-Modul (altes Verhalten: Titel + getippter Text).
    matches = scoped.filter(b => {
      if (!q) return true;
      if ((b.title || '').toLowerCase().includes(q)) return true;
      return (b.pages || []).some(p => (p.texts || []).some(t => stripHtml(t.html).toLowerCase().includes(q)));
    }).map(b => ({ book: b, match: 'none', snippet: '' }));
  }
  const htrMsg = (useIndex && GrimoireInkIndex.HTR_UNAVAILABLE_MSG)
    ? GrimoireInkIndex.HTR_UNAVAILABLE_MSG
    : 'HSR nicht verfügbar (V1: nur getippter Text durchsuchbar)';
  let htrOn = false;
  try { htrOn = !!(useIndex && GrimoireInkIndex.isHtrAvailable && GrimoireInkIndex.isHtrAvailable()); } catch { htrOn = false; }
  const hintHtml = htrOn ? '' : '<div style="font-size:12px;opacity:.75;margin-bottom:8px">' + esc(htrMsg) + '</div>';
  // SPEC-07 light: Treffer-Zähler bei aktiver Query (klein, im Grid-Header).
  const counterHtml = searched
    ? '<div style="font-size:12px;opacity:.75;margin-bottom:8px">' + matches.length + ' Treffer für &bdquo;' + esc(rawQ.trim().slice(0, 80)) + '&ldquo;</div>'
    : '';
  if (!matches.length) {
    const folderHint = (activeFolderId !== 'all')
      ? 'In diesem Ordner noch nichts. Lege oben ein neues Buch an (landet hier) oder verschiebe ein Buch hierher.'
      : 'Keine Bücher gefunden. Lege oben ein neues Buch an.';
    grid.innerHTML = hintHtml + counterHtml + '<div style="font-size:14px;opacity:.8">' + (searched ? 'Keine Treffer. Suche ändern oder leeren.' : esc(folderHint)) + '</div>';
    return;
  }
  grid.innerHTML = hintHtml + counterHtml + matches.map(({ book: b, match, snippet }) => {
    const firstText = (b.pages || []).flatMap(p => p.texts || [])[0];
    const preview = firstText ? esc(stripHtml(firstText.html).slice(0, 120)) : 'Leere Seiten – tippen zum Öffnen.';
    const strokes = (b.pages || []).reduce((n, p) => n + (p.strokes || []).length, 0);
    let badge = '';
    if (q && match && match !== 'none') {
      const label = match === 'tag' ? 'Tag' : (match === 'title' ? 'Titel' : 'Text');
      badge = '<span style="display:inline-block;font-size:11px;border:1px solid currentColor;border-radius:999px;padding:0 8px;margin-left:8px;opacity:.8"'
        + ' title="Treffer in getipptem Text – keine Handschrift-Erkennung">' + label + '</span>';
    }
    const snippetHtml = (q && snippet && match !== 'title')
      ? '<div style="font-size:12px;opacity:.75;margin-top:2px">' + esc(snippet) + '</div>' : '';
    let folderBadge = '';
    try {
      const fname = (typeof GrimoireFolders !== 'undefined')
        ? GrimoireFolders.folderName(state.folders, b.folderId)
        : (b.folderId || 'Unsortiert');
      folderBadge = '<button type="button" class="folder-badge" onclick="event.stopPropagation();setActiveFolder(\'' + (b.folderId || 'unsorted') + '\',event)" title="Nach Ordner filtern">📁 ' + esc(fname || 'Unsortiert') + '</button>';
    } catch { /* ignore */ }
    return '<div class="notebook-cover" draggable="true" ondragstart="bookDragStart(event,\'' + b.id + '\')" onclick="openBookView(\'' + b.id + '\')">'
      + '<div class="notebook-spine"></div>'
      + '<div class="notebook-body">'
      + '<div class="notebook-title">' + esc(b.title) + badge + '</div>'
      + '<div class="notebook-meta">' + folderBadge + '<span>' + (b.pages || []).length + ' Seite(n) · ' + strokes + ' Striche · ' + new Date(b.updatedAt).toLocaleDateString('de-DE') + '</span></div>'
      + '<div class="notebook-preview">' + preview + '</div>'
      + snippetHtml
      + '<div class="notebook-actions">'
      + '<button class="mini-button" onclick="openBookInSplit(\'' + b.id + '\',event)" title="Als zweites Dokument daneben öffnen (Split-Screen, ein Fenster)">⇉ Split</button>'
      + '<button class="mini-button" onclick="exportBookJSON(\'' + b.id + '\',event)">Export</button>'
      + '<button class="mini-button" onclick="exportGoodNotes(\'' + b.id + '\',event)" aria-label="Buch als GoodNotes-Datei exportieren">📤 GoodNotes</button>'
      + '<button class="mini-button" onclick="duplicateBook(\'' + b.id + '\',event)">Duplizieren</button>'
      + '<button class="mini-button" onclick="deleteBook(\'' + b.id + '\',event)">Löschen</button>'
      + '</div>'
      + '<label class="move-row" onclick="event.stopPropagation()" title="Buch in Ordner verschieben">'
      + '<span>📁</span>'
      + '<select onchange="moveBookToFolder(\'' + b.id + '\',this.value,event)" aria-label="Buch in Ordner verschieben">' + folderOptionsHtml(b.folderId) + '</select>'
      + '</label>'
      + '</div></div>';
  }).join('');
}

/* ---------- Seiten (pane-bewusst: aktiver Pane) ---------- */
function activePageId() { return panePageId(activePaneIdx()) || state.openPageId; }
function setActivePageId(pid) {
  const i = activePaneIdx();
  const api = splitApi();
  const bid = paneBookId(i);
  if (api) api.setPaneDoc(split, i, bid, pid);
  else split.panes[i] = { bookId: bid, pageId: pid };
  if (i === 0) state.openPageId = pid;
  syncSplitToState();
}
function historyState(allPages = false, pageId) {
  const b = openBook(); if (!b) return null;
  const pid = pageId || activePageId();
  if (allPages) return JSON.stringify({ bookId: b.id, pageId: pid, pages: b.pages });
  const p = b.pages.find(p => p.id === pid); if (!p) return null;
  return JSON.stringify({ bookId: b.id, pageId: p.id, page: p });
}
function snapshot(allPages = false) {
  const entry = historyState(allPages); if (!entry) return;
  undoStack.push(entry);
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
}
function restore(json) {
  const b = openBook(); if (!b) return;
  const s = JSON.parse(json);
  if (s.bookId !== b.id) return;
  if (s.pages) {
    b.pages = s.pages;
    if (!b.pages.some(p => p.id === s.pageId)) s.pageId = (b.pages[0] && b.pages[0].id) || null;
  } else {
    const idx = b.pages.findIndex(p => p.id === s.pageId);
    if (idx === -1) return;
    b.pages[idx] = s.page;
  }
  if (s.pageId) setActivePageId(s.pageId);
  selectedBox = null; selectedImg = null;
  touchBook(); persistSoon(); renderAll();
}
function moveHistory(from, to) {
  if (!from.length) return;
  const entry = from[from.length - 1], s = JSON.parse(entry);
  const b = openBook(); if (!b || b.id !== s.bookId) return;
  const inverse = historyState(!!s.pages); if (!inverse) return;
  to.push(inverse);
  from.pop();
  restore(entry);
}
function undo() { moveHistory(undoStack, redoStack); }
function redo() { moveHistory(redoStack, undoStack); }
function setPanePageAndRender(i, pid) {
  try { if (typeof stopLaser === 'function') stopLaser(); } catch { /* ignore */ }
  const api = splitApi();
  const bid = paneBookId(i);
  if (api) api.setPaneDoc(split, i, bid, pid);
  else split.panes[i] = { bookId: bid, pageId: pid };
  if (i === 0) state.openPageId = pid;
  const ui = paneUI[i];
  if (ui) { ui.undo = []; ui.redo = []; ui.selBox = null; ui.selImg = null; }
  if (i === activePaneIdx()) { undoStack = []; redoStack = []; selectedBox = null; selectedImg = null; }
  syncSplitToState(); persistSoon(); renderAll();
}
function addPage() {
  const b = openBook(); if (!b) return;
  snapshot(true);
  const p = newPage();
  stampPageSizeForBook(p, b.paper); // neue Seite erbt das Buch-Format
  const idx = b.pages.findIndex(x => x.id === activePageId());
  b.pages.splice(idx + 1, 0, p);
  setActivePageId(p.id);
  touchBook(); persistSoon(); renderAll();
}
function duplicatePage() {
  const b = openBook(); const p = currentPage(); if (!b || !p) return;
  snapshot(true);
  const copy = JSON.parse(JSON.stringify(p)); copy.id = uid();
  const idx = b.pages.findIndex(x => x.id === p.id);
  b.pages.splice(idx + 1, 0, copy);
  setActivePageId(copy.id);
  touchBook(); persistSoon(); renderAll();
}
/* Vorlage duplizieren: gleiche Struktur (Hintergrund), aber OHNE Handschrift
 * (strokes inkl. Marker), OHNE Textfelder (texts) und OHNE Bild-Overlays –
 * also eine saubere, leere Seite mit demselben Papier/Hintergrund.
 * Button hängt am Ende des Rails nach der letzten Seite. */
function duplicatePageAsTemplate() {
  const b = openBook(); const p = currentPage(); if (!b || !p) return;
  snapshot(true);
  let tpl;
  try {
    if (typeof PagesImport !== 'undefined' && PagesImport.buildTemplatePage) {
      tpl = PagesImport.buildTemplatePage(p);
      tpl.id = uid();
    } else {
      tpl = newPage(); tpl.bg = (typeof p.bg === 'string') ? p.bg : null;
    }
  } catch { tpl = newPage(); tpl.bg = (typeof p.bg === 'string') ? p.bg : null; }
  const idx = b.pages.findIndex(x => x.id === p.id);
  b.pages.splice(idx + 1, 0, tpl);
  setActivePageId(tpl.id);
  touchBook(); persistSoon(); renderAll();
}
function duplicatePageTemplateInPane(i, ev) { return withPane(i, duplicatePageAsTemplate, ev); }
/* ---------- Dokument-in-Dokument-Import (Seiten übernehmen) ----------
 * Quell-Buch -> aktuelles Buch: Seiten (alle oder Bereich "1-3,5") werden
 * als Kopie (frische IDs) hinter der aktuellen Seite eingefügt. Danach
 * Sprung zur ersten importierten Seite. blob:-Refs werden geteilt (V1: kein GC). */
function importPagesFromBook(sourceBookId, pageRangeStr, targetPaneIdx) {
  const ti = (targetPaneIdx === 1) ? 1 : activePaneIdx();
  const target = paneBook(ti);
  const src = state.books.find(x => x.id === sourceBookId);
  if (!src || !target || src.id === target.id) return [];
  const total = (src.pages || []).length;
  if (!total) return [];
  let wanted = null;
  try {
    if (typeof PagesImport !== 'undefined' && PagesImport.parsePageRange) {
      wanted = (pageRangeStr == null || String(pageRangeStr).trim() === '')
        ? null : PagesImport.parsePageRange(pageRangeStr, total);
      if (wanted && !wanted.length) return [];
    }
  } catch { wanted = null; }
  let clones = [];
  try {
    if (typeof PagesImport !== 'undefined' && PagesImport.clonePagesForImport) {
      clones = PagesImport.clonePagesForImport(src.pages, wanted);
    } else {
      clones = (src.pages || []).map(p => {
        const c = JSON.parse(JSON.stringify(p)); c.id = uid();
        (c.texts || []).forEach(t => { t.id = uid(); });
        (c.images || []).forEach(im => { im.id = uid(); });
        return c;
      });
    }
  } catch { return []; }
  if (!clones.length) return [];
  setActivePane(ti, true);
  snapshot(true);
  const b = openBook(); if (!b) return [];
  const at = b.pages.findIndex(x => x.id === activePageId());
  b.pages.splice(at + 1, 0, ...clones);
  setActivePageId(clones[0].id);
  touchBook(); persistSoon(); renderAll();
  return clones.map(c => c.id);
}
function openDocImportDialog(paneIdx, ev) {
  if (ev) { try { ev.stopPropagation(); } catch { /* ignore */ } }
  const ti = (paneIdx === 1 || paneIdx === 0) ? paneIdx : activePaneIdx();
  setActivePane(ti, true);
  const target = paneBook(ti);
  if (!target) { alert('Kein Ziel-Dokument geöffnet.'); return; }
  const others = (state.books || []).filter(b => b.id !== target.id);
  if (!others.length) { alert('Kein weiteres Dokument zum Importieren vorhanden. Lege zuerst ein zweites Buch an.'); return; }
  const names = others.map((b, i) => (i + 1) + '. ' + (b.title || 'Unbenannt') + ' (' + (b.pages || []).length + ' S.)').join('\n');
  let choice = null;
  try { choice = prompt('Aus welchem Dokument importieren? (Nummer eingeben)\nZiel: ' + (target.title || '') + '\n\n' + names, '1'); } catch { return; }
  if (choice == null) return;
  const n = Math.floor(Number(String(choice).trim()));
  if (!isFinite(n) || n < 1 || n > others.length) return;
  const src = others[n - 1];
  let range = '';
  try {
    const ans = prompt('Seitenbereich aus „' + (src.title || '') + '“ (z. B. 1-3,5 – leer = alle ' + (src.pages || []).length + ' Seiten):', '');
    if (ans === null) return;
    range = ans || '';
  } catch { range = ''; }
  const ids = importPagesFromBook(src.id, range, ti);
  if (!ids.length) alert('Nichts importiert (Bereich prüfen).');
  else setSaveStatus('💾 gespeichert (' + ids.length + ' Seite(n) aus „' + (src.title || '') + '“ importiert)');
}
function deletePage() {
  const b = openBook(); if (!b || b.pages.length <= 1) { alert('Die letzte Seite kann nicht gelöscht werden.'); return; }
  if (!confirm('Seite löschen?')) return;
  snapshot(true);
  const idx = b.pages.findIndex(x => x.id === activePageId());
  b.pages.splice(idx, 1);
  setActivePageId(b.pages[Math.max(0, idx - 1)].id);
  touchBook(); persistSoon(); renderAll();
}
function clearPage() {
  const p = currentPage(); if (!p) return;
  if (!confirm('Seite wirklich leeren?')) return;
  snapshot();
  p.strokes = []; p.texts = []; p.images = [];
  touchBook(); persistSoon(); renderAll();
}
function gotoPage(id) { setPanePageAndRender(activePaneIdx(), id); }
// Pane-Wrapper für die pro-Pane Buttons (aktivieren erst den Pane, dann Aktion)
function withPane(i, fn, ev) {
  if (ev) { try { ev.stopPropagation(); } catch { /* ignore */ } }
  if (i === 1 || i === 0) setActivePane(i, true);
  return fn();
}
function addPageInPane(i, ev) { return withPane(i, addPage, ev); }
function duplicatePageInPane(i, ev) { return withPane(i, duplicatePage, ev); }
function deletePageInPane(i, ev) { return withPane(i, deletePage, ev); }
function clearPageInPane(i, ev) { return withPane(i, clearPage, ev); }
function gotoPageInPane(id, i) { setActivePane(i === 1 ? 1 : 0, true); gotoPage(id); }
function exportPagePNGInPane(i, ev) { if (ev) { try { ev.stopPropagation(); } catch { /* ignore */ } } setActivePane(i === 1 ? 1 : 0, true); exportPagePNG(); }
function clearPageBgInPane(i, ev) { if (ev) { try { ev.stopPropagation(); } catch { /* ignore */ } } setActivePane(i === 1 ? 1 : 0, true); clearPageBg(); }
function renameBookInPane(v, i) { setActivePane(i === 1 ? 1 : 0, true); renameBook(v); }
function setPaperInPane(v, i) { setActivePane(i === 1 ? 1 : 0, true); setPaper(v); }
function setPageSizeInPane(v, i) { setActivePane(i === 1 ? 1 : 0, true); setPageSize(v); }

/* ---------- Seiten-Preview-Pop-up (aktiver Pane) ---------- */
let previewPageId = null;
let previewPaneIdx = 0;
function openPagePreview(id) {
  previewPaneIdx = activePaneIdx();
  const b = paneBook(previewPaneIdx); if (!b || !b.pages.length) return;
  previewPageId = id || panePageId(previewPaneIdx);
  $('previewOverlay').classList.add('active');
  renderPreview();
}
function closePagePreview() {
  const o = $('previewOverlay');
  if (o) o.classList.remove('active');
  previewPageId = null;
}
function stepPreview(d) {
  const b = paneBook(previewPaneIdx); if (!b || !b.pages.length) return;
  const idx = Math.max(0, b.pages.findIndex(p => p.id === previewPageId));
  previewPageId = b.pages[(idx + d + b.pages.length) % b.pages.length].id;
  renderPreview();
}
function openPreviewPage() {
  const id = previewPageId;
  const pi = previewPaneIdx;
  closePagePreview();
  if (id) { setActivePane(pi, true); gotoPage(id); }
}
function drawPreviewImg(g, src, x, y, w, h) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => { try { g.drawImage(img, x, y, w, h); } catch { /* ignore */ } res(); };
    img.onerror = res; img.src = src;
  });
}
async function renderPreview() {
  const b = paneBook(previewPaneIdx); if (!b) return;
  const p = b.pages.find(x => x.id === previewPageId) || b.pages[0];
  if (!p) return;
  previewPageId = p.id;
  const idx = b.pages.indexOf(p);
  $('previewTitle').textContent = 'SEITE ' + (idx + 1) + ' / ' + b.pages.length;
  $('previewMeta').textContent = p.strokes.length + ' Striche · ' + p.texts.length + ' Texte · ' + p.images.length + ' Bilder';
  const c = $('previewCanvas');
  const pd = pageDimsOf(p, b && b.paper);
  const W = 600, H = Math.max(1, Math.round(600 * pd.h / pd.w));
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  let _pbg = '#fffdf6';
  try { const P = paperApi(); if (P) _pbg = P.bgFor(b && b.paper); } catch { /* Default */ }
  g.fillStyle = _pbg; g.fillRect(0, 0, W, H);
  const resolve = (typeof GrimoireStore !== 'undefined') ? (r => GrimoireStore.dataUrl(r)) : (async r => r);
  if (p.bg) {
    try {
      const src = await resolve(p.bg);
      if (src && previewPageId === p.id) await drawPreviewImg(g, src, 0, 0, W, H);
    } catch { /* weiter ohne HG */ }
  }
  for (const im of p.images) {
    try {
      const src = await resolve(im.src);
      if (!src || previewPageId !== p.id) continue;
      const nat = await new Promise(res => {
        const probe = new Image();
        probe.onload = () => res({ w: probe.naturalWidth || 1, h: probe.naturalHeight || 1 });
        probe.onerror = () => res(null);
        probe.src = src;
      });
      if (!nat || previewPageId !== p.id) continue;
      const w = im.w * W, h = w * nat.h / nat.w;
      await drawPreviewImg(g, src, im.x * W, im.y * H, w, h);
    } catch { /* einzelnes Bild überspringen */ }
  }
  if (previewPageId !== p.id) return; // inzwischen weitergeblättert
  g.save(); g.scale(W / pd.w, H / pd.h);
  p.strokes.forEach(s => drawStroke(g, s));
  g.restore();
  g.fillStyle = '#2a1a0e'; g.font = '13px serif';
  p.texts.forEach(t => {
    const lines = stripHtml(t.html).split('\n');
    lines.slice(0, 12).forEach((ln, i) => {
      try { g.fillText(ln.slice(0, 50), t.x * W + 5, t.y * H + 15 + i * 15); } catch { /* ignore */ }
    });
  });
}
document.addEventListener('keydown', e => {
  const o = $('previewOverlay');
  if (!o || !o.classList.contains('active')) return;
  if ($('editorOverlay') && $('editorOverlay').classList.contains('active')) return;
  if (e.key === 'Escape') closePagePreview();
  else if (e.key === 'ArrowRight') stepPreview(1);
  else if (e.key === 'ArrowLeft') stepPreview(-1);
  else if (e.key === 'Enter') openPreviewPage();
});

/* ---------- Toolbar ---------- */
function setTool(t) {
  tool = t; selectedBox = null; selectedImg = null;
  try { if (typeof stopLaser === 'function') stopLaser(); } catch { /* ignore */ }
  parkActiveUI();
  syncToolbar(); renderTextLayer(); renderImgLayer();
  try { if (typeof applyStageTouchAction === 'function') applyStageTouchAction(); } catch { /* ignore */ }
  const names = { pen: '✒ Stift', marker: '🖍 Marker', eraser: '⌫ Radierer', text: 'T Text', move: '✥ Auswahl', laser: '🔦 Laser' };
  const st0 = $('statusTool'), st1 = $('statusToolB');
  if (st0) st0.textContent = names[t] || t;
  if (st1) st1.textContent = names[t] || t;
  const s0 = $('stage'), s1 = $('stageB');
  const isLaser = (typeof GrimoireLaser !== 'undefined' && GrimoireLaser.isLaserTool)
    ? GrimoireLaser.isLaserTool(t) : t === 'laser';
  const cur = isLaser ? 'none' : t === 'text' ? 'text' : t === 'move' ? 'move' : 'crosshair';
  if (s0) { s0.style.cursor = cur; s0.classList.toggle('tool-laser', isLaser); }
  if (s1) { s1.style.cursor = cur; s1.classList.toggle('tool-laser', isLaser); }
}
function setColor(v) { penColor = v; }
function setSize(v) { penSize = +v; $('sizeLabel').textContent = v + 'px'; }
function syncToolbar() {
  document.querySelectorAll('#toolButtons .mini-button').forEach(b => b.classList.toggle('picked', b.dataset.tool === tool));
  $('penColor').value = penColor;
  $('penSize').value = penSize;
  $('sizeLabel').textContent = penSize + 'px';
  const em = $('eraserMode'), eh = $('eraserHLOnly');
  if (em) em.value = eraserMode;
  if (eh) eh.checked = eraserHighlighterOnly;
  const fd = $('fingerDrawToggle');
  if (fd) {
    fd.classList.toggle('picked', !!inputPrefs.fingerDraw);
    fd.textContent = inputPrefs.fingerDraw ? '✍ Schreiben: an' : '✍ Schreiben: aus';
    fd.title = inputPrefs.fingerDraw
      ? 'Finger und Maus schreiben (an). Ausschalten: Finger und Maus scrollen.'
      : 'Finger und Maus scrollen. Einschalten, um mit Finger oder Maus zu schreiben.';
  }
  const st0 = $('statusTool');
  if (st0) {
    const names = { pen: '✒ Stift', marker: '🖍 Marker', eraser: '⌫ Radierer', text: 'T Text', move: '✥ Auswahl', laser: '🔦 Laser' };
    st0.textContent = (names[tool] || tool) + (inputPrefs.fingerDraw ? ' · Finger/Maus schreiben' : ' · Finger/Maus scrollen');
  }
}
function openTextEditorForSelected() {
  if (selectedBox) { editorPaneIdx = activePaneIdx(); openTextEditorForBox(selectedBox, 'Textbox'); }
  else alert('Erst eine Textbox anklicken (Tool „T Text“ oder „✥ Auswahl“).');
}

/* ---------- Canvas (pane-bewusst, Suffix '' / 'B') ---------- */
function canvas(idx) { return $(eid('drawCanvas', idx)); }
function ctx2d(idx) { const c = canvas(idx); return c ? c.getContext('2d') : null; }
function overlayEl(idx) { return $(eid('overlayCanvas', idx)); }
function fitCanvasFor(idx) {
  const c = $(eid('drawCanvas', idx)), o = $(eid('overlayCanvas', idx));
  if (!c || !o) return;
  // Backing folgt dem Seitenformat (gedeckelt, damit große Formate
  // nicht den Speicher sprengen); Koordinaten bleiben Seiten-Einheiten.
  const d = paneDims(idx);
  let dpr = Math.min(2, window.devicePixelRatio || 1);
  try {
    if (typeof PagesImport !== 'undefined' && PagesImport.backingForPage) {
      const bk = PagesImport.backingForPage(d.w, d.h, dpr);
      [c, o].forEach(x => { x.width = bk.w; x.height = bk.h; });
      c.getContext('2d').setTransform(bk.dpr, 0, 0, bk.dpr, 0, 0);
      o.getContext('2d').setTransform(bk.dpr, 0, 0, bk.dpr, 0, 0);
      return;
    }
  } catch { /* Fallback unten */ }
  [c, o].forEach(x => { x.width = d.w * dpr; x.height = d.h * dpr; });
  c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  o.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
}
function fitCanvas() { fitCanvasFor(activePaneIdx()); }
function stagePosFor(ev, idx) {
  const r = $(eid('stage', idx)).getBoundingClientRect();
  // Apple Pencil Pressure miterfassen (Fallback 0.5 bei 0/unbekannt: Hover, Maus, fehlende Sensorik)
  let p = 0.5;
  try {
    if (typeof GrimoirePencil !== 'undefined' && GrimoirePencil.normalizePressure) p = GrimoirePencil.normalizePressure(ev.pressure);
    else if (typeof ev.pressure === 'number' && ev.pressure > 0) p = Math.min(1, ev.pressure);
  } catch { /* Fallback 0.5 */ }
  const d = paneDims(idx);
  return { x: (ev.clientX - r.left) / r.width * d.w, y: (ev.clientY - r.top) / r.height * d.h, nx: (ev.clientX - r.left) / r.width, ny: (ev.clientY - r.top) / r.height, p };
}
function stagePos(ev) { return stagePosFor(ev, activePaneIdx()); }
function drawStroke(c, s) {
  if (!s.points.length) return;
  c.save();
  c.strokeStyle = s.color;
  c.lineWidth = s.size;
  c.lineCap = 'round'; c.lineJoin = 'round';
  if (s.tool === 'marker') { c.globalAlpha = 0.35; c.globalCompositeOperation = 'multiply'; }
  if (s.alpha != null && s.alpha < 1) c.globalAlpha *= s.alpha;
  if (s.dash && s.dash.length) { try { c.setLineDash(s.dash); } catch { /* ignore */ } }
  // Cleaner-Look: Punkte vor dem Rendern leicht glätten (Chaikin, 1x),
  // aber Altbestand/Shapes unverfälscht lassen bei closed/fill/dash.
  let pts = s.points;
  const closed = !!s.closed || (!!s.fill && pts.length > 2);
  const canSmooth = !closed && !(s.dash && s.dash.length) && pts.length >= 3
    && typeof GrimoirePencil !== 'undefined' && GrimoirePencil.chaikinSmooth;
  if (canSmooth) {
    try { pts = GrimoirePencil.chaikinSmooth(pts, 1); } catch { pts = s.points; }
  }
  // Pressure-Stift: Punkte mit p -> segweise variable Breite (round caps),
  // gerendert als Midpoint-Quadratics statt LineTo-Polygon (cleaner, ruhiger);
  // Punkte ohne p (Altbestand, Shapes, Fills, Dashes) -> single size wie bisher.
  const usePressure = !closed && !(s.dash && s.dash.length) && pts.some(q => q && typeof q.p === 'number');
  if (usePressure) {
    const wOf = q => {
      let pp = 0.5;
      try {
        pp = (typeof GrimoirePencil !== 'undefined' && GrimoirePencil.normalizePressure)
          ? GrimoirePencil.normalizePressure(q.p)
          : ((typeof q.p === 'number' && q.p > 0) ? Math.min(1, q.p) : 0.5);
      } catch { pp = 0.5; }
      try {
        if (typeof GrimoirePencil !== 'undefined' && GrimoirePencil.pressureWidth) return GrimoirePencil.pressureWidth(s.size, pp);
      } catch { /* Fallback unten */ }
      return Math.min(s.size * 3, Math.max(s.size * 0.5, s.size * (0.35 + 0.9 * pp)));
    };
    if (pts.length === 1) {
      c.fillStyle = s.color;
      c.beginPath(); c.arc(pts[0].x, pts[0].y, wOf(pts[0]) / 2, 0, 7); c.fill();
      c.restore();
      return;
    }
    if (pts.length === 2) {
      c.lineWidth = (wOf(pts[0]) + wOf(pts[1])) / 2;
      c.beginPath();
      c.moveTo(pts[0].x, pts[0].y);
      c.lineTo(pts[1].x, pts[1].y);
      c.stroke();
      c.restore();
      return;
    }
    // Midpoint-Quadratics mit variabler Breite: pro Segment ein Pfad,
    // Breite = Mittel der Endpunkt-Breiten (weich, ohne Stufen).
    let prevMx = (pts[0].x + pts[1].x) / 2, prevMy = (pts[0].y + pts[1].y) / 2;
    c.lineWidth = (wOf(pts[0]) + wOf(pts[1])) / 2;
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    c.lineTo(prevMx, prevMy);
    c.stroke();
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      c.lineWidth = (wOf(pts[i]) + wOf(pts[i + 1])) / 2;
      c.beginPath();
      c.moveTo(prevMx, prevMy);
      c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      c.stroke();
      prevMx = mx; prevMy = my;
    }
    c.restore();
    return;
  }
  // Ohne Pressure: ebenfalls Midpoint-Quadratics (sichtbar runder als LineTo).
  if (!closed && !(s.dash && s.dash.length) && pts.length > 2) {
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    c.lineTo((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
    for (let i = 1; i < pts.length - 1; i++) {
      c.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
    }
    c.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    if (pts.length === 1) {
      c.fillStyle = s.color;
      c.beginPath(); c.arc(pts[0].x, pts[0].y, s.size / 2, 0, 7); c.fill();
    } else {
      c.stroke();
    }
    c.restore();
    return;
  }
  c.beginPath();
  c.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
  if (pts.length === 1) {
    c.fillStyle = s.color;
    c.beginPath(); c.arc(pts[0].x, pts[0].y, s.size / 2, 0, 7); c.fill();
  } else {
    if (closed) c.closePath();
    if (s.fill) {
      c.fillStyle = s.fill;
      const ga = c.globalAlpha;
      c.globalAlpha = ga * (s.fillAlpha == null ? 1 : s.fillAlpha);
      c.fill();
      c.globalAlpha = ga;
    }
    c.stroke();
  }
  c.restore();
}
function renderCanvasFor(idx) {
  fitCanvasFor(idx);
  const c = ctx2d(idx);
  if (!c) return;
  const p = panePage(idx); if (!p) return;
  const d = paneDims(idx);
  c.clearRect(0, 0, d.w, d.h);
  p.strokes.forEach(s => drawStroke(c, s));
}
function renderCanvas() { renderCanvasFor(activePaneIdx()); }
function previewStroke(points, color, size, toolName) {
  const oc = overlayEl(activePaneIdx()); if (!oc) return;
  const o = oc.getContext('2d');
  const d = paneDims(activePaneIdx());
  o.clearRect(0, 0, d.w, d.h);
  if (points && points.length) drawStroke(o, { tool: toolName, color, size, points });
}
// Apple Pencil Hover-Preview: Ghost-Kreis am Cursor, kein Zeichnen (nur pen-Hover, Stift/Marker).
function drawHoverPreview(pos) {
  const oc = overlayEl(activePaneIdx()); if (!oc) return;
  const g = oc.getContext('2d');
  const d = paneDims(activePaneIdx());
  g.clearRect(0, 0, d.w, d.h);
  const base = tool === 'marker' ? penSize * 3 : penSize;
  g.save();
  g.strokeStyle = penColor; g.globalAlpha = 0.75; g.lineWidth = 1.5;
  g.beginPath(); g.arc(pos.x, pos.y, Math.max(3, base / 2), 0, 7); g.stroke();
  g.globalAlpha = 0.3; g.fillStyle = penColor;
  g.beginPath(); g.arc(pos.x, pos.y, 2, 0, 7); g.fill();
  g.restore();
}
/* ---------- Laserpointer (nur Overlay, nie persistent) ----------
 * Trail aus {x,y,t} in Seiten-Koordinaten, pro aktivem Pane (laserIdx).
 * Rendert Glow-Dot + kurze Spur, verblasst via rAF – kein Snapshot,
 * kein Undo, kein Persist, kein Export (Export nutzt nur drawCanvas). */
let laserTrail = [], laserIdx = 0, laserRaf = 0, laserDown = false;
function laserApi() { try { return (typeof GrimoireLaser !== 'undefined') ? GrimoireLaser : null; } catch { return null; } }
function isLaserActive() { const L = laserApi(); return L ? L.isLaserTool(tool) : tool === 'laser'; }
function laserColor() { const L = laserApi(); return (L && L.COLOR) || '#ff2211'; }
function laserFadeMs() { const L = laserApi(); return (L && L.FADE_MS) || 700; }
function drawLaserFrame() {
  laserRaf = 0;
  const L = laserApi();
  const now = Date.now();
  laserTrail = L ? L.prune(laserTrail, now, laserFadeMs()) : [];
  const oc = overlayEl(laserIdx);
  if (!oc) { if (laserTrail.length) scheduleLaserFrame(); return; }
  const g = oc.getContext('2d');
  let d = { w: 1000, h: 1414 };
  try { d = paneDims(laserIdx); } catch { /* Fallback */ }
  try { g.clearRect(0, 0, d.w, d.h); } catch { /* ignore */ }
  if (!laserTrail.length) return;
  const col = laserColor(), fade = laserFadeMs();
  const dotR = (L && L.DOT_R) || 9;
  g.save();
  g.lineCap = 'round'; g.lineJoin = 'round';
  // Spur (älter = transparenter, dünner)
  for (let i = 1; i < laserTrail.length; i++) {
    const a = L ? L.alphaFor(now - laserTrail[i].t, fade) : 1;
    if (a <= 0) continue;
    g.save();
    g.globalAlpha = Math.min(1, 0.55 * a + 0.05);
    g.strokeStyle = col;
    g.lineWidth = Math.max(1, dotR * 0.7 * a + 1);
    g.shadowColor = col; g.shadowBlur = 12 * a;
    g.beginPath();
    g.moveTo(laserTrail[i - 1].x, laserTrail[i - 1].y);
    g.lineTo(laserTrail[i].x, laserTrail[i].y);
    g.stroke();
    g.restore();
  }
  // Kopf: heller Kern + Glow-Ring
  const head = laserTrail[laserTrail.length - 1];
  const ha = L ? L.alphaFor(now - head.t, fade) : 1;
  if (ha > 0) {
    g.save();
    g.globalAlpha = Math.min(1, ha + 0.15);
    g.shadowColor = col; g.shadowBlur = 22;
    g.fillStyle = col;
    g.beginPath(); g.arc(head.x, head.y, dotR, 0, 7); g.fill();
    g.shadowBlur = 0;
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath(); g.arc(head.x - dotR * 0.18, head.y - dotR * 0.18, Math.max(1.5, dotR * 0.32), 0, 7); g.fill();
    g.restore();
  }
  g.restore();
  if (laserTrail.length) scheduleLaserFrame();
}
function scheduleLaserFrame() {
  if (laserRaf) return;
  try {
    laserRaf = requestAnimationFrame(drawLaserFrame);
  } catch {
    // Node/kein rAF (Tests): synchron einmal rendern
    try { drawLaserFrame(); } catch { /* ignore */ }
    laserRaf = 0;
  }
}
function laserPushFor(idx, pos) {
  const L = laserApi();
  laserIdx = idx;
  if (L) laserTrail = L.push(laserTrail, { x: pos.x, y: pos.y, t: Date.now() });
  else { laserTrail.push({ x: pos.x, y: pos.y, t: Date.now() }); while (laserTrail.length > 24) laserTrail.shift(); }
  scheduleLaserFrame();
}
function stopLaser() {
  laserTrail = []; laserDown = false;
  if (laserRaf) { try { cancelAnimationFrame(laserRaf); } catch { /* ignore */ } laserRaf = 0; }
  try { clearOverlayFor(laserIdx); } catch { /* ignore */ }
  try { clearOverlayFor(activePaneIdx()); } catch { /* ignore */ }
}
function clearHoverPreview() {
  if (drawing) return;
  clearOverlayFor(activePaneIdx());
}
function distToStroke(pt, s, radius) {
  return s.points.some(q => Math.hypot(q.x - pt.x, q.y - pt.y) <= radius + s.size / 2);
}

function bindStageFor(idx) {
  const stage = $(eid('stage', idx));
  if (!stage || stage._splitBound) return;
  stage._splitBound = true;
  const activePointers = new Set();
  // Pencil-vs-Finger-Entscheidung (rein lesbar, auch ohne Pencil-Modul sicher):
  // Stift/Maus -> schreiben, Finger -> scrollen (außer fingerDraw an).
  // Text-/Auswahl-Werkzeug bleibt per Tap auch mit Finger bedienbar.
  const wantsInk = (ev) => {
    try {
      if (typeof GrimoirePencil !== 'undefined' && GrimoirePencil.shouldInkForPointer) {
        return GrimoirePencil.shouldInkForPointer(ev, inputPrefs);
      }
    } catch { /* Fallback unten */ }
    const t = (ev.pointerType || 'mouse');
    if (t === 'pen') return true;
    if (t === 'touch' || t === 'mouse') return !!inputPrefs.fingerDraw;
    return false;
  };
  const pushCoalesced = (ev, into) => {
    let list = [ev];
    try {
      if (typeof GrimoirePencil !== 'undefined' && GrimoirePencil.collectCoalesced) {
        list = GrimoirePencil.collectCoalesced(ev);
      } else if (typeof ev.getCoalescedEvents === 'function') {
        const l = ev.getCoalescedEvents();
        if (l && l.length) list = l;
      }
    } catch { list = [ev]; }
    let added = 0;
    for (const ce of list) {
      const pos = stagePosFor(ce, idx);
      let sm = null;
      if (into.stabilizer) {
        try { sm = into.stabilizer.push({ x: pos.x, y: pos.y, p: pos.p }, (ce.timeStamp || Date.now())); } catch { sm = null; }
        if (!sm) continue; // Jitter-Falle: Micro-Rauschen schlucken
      } else {
        sm = { x: pos.x, y: pos.y, p: pos.p };
      }
      into.points.push(sm);
      added++;
    }
    return added;
  };
  stage.addEventListener('pointerdown', ev => {
    if ($('viewBook').classList.contains('active') === false) return;
    if (activePaneIdx() !== idx) setActivePane(idx, true);
    // SPEC-25: Zweit-/Dritt-Finger bricht laufende Ein-Finger-Zeichnung ab
    // (kein Commit), damit Zwei-/Drei-Finger-Tap kein Undo-Artefakt hinterlässt.
    if (ev.isPrimary === false) {
      activePointers.add(ev.pointerId);
      if (drawing && !drawing.erasing) {
        drawing = null;
        try { clearOverlayFor(idx); } catch { /* ignore */ }
        undoStack.pop(); // eben genommener Snapshot war leer -> zurückrollen
      } else if (drawing) { drawing = null; }
      eraseTrail = null;
      return;
    }
    // Palm-Rejection: Touch kurz nach Stift = Handballen -> ignorieren.
    try {
      const pt = String(ev.pointerType || '');
      if (pt === 'pen') {
        penActive = true;
        if (palmGuard) palmGuard.markPen(Date.now());
      } else if (pt === 'touch' && palmGuard && palmGuard.isPalmTouch(Date.now())) {
        return;
      }
    } catch { /* Palm-Guard optional */ }
    // Finger scrollt nativ: kein Ink-Start, kein Capture, kein preventDefault
    // (Browser übernimmt das Scrollen). Nur Ink-Tools sind betroffen;
    // Text/Auswahl bleiben per Tap bedienbar.
    // Laserpointer: immer aktiv (auch Finger), speichert nichts.
    if (isLaserActive()) {
      if (ev.isPrimary === false) return;
      activePointers.add(ev.pointerId);
      const posL = stagePosFor(ev, idx);
      if (!currentPage()) return;
      try { stage.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
      try { ev.preventDefault(); } catch { /* ignore */ }
      laserDown = true;
      laserPushFor(idx, posL);
      return;
    }
    const inkTool = (tool === 'pen' || tool === 'marker' || tool === 'eraser');
    if (inkTool && !wantsInk(ev)) return;
    activePointers.add(ev.pointerId);
    const pos = stagePosFor(ev, idx);
    const p = currentPage(); if (!p) return;
    if (tool === 'pen' || tool === 'marker') {
      snapshot();
      try { stage.setPointerCapture(ev.pointerId); } catch { /* Touch-Scroll darf nicht capturen */ }
      const stab = (typeof GrimoirePencil !== 'undefined' && GrimoirePencil.createStabilizer)
        ? GrimoirePencil.createStabilizer({ minDistance: 0.9 }) : null;
      drawing = { tool, color: penColor, size: tool === 'marker' ? penSize * 3 : penSize, points: [], stabilizer: stab, pointerType: String(ev.pointerType || 'mouse') };
      pushCoalesced(ev, drawing);
      if (!drawing.points.length) drawing.points.push({ x: pos.x, y: pos.y, p: pos.p });
      previewStroke(drawing.points, drawing.color, drawing.size, drawing.tool);
    } else if (tool === 'eraser') {
      snapshot();
      try { stage.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
      drawing = { erasing: true, pointerType: String(ev.pointerType || 'mouse') };
      eraseTrail = [{ x: pos.x, y: pos.y, t: Date.now() }];
      eraseAt(pos);
    } else if (tool === 'text') {
      const el = ev.target.closest('.text-box');
      if (el) return; // Klick auf Box wird dort behandelt
      snapshot();
      const box = { id: uid(), x: pos.nx, y: pos.ny, html: 'Neuer Text – doppelklicken für Editor' };
      // Textfeld-Upgrade: neue Boxen übernehmen den Default-Stil (grimoireTextDefault).
      try {
        if (typeof GrimoirePencil !== 'undefined' && GrimoirePencil.applyDefaultToBox) {
          GrimoirePencil.applyDefaultToBox(box, GrimoirePencil.getTextDefault());
        }
      } catch { /* Default-Stil optional */ }
      p.texts.push(box);
      selectedBox = box.id;
      touchBook(); persistSoon(); renderTextLayer();
    }
  });
  stage.addEventListener('pointermove', ev => {
    // Laserpointer: folgt jeder Bewegung (auch Hover ohne Buttons), nur Overlay.
    if (isLaserActive()) {
      if (ev.isPrimary === false) return;
      if (activePaneIdx() !== idx) { try { setActivePane(idx, true); } catch { /* ignore */ } }
      laserPushFor(idx, stagePosFor(ev, idx));
      return;
    }
    // Apple Pencil Hover (pen, keine Buttons, Stift/Marker): nur Ghost-Vorschau, kein Zeichnen.
    if (!drawing && ev.pointerType === 'pen' && ev.buttons === 0 && (tool === 'pen' || tool === 'marker')) {
      drawHoverPreview(stagePosFor(ev, idx));
      return;
    }
    if (!drawing) return;
    if (ev.isPrimary === false) return;
    // Touch-Scroll während aktivem Ink-Stroke: anderer Pointer -> ignorieren
    // (aktiver Stroke gehört Pen/Maus; Finger-Scroll läuft parallel nativ).
    if (ev.pointerType === 'touch' && drawing.pointerType && drawing.pointerType !== 'touch') return;
    const pos = stagePosFor(ev, idx);
    if (drawing.erasing) {
      if (eraseTrail) {
        eraseTrail.push({ x: pos.x, y: pos.y, t: Date.now() });
        if (eraseTrail.length > 60) eraseTrail.splice(0, eraseTrail.length - 60);
      }
      eraseAt(pos); return;
    }
    const before = drawing.points.length;
    pushCoalesced(ev, drawing);
    if (drawing.points.length !== before) {
      previewStroke(drawing.points, drawing.color, drawing.size, drawing.tool);
    }
  });
  stage.addEventListener('pointerleave', () => { if (isLaserActive()) return; clearHoverPreview(); });
  const finish = (ev) => {
    if (ev && ev.pointerId != null) activePointers.delete(ev.pointerId);
    // Laser: Button loslassen beendet nur den Druck – der Trail verblasst von selbst.
    if (isLaserActive()) { laserDown = false; return; }
    try {
      if (ev && String(ev.pointerType || '') === 'pen') {
        penActive = false;
        if (palmGuard) palmGuard.markPen(Date.now());
      }
    } catch { /* ignore */ }
    if (!drawing) return;
    const p = currentPage();
    // SPEC-25 Scribble-Erase: schnelles Hin-und-Her im Radierer löscht alle
    // berührten Strokes ganz (Stroke-Delete), auch im Precision-Modus.
    if (drawing.erasing && eraseTrail && p) {
      try {
        const isScribble = (typeof GrimoireErase !== 'undefined')
          ? GrimoireErase.isScribbleGesture(eraseTrail)
          : false;
        if (isScribble) {
          const victims = GrimoireErase.collectScribbleVictims(p.strokes, eraseTrail, undefined, { mode: 'stroke', highlighterOnly: eraserHighlighterOnly });
          if (victims.length) {
            const gone = new Set(victims);
            p.strokes = p.strokes.filter(s => !gone.has(s));
            touchBook(); persistSoon(); renderCanvas(); renderRail();
          }
        }
      } catch { /* ignore */ }
      eraseTrail = null;
    }
    if (!drawing.erasing && drawing.points.length && p) {
      // Stabilizer ist Laufzeit-Only (Funktionen) -> nicht persistieren.
      const clean = { tool: drawing.tool, color: drawing.color, size: drawing.size, points: drawing.points };
      p.strokes.push(clean);
      touchBook(); persistSoon(); renderCanvas(); renderRail();
    }
    drawing = null;
    try { clearOverlayFor(activePaneIdx()); } catch { /* ignore */ }
  };
  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', finish);
}
function bindStage() { bindStageFor(0); bindStageFor(1); }
function eraseAt(pos) {
  const p = currentPage(); if (!p) return;
  // SPEC-25: Eraser-Modi + "Nur Highlighter" (Fallback ohne Helper = altes Verhalten)
  if (typeof GrimoireErase === 'undefined') {
    const before = p.strokes.length;
    p.strokes = p.strokes.filter(s => !distToStroke(pos, s, 12));
    if (p.strokes.length !== before) { touchBook(); persistSoon(); renderCanvas(); renderRail(); }
    return;
  }
  const orig = p.strokes;
  const res = GrimoireErase.filterStrokesForErase(orig, pos, undefined, { mode: eraserMode, highlighterOnly: eraserHighlighterOnly });
  const changed = res.removed.length > 0 || res.kept.length !== orig.length || res.kept.some(s => orig.indexOf(s) === -1);
  if (changed) { p.strokes = res.kept; touchBook(); persistSoon(); renderCanvas(); renderRail(); }
}
/* SPEC-25: Zwei-Finger-Tap = undo(), Drei-Finger-Tap = redo() (Touch-Handler
 * auf stage, Dauer <300ms, kaum Bewegung -> kein Konflikt mit Pinch-Zoom).
 * Buttons bleiben unverändert. */
function bindTapGesturesFor(idx) {
  const stage = $(eid('stage', idx));
  if (!stage || stage._tapGesturesBound) return;
  stage._tapGesturesBound = true;
  let startT = 0, maxTouches = 0, maxMove = 0;
  const centroid = list => {
    let x = 0, y = 0;
    for (const t of list) { x += t.clientX; y += t.clientY; }
    return { x: x / Math.max(1, list.length), y: y / Math.max(1, list.length) };
  };
  let startCent = null;
  stage.addEventListener('touchstart', ev => {
    if ($('viewBook').classList.contains('active') === false) return;
    if (ev.touches.length === 1) {
      startT = Date.now(); maxTouches = 1; maxMove = 0;
      startCent = centroid(ev.touches);
    } else if (startT) {
      maxTouches = Math.max(maxTouches, ev.touches.length);
      startCent = centroid(ev.touches);
    }
  }, { passive: true });
  stage.addEventListener('touchmove', ev => {
    if (!startT || !startCent) return;
    const c = centroid(ev.touches);
    maxMove = Math.max(maxMove, Math.hypot(c.x - startCent.x, c.y - startCent.y));
  }, { passive: true });
  const end = ev => {
    if (!startT) return;
    if (ev.touches.length !== 0) return; // erst wenn alle Finger oben sind
    const dur = Date.now() - startT;
    const n = maxTouches;
    startT = 0; maxTouches = 0; startCent = null;
    if ($('viewBook').classList.contains('active') === false) return;
    let action = null;
    try {
      action = (typeof GrimoireErase !== 'undefined')
        ? GrimoireErase.gestureActionForTap(n, dur, maxMove)
        : (dur < 300 && maxMove < 12 ? (n === 2 ? 'undo' : n === 3 ? 'redo' : null) : null);
    } catch { action = null; }
    if (drawing) return; // laufende Zeichnung hat Vorrang (kein Tap)
    // Pinch-Zoom-Schutz: gestureActionForTap liefert nur bei kurz + ruhig
    if (action === 'undo') { try { ev.preventDefault(); } catch { /* ignore */ } undo(); }
    else if (action === 'redo') { try { ev.preventDefault(); } catch { /* ignore */ } redo(); }
  };
  stage.addEventListener('touchend', end);
  stage.addEventListener('touchcancel', () => { startT = 0; maxTouches = 0; startCent = null; });
}
function bindTapGestures() { bindTapGesturesFor(0); bindTapGesturesFor(1); }

/* ---------- Scroll-Navigation (Wheel blättert, pro Pane, Split-kompatibel) ----------
 * Nur `wheel` auf .stage-wrap/.stage löst aus – Pointer/Touch-Zeichnung und
 * Two-Finger-Tap bleiben unberührt. Pinch-Zoom (ctrlKey/metaKey) läuft durch
 * an den Browser. Ein Flip nutzt setPanePageAndRender (leert UI-Stapel korrekt)
 * und zieht den aktiven Pane mit (wie andere Pane-Aktionen). Kein Wrap:
 * am Anfang/Ende blinkt die Statuszeile + Rail-Thumb kurz auf. */
function scrollNavFlipInPane(idx, dir) {
  const key = (idx === 1) ? 1 : 0;
  const b = paneBook(key); if (!b || !b.pages.length) return false;
  const cur = panePageId(key);
  let pos = b.pages.findIndex(p => p.id === cur);
  if (pos < 0) pos = 0;
  let next = null;
  try {
    next = (typeof GrimoireScrollNav !== 'undefined')
      ? GrimoireScrollNav.neighborIndex(pos, dir, b.pages.length)
      : ((pos + dir >= 0 && pos + dir < b.pages.length) ? pos + dir : null);
  } catch { next = null; }
  if (next == null) { scrollNavBoundaryFeedback(key); return false; }
  setActivePane(key, true);
  setPanePageAndRender(key, b.pages[next].id);
  // Weiche Blende statt hartem Schnitt (reine Optik, kein Einfluss auf State).
  try {
    const st = $(eid('stage', key));
    if (st) {
      st.classList.remove('scrollnav-flip');
      void st.offsetWidth; // Animation neu starten
      st.classList.add('scrollnav-flip');
      setTimeout(() => { try { st.classList.remove('scrollnav-flip'); } catch { /* ignore */ } }, 240);
    }
  } catch { /* Feedback optional */ }
  return true;
}
function scrollNavBoundaryFeedback(idx) {
  try {
    const st = $(eid('statusPage', idx));
    if (st) {
      st.classList.remove('scrollnav-flash');
      void st.offsetWidth; // Animation neu starten
      st.classList.add('scrollnav-flash');
      setTimeout(() => { try { st.classList.remove('scrollnav-flash'); } catch { /* ignore */ } }, 450);
    }
    const rail = $(eid('pageRail', idx));
    if (rail) {
      const sel = rail.querySelector('.page-thumb.selected');
      if (sel) {
        sel.classList.remove('scrollnav-bump');
        void sel.offsetWidth;
        sel.classList.add('scrollnav-bump');
        setTimeout(() => { try { sel.classList.remove('scrollnav-bump'); } catch { /* ignore */ } }, 450);
      }
    }
  } catch { /* Feedback optional */ }
}
function scrollNavCanFlip(key, dir) {
  // Gibt es in Richtung dir überhaupt eine Nachbarseite? (kein Wrap)
  try {
    const b = paneBook(key); if (!b || !b.pages.length) return false;
    const pos = b.pages.findIndex(p => p.id === panePageId(key));
    const api = (typeof GrimoireScrollNav !== 'undefined') ? GrimoireScrollNav : null;
    const next = api ? api.neighborIndex(pos < 0 ? 0 : pos, dir, b.pages.length)
      : ((pos + dir >= 0 && pos + dir < b.pages.length) ? pos + dir : null);
    return next != null;
  } catch { return false; }
}
function scrollNavGuardsPass() {
  // Gemeinsame Vorbedingungen für Wheel- und Swipe-Blättern.
  if (!isScrollNavEnabled()) return false;
  if (!$('viewBook') || !$('viewBook').classList.contains('active')) return false;
  // Overlays (Texteditor/Preview/Graph/Cloud) nicht stören.
  if (($('editorOverlay') && $('editorOverlay').classList.contains('active'))
    || ($('previewOverlay') && $('previewOverlay').classList.contains('active'))
    || ($('graphOverlay') && $('graphOverlay').classList.contains('active'))
    || ($('awOverlay') && $('awOverlay').classList.contains('active'))) return false;
  if (typeof GrimoireScrollNav === 'undefined') return false;
  return true;
}
function bindScrollNavFor(idx) {
  const stage = $(eid('stage', idx));
  if (!stage) return;
  const wrap = (stage.closest && stage.closest('.stage-wrap')) || stage;
  if (wrap._scrollNavBound) return;
  wrap._scrollNavBound = true;
  wrap.addEventListener('wheel', (ev) => {
    try {
      if (!scrollNavGuardsPass()) return; // aus / Overlay / kein Modul -> nativ
      const key = (idx === 1) ? 1 : 0;
      if (!scrollNavPane[key]) scrollNavPane[key] = GrimoireScrollNav.createPaneState();
      const r = GrimoireScrollNav.stepWheel(scrollNavPane[key], ev || {}, Date.now());
      if (!r.handled) return; // horizontal / Pinch-Zoom -> Browser
      if (r.flip) {
        ev.preventDefault();
        scrollNavFlipInPane(key, r.flip);
        return;
      }
      // Unter der Schwelle / im Cooldown: nur schlucken, wenn Blättern in diese
      // Richtung überhaupt möglich ist – am Buchanfang/-ende läuft der native
      // Scroll weiter, statt sich „festgefahren" anzufühlen.
      const dir = (r.dy || 0) > 0 ? 1 : -1;
      if (scrollNavCanFlip(key, dir)) ev.preventDefault();
    } catch { /* Wheel-Navigation optional, Zeichnung unberührt */ }
  }, { passive: false });
  // Touch bleibt vollständig beim Browser: Finger kann die Seite scrollen,
  // Apple Pencil wird ausschließlich über Pointer-Events als Tinte behandelt.
}
function bindScrollNav() { bindScrollNavFor(0); bindScrollNavFor(1); }

/* ---------- Text- & Bild-Layer (pro Pane, Suffix '' / 'B') ---------- */
function renderTextLayerFor(idx) {
  const layer = $(eid('textLayer', idx));
  if (!layer) return;
  const p = panePage(idx);
  const ui = paneUI[idx] || {};
  const sel = (idx === activePaneIdx()) ? selectedBox : (ui.selBox || null);
  if (!p) { layer.innerHTML = ''; return; }
  layer.innerHTML = '';
  p.texts.forEach(t => {
    const d = document.createElement('div');
    d.className = 'text-box' + (t.id === sel ? ' selected' : '');
    d.style.left = (t.x * 100) + '%';
    d.style.top = (t.y * 100) + '%';
    d.style.maxWidth = '86%';
    // Textfeld-Upgrade: gespeicherter Box-Stil (Default-Stil) als Inline-Style;
    // Altboxen ohne Felder rendern unverändert per CSS.
    if (t.fontSize) d.style.fontSize = t.fontSize + 'px';
    if (t.color) d.style.color = t.color;
    if (t.align) d.style.textAlign = t.align;
    d.innerHTML = t.html;
    // SPEC-07 light: ```query-Block als Live-Trefferliste (nur Anzeige).
    try {
      if (typeof GrimoireSearch !== 'undefined' && (t.html || '').indexOf('data-lang="query"') !== -1) {
        renderQueryBlocks(d, state.books);
      }
    } catch { /* kaputter Block bleibt Code, kein Crash */ }
    d.onclick = e => { e.stopPropagation(); setActivePane(idx, true); selectedBox = t.id; selectedImg = null; parkActiveUI(); renderAll(); };
    d.ondblclick = e => { e.stopPropagation(); setActivePane(idx, true); openTextEditorForBox(t.id, 'Textbox'); };
    if (tool === 'move' || tool === 'text') makeDraggable(d, t, 'text');
    layer.appendChild(d);
  });
}
function renderTextLayer() { renderTextLayerFor(activePaneIdx()); }
/* SPEC-07 light: eingebetteter ```query-Block in Textboxen.
 * Rendert die Query als Live-Trefferliste (Titel + Snippet), max 5 Treffer
 * (GrimoireSearch.QUERY_MAX_RESULTS). LIMIT (bewusst Anzeige-only):
 * Klick springt NICHT in die Treffer (kein Cursor/Scroll), keine Historie,
 * kein Kontext-Snippet mit Zeilennummer – nur Titel + Textanriss.
 * Betrifft nur die Anzeige (box.html bleibt unverändert, Editor lädt roh). */
function renderQueryBlocks(container, allBooks) {
  const blocks = container.querySelectorAll('pre > code[data-lang="query"]');
  blocks.forEach(code => {
    const pre = code.parentElement;
    if (!pre) return;
    const q = (code.textContent || '').trim();
    let ranked = [];
    try {
      const parsed = GrimoireSearch.parseQuery(q);
      if (parsed && !parsed.isEmpty) ranked = GrimoireSearch.rankBooks(allBooks || [], parsed);
    } catch { ranked = []; }
    const limit = (typeof GrimoireSearch.QUERY_MAX_RESULTS === 'number') ? GrimoireSearch.QUERY_MAX_RESULTS : 5;
    const top = ranked.slice(0, limit);
    const box = document.createElement('div');
    box.className = 'grimoire-query-results';
    box.style.cssText = 'border:1px dashed #8b5a2b;border-radius:6px;padding:6px 8px;font-size:13px;';
    let html = '<div style="font-size:12px;opacity:.75;margin-bottom:4px">🔎 <code>query</code>: '
      + esc(q.slice(0, 80) || '–') + ' · ' + ranked.length + ' Treffer (nur Anzeige, max ' + limit + ' – Klick springt nicht)</div>';
    if (!top.length) {
      html += '<div style="opacity:.7">Keine Treffer.</div>';
    } else {
      html += top.map(r => {
        const first = ((r.book.pages || []).flatMap(p => p.texts || []))[0];
        const snip = first ? stripHtml(first.html).slice(0, 80) : '–';
        return '<div style="padding:2px 0;border-top:1px solid rgba(139,90,43,.25)">📖 <b>' + esc(r.book.title) + '</b>'
          + '<span style="opacity:.75"> – ' + esc(snip) + '</span></div>';
      }).join('');
    }
    box.innerHTML = html;
    pre.replaceWith(box);
  });
}
function renderImgLayerFor(idx) {
  const layer = $(eid('imgLayer', idx));
  if (!layer) return;
  const p = panePage(idx);
  const ui = paneUI[idx] || {};
  const sel = (idx === activePaneIdx()) ? selectedImg : (ui.selImg || null);
  if (!p) { layer.innerHTML = ''; return; }
  layer.innerHTML = '';
  p.images.forEach(im => {
    const d = document.createElement('div');
    d.className = 'img-item' + (im.id === sel ? ' selected' : '');
    d.style.left = (im.x * 100) + '%';
    d.style.top = (im.y * 100) + '%';
    d.style.width = (im.w * 100) + '%';
    d.style.aspectRatio = 'auto';
    const img = document.createElement('img');
    // blob:-Refs lösen asynchron auf (Cache in GrimoireStore), Rest direkt
    img.src = (typeof GrimoireStore !== 'undefined' ? (GrimoireStore.url(im.src) || TRANSPARENT_PIXEL) : im.src);
    img.draggable = false;
    img.style.height = 'auto';
    d.appendChild(img);
    const h = document.createElement('div');
    h.className = 'img-handle'; h.textContent = '⤡';
    h.onpointerdown = e => { e.stopPropagation(); e.preventDefault(); setActivePane(idx, true); startResize(e, im); };
    d.appendChild(h);
    d.onclick = e => { e.stopPropagation(); setActivePane(idx, true); selectedImg = im.id; selectedBox = null; parkActiveUI(); renderAll(); };
    d.ondblclick = e => { e.stopPropagation(); setActivePane(idx, true); if (confirm('Bild entfernen?')) { snapshot(); const pg = currentPage(); pg.images = pg.images.filter(x => x.id !== im.id); selectedImg = null; touchBook(); persistSoon(); renderAll(); } };
    if (tool === 'move') makeDraggable(d, im, 'img');
    layer.appendChild(d);
  });
}
function renderImgLayer() { renderImgLayerFor(activePaneIdx()); }
function makeDraggable(el, obj, kind) {
  el.onpointerdown = e => {
    if (tool !== 'move' && !(kind === 'text' && tool === 'text')) return;
    if (e.target.classList && e.target.classList.contains('img-handle')) return;
    e.preventDefault();
    const stage = $(eid('stage', activePaneIdx())).getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY, ox = obj.x, oy = obj.y;
    e.stopPropagation();
    selectedBox = kind === 'text' ? obj.id : null;
    selectedImg = kind === 'img' ? obj.id : null;
    document.querySelectorAll('.text-box.selected, .img-item.selected').forEach(node => node.classList.remove('selected'));
    el.classList.add('selected');
    if (kind === 'text') return dragText(e, obj, stage, startX, startY, ox, oy);
    const move = me => { obj.x = Math.min(.95, Math.max(0, ox + (me.clientX - startX) / stage.width)); obj.y = Math.min(.95, Math.max(0, oy + (me.clientY - startY) / stage.height)); el.style.left = obj.x * 100 + '%'; el.style.top = obj.y * 100 + '%'; };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); touchBook(); persistSoon(); };
    snapshotOnceDrag();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
}
let dragSnapshotTaken = false;
function snapshotOnceDrag() { if (!dragSnapshotTaken) { snapshot(); dragSnapshotTaken = true; setTimeout(() => dragSnapshotTaken = false, 0); } }
function dragText(e, obj, stage, startX, startY, ox, oy) {
  snapshotOnceDrag();
  const el = e.currentTarget;
  const move = me => { obj.x = Math.min(.9, Math.max(0, ox + (me.clientX - startX) / stage.width)); obj.y = Math.min(.95, Math.max(0, oy + (me.clientY - startY) / stage.height)); el.style.left = obj.x * 100 + '%'; el.style.top = obj.y * 100 + '%'; };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); touchBook(); persistSoon(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
function startResize(e, im) {
  const stage = $(eid('stage', activePaneIdx())).getBoundingClientRect();
  const startX = e.clientX, ow = im.w;
  snapshot();
  const move = me => { im.w = Math.min(.95, Math.max(.05, ow + (me.clientX - startX) / stage.width)); renderImgLayer(); };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); touchBook(); persistSoon(); renderImgLayer(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
function importImage(ev) {
  const files = ev.target.files && Array.from(ev.target.files); if (!files || !files.length) return;
  const p = currentPage(); if (!p) return;
  // Rückwärtskompatibel: Einzelfall wie bisher; mehrere Dateien -> mehrere Overlays nacheinander.
  files.forEach(f => importImageFileAsOverlay(f));
  ev.target.value = '';
}
function importImageFileAsOverlay(f) {
  const p = currentPage(); if (!p || !f) return;
  const img = new Image();
  img.onload = () => {
    const max = 800;
    const sc = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    // Snapshot passiert in importImageBlob direkt vor dem Push (ein Undo-Schritt)
    c.toBlob(b => importImageBlob(b || c), 'image/jpeg', 0.85);
    touchBook(); persistSoon();
    setTool('move');
  };
  img.src = URL.createObjectURL(f);
  // NOTE: importImageBlob übernimmt push/render (async Blob-Store)
}
function importImageBlob(blob) {
  // Canvas-Blob (oder Datei) in Blob-Store legen -> kurze blob:-Ref statt dataURL
  const p = currentPage(); if (!p) return;
  const done = async (src) => {
    if (!src) return;
    if (typeof GrimoireStore !== 'undefined' && GrimoireStore.putDataUrl && src.startsWith('data:')) {
      src = await GrimoireStore.putDataUrl(src);
    }
    snapshot();
    p.images.push({ id: uid(), x: 0.15, y: 0.25, w: 0.5, src });
    touchBook(); persistSoon(); renderImgLayer();
    setTool('move');
  };
  if (typeof GrimoireStore !== 'undefined' && GrimoireStore.putBlob) {
    GrimoireStore.putBlob(blob).then(done);
  } else {
    const r = new FileReader();
    r.onload = () => done(r.result);
    r.readAsDataURL(blob);
  }
}

/* ---------- Import als neue Seite(n) (SPEC-32, ohne Cloud) ---------- */
// Bild -> neue Seite mit Bild als Hintergrund (bg, Layer-Trennung: Ink liegt darüber).
// max 1600px lange Kante, JPEG 0.85, danach Sprung auf die neue Seite.
function importImageAsNewPage(file, opts) {
  opts = opts || {};
  const jump = opts.jump !== false;
  return new Promise(resolve => {
    const b = openBook(); if (!b || !file) { resolve(null); return; }
    const needPage = () => currentPage();
    if (!needPage()) { resolve(null); return; }
    const finishWithDataUrl = async (dataUrl, natW, natH) => {
      try {
        let src = dataUrl;
        // Aufgabe 4: Import-Kompression (Seiten-Kontext) vor dem Einlagern.
        if (typeof PagesImport !== 'undefined' && PagesImport.compressImageDataUrl && typeof src === 'string') {
          try { src = await PagesImport.compressImageDataUrl(src, 'page'); } catch { /* Original behalten */ }
        }
        if (typeof GrimoireStore !== 'undefined' && GrimoireStore.putDataUrl && typeof src === 'string' && src.startsWith('data:')) {
          src = await GrimoireStore.putDataUrl(src);
        }
        const book = openBook(); if (!book) { resolve(null); return; }
        // Bild-Seite im nativen Seitenverhältnis (Breite 1000, Höhe proportional)
        let size = null;
        try {
          if (typeof PagesImport !== 'undefined' && PagesImport.sizeForImage) {
            size = PagesImport.sizeForImage(natW, natH);
          }
        } catch { size = null; }
        const mk = (typeof PagesImport !== 'undefined' && PagesImport.buildNewPageModel)
          ? (bg => { const m = PagesImport.buildNewPageModel({ bg, size }); m.id = uid(); return { id: m.id, strokes: [], texts: [], images: [], bg: m.bg, ...(m.size ? { size: m.size } : {}) }; })
          : (bg => ({ id: uid(), strokes: [], texts: [], images: [], bg, ...(size ? { size } : {}) }));
        const page = mk(src || null);
        const idx = book.pages.findIndex(x => x.id === activePageId());
        book.pages.splice(idx + 1, 0, page);
        if (jump) setActivePageId(page.id);
        else if (!opts._bulkFirstId) opts._bulkFirstId = page.id;
        touchBook(); persistSoon(); renderAll();
        resolve(page.id);
      } catch { resolve(null); }
    };
    // Datei -> Image-Element -> Canvas (1600px-Limit) -> JPEG-dataURL
    let objUrl = null;
    try { objUrl = URL.createObjectURL(file); } catch { resolve(null); return; }
    const img = new Image();
    img.onload = () => {
      try {
        const lim = (typeof PagesImport !== 'undefined' && PagesImport.MAX_IMAGE_LONG_EDGE) || 1600;
        const sc = Math.min(1, lim / Math.max(img.width || 1, img.height || 1));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round((img.width || 1) * sc));
        c.height = Math.max(1, Math.round((img.height || 1) * sc));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        try { URL.revokeObjectURL(objUrl); } catch { /* ignore */ }
        if (c.toBlob) c.toBlob(blob => {
          if (!blob) { try { resolve(null); } catch { /* ignore */ } return; }
          const r = new FileReader();
          r.onload = () => finishWithDataUrl(r.result, c.width, c.height);
          r.onerror = () => resolve(null);
          r.readAsDataURL(blob);
        }, 'image/jpeg', 0.85);
        else {
          try { finishWithDataUrl(c.toDataURL('image/jpeg', 0.85), c.width, c.height); } catch { resolve(null); }
        }
      } catch { try { URL.revokeObjectURL(objUrl); } catch { /* ignore */ } resolve(null); }
    };
    img.onerror = () => { try { URL.revokeObjectURL(objUrl); } catch { /* ignore */ } resolve(null); };
    img.src = objUrl;
  });
}
// <input>-Handler (multi-select): pro Bild eine neue Seite, danach Sprung zur ersten neuen Seite.
function importImageAsPage(ev) {
  const files = (ev.target.files && Array.from(ev.target.files)) || [];
  if (!files.length) return;
  ev.target.value = '';
  (async () => {
    const bulk = { jump: false, _bulkFirstId: null };
    const ids = [];
    for (let i = 0; i < files.length; i++) {
      setSaveStatus('Importiere Bild ' + (i + 1) + '/' + files.length + ' …');
      const id = await importImageAsNewPage(files[i], bulk);
      if (id) ids.push(id);
    }
    const first = bulk._bulkFirstId || ids[0];
    if (first) { setActivePageId(first); renderAll(); }
    persistSoon();
    setSaveStatus(ids.length ? '💾 gespeichert (' + ids.length + ' Bild-Seite(n))' : '💾 gespeichert');
  })().catch(() => setSaveStatus('💾 gespeichert'));
}
// PDF-Seitenzahl via pdf.js (nur Zählen, kein Rendern).
async function gnGetPdfPageCount(pdfBytes) {
  const pdfjs = await gnPdfJs();
  const pdf = await pdfjs.getDocument({ data: pdfBytes.slice() }).promise;
  try { return pdf.numPages || 0; }
  finally { try { await pdf.destroy(); } catch { /* ignore */ } }
}
// PDF -> pro PDF-Seite eine neue Federwerk-Seite mit bg (sequentiell, lazy-freundlich).
// pageRangeStr z. B. „1-3,5", leer = alle. Offline -> Hinweis-Textbox statt bg.
async function importPdfAsNewPages(file, pageRangeStr) {
  const book = openBook(); if (!book || !file) return [];
  let pdfBytes;
  try { pdfBytes = new Uint8Array(await file.arrayBuffer()); }
  catch { return []; }
  if (!pdfBytes.length) return [];
  const fallbackHtml = (pgNo) => {
    if (typeof PagesImport !== 'undefined' && PagesImport.offlinePdfFallbackHtml) {
      return PagesImport.offlinePdfFallbackHtml(file.name, pgNo);
    }
    return '<p><i>PDF-Hintergrund offline nicht ladbar (' + file.name + ', Seite ' + pgNo + ').</i></p>';
  };
  let total = 0;
  try { total = await gnGetPdfPageCount(pdfBytes); }
  catch (e) {
    console.warn('PDF-Seitenzahl nicht lesbar (offline?):', e);
    total = 0;
  }
  const createdIds = [];
  const insertAfterIdx = () => book.pages.findIndex(x => x.id === activePageId());
  // Offline-Fallback: pdf.js gar nicht ladbar -> eine Hinweis-Seite statt N Seiten.
  if (!total) {
    const page = (typeof PagesImport !== 'undefined' && PagesImport.buildNewPageModel)
      ? (() => { const m = PagesImport.buildNewPageModel({}); m.id = uid(); return { id: m.id, strokes: [], texts: [], images: [], bg: null }; })()
      : newPage();
    page.texts.push({ id: uid(), x: 0.06, y: 0.015, html: fallbackHtml(null) });
    book.pages.splice(insertAfterIdx() + 1, 0, page);
    createdIds.push(page.id);
    setActivePageId(page.id);
    touchBook(); persistSoon(); renderAll();
    return createdIds;
  }
  const wanted = (typeof PagesImport !== 'undefined' && PagesImport.parsePageRange)
    ? PagesImport.parsePageRange(pageRangeStr, total)
    : (() => { const a = []; for (let i = 1; i <= total; i++) a.push(i); return a; })();
  if (!wanted.length) return [];
  const status = (typeof PagesImport !== 'undefined' && PagesImport.pdfImportStatus)
    ? PagesImport.pdfImportStatus : ((d, t) => 'Importiere PDF – Seite ' + d + '/' + t + ' …');
  const firstNewId = { v: null };
  for (let i = 0; i < wanted.length; i++) {
    const pgNo = wanted[i];
    setSaveStatus(status(i + 1, wanted.length, file.name));
    // UI zwischen Seiten atmen lassen (große PDFs frieren nicht ein)
    await new Promise(r => setTimeout(r, 0));
    let bg = null;
    let bgW = 0, bgH = 0;
    try {
      const url = await gnRenderPdfPage(pdfBytes.slice(), pgNo, 1000);
      let cUrl = url;
      // Aufgabe 4: PDF-Seitenbild vor dem Einlagern komprimieren.
      if (typeof PagesImport !== 'undefined' && PagesImport.compressImageDataUrl && typeof cUrl === 'string') {
        try { cUrl = await PagesImport.compressImageDataUrl(cUrl, 'page'); } catch { /* Original behalten */ }
      }
      bg = (typeof GrimoireStore !== 'undefined' && GrimoireStore.putDataUrl)
        ? await GrimoireStore.putDataUrl(cUrl) : cUrl;
      // Gerenderte PDF-Maße -> natives Seitenformat (statt A4-Streckung)
      try {
        const nat = await naturalSizeOfDataUrl(typeof cUrl === 'string' ? cUrl : url);
        if (nat && nat.w > 0 && nat.h > 0) { bgW = nat.w; bgH = nat.h; }
      } catch { /* Default-Format */ }
    } catch (e) {
      console.warn('PDF-Hintergrund Seite ' + pgNo + ':', e);
      bg = null;
    }
    let pageSize = null;
    try {
      if (bg && bgW > 0 && bgH > 0 && typeof PagesImport !== 'undefined' && PagesImport.sizeForImage) {
        pageSize = PagesImport.sizeForImage(bgW, bgH);
      }
    } catch { pageSize = null; }
    const page = (typeof PagesImport !== 'undefined' && PagesImport.buildNewPageModel)
      ? (() => { const m = PagesImport.buildNewPageModel({ bg, size: pageSize }); m.id = uid(); return { id: m.id, strokes: [], texts: [], images: [], bg: m.bg, ...(m.size ? { size: m.size } : {}) }; })()
      : (() => { const p = newPage(); p.bg = bg; if (pageSize) p.size = pageSize; return p; })();
    if (!bg) {
      page.texts.push({ id: uid(), x: 0.06, y: 0.015, html: fallbackHtml(pgNo) });
    }
    const at = insertAfterIdx() + 1 + i;
    book.pages.splice(at, 0, page);
    createdIds.push(page.id);
    if (!firstNewId.v) firstNewId.v = page.id;
    touchBook(); persistSoon();
    renderRail();
  }
  if (firstNewId.v) setActivePageId(firstNewId.v);
  touchBook(); persistSoon(); renderAll();
  setSaveStatus('💾 gespeichert (' + createdIds.length + ' PDF-Seite(n))');
  return createdIds;
}
// <input>-Handler für PDF-Import als neue Seiten (Bereich per Prompt wählbar).
function importPdfAsPages(ev, presetRange) {
  const files = (ev.target.files && Array.from(ev.target.files)) || [];
  if (!files.length) return;
  ev.target.value = '';
  let range = presetRange;
  if (range === undefined) {
    try {
      const ans = prompt('Seitenbereich (z. B. 1-3,5 – leer = alle Seiten):', '');
      if (ans === null) return; // Abbrechen -> kein Import
      range = ans;
    } catch { range = ''; }
  }
  (async () => {
    for (const f of files) {
      await importPdfAsNewPages(f, range);
    }
  })().catch(e => { console.warn('PDF-Import:', e); setSaveStatus('💾 gespeichert'); });
}

/* ---------- Rail / Status / Paper (pro Pane) ---------- */
function renderRailFor(idx) {
  const rail = $(eid('pageRail', idx));
  if (!rail) return;
  const b = paneBook(idx); if (!b) { rail.innerHTML = ''; return; }
  const curPid = panePageId(idx);
  rail.innerHTML = '';
  b.pages.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'page-thumb' + (p.id === curPid ? ' selected' : '');
    // Thumbnail im nativen Seitenverhältnis (Contain in 140×198-Box)
    const pd = pageDimsOf(p, b && b.paper);
    const tScale = Math.min(140 / pd.w, 198 / pd.h);
    const tw = Math.max(1, Math.round(pd.w * tScale)), th = Math.max(1, Math.round(pd.h * tScale));
    const c = document.createElement('canvas');
    c.width = tw; c.height = th;
    const g = c.getContext('2d');
    let _tbg = '#fffdf6';
    try { const P = paperApi(); if (P) _tbg = P.bgFor(b && b.paper); } catch { /* Default */ }
    g.fillStyle = _tbg; g.fillRect(0, 0, tw, th);
    g.save(); g.scale(tw / pd.w, th / pd.h);
    p.strokes.forEach(s => drawStroke(g, s));
    g.restore();
    const label = document.createElement('div');
    label.className = 'thumb-label';
    label.textContent = 'Seite ' + (i + 1);
    d.appendChild(c); d.appendChild(label);
    d.title = 'Vorschau öffnen (Doppelklick: direkt öffnen)';
    d.onclick = () => { setActivePane(idx, true); openPagePreview(p.id); };
    d.ondblclick = (e) => { if (e) e.stopPropagation(); gotoPageInPane(p.id, idx); };
    rail.appendChild(d);
  });
  // Button am Ende der letzten Seite: saubere Vorlagen-Kopie (ohne
  // Handschrift/Textfelder/Marker, nur Hintergrund-Struktur).
  try {
    const tpl = document.createElement('button');
    tpl.type = 'button';
    tpl.className = 'page-thumb page-thumb--template no-print';
    tpl.title = 'Letzte Seite als leere Vorlage duplizieren (ohne Handschrift, Textfelder, Marker – nur Hintergrund)';
    tpl.setAttribute('aria-label', 'Letzte Seite als leere Vorlage duplizieren (ohne Handschrift, Textfelder, Marker)');
    tpl.innerHTML = '<span class="thumb-plus" aria-hidden="true">+</span>'
      + '<span class="thumb-label">Vorlage<br>∅ Handschrift/Text/Marker</span>';
    tpl.onclick = (e) => {
      if (e) e.stopPropagation();
      setActivePane(idx, true);
      // Auf letzte Seite springen, dann deren saubere Vorlage anhängen.
      const bb = paneBook(idx);
      if (bb && bb.pages.length) {
        const lastId = bb.pages[bb.pages.length - 1].id;
        setPanePageAndRender(idx, lastId);
      }
      duplicatePageAsTemplate();
    };
    rail.appendChild(tpl);
  } catch { /* Rail-Button optional */ }
  const pos = b.pages.findIndex(p => p.id === curPid);
  const st = $(eid('statusPage', idx));
  if (st) {
    let fmt = '';
    try {
      const cur = b.pages[pos];
      // Eigenes Format -> benennen; sonst folgt die Seite der Buchvorlage.
      let own = null;
      if (typeof PagesImport !== 'undefined' && PagesImport.sanitizePageSize) {
        own = PagesImport.sanitizePageSize(cur && cur.size);
      }
      if (own && typeof PagesImport !== 'undefined' && PagesImport.formatLabel) {
        fmt = ' · ' + PagesImport.formatLabel(own);
      } else if (typeof FederwerkPaper !== 'undefined' && FederwerkPaper.resolve) {
        const t = FederwerkPaper.resolve(b.paper);
        fmt = ' · ' + ((t && t.name) || 'Buchvorlage');
      }
    } catch { /* Format-Label optional */ }
    st.textContent = 'Seite ' + (pos + 1) + '/' + b.pages.length + fmt;
  }
}
function renderRail() { renderRailFor(activePaneIdx()); }
function applyPaperFor(idx) {
  const b = paneBook(idx);
  const st = $(eid('stage', idx));
  if (!st) return;
  // Alle Papier-Klassen abräumen (Legacy 'lined'/'grid' inkl.), dann die der
  // aufgelösten Vorlage legen. Ohne Lib: Legacy-Verhalten (b.paper direkt).
  const P = paperApi();
  try {
    if (P) st.classList.remove.apply(st.classList, P.allCssClasses());
    else st.classList.remove('lined', 'grid');
  } catch { try { st.classList.remove('lined', 'grid'); } catch { /* ignore */ } }
  if (P) {
    try { P.cssClasses(b && b.paper).forEach(c => st.classList.add(c)); } catch { /* ohne Pattern */ }
  } else if (b && b.paper) {
    try { st.classList.add(b.paper); } catch { /* ignore */ }
  }
  // Bühnen-Verhältnis folgt der tatsächlichen Seite (page.size gesetzt vom
  // Vorlagenwechsel bzw. Bild-/PDF-Format) – Fallback Buch-Vorlage/A4.
  try {
    const pd = pageDimsOf(panePage(idx), b && b.paper);
    if (pd && pd.w > 0 && pd.h > 0) st.style.aspectRatio = pd.w + ' / ' + pd.h;
  } catch { /* CSS-Default (210/297) bleibt */ }
}
function applyPaper() { applyPaperFor(activePaneIdx()); }
function applyBgFor(idx) {
  const p = panePage(idx);
  const bg = $(eid('bgLayer', idx));
  if (!bg) return;
  let src = (p && p.bg) || null;
  if (src && typeof GrimoireStore !== 'undefined') src = GrimoireStore.url(src) || null;
  bg.style.backgroundImage = src ? 'url("' + src + '")' : 'none';
}
function applyBg() { applyBgFor(activePaneIdx()); }
function clearPageBg() {
  const p = currentPage(); if (!p || !p.bg) return;
  snapshot();
  p.bg = null;
  touchBook(); persistSoon(); renderAll();
}
function renderAllFor(idx) {
  applyPaperFor(idx); applyBgFor(idx); renderCanvasFor(idx);
  renderTextLayerFor(idx); renderImgLayerFor(idx); renderRailFor(idx);
  syncPaneChrome(idx);
}
function renderAll() {
  applySplitLayout();
  renderAllFor(0);
  if (splitEnabled()) renderAllFor(1);
}

/* ---------- Export / Import ---------- */
/* Aufgabe 5 (KI-lesbares Format): Exporte tragen $schema/formatVersion/
 * formatDoc/_ai (gesetzt via js/format-doc.js, GrimoireFormat). Fallback,
 * falls das Skript fehlt: skalare Meta-Felder direkt setzen. */
function withFormatMeta(obj) {
  try {
    if (typeof GrimoireFormat !== 'undefined' && GrimoireFormat.attachFormatMeta) return GrimoireFormat.attachFormatMeta(obj);
  } catch { /* Fallback unten */ }
  try {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      if (!obj.formatVersion) obj.formatVersion = 'federwerk-1';
      if (!obj.$schema) obj.$schema = './federwerk.schema.json';
      if (!obj.formatDoc) obj.formatDoc = './FEDERWERK_FORMAT.md';
    }
  } catch { /* ignore */ }
  return obj;
}
function download(filename, text, type) {
  const blob = new Blob([text], { type: type || 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function exportAllJSON() {
  (async () => {
    const books = (typeof GrimoireStore !== 'undefined')
      ? await Promise.all(state.books.map(b => GrimoireStore.inlineBook(b)))
      : state.books;
    ensureFoldersLocal();
    download('grimoire-export.json', JSON.stringify(withFormatMeta({ books, folders: state.folders || [], openBookId: state.openBookId, openPageId: state.openPageId }), null, 2));
  })().catch(e => alert('Export fehlgeschlagen: ' + e.message));
}
function exportBookJSON(id, ev) {
  if (ev) ev.stopPropagation();
  const b = state.books.find(x => x.id === id); if (!b) return;
  (async () => {
    const out = (typeof GrimoireStore !== 'undefined') ? await GrimoireStore.inlineBook(b) : b;
    download('grimoire-' + (b.title || 'buch').replace(/[^\wäöüÄÖÜß-]+/gi, '_') + '.json', JSON.stringify(withFormatMeta(out), null, 2));
  })().catch(e => alert('Export fehlgeschlagen: ' + e.message));
}
function exportGoodNotes(id, ev) {
  if (ev) ev.stopPropagation();
  const b = state.books.find(x => x.id === id); if (!b) return;
  (async () => {
    try {
      const out = (typeof GrimoireStore !== 'undefined') ? await GrimoireStore.inlineBook(b) : b;
      const zipData = GoodNotes.exportGoodNotes(out);
      const blob = new Blob([zipData], { type: 'application/zip' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (b.title || 'grimoire').replace(/[^\wäöüÄÖÜß-]+/gi, '_') + '.goodnotes';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      setSaveStatus('✅ .goodnotes exportiert');
    } catch (e) {
      alert('GoodNotes-Export fehlgeschlagen: ' + e.message);
    }
  })();
}
function normalizeBook(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj.books)) return obj.books.map(normalizeBook).filter(Boolean);
  if (!Array.isArray(obj.pages)) return null;
  const b = JSON.parse(JSON.stringify(obj));
  b.id = uid();
  b.title = String(b.title || 'Importiertes Buch');
  // Papier-ID normalisieren (Legacy '' | 'lined' | 'grid' -> Katalog-ID;
  // Unbekanntes -> Default; rendern geht immer, siehe FederwerkPaper.resolve)
  try { const P = paperApi(); b.paper = P ? P.normalizeId(b.paper) : (b.paper || ''); }
  catch { b.paper = b.paper || ''; }
  b.updatedAt = Date.now();
  // Ordner-Referenz aus Alt-Exporten verwerfen (IDs sind neu) – landet in Unsortiert/aktivem Ordner
  b.folderId = null;
  try {
    if (activeFolderId && activeFolderId !== 'all' && activeFolderId !== 'unsorted') {
      const ok = (state.folders || []).some(f => f.id === activeFolderId);
      if (ok) b.folderId = activeFolderId;
    }
  } catch { /* ignore */ }
  b.pages.forEach(p => {
    p.id = uid();
    p.strokes = Array.isArray(p.strokes) ? p.strokes : [];
    p.texts = Array.isArray(p.texts) ? p.texts : [];
    p.images = Array.isArray(p.images) ? p.images : [];
    p.bg = typeof p.bg === 'string' ? p.bg : null;
    // Seitenformat aus Export übernehmen (ungültig -> Default/A4)
    try {
      if (typeof PagesImport !== 'undefined' && PagesImport.sanitizePageSize) {
        const s = PagesImport.sanitizePageSize(p.size);
        if (s) p.size = s;
        else delete p.size;
      } else if (p.size != null) {
        const w = Math.round(Number(p.size.w)), h = Math.round(Number(p.size.h));
        if (!(isFinite(w) && isFinite(h) && w >= 200 && w <= 2400 && h >= 200 && h <= 2400)) delete p.size;
        else if (w === CANVAS_W && h === CANVAS_H) delete p.size;
      }
    } catch { try { delete p.size; } catch { /* ignore */ } }
  });
  if (!b.pages.length) b.pages.push(newPage());
  return b;
}
function normalizeFoldersImported(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const name = String(f.name || '').trim().slice(0, 60);
    if (!name) continue;
    // Zusammenführen nach Name (IDs aus Export sind gerätefremd)
    let target = (state.folders || []).find(x => String(x.name || '').toLowerCase() === name.toLowerCase())
      || out.find(x => String(x.name || '').toLowerCase() === name.toLowerCase());
    if (!target) {
      if (typeof GrimoireFolders !== 'undefined') target = GrimoireFolders.createFolder(state.folders, name);
      else { target = { id: uid(), name, parentId: null, createdAt: Date.now(), updatedAt: Date.now() }; state.folders.push(target); }
    }
    if (target && !seen.has(target.id)) { seen.add(target.id); out.push(target); }
  }
  return out;
}
function importAllJSON(ev) {
  const files = ev.target.files; if (!files || !files.length) return;
  let pending = files.length;
  const added = [];
  Array.from(files).forEach(f => {
    const r = new FileReader();
    r.onload = async () => {
      try {
        const p = JSON.parse(r.result);
        // Ordner aus Gesamt-Export übernehmen (nach Name gemergt)
        try {
          if (p && Array.isArray(p.folders) && p.folders.length) {
            ensureFoldersLocal();
            normalizeFoldersImported(p.folders);
          }
        } catch { /* Ordner optional */ }
        const books = Array.isArray(p) ? p.map(normalizeBook).filter(Boolean)
          : (p.books ? p.books.map(normalizeBook).filter(Boolean)
          : (normalizeBook(p) ? (Array.isArray(normalizeBook(p)) ? normalizeBook(p) : [normalizeBook(p)]) : []));
        // Importierte dataURLs in Blob-Store auslagern (kleiner State)
        if (typeof GrimoireStore !== 'undefined') {
          for (const b of books) await GrimoireStore.extractBook(b);
        }
        books.forEach(b => { state.books.unshift(b); added.push(b.title); });
      } catch { /* einzelne defekte Datei ignorieren, Rest zählt */ }
      if (--pending === 0) {
        ev.target.value = '';
        if (!added.length) { alert('Keine gültige Federwerk-JSON-Datei dabei.'); return; }
        persistNow(); renderLibrary(); showLibrary();
        alert(added.length + ' Dokument(e) importiert:\n• ' + added.join('\n• '));
      }
    };
    r.readAsText(f);
  });
}
/* ---------- GoodNotes-Import (.goodnotes, mehrere Dateien) ---------- */
const GN_PDFJS = [
  { lib: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs', worker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs' },
  { lib: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs', worker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs' }
];
let gnPdfJsPromise = null;
function gnPdfJs() {
  if (!gnPdfJsPromise) {
    gnPdfJsPromise = (async () => {
      let lastErr = null;
      for (const cdn of GN_PDFJS) {
        try {
          const lib = await import(cdn.lib);
          lib.GlobalWorkerOptions.workerSrc = cdn.worker;
          return lib;
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('pdf.js nicht ladbar');
    })();
  }
  return gnPdfJsPromise;
}
async function gnRenderPdfWorker(pdfBytes, pageNo, targetW, cdn, timeoutMs) {
  // Worker-Pfad mit harter Timeout-Garantie (terminate blockiert nie den Main-Thread)
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    throw new Error('kein worker/offscreen-canvas');
  }
  return new Promise((resolve, reject) => {
    let worker = null;
    const timer = setTimeout(() => {
      try { worker && worker.terminate(); } catch { /* ignore */ }
      reject(new Error('pdf-timeout'));
    }, timeoutMs || 30000);
    try {
      worker = new Worker('js/gnpdf-worker.js', { type: 'module' });
    } catch (e) { clearTimeout(timer); reject(e); return; }
    worker.onmessage = (ev) => {
      const d = ev.data || {};
      // Fremd-Messages (z.B. Browser-Infra) ignorieren, nur eigene Antworten werten
      if (d.ok !== true && !d.error) return;
      clearTimeout(timer);
      try { worker.terminate(); } catch { /* ignore */ }
      if (d.ok && d.url) resolve(d.url);
      else reject(new Error(d.error || 'pdf-worker'));
    };
    worker.onerror = (ev) => {
      clearTimeout(timer);
      try { worker.terminate(); } catch { /* ignore */ }
      reject(new Error((ev && ev.message) || 'worker-fehler'));
    };
    try {
      worker.postMessage({ libUrl: cdn.lib, workerUrl: cdn.worker, pdf: pdfBytes, pageNo, targetW });
    } catch (e) { clearTimeout(timer); reject(e); }
  });
}
async function gnRenderPdfPageMain(pdfBytes, pageNo, targetW, timeoutMs) {
  // Fallback nur für Browser ohne Worker/OffscreenCanvas (kann hängen -> kurzes Timeout)
  const pdfjs = await gnPdfJs();
  const pdf = await pdfjs.getDocument({ data: pdfBytes }).promise;
  try {
    const page = await pdf.getPage(Math.max(1, Math.min(pageNo, pdf.numPages)));
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: targetW / v1.width });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const render = page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    await Promise.race([render, new Promise((_, rej) => setTimeout(() => rej(new Error('pdf-timeout')), timeoutMs || 20000))]);
    return c.toDataURL('image/jpeg', 0.85);
  } finally {
    try { await pdf.destroy(); } catch { /* ignore */ }
  }
}
async function gnRenderPdfPage(pdfBytes, pageNo, targetW, timeoutMs) {
  const canWorker = (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined');
  if (canWorker) {
    let lastErr = null;
    for (const cdn of GN_PDFJS) {
      try { return await gnRenderPdfWorker(pdfBytes.slice(), pageNo, targetW, cdn, timeoutMs || 30000); }
      catch (e) { lastErr = e; console.warn('PDF-Worker', cdn.lib, e); }
    }
    throw lastErr || new Error('pdf-worker');
  }
  return gnRenderPdfPageMain(pdfBytes, pageNo, targetW, timeoutMs);
}
function gnImageToDataURL(bytes, mime) {
  return new Promise(res => {
    let url = null;
    try {
      url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    } catch { res(null); return; }
    const img = new Image();
    img.onload = () => {
      try {
        const max = 1000;
        const sc = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * sc));
        c.height = Math.max(1, Math.round(img.height * sc));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        res(c.toDataURL(mime === 'image/png' ? 'image/png' : 'image/jpeg', 0.85));
      } catch { URL.revokeObjectURL(url); res(null); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); res(null); };
    img.src = url;
  });
}
async function buildBookFromGN(doc, fileName, members) {
  const DPI = 132 / 72;
  const book = { id: uid(), title: doc.title || fileName.replace(/\.goodnotes$/i, ''), paper: '', updatedAt: Date.now(), folderId: null, pages: [] };
  try {
    if (activeFolderId && activeFolderId !== 'all' && activeFolderId !== 'unsorted') {
      const ok = (state.folders || []).some(f => f.id === activeFolderId);
      if (ok) book.folderId = activeFolderId;
    }
  } catch { /* ignore */ }
  let pdfBytes = null;
  if (members) {
    for (const k of Object.keys(members)) {
      const b = members[k];
      if (k.startsWith('attachments/') && b.length > 5 && b[0] === 0x25 && b[1] === 0x50) { pdfBytes = b.slice(); break; }
    }
  }
  for (let pi = 0; pi < doc.pages.length; pi++) {
    const pg = doc.pages[pi];
    const m = GoodNotes.mapPage(pg);
    // Bewusst KEIN page.size: mapPage rechnet alles in den fixen A4-Raum
    // (1000×1414, inkl. offY) – natives GN-Format käme erst mit Re-Mapping.
    const page = { id: uid(), strokes: m.strokes, texts: [], images: [], bg: null };
    // Ältere/teilweise exportierte GoodNotes-Dateien enthalten keine
    // Seitenabmessungen. In diesem Fall auf das Standard-A4-Format zurückfallen.
    const dimW = Number(pg.dim && pg.dim.w) > 0 ? Number(pg.dim.w) : (595.28 / DPI);
    const dimH = Number(pg.dim && pg.dim.h) > 0 ? Number(pg.dim.h) : (841.89 / DPI);
    const iw = dimW * DPI, ih = dimH * DPI;
    const sc = CANVAS_W / iw, offY = (CANVAS_H - ih * sc) / 2;
    for (const t of m.texts) {
      page.texts.push({ id: uid(), x: Math.max(0, Math.min(0.9, t.x)), y: Math.max(0, Math.min(0.95, t.y)), html: t.html });
    }
    for (const im of pg.images) {
      const dataUrl = await gnImageToDataURL(im.bytes, im.mime);
      if (!dataUrl) continue;
      page.images.push({
        id: uid(),
        x: Math.round((im.ie.x * sc) / CANVAS_W * 10000) / 10000,
        y: Math.round((im.ie.y * sc + offY) / CANVAS_H * 10000) / 10000,
        w: Math.round((im.ie.w * sc) / CANVAS_W * 10000) / 10000,
        src: dataUrl
      });
    }
    book.pages.push(page);
  }
  if (!book.pages.length) book.pages.push(newPage());
  // Bilder/bg in Blob-Store auslagern (kleiner State, kein localStorage-Overflow)
  if (typeof GrimoireStore !== 'undefined') await GrimoireStore.extractBook(book);
  // PDF-Hintergrund LAZY: Import bleibt schnell & offline-fähig, Rendering läuft nach.
  let pdfPending = 0;
  if (pdfBytes && doc.stats.pdfBg) {
    pdfPending = book.pages.length;
    book.pages.forEach((page, pi) => {
      gnRenderPdfPageLazy(pdfBytes, pi + 1, book.id, page.id);
    });
  }
  return { book, pdfPending };
}
// PDF-Render mit Timeout; Erfolg -> bg setzen, Fehlschlag -> Hinweis-Box
async function gnRenderPdfPageLazy(pdfBytes, pageNo, bookId, pageId) {
  const done = async (ok, url) => {
    const b = state.books.find(x => x.id === bookId);
    const p = b && b.pages.find(x => x.id === pageId);
    if (!p) return;
    if (ok && url) {
      // dataURL in Blob-Store auslagern statt State aufzublähen
      p.bg = (typeof GrimoireStore !== 'undefined') ? await GrimoireStore.putDataUrl(url) : url;
      // evtl. Fallback-Hinweis wieder entfernen
      p.texts = p.texts.filter(t => !stripHtml(t.html).includes('PDF-Hintergrund des Originals'));
    } else if (!p.bg) {
      p.texts.push({ id: uid(), x: 0.06, y: 0.015, html: '<p><i>GoodNotes-Import: PDF-Hintergrund des Originals nicht übernommen (pdf.js offline nicht ladbar).</i></p>' });
    }
    touchBookLazy(bookId);
    persistSoon();
    const visible = [0, 1].some(i => paneBookId(i) === bookId && panePageId(i) === pageId);
    const inBook = [0, 1].some(i => paneBookId(i) === bookId);
    if (visible) renderAll();
    else if (inBook) renderAll();
  };
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('pdf-timeout')), 25000));
  try {
    const url = await Promise.race([gnRenderPdfPage(pdfBytes, pageNo, 1000), timeout]);
    done(true, url);
  } catch (e) {
    console.warn('PDF-Hintergrund Seite ' + pageNo + ':', e);
    done(false);
  }
}
function touchBookLazy(bookId) {
  const b = state.books.find(x => x.id === bookId);
  if (b) b.updatedAt = Date.now();
}
async function importGoodNotes(ev) {
  const files = ev.target.files; if (!files || !files.length) return;
  ev.target.value = '';
  const list = Array.from(files);
  const ok = [], fail = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    setSaveStatus('Importiere ' + (i + 1) + '/' + list.length + ' …');
    try {
      const buf = await f.arrayBuffer();
      const members = await GNZip.readZip(new Uint8Array(buf));
      const doc = GoodNotes.parseDocument(members, f.name.replace(/\.goodnotes$/i, ''));
      if (!doc.pages.length) throw new Error('keine Seiten');
      const { book, pdfPending } = await buildBookFromGN(doc, f.name, members);
      const nStrokes = book.pages.reduce((n, p) => n + p.strokes.length, 0);
      const nImg = book.pages.reduce((n, p) => n + p.images.length, 0);
      const nTexts = book.pages.reduce((n, p) => n + p.texts.length, 0);
      state.books.unshift(book);
      persistNow();
      let extra = '';
      if (pdfPending) extra += ', PDF-HG rendert nach';
      if (doc.stats.texts) extra += ', ' + doc.stats.texts + ' Textbox(en)';
      if (doc.stats.shapes) extra += ', ' + doc.stats.shapes + ' Shape(s)';
      ok.push('• ' + book.title + ' (' + book.pages.length + ' S., ' + nStrokes + ' Striche, ' + nImg + ' Bilder, ' + nTexts + ' Texte' + extra + ')');
    } catch (err) {
      console.warn('GoodNotes-Import fehlgeschlagen:', f.name, err);
      fail.push('• ' + f.name + ' (' + (err && err.message || 'unbekannt') + ')');
    }
  }
  renderLibrary(); showLibrary();
  let msg = ok.length ? ok.length + ' Dokument(e) importiert:\n' + ok.join('\n') : 'Nichts importiert.';
  if (fail.length) msg += '\nFehlgeschlagen:\n' + fail.join('\n');
  alert(msg);
}
function exportPagePNG() {
  const p = currentPage(); if (!p) return;
  (async () => {
    const resolve = (typeof GrimoireStore !== 'undefined')
      ? (ref => GrimoireStore.dataUrl(ref)) : (async ref => ref);
    const _book = openBook();
    const pd = pageDimsOf(p, _book && _book.paper);
    const c = document.createElement('canvas');
    c.width = pd.w; c.height = pd.h;
    const g = c.getContext('2d');
    let _bg = '#fffdf6';
    try { const P = paperApi(); if (P) _bg = P.bgFor(_book && _book.paper); else if (_book && _book.paper === 'grid') _bg = '#ffffff'; }
    catch { _bg = (_book && _book.paper === 'grid') ? '#ffffff' : '#fffdf6'; }
    g.fillStyle = _bg; g.fillRect(0, 0, pd.w, pd.h);
    // Hintergrund (bg, blob:-Ref möglich) zuerst
    if (p.bg) {
      const bgSrc = await resolve(p.bg);
      if (bgSrc) {
        await new Promise(res => {
          const bgImg = new Image();
          bgImg.onload = () => { try { g.drawImage(bgImg, 0, 0, pd.w, pd.h); } catch { /* ignore */ } res(); };
          bgImg.onerror = res; bgImg.src = bgSrc;
        });
      }
    }
    const jobs = p.images.map(im => (async () => {
      const src = await resolve(im.src);
      if (!src) return;
      await new Promise(res => {
        const img = new Image();
        img.onload = () => { try { g.drawImage(img, im.x * pd.w, im.y * pd.h, im.w * pd.w, img.height * (im.w * pd.w / img.width)); } catch { /* ignore */ } res(); };
        img.onerror = res; img.src = src;
      });
    })());
    await Promise.all(jobs);
    p.strokes.forEach(s => drawStroke(g, s));
    g.fillStyle = '#2a1a0e'; g.font = '22px serif';
    p.texts.forEach(t => {
      const lines = stripHtml(t.html).split('\n');
      lines.slice(0, 20).forEach((ln, i) => g.fillText(ln.slice(0, 60), t.x * pd.w + 8, t.y * pd.h + 24 + i * 26));
    });
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = 'seite.png';
    a.click();
  })().catch(e => alert('PNG-Export fehlgeschlagen: ' + e.message));
}

/* ---------- Init (async: IndexedDB + Legacy-Migration + Split-Restore) ---------- */
function restoreSplitFromState() {
  try {
    const api = splitApi();
    if (api && state.split) {
      split = api.restore(state.split);
    } else if (state.split && typeof state.split === 'object') {
      split = {
        enabled: !!state.split.enabled,
        active: state.split.active === 1 ? 1 : 0,
        ratio: typeof state.split.ratio === 'number' ? state.split.ratio : 0.5,
        panes: Array.isArray(state.split.panes) ? state.split.panes : [{ bookId: null, pageId: null }, { bookId: null, pageId: null }],
      };
    }
    // Ungültige Buch-IDs (gelöscht) auf vorhandene Bücher zurücksetzen
    const valid = id => state.books.some(b => b.id === id);
    [0, 1].forEach(i => {
      const p = split.panes && split.panes[i];
      if (!p) return;
      if (p.bookId && !valid(p.bookId)) { p.bookId = null; p.pageId = null; }
      if (p.bookId) {
        const b = state.books.find(x => x.id === p.bookId);
        if (b && !b.pages.some(x => x.id === p.pageId)) p.pageId = b.pages[0] && b.pages[0].id;
      }
    });
    if (!split.panes[0] || !split.panes[0].bookId) {
      split.panes[0] = { bookId: state.openBookId, pageId: state.openPageId };
    }
    if (!splitEnabled()) split.active = 0;
    paneUI = [
      { undo: [], redo: [], selBox: null, selImg: null },
      { undo: [], redo: [], selBox: null, selImg: null },
    ];
    undoStack = []; redoStack = []; selectedBox = null; selectedImg = null;
    unparkActiveUI();
    editorPaneIdx = activePaneIdx();
  } catch { /* Split-Restore optional */ }
}
function bindSplitDivider() {
  const div = $('splitDivider');
  const cont = $('splitContainer');
  if (!div || !cont || div._splitDragBound) return;
  div._splitDragBound = true;
  let dragging = false;
  const ratioFromEvent = (ev) => {
    const r = cont.getBoundingClientRect();
    if (!r.width) return null;
    const vertical = window.innerWidth <= 860;
    if (vertical) {
      if (!r.height) return null;
      return (ev.clientY - r.top) / r.height;
    }
    return (ev.clientX - r.left) / r.width;
  };
  const move = (ev) => {
    if (!dragging) return;
    const v = ratioFromEvent(ev);
    if (v == null) return;
    try { ev.preventDefault(); } catch { /* ignore */ }
    setSplitRatio(v);
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    try { div.releasePointerCapture && div.hasPointerCapture && div.hasPointerCapture(1); } catch { /* ignore */ }
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
  div.addEventListener('pointerdown', (ev) => {
    if (!splitEnabled()) return;
    dragging = true;
    try { div.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    try { ev.preventDefault(); } catch { /* ignore */ }
  });
}
window.addEventListener('resize', () => { if (openBook()) { renderCanvasFor(0); if (splitEnabled()) renderCanvasFor(1); } });
bindStage();
bindTapGestures();
bindScrollNav();
bindSplitDivider();
if (typeof GrimoireStore !== 'undefined') {
  // Blob-URLs trudeln asynchron ein -> sichtbare Ebenen nachrendern
  GrimoireStore.subscribe(() => {
    if ($('viewBook') && $('viewBook').classList.contains('active')) { renderImgLayerFor(0); applyBgFor(0); if (splitEnabled()) { renderImgLayerFor(1); applyBgFor(1); } }
  });
}
document.addEventListener('keydown', e => {
  // Split-Shortcuts (nur in Buchansicht, ohne Editor/Overlays/Input-Fokus)
  try {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    const typing = /INPUT|TEXTAREA|SELECT/.test(tag) || (document.activeElement && document.activeElement.isContentEditable);
    const overlayOpen = ($('editorOverlay') && $('editorOverlay').classList.contains('active'))
      || ($('previewOverlay') && $('previewOverlay').classList.contains('active'))
      || ($('graphOverlay') && $('graphOverlay').classList.contains('active'))
      || ($('awOverlay') && $('awOverlay').classList.contains('active'));
    if (!typing && !overlayOpen && $('viewBook') && $('viewBook').classList.contains('active')) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'b' && e.shiftKey) { e.preventDefault(); toggleSplit(); return; }
      if (mod && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        setActivePane(e.key === 'ArrowRight' ? 1 : 0, true);
        return;
      }
      // Werkzeug-Kürzel: L = Laserpointer (speichert nichts), Esc verlässt den Laser.
      if (!mod && !e.altKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); setTool('laser'); return; }
      if (!mod && !e.altKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); setTool('pen'); return; }
      if (e.key === 'Escape' && isLaserActive()) { e.preventDefault(); setTool('pen'); return; }
    }
  } catch { /* Shortcuts optional */ }
});
(async function boot() {
  let migrated = 0;
  try {
    if (typeof GrimoireStore !== 'undefined') {
      const s = await GrimoireStore.init();
      if (s && Array.isArray(s.books)) {
        state = s;
        migrated = s._migratedImages || 0;
        delete state._migratedImages;
        ensureFoldersLocal();
      } else {
        load(); // kein gespeicherter Stand -> Legacy-Pfad (legt Starter-Buch an)
      }
    } else {
      load();
    }
  } catch {
    try { load(); } catch { /* ignore */ }
  }
  ensureFoldersLocal();
  // Cloud-Ordner-Mirror einlesen (falls Sync schon lief), ohne lokale zu verlieren
  try { pullFoldersFromMirror(); } catch { /* ignore */ }
  renderLibrary();
  restoreSplitFromState();
  bindStage(); bindTapGestures(); bindScrollNav(); bindSplitDivider();
  try { applyStageTouchAction(); } catch { /* Eingabe-Prefs optional */ }
  if (state.openBookId && state.books.some(b => b.id === state.openBookId)) openBookView(state.openBookId, state.openPageId, 0);
  else if (state.books.length) openBookView(state.books[0].id, state.books[0].pages[0] && state.books[0].pages[0].id, 0);
  else showLibrary();
  setTool('pen');
  if (migrated) setSaveStatus('💾 gespeichert (☁ ' + migrated + ' Bild(er) in Bildspeicher migriert)');
})();

/* ---------- Graph-View (SPEC-09 light, V1) ---------- */
// V1-Limit (dokumentiert): statisches Radial-/Kreis-Layout, kein Force-Layout,
// kein Pan/Zoom, keine Filter-/Gruppen-Farben. Knoten = Bücher (Radius nach
// In-Degree), Kanten = [[Wikilink]]-Treffer (s. js/graph.js, DOM-frei).
const GRAPH_W = 800, GRAPH_H = 500;
let graphMode = 'global';
let graphLayout = []; // [{x, y, r, node}] in GRAPH_W x GRAPH_H-Koordinaten

function openGraphOverlay() {
  const o = $('graphOverlay'); if (!o) return;
  const sel = $('graphBookSelect');
  if (sel) {
    sel.innerHTML = state.books.map(b => '<option value="' + esc(b.title) + '">' + esc(b.title) + '</option>').join('');
    const cur = openBook();
    const want = cur ? cur.title : (state.books[0] && state.books[0].title);
    if (want != null) sel.value = want;
  }
  o.classList.add('active');
  renderGraph();
}
function closeGraphOverlay() {
  const o = $('graphOverlay');
  if (o) o.classList.remove('active');
}
function setGraphMode(m) {
  graphMode = (m === 'local') ? 'local' : 'global';
  renderGraph();
}
function graphFullSafe() {
  if (typeof GrimoireGraph === 'undefined') return { nodes: [], edges: [] };
  try { return GrimoireGraph.buildGraph(state.books); }
  catch { return { nodes: [], edges: [] }; }
}
function graphNodeAt(ev) {
  const canvas = $('graphCanvas'); if (!canvas || !graphLayout.length) return null;
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const x = (ev.clientX - r.left) / r.width * GRAPH_W;
  const y = (ev.clientY - r.top) / r.height * GRAPH_H;
  for (let i = graphLayout.length - 1; i >= 0; i--) {
    const L = graphLayout[i];
    if (Math.hypot(L.x - x, L.y - y) <= L.r + 5) return L.node;
  }
  return null;
}
function onGraphClick(ev) {
  const n = graphNodeAt(ev);
  if (n && n.bookId) { closeGraphOverlay(); openBookView(n.bookId); }
}
function onGraphHover(ev) {
  const canvas = $('graphCanvas'), tip = $('graphTip');
  const n = graphNodeAt(ev);
  if (canvas) {
    canvas.style.cursor = n ? 'pointer' : 'default';
    canvas.title = n ? n.title + ' – klicken zum Öffnen' : '';
  }
  if (tip) {
    if (n && canvas) {
      const r = canvas.getBoundingClientRect();
      tip.style.display = 'block';
      tip.textContent = n.title;
      tip.style.left = (ev.clientX - r.left + 12) + 'px';
      tip.style.top = (ev.clientY - r.top + 12) + 'px';
    } else {
      tip.style.display = 'none';
    }
  }
}
function renderGraph() {
  const canvas = $('graphCanvas'), info = $('graphInfo');
  if (!canvas) return;
  const setInfo = t => { if (info) info.textContent = t; };
  if (typeof GrimoireGraph === 'undefined') { setInfo('Graph-Modul nicht geladen.'); return; }
  const full = graphFullSafe();
  const bG = $('graphModeGlobal'), bL = $('graphModeLocal'), dw = $('graphDepthWrap');
  if (bG) bG.classList.toggle('picked', graphMode === 'global');
  if (bL) bL.classList.toggle('picked', graphMode === 'local');
  const depthEl = $('graphDepth');
  const depth = depthEl ? (Math.min(2, Math.max(1, +depthEl.value || 1))) : 1;
  const dl = $('graphDepthLabel');
  if (dl) dl.textContent = String(depth);
  if (dw) dw.style.display = graphMode === 'local' ? '' : 'none';
  let g = full, centerId = null;
  if (graphMode === 'local') {
    const sel = $('graphBookSelect');
    const title = sel ? sel.value : ((openBook() && openBook().title) || '');
    try { g = GrimoireGraph.localGraph(full, title || '', depth); }
    catch { g = { nodes: [], edges: [] }; }
    const want = String(title || '').trim().toLowerCase();
    const c = g.nodes.find(n => String(n.title || '').trim().toLowerCase() === want);
    centerId = c ? c.id : (g.nodes[0] && g.nodes[0].id);
  }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = GRAPH_W * dpr; canvas.height = GRAPH_H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, GRAPH_W, GRAPH_H);
  let cssText = '#2a1a0e';
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--text');
    if (v && v.trim()) cssText = v.trim();
  } catch { /* Fallback */ }
  setInfo(g.nodes.length + ' Knoten · ' + g.edges.length + ' Kanten' +
    (graphMode === 'local' ? ' · lokal (Tiefe ' + depth + ')' : ' · global'));
  graphLayout = [];
  if (!g.nodes.length) {
    ctx.fillStyle = cssText; ctx.font = '16px serif'; ctx.textAlign = 'center';
    ctx.fillText(
      graphMode === 'local' ? 'Kein Startbuch / keine Nachbarn – Buch wählen oder [[Links]] anlegen.' : 'Keine Bücher – lege zuerst ein Buch an.',
      GRAPH_W / 2, GRAPH_H / 2);
    return;
  }
  // In-Degree (im sichtbaren Teilgraphen) -> Knotenradius
  const indeg = {};
  g.nodes.forEach(n => { indeg[n.id] = 0; });
  g.edges.forEach(e => { if (e.to in indeg) indeg[e.to]++; });
  const radOf = n => Math.min(30, 12 + 5 * Math.sqrt(indeg[n.id] || 0));
  // Positionen: global = Kreis, lokal = Zentrum + Ringe nach BFS-Tiefe
  const pos = {};
  if (graphMode === 'local' && centerId) {
    const adj = {};
    g.nodes.forEach(n => { adj[n.id] = []; });
    g.edges.forEach(e => {
      if (adj[e.from] && adj[e.to]) {
        if (adj[e.from].indexOf(e.to) === -1) adj[e.from].push(e.to);
        if (adj[e.to].indexOf(e.from) === -1) adj[e.to].push(e.from);
      }
    });
    const dep = {}; dep[centerId] = 0;
    const q = [centerId];
    while (q.length) {
      const c = q.shift();
      adj[c].forEach(nb => { if (!(nb in dep)) { dep[nb] = dep[c] + 1; q.push(nb); } });
    }
    const rings = {};
    g.nodes.forEach(n => {
      if (n.id === centerId) return;
      const dd = dep[n.id] || 1;
      (rings[dd] = rings[dd] || []).push(n);
    });
    pos[centerId] = { x: GRAPH_W / 2, y: GRAPH_H / 2 };
    Object.keys(rings).map(Number).sort((a, b) => a - b).forEach((dd, ri) => {
      const ring = rings[dd];
      const rad = Math.min(150 + ri * 100, Math.min(GRAPH_W, GRAPH_H) / 2 - 40);
      ring.forEach((n, i) => {
        const a = (i / ring.length) * Math.PI * 2 - Math.PI / 2;
        pos[n.id] = {
          x: GRAPH_W / 2 + Math.cos(a) * rad * 1.5,
          y: GRAPH_H / 2 + Math.sin(a) * rad * 0.85
        };
      });
    });
  } else if (g.nodes.length === 1) {
    pos[g.nodes[0].id] = { x: GRAPH_W / 2, y: GRAPH_H / 2 };
  } else {
    const rad = Math.min(GRAPH_W, GRAPH_H) / 2 - 60;
    g.nodes.forEach((n, i) => {
      const a = (i / g.nodes.length) * Math.PI * 2 - Math.PI / 2;
      pos[n.id] = {
        x: GRAPH_W / 2 + Math.cos(a) * rad * 1.5,
        y: GRAPH_H / 2 + Math.sin(a) * rad
      };
    });
  }
  // Kanten (Selbstlink = kleiner Loop über dem Knoten)
  ctx.strokeStyle = '#c9a87c'; ctx.lineWidth = 1.5;
  g.edges.forEach(e => {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) return;
    ctx.beginPath();
    if (e.from === e.to) {
      const nb = g.nodes.find(n => n.id === e.from);
      const rr = nb ? radOf(nb) : 14;
      ctx.arc(a.x, a.y - rr - 9, 10, 0, 7);
    } else {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  });
  // Knoten + Labels
  ctx.textAlign = 'center';
  g.nodes.forEach(n => {
    const p = pos[n.id]; if (!p) return;
    const r = radOf(n);
    graphLayout.push({ x: p.x, y: p.y, r, node: n });
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7);
    ctx.fillStyle = (graphMode === 'local' && n.id === centerId) ? '#654321' : '#8b5a2b';
    ctx.fill();
    ctx.strokeStyle = '#e5d5c0'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = cssText; ctx.font = '12px serif';
    const label = n.title.length > 18 ? n.title.slice(0, 17) + '…' : n.title;
    ctx.fillText(label, p.x, p.y + r + 14);
  });
  if (g.nodes.length === 1 && !g.edges.length) {
    ctx.fillStyle = cssText; ctx.font = '13px serif'; ctx.textAlign = 'center';
    ctx.fillText('Noch keine [[Links]] – lege Wikilinks zwischen Büchern an.', GRAPH_W / 2, 24);
  }
}
document.addEventListener('keydown', e => {
  const o = $('graphOverlay');
  if (!o || !o.classList.contains('active')) return;
  if ($('editorOverlay') && $('editorOverlay').classList.contains('active')) return;
  if (e.key === 'Escape') closeGraphOverlay();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

/* ---------- iPad Safe-Area: --header-h live nachmessen ----------
 * Der Header bricht je nach Breakpoint/Orientation um (ein-/zweizeilig).
 * CSS liefert statische Fallbacks pro Breakpoint, JS korrigiert --header-h
 * auf die echte Höhe, damit .toolbar (top: var(--toolbar-top) + sat) und
 * .folder-sidebar nie unter dem glasigen Header kleben – Portrait/Landscape,
 * Safari-Tab (--sat≈0) wie PWA-standalone (Notch-Inset). Node-sicher (Tests). */
(function syncHeaderH() {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const root = document.documentElement;
    const update = () => {
      try {
        const h = document.querySelector('.header');
        if (!h || !root || !root.style || typeof h.getBoundingClientRect !== 'function') return;
        const rectH = Math.round(h.getBoundingClientRect().height);
        if (rectH >= 40 && rectH <= 400) {
          root.style.setProperty('--header-h', rectH + 'px');
          // Toolbar-Offset = Header-Höhe + Lücke (12px mobil / 20px desktop-Nähe).
          // Kurz halten: Header + 20px, mindestens 66px (historischer Mobil-Wert).
          const gap = (typeof window.innerWidth === 'number' && window.innerWidth <= 860) ? 20 : 20;
          root.style.setProperty('--toolbar-top', Math.max(66, rectH + gap) + 'px');
        }
      } catch { /* ignore */ }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', update, { once: true });
    else update();
    window.addEventListener('load', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    try {
      if (typeof ResizeObserver !== 'undefined') {
        const h = document.querySelector('.header');
        if (h) new ResizeObserver(update).observe(h);
      }
    } catch { /* ignore */ }
    // Nach Fonts/Layout-Shift (Cinzel/Crimson via Google Fonts) erneut messen.
    try { setTimeout(update, 500); setTimeout(update, 1500); } catch { /* ignore */ }
  } catch { /* ignore */ }
})();
