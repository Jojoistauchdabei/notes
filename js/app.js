/* Grimoire – GoodNotes-Klon im DND-Stil. LocalStorage, kein Server. */
/* Seitenformat: A4 (210:297), Canvas 1000×1414 */
const LS_KEY = 'grimoire-dnd-v1';
const CANVAS_W = 1000, CANVAS_H = 1414;

let state = { books: [], openBookId: null, openPageId: null };
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
function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) { const p = JSON.parse(raw); if (p && Array.isArray(p.books)) state = p; }
  } catch { /* ignore */ }
  if (!state.books.length) {
    const b = newBook('Mein erstes Grimoire', true);
    state.books.push(b);
    state.openBookId = b.id; state.openPageId = b.pages[0].id;
    persistNow();
  }
}
function persistNow() {
  try {
    syncSplitToState();
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
  const b = { id: uid(), title: title || 'Neues Buch', paper: 'grid', updatedAt: Date.now(), pages: [newPage()] };
  // SPEC-31 light: Suchsprache pro Buch (book.lang, Default Gerätesprache/'de').
  // V1 bewusst ohne UI-Bruch (kein Dialog-Feld); Umstellung später hier im
  // Buch-Flow, aktuell per GrimoireInkIndex.setBookLang(book, 'en').
  try { b.lang = (typeof GrimoireInkIndex !== 'undefined' && GrimoireInkIndex.defaultLang) ? GrimoireInkIndex.defaultLang() : 'de'; } catch { b.lang = 'de'; }
  if (withStarter) {
    b.pages[0].texts.push({ id: uid(), x: 0.08, y: 0.05, html: '<h2>Willkommen im Grimoire ⚔</h2><p>• <b>Stift/Marker:</b> auf der Seite malen (Maus, Touch, Stylus)<br>• <b>Text:</b> Tool „T Text“ → auf Seite klicken → Doppelklick öffnet den großen Texteditor<br>• <b>Bild:</b> über 🖼 einfügen, in Auswahl-Modus ✥ verschieben &amp; skalieren<br>• <b>Radierer:</b> Striche antippen zum Löschen</p>' });
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
  // Cloud-Propagierung (fire-and-forget, nur wenn konfiguriert)
  try {
    if (typeof GrimoireCloud !== 'undefined' && GrimoireCloud.isConfigured()) {
      GrimoireCloud.deleteRemoteBookById(id).catch(() => {});
    } else if (typeof GrimoireCloud !== 'undefined') {
      GrimoireCloud.forgetLocalBook(id);
    }
  } catch { /* Cloud optional */ }
}
function duplicateBook(id, ev) {
  if (ev) ev.stopPropagation();
  const src = state.books.find(b => b.id === id); if (!src) return;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid(); copy.title = src.title + ' (Kopie)';
  copy.pages.forEach(p => { p.id = uid(); });
  copy.updatedAt = Date.now();
  state.books.unshift(copy);
  persistNow(); renderLibrary();
}
function renameBook(v) { const b = openBook(); if (!b) return; b.title = v || 'Unbenannt'; touchBook(); persistSoon(); syncPaneChrome(activePaneIdx()); syncBookSelects(); }
// SPEC-31: book.lang bleibt beim Umbenennen erhalten; Sprachwechsel später
// im Buch-Dialog (z. B. <select>), V1 nur per GrimoireInkIndex.setBookLang().
function setPaper(v) { const b = openBook(); if (!b) return; b.paper = v; touchBook(); persistSoon(); renderAll(); }

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
  try { const oc = $('overlayCanvas'); if (oc) oc.getContext('2d').clearRect(0, 0, CANVAS_W, CANVAS_H); } catch { /* ignore */ }
  try { const ocB = $('overlayCanvasB'); if (ocB) ocB.getContext('2d').clearRect(0, 0, CANVAS_W, CANVAS_H); } catch { /* ignore */ }
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
  if (ps) ps.value = (b && b.paper) || '';
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
function renderLibrary() {
  const rawQ = ($('librarySearch').value || '');
  const q = rawQ.toLowerCase();
  const grid = $('libraryGrid');
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
    try { ranked = GrimoireSearch.rankBooks(state.books, parsed); } catch { ranked = []; }
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
    try { matches = GrimoireInkIndex.searchBooks(state.books, rawQ); }
    catch { matches = state.books.map(b => ({ book: b, match: 'none', snippet: '' })); }
  } else {
    // Fallback ohne Index-Modul (altes Verhalten: Titel + getippter Text).
    matches = state.books.filter(b => {
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
    grid.innerHTML = hintHtml + counterHtml + '<div style="font-size:14px;opacity:.8">' + (searched ? 'Keine Treffer. Suche ändern oder leeren.' : 'Keine Bücher gefunden. Lege oben ein neues Buch an.') + '</div>';
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
    return '<div class="notebook-cover" onclick="openBookView(\'' + b.id + '\')">'
      + '<div class="notebook-spine"></div>'
      + '<div class="notebook-body">'
      + '<div class="notebook-title">' + esc(b.title) + badge + '</div>'
      + '<div class="notebook-meta">' + (b.pages || []).length + ' Seite(n) · ' + strokes + ' Striche · ' + new Date(b.updatedAt).toLocaleDateString('de-DE') + '</div>'
      + '<div class="notebook-preview">' + preview + '</div>'
      + snippetHtml
      + '<div class="notebook-actions">'
      + '<button class="mini-button" onclick="openBookInSplit(\'' + b.id + '\',event)" title="Als zweites Dokument daneben öffnen (Split-Screen, ein Fenster)">⇉ Split</button>'
      + '<button class="mini-button" onclick="exportBookJSON(\'' + b.id + '\',event)">Export</button>'
      + '<button class="mini-button" onclick="exportGoodNotes(\'' + b.id + '\',event)" aria-label="Buch als GoodNotes-Datei exportieren">📤 GoodNotes</button>'
      + '<button class="mini-button" onclick="duplicateBook(\'' + b.id + '\',event)">Duplizieren</button>'
      + '<button class="mini-button" onclick="deleteBook(\'' + b.id + '\',event)">Löschen</button>'
      + '</div></div></div>';
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
  const W = 600, H = Math.round(600 * CANVAS_H / CANVAS_W);
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fffdf6'; g.fillRect(0, 0, W, H);
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
  g.save(); g.scale(W / CANVAS_W, H / CANVAS_H);
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
  parkActiveUI();
  syncToolbar(); renderTextLayer(); renderImgLayer();
  const names = { pen: '✒ Stift', marker: '🖍 Marker', eraser: '⌫ Radierer', text: 'T Text', move: '✥ Auswahl' };
  const st0 = $('statusTool'), st1 = $('statusToolB');
  if (st0) st0.textContent = names[t] || t;
  if (st1) st1.textContent = names[t] || t;
  const s0 = $('stage'), s1 = $('stageB');
  const cur = t === 'text' ? 'text' : t === 'move' ? 'move' : 'crosshair';
  if (s0) s0.style.cursor = cur;
  if (s1) s1.style.cursor = cur;
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
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  [c, o].forEach(x => { x.width = CANVAS_W * dpr; x.height = CANVAS_H * dpr; });
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
  return { x: (ev.clientX - r.left) / r.width * CANVAS_W, y: (ev.clientY - r.top) / r.height * CANVAS_H, nx: (ev.clientX - r.left) / r.width, ny: (ev.clientY - r.top) / r.height, p };
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
  const pts = s.points;
  const closed = !!s.closed || (!!s.fill && pts.length > 2);
  // Pressure-Stift: Punkte mit p -> segweise variable Breite (round caps);
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
    for (let i = 1; i < pts.length; i++) {
      c.lineWidth = (wOf(pts[i - 1]) + wOf(pts[i])) / 2;
      c.beginPath();
      c.moveTo(pts[i - 1].x, pts[i - 1].y);
      c.lineTo(pts[i].x, pts[i].y);
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
  c.clearRect(0, 0, CANVAS_W, CANVAS_H);
  const p = panePage(idx); if (!p) return;
  p.strokes.forEach(s => drawStroke(c, s));
}
function renderCanvas() { renderCanvasFor(activePaneIdx()); }
function previewStroke(points, color, size, toolName) {
  const oc = overlayEl(activePaneIdx()); if (!oc) return;
  const o = oc.getContext('2d');
  o.clearRect(0, 0, CANVAS_W, CANVAS_H);
  if (points && points.length) drawStroke(o, { tool: toolName, color, size, points });
}
// Apple Pencil Hover-Preview: Ghost-Kreis am Cursor, kein Zeichnen (nur pen-Hover, Stift/Marker).
function drawHoverPreview(pos) {
  const oc = overlayEl(activePaneIdx()); if (!oc) return;
  const g = oc.getContext('2d');
  g.clearRect(0, 0, CANVAS_W, CANVAS_H);
  const base = tool === 'marker' ? penSize * 3 : penSize;
  g.save();
  g.strokeStyle = penColor; g.globalAlpha = 0.75; g.lineWidth = 1.5;
  g.beginPath(); g.arc(pos.x, pos.y, Math.max(3, base / 2), 0, 7); g.stroke();
  g.globalAlpha = 0.3; g.fillStyle = penColor;
  g.beginPath(); g.arc(pos.x, pos.y, 2, 0, 7); g.fill();
  g.restore();
}
function clearHoverPreview() {
  if (drawing) return;
  const oc = overlayEl(activePaneIdx()); if (!oc) return;
  oc.getContext('2d').clearRect(0, 0, CANVAS_W, CANVAS_H);
}
function distToStroke(pt, s, radius) {
  return s.points.some(q => Math.hypot(q.x - pt.x, q.y - pt.y) <= radius + s.size / 2);
}

function bindStageFor(idx) {
  const stage = $(eid('stage', idx));
  if (!stage || stage._splitBound) return;
  stage._splitBound = true;
  const activePointers = new Set();
  stage.addEventListener('pointerdown', ev => {
    if ($('viewBook').classList.contains('active') === false) return;
    if (activePaneIdx() !== idx) setActivePane(idx, true);
    // SPEC-25: Zweit-/Dritt-Finger bricht laufende Ein-Finger-Zeichnung ab
    // (kein Commit), damit Zwei-/Drei-Finger-Tap kein Undo-Artefakt hinterlässt.
    if (ev.isPrimary === false) {
      activePointers.add(ev.pointerId);
      if (drawing && !drawing.erasing) {
        drawing = null;
        try { overlayEl(idx).getContext('2d').clearRect(0, 0, CANVAS_W, CANVAS_H); } catch { /* ignore */ }
        undoStack.pop(); // eben genommener Snapshot war leer -> zurückrollen
      } else if (drawing) { drawing = null; }
      eraseTrail = null;
      return;
    }
    activePointers.add(ev.pointerId);
    const pos = stagePosFor(ev, idx);
    const p = currentPage(); if (!p) return;
    if (tool === 'pen' || tool === 'marker') {
      snapshot();
      stage.setPointerCapture(ev.pointerId);
      drawing = { tool, color: penColor, size: tool === 'marker' ? penSize * 3 : penSize, points: [{ x: pos.x, y: pos.y, p: pos.p }] };
      previewStroke(drawing.points, drawing.color, drawing.size, drawing.tool);
    } else if (tool === 'eraser') {
      snapshot();
      drawing = { erasing: true };
      eraseTrail = [{ x: pos.x, y: pos.y, t: Date.now() }];
      eraseAt(pos);
      stage.setPointerCapture(ev.pointerId);
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
    // Apple Pencil Hover (pen, keine Buttons, Stift/Marker): nur Ghost-Vorschau, kein Zeichnen.
    if (!drawing && ev.pointerType === 'pen' && ev.buttons === 0 && (tool === 'pen' || tool === 'marker')) {
      drawHoverPreview(stagePosFor(ev, idx));
      return;
    }
    if (!drawing) return;
    if (ev.isPrimary === false) return;
    const pos = stagePosFor(ev, idx);
    if (drawing.erasing) {
      if (eraseTrail) {
        eraseTrail.push({ x: pos.x, y: pos.y, t: Date.now() });
        if (eraseTrail.length > 60) eraseTrail.splice(0, eraseTrail.length - 60);
      }
      eraseAt(pos); return;
    }
    drawing.points.push({ x: pos.x, y: pos.y, p: pos.p });
    previewStroke(drawing.points, drawing.color, drawing.size, drawing.tool);
  });
  stage.addEventListener('pointerleave', () => { clearHoverPreview(); });
  const finish = (ev) => {
    if (ev && ev.pointerId != null) activePointers.delete(ev.pointerId);
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
      p.strokes.push(drawing);
      touchBook(); persistSoon(); renderCanvas(); renderRail();
    }
    drawing = null;
    try { overlayEl(activePaneIdx()).getContext('2d').clearRect(0, 0, CANVAS_W, CANVAS_H); } catch { /* ignore */ }
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
    const finishWithDataUrl = async dataUrl => {
      try {
        let src = dataUrl;
        if (typeof GrimoireStore !== 'undefined' && GrimoireStore.putDataUrl && typeof src === 'string' && src.startsWith('data:')) {
          src = await GrimoireStore.putDataUrl(src);
        }
        const book = openBook(); if (!book) { resolve(null); return; }
        const mk = (typeof PagesImport !== 'undefined' && PagesImport.buildNewPageModel)
          ? (bg => { const m = PagesImport.buildNewPageModel({ bg }); m.id = uid(); return { id: m.id, strokes: [], texts: [], images: [], bg: m.bg }; })
          : (bg => ({ id: uid(), strokes: [], texts: [], images: [], bg }));
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
          r.onload = () => finishWithDataUrl(r.result);
          r.onerror = () => resolve(null);
          r.readAsDataURL(blob);
        }, 'image/jpeg', 0.85);
        else {
          try { finishWithDataUrl(c.toDataURL('image/jpeg', 0.85)); } catch { resolve(null); }
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
// PDF -> pro PDF-Seite eine neue Grimoire-Seite mit bg (sequentiell, lazy-freundlich).
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
    try {
      const url = await gnRenderPdfPage(pdfBytes.slice(), pgNo, 1000);
      bg = (typeof GrimoireStore !== 'undefined' && GrimoireStore.putDataUrl)
        ? await GrimoireStore.putDataUrl(url) : url;
    } catch (e) {
      console.warn('PDF-Hintergrund Seite ' + pgNo + ':', e);
      bg = null;
    }
    const page = (typeof PagesImport !== 'undefined' && PagesImport.buildNewPageModel)
      ? (() => { const m = PagesImport.buildNewPageModel({ bg }); m.id = uid(); return { id: m.id, strokes: [], texts: [], images: [], bg: m.bg }; })()
      : (() => { const p = newPage(); p.bg = bg; return p; })();
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
    const c = document.createElement('canvas');
    c.width = 140; c.height = 198; // A4-Mini (210:297)
    const g = c.getContext('2d');
    g.fillStyle = '#fffdf6'; g.fillRect(0, 0, 140, 198);
    g.save(); g.scale(140 / CANVAS_W, 198 / CANVAS_H);
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
  const pos = b.pages.findIndex(p => p.id === curPid);
  const st = $(eid('statusPage', idx));
  if (st) st.textContent = 'Seite ' + (pos + 1) + '/' + b.pages.length;
}
function renderRail() { renderRailFor(activePaneIdx()); }
function applyPaperFor(idx) {
  const b = paneBook(idx);
  const st = $(eid('stage', idx));
  if (!st) return;
  st.classList.remove('lined', 'grid');
  if (b && b.paper) st.classList.add(b.paper);
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
    download('grimoire-export.json', JSON.stringify({ books, openBookId: state.openBookId, openPageId: state.openPageId }, null, 2));
  })().catch(e => alert('Export fehlgeschlagen: ' + e.message));
}
function exportBookJSON(id, ev) {
  if (ev) ev.stopPropagation();
  const b = state.books.find(x => x.id === id); if (!b) return;
  (async () => {
    const out = (typeof GrimoireStore !== 'undefined') ? await GrimoireStore.inlineBook(b) : b;
    download('grimoire-' + (b.title || 'buch').replace(/[^\wäöüÄÖÜß-]+/gi, '_') + '.json', JSON.stringify(out, null, 2));
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
  b.paper = b.paper || '';
  b.updatedAt = Date.now();
  b.pages.forEach(p => {
    p.id = uid();
    p.strokes = Array.isArray(p.strokes) ? p.strokes : [];
    p.texts = Array.isArray(p.texts) ? p.texts : [];
    p.images = Array.isArray(p.images) ? p.images : [];
    p.bg = typeof p.bg === 'string' ? p.bg : null;
  });
  if (!b.pages.length) b.pages.push(newPage());
  return b;
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
        if (!added.length) { alert('Keine gültige Grimoire-JSON-Datei dabei.'); return; }
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
  const book = { id: uid(), title: doc.title || fileName.replace(/\.goodnotes$/i, ''), paper: '', updatedAt: Date.now(), pages: [] };
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
    const page = { id: uid(), strokes: m.strokes, texts: [], images: [], bg: null };
    const iw = pg.dim.w * DPI, ih = pg.dim.h * DPI;
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
    const c = document.createElement('canvas');
    c.width = CANVAS_W; c.height = CANVAS_H;
    const g = c.getContext('2d');
    const _book = openBook();
    g.fillStyle = (_book && _book.paper === 'grid') ? '#ffffff' : '#fffdf6'; g.fillRect(0, 0, CANVAS_W, CANVAS_H);
    // Hintergrund (bg, blob:-Ref möglich) zuerst
    if (p.bg) {
      const bgSrc = await resolve(p.bg);
      if (bgSrc) {
        await new Promise(res => {
          const bgImg = new Image();
          bgImg.onload = () => { try { g.drawImage(bgImg, 0, 0, CANVAS_W, CANVAS_H); } catch { /* ignore */ } res(); };
          bgImg.onerror = res; bgImg.src = bgSrc;
        });
      }
    }
    const jobs = p.images.map(im => (async () => {
      const src = await resolve(im.src);
      if (!src) return;
      await new Promise(res => {
        const img = new Image();
        img.onload = () => { try { g.drawImage(img, im.x * CANVAS_W, im.y * CANVAS_H, im.w * CANVAS_W, img.height * (im.w * CANVAS_W / img.width)); } catch { /* ignore */ } res(); };
        img.onerror = res; img.src = src;
      });
    })());
    await Promise.all(jobs);
    p.strokes.forEach(s => drawStroke(g, s));
    g.fillStyle = '#2a1a0e'; g.font = '22px serif';
    p.texts.forEach(t => {
      const lines = stripHtml(t.html).split('\n');
      lines.slice(0, 20).forEach((ln, i) => g.fillText(ln.slice(0, 60), t.x * CANVAS_W + 8, t.y * CANVAS_H + 24 + i * 26));
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
      || ($('cloudOverlay') && $('cloudOverlay').classList.contains('active'));
    if (!typing && !overlayOpen && $('viewBook') && $('viewBook').classList.contains('active')) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'b' && e.shiftKey) { e.preventDefault(); toggleSplit(); return; }
      if (mod && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        setActivePane(e.key === 'ArrowRight' ? 1 : 0, true);
        return;
      }
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
      } else {
        load(); // kein gespeicherter Stand -> Legacy-Pfad (legt Starter-Buch an)
      }
    } else {
      load();
    }
  } catch {
    try { load(); } catch { /* ignore */ }
  }
  renderLibrary();
  restoreSplitFromState();
  bindStage(); bindTapGestures(); bindSplitDivider();
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
