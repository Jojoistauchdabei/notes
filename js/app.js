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
  if (withStarter) {
    b.pages[0].texts.push({ id: uid(), x: 0.08, y: 0.05, html: '<h2>Willkommen im Grimoire ⚔</h2><p>• <b>Stift/Marker:</b> auf der Seite malen (Maus, Touch, Stylus)<br>• <b>Text:</b> Tool „T Text“ → auf Seite klicken → Doppelklick öffnet den großen Texteditor<br>• <b>Bild:</b> über 🖼 einfügen, in Auswahl-Modus ✥ verschieben &amp; skalieren<br>• <b>Radierer:</b> Striche antippen zum Löschen</p>' });
  }
  return b;
}
function openBook() { return state.books.find(b => b.id === state.openBookId) || null; }
function currentPage() {
  const b = openBook(); if (!b) return null;
  return b.pages.find(p => p.id === state.openPageId) || b.pages[0] || null;
}
function touchBook() { const b = openBook(); if (b) b.updatedAt = Date.now(); }

/* ---------- Bibliothek ---------- */
function showLibrary() {
  $('viewLibrary').classList.add('active');
  $('viewBook').classList.remove('active');
  renderLibrary();
}
function openBookView(id, pageId) {
  state.openBookId = id;
  const b = openBook();
  state.openPageId = pageId || (b.pages[0] && b.pages[0].id);
  undoStack = []; redoStack = []; selectedBox = null; selectedImg = null;
  $('viewLibrary').classList.remove('active');
  $('viewBook').classList.add('active');
  $('bookTitle').value = b.title;
  $('paperSelect').value = b.paper || '';
  syncToolbar(); renderAll();
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
  persistNow(); renderLibrary();
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
function renameBook(v) { const b = openBook(); if (!b) return; b.title = v || 'Unbenannt'; touchBook(); persistSoon(); }
function setPaper(v) { const b = openBook(); if (!b) return; b.paper = v; touchBook(); persistSoon(); applyPaper(); }

function renderLibrary() {
  const q = ($('librarySearch').value || '').toLowerCase();
  const grid = $('libraryGrid');
  const books = state.books.filter(b => {
    if (!q) return true;
    if (b.title.toLowerCase().includes(q)) return true;
    return b.pages.some(p => p.texts.some(t => stripHtml(t.html).toLowerCase().includes(q)));
  });
  if (!books.length) {
    grid.innerHTML = '<div style="font-size:14px;opacity:.8">Keine Bücher gefunden. Lege oben ein neues Buch an.</div>';
    return;
  }
  grid.innerHTML = books.map(b => {
    const firstText = b.pages.flatMap(p => p.texts)[0];
    const preview = firstText ? esc(stripHtml(firstText.html).slice(0, 120)) : 'Leere Seiten – tippen zum Öffnen.';
    const strokes = b.pages.reduce((n, p) => n + p.strokes.length, 0);
    return '<div class="notebook-cover" onclick="openBookView(\'' + b.id + '\')">'
      + '<div class="notebook-spine"></div>'
      + '<div class="notebook-body">'
      + '<div class="notebook-title">' + esc(b.title) + '</div>'
      + '<div class="notebook-meta">' + b.pages.length + ' Seite(n) · ' + strokes + ' Striche · ' + new Date(b.updatedAt).toLocaleDateString('de-DE') + '</div>'
      + '<div class="notebook-preview">' + preview + '</div>'
      + '<div class="notebook-actions">'
      + '<button class="mini-button" onclick="exportBookJSON(\'' + b.id + '\',event)">Export</button>'
      + '<button class="mini-button" onclick="exportGoodNotes(\'' + b.id + '\',event)" aria-label="Buch als GoodNotes-Datei exportieren">📤 GoodNotes</button>'
      + '<button class="mini-button" onclick="duplicateBook(\'' + b.id + '\',event)">Duplizieren</button>'
      + '<button class="mini-button" onclick="deleteBook(\'' + b.id + '\',event)">Löschen</button>'
      + '</div></div></div>';
  }).join('');
}

/* ---------- Seiten ---------- */
function snapshot() {
  const p = currentPage(); if (!p) return;
  undoStack.push(JSON.stringify({ strokes: p.strokes, texts: p.texts, images: p.images, bg: p.bg || null }));
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
}
function restore(json) {
  const p = currentPage(); if (!p) return;
  const s = JSON.parse(json);
  p.strokes = s.strokes; p.texts = s.texts; p.images = s.images; p.bg = s.bg || null;
  selectedBox = null; selectedImg = null;
  touchBook(); persistSoon(); renderAll();
}
function undo() { if (!undoStack.length) return; const p = currentPage(); redoStack.push(JSON.stringify({ strokes: p.strokes, texts: p.texts, images: p.images })); restore(undoStack.pop()); redoStackFix(); }
function redoStackFix() { /* redoStack bereits gesetzt */ }
function redo() {
  if (!redoStack.length) return;
  const p = currentPage(); if (!p) return;
  undoStack.push(JSON.stringify({ strokes: p.strokes, texts: p.texts, images: p.images }));
  restore(redoStack.pop());
}
function addPage() {
  const b = openBook(); if (!b) return;
  snapshot();
  const p = newPage();
  const idx = b.pages.findIndex(x => x.id === state.openPageId);
  b.pages.splice(idx + 1, 0, p);
  state.openPageId = p.id;
  touchBook(); persistSoon(); renderAll();
}
function duplicatePage() {
  const b = openBook(); const p = currentPage(); if (!b || !p) return;
  snapshot();
  const copy = JSON.parse(JSON.stringify(p)); copy.id = uid();
  const idx = b.pages.findIndex(x => x.id === p.id);
  b.pages.splice(idx + 1, 0, copy);
  state.openPageId = copy.id;
  touchBook(); persistSoon(); renderAll();
}
function deletePage() {
  const b = openBook(); if (!b || b.pages.length <= 1) { alert('Die letzte Seite kann nicht gelöscht werden.'); return; }
  if (!confirm('Seite löschen?')) return;
  snapshot();
  const idx = b.pages.findIndex(x => x.id === state.openPageId);
  b.pages.splice(idx, 1);
  state.openPageId = b.pages[Math.max(0, idx - 1)].id;
  touchBook(); persistSoon(); renderAll();
}
function clearPage() {
  const p = currentPage(); if (!p) return;
  if (!confirm('Seite wirklich leeren?')) return;
  snapshot();
  p.strokes = []; p.texts = []; p.images = [];
  touchBook(); persistSoon(); renderAll();
}
function gotoPage(id) { state.openPageId = id; undoStack = []; redoStack = []; selectedBox = null; selectedImg = null; renderAll(); }

/* ---------- Seiten-Preview-Pop-up (Klick auf Mini-Thumbnail) ---------- */
let previewPageId = null;
function openPagePreview(id) {
  const b = openBook(); if (!b || !b.pages.length) return;
  previewPageId = id || state.openPageId;
  $('previewOverlay').classList.add('active');
  renderPreview();
}
function closePagePreview() {
  const o = $('previewOverlay');
  if (o) o.classList.remove('active');
  previewPageId = null;
}
function stepPreview(d) {
  const b = openBook(); if (!b || !b.pages.length) return;
  const idx = Math.max(0, b.pages.findIndex(p => p.id === previewPageId));
  previewPageId = b.pages[(idx + d + b.pages.length) % b.pages.length].id;
  renderPreview();
}
function openPreviewPage() {
  const id = previewPageId;
  closePagePreview();
  if (id) gotoPage(id);
}
function drawPreviewImg(g, src, x, y, w, h) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => { try { g.drawImage(img, x, y, w, h); } catch { /* ignore */ } res(); };
    img.onerror = res; img.src = src;
  });
}
async function renderPreview() {
  const b = openBook(); if (!b) return;
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
  syncToolbar(); renderTextLayer(); renderImgLayer();
  const names = { pen: '✒ Stift', marker: '🖍 Marker', eraser: '⌫ Radierer', text: 'T Text', move: '✥ Auswahl' };
  $('statusTool').textContent = names[t] || t;
  $('stage').style.cursor = t === 'text' ? 'text' : t === 'move' ? 'move' : 'crosshair';
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
  if (selectedBox) openTextEditorForBox(selectedBox, 'Textbox');
  else alert('Erst eine Textbox anklicken (Tool „T Text“ oder „✥ Auswahl“).');
}

/* ---------- Canvas ---------- */
function canvas() { return $('drawCanvas'); }
function ctx2d() { return canvas().getContext('2d'); }
function fitCanvas() {
  const c = canvas(), o = $('overlayCanvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  [c, o].forEach(x => { x.width = CANVAS_W * dpr; x.height = CANVAS_H * dpr; });
  c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  o.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
}
function stagePos(ev) {
  const r = $('stage').getBoundingClientRect();
  // Apple Pencil Pressure miterfassen (Fallback 0.5 bei 0/unbekannt: Hover, Maus, fehlende Sensorik)
  let p = 0.5;
  try {
    if (typeof GrimoirePencil !== 'undefined' && GrimoirePencil.normalizePressure) p = GrimoirePencil.normalizePressure(ev.pressure);
    else if (typeof ev.pressure === 'number' && ev.pressure > 0) p = Math.min(1, ev.pressure);
  } catch { /* Fallback 0.5 */ }
  return { x: (ev.clientX - r.left) / r.width * CANVAS_W, y: (ev.clientY - r.top) / r.height * CANVAS_H, nx: (ev.clientX - r.left) / r.width, ny: (ev.clientY - r.top) / r.height, p };
}
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
function renderCanvas() {
  fitCanvas();
  const c = ctx2d();
  c.clearRect(0, 0, CANVAS_W, CANVAS_H);
  const p = currentPage(); if (!p) return;
  p.strokes.forEach(s => drawStroke(c, s));
}
function previewStroke(points, color, size, toolName) {
  const o = $('overlayCanvas').getContext('2d');
  o.clearRect(0, 0, CANVAS_W, CANVAS_H);
  if (points && points.length) drawStroke(o, { tool: toolName, color, size, points });
}
// Apple Pencil Hover-Preview: Ghost-Kreis am Cursor, kein Zeichnen (nur pen-Hover, Stift/Marker).
function drawHoverPreview(pos) {
  const oc = $('overlayCanvas'); if (!oc) return;
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
  const oc = $('overlayCanvas'); if (!oc) return;
  oc.getContext('2d').clearRect(0, 0, CANVAS_W, CANVAS_H);
}
function distToStroke(pt, s, radius) {
  return s.points.some(q => Math.hypot(q.x - pt.x, q.y - pt.y) <= radius + s.size / 2);
}

function bindStage() {
  const stage = $('stage');
  const activePointers = new Set();
  stage.addEventListener('pointerdown', ev => {
    if ($('viewBook').classList.contains('active') === false) return;
    // SPEC-25: Zweit-/Dritt-Finger bricht laufende Ein-Finger-Zeichnung ab
    // (kein Commit), damit Zwei-/Drei-Finger-Tap kein Undo-Artefakt hinterlässt.
    if (ev.isPrimary === false) {
      activePointers.add(ev.pointerId);
      if (drawing && !drawing.erasing) {
        drawing = null;
        try { $('overlayCanvas').getContext('2d').clearRect(0, 0, CANVAS_W, CANVAS_H); } catch { /* ignore */ }
        undoStack.pop(); // eben genommener Snapshot war leer -> zurückrollen
      } else if (drawing) { drawing = null; }
      eraseTrail = null;
      return;
    }
    activePointers.add(ev.pointerId);
    const pos = stagePos(ev);
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
      drawHoverPreview(stagePos(ev));
      return;
    }
    if (!drawing) return;
    if (ev.isPrimary === false) return;
    const pos = stagePos(ev);
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
    $('overlayCanvas').getContext('2d').clearRect(0, 0, CANVAS_W, CANVAS_H);
  };
  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', finish);
}
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
function bindTapGestures() {
  const stage = $('stage');
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

/* ---------- Text- & Bild-Layer ---------- */
function renderTextLayer() {
  const layer = $('textLayer');
  const p = currentPage(); if (!p) { layer.innerHTML = ''; return; }
  layer.innerHTML = '';
  p.texts.forEach(t => {
    const d = document.createElement('div');
    d.className = 'text-box' + (t.id === selectedBox ? ' selected' : '');
    d.style.left = (t.x * 100) + '%';
    d.style.top = (t.y * 100) + '%';
    d.style.maxWidth = '86%';
    // Textfeld-Upgrade: gespeicherter Box-Stil (Default-Stil) als Inline-Style;
    // Altboxen ohne Felder rendern unverändert per CSS.
    if (t.fontSize) d.style.fontSize = t.fontSize + 'px';
    if (t.color) d.style.color = t.color;
    if (t.align) d.style.textAlign = t.align;
    d.innerHTML = t.html;
    d.onclick = e => { e.stopPropagation(); selectedBox = t.id; selectedImg = null; renderTextLayer(); renderImgLayer(); };
    d.ondblclick = e => { e.stopPropagation(); openTextEditorForBox(t.id, 'Textbox'); };
    if (tool === 'move' || tool === 'text') makeDraggable(d, t, 'text');
    layer.appendChild(d);
  });
}
function renderImgLayer() {
  const layer = $('imgLayer');
  const p = currentPage(); if (!p) { layer.innerHTML = ''; return; }
  layer.innerHTML = '';
  p.images.forEach(im => {
    const d = document.createElement('div');
    d.className = 'img-item' + (im.id === selectedImg ? ' selected' : '');
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
    h.onpointerdown = e => { e.stopPropagation(); e.preventDefault(); startResize(e, im); };
    d.appendChild(h);
    d.onclick = e => { e.stopPropagation(); selectedImg = im.id; selectedBox = null; renderImgLayer(); renderTextLayer(); };
    d.ondblclick = e => { e.stopPropagation(); if (confirm('Bild entfernen?')) { snapshot(); p.images = p.images.filter(x => x.id !== im.id); selectedImg = null; touchBook(); persistSoon(); renderAll(); } };
    if (tool === 'move') makeDraggable(d, im, 'img');
    layer.appendChild(d);
  });
}
function makeDraggable(el, obj, kind) {
  el.onpointerdown = e => {
    if (tool !== 'move' && !(kind === 'text' && tool === 'text')) return;
    if (e.target.classList && e.target.classList.contains('img-handle')) return;
    e.preventDefault();
    const stage = $('stage').getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY, ox = obj.x, oy = obj.y;
    if (kind === 'text') { selectedBox = obj.id; renderTextLayer(); return dragText(e, obj, stage, startX, startY, ox, oy); }
    selectedImg = obj.id; renderImgLayer();
    const move = me => { obj.x = Math.min(.95, Math.max(0, ox + (me.clientX - startX) / stage.width)); obj.y = Math.min(.95, Math.max(0, oy + (me.clientY - startY) / stage.height)); el.style.left = obj.x * 100 + '%'; el.style.top = obj.y * 100 + '%'; };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); touchBook(); persistSoon(); };
    snapshotOnceDrag();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
}
let dragSnapshotTaken = false;
function snapshotOnceDrag() { if (!dragSnapshotTaken) { snapshot(); dragSnapshotTaken = true; setTimeout(() => dragSnapshotTaken = false, 0); } }
function dragText(e, obj, stage, startX, startY, ox, oy) {
  snapshotOnceDrag();
  const el = e.currentTarget;
  const move = me => { obj.x = Math.min(.9, Math.max(0, ox + (me.clientX - startX) / stage.width)); obj.y = Math.min(.95, Math.max(0, oy + (me.clientY - startY) / stage.height)); el.style.left = obj.x * 100 + '%'; el.style.top = obj.y * 100 + '%'; };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); touchBook(); persistSoon(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
function startResize(e, im) {
  const stage = $('stage').getBoundingClientRect();
  const startX = e.clientX, ow = im.w;
  snapshot();
  const move = me => { im.w = Math.min(.95, Math.max(.05, ow + (me.clientX - startX) / stage.width)); renderImgLayer(); };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); touchBook(); persistSoon(); renderImgLayer(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
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
        const idx = book.pages.findIndex(x => x.id === state.openPageId);
        book.pages.splice(idx + 1, 0, page);
        if (jump) state.openPageId = page.id;
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
    if (first) { state.openPageId = first; renderAll(); }
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
  const insertAfterIdx = () => book.pages.findIndex(x => x.id === state.openPageId);
  // Offline-Fallback: pdf.js gar nicht ladbar -> eine Hinweis-Seite statt N Seiten.
  if (!total) {
    const page = (typeof PagesImport !== 'undefined' && PagesImport.buildNewPageModel)
      ? (() => { const m = PagesImport.buildNewPageModel({}); m.id = uid(); return { id: m.id, strokes: [], texts: [], images: [], bg: null }; })()
      : newPage();
    page.texts.push({ id: uid(), x: 0.06, y: 0.015, html: fallbackHtml(null) });
    book.pages.splice(insertAfterIdx() + 1, 0, page);
    createdIds.push(page.id);
    state.openPageId = page.id;
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
  if (firstNewId.v) state.openPageId = firstNewId.v;
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

/* ---------- Rail / Status / Paper ---------- */
function renderRail() {
  const rail = $('pageRail');
  const b = openBook(); if (!b) return;
  rail.innerHTML = '';
  b.pages.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'page-thumb' + (p.id === state.openPageId ? ' selected' : '');
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
    d.title = 'Vorschau öffnen';
    d.onclick = () => openPagePreview(p.id);
    rail.appendChild(d);
  });
  const idx = b.pages.findIndex(p => p.id === state.openPageId);
  $('statusPage').textContent = 'Seite ' + (idx + 1) + '/' + b.pages.length;
}
function applyPaper() {
  const b = openBook();
  const st = $('stage');
  st.classList.remove('lined', 'grid');
  if (b && b.paper) st.classList.add(b.paper);
}
function applyBg() {
  const p = currentPage();
  const bg = $('bgLayer');
  if (!bg) return;
  let src = (p && p.bg) || null;
  if (src && typeof GrimoireStore !== 'undefined') src = GrimoireStore.url(src) || null;
  bg.style.backgroundImage = src ? 'url("' + src + '")' : 'none';
}
function clearPageBg() {
  const p = currentPage(); if (!p || !p.bg) return;
  snapshot();
  p.bg = null;
  touchBook(); persistSoon(); renderAll();
}
function renderAll() { applyPaper(); applyBg(); renderCanvas(); renderTextLayer(); renderImgLayer(); renderRail(); }

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
    if (state.openBookId === bookId && state.openPageId === pageId) renderAll();
    else if (state.openBookId === bookId) renderRail();
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

/* ---------- Init (async: IndexedDB + Legacy-Migration) ---------- */
window.addEventListener('resize', () => { if (openBook()) renderCanvas(); });
bindStage();
bindTapGestures();
if (typeof GrimoireStore !== 'undefined') {
  // Blob-URLs trudeln asynchron ein -> sichtbare Ebenen nachrendern
  GrimoireStore.subscribe(() => {
    if ($('viewBook') && $('viewBook').classList.contains('active')) { renderImgLayer(); applyBg(); }
  });
}
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
  if (state.openBookId && openBook()) openBookView(state.openBookId, state.openPageId);
  else showLibrary();
  setTool('pen');
  if (migrated) setSaveStatus('💾 gespeichert (☁ ' + migrated + ' Bild(er) in Bildspeicher migriert)');
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
