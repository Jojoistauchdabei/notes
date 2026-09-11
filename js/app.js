/* Grimoire – GoodNotes-Klon im DND-Stil. LocalStorage, kein Server. */
const LS_KEY = 'grimoire-dnd-v1';
const CANVAS_W = 1000, CANVAS_H = 1294;

let state = { books: [], openBookId: null, openPageId: null };
let tool = 'pen', penColor = '#2a1a0e', penSize = 3;
let undoStack = [], redoStack = [];
let drawing = null, selectedBox = null, selectedImg = null;
let saveTimer = null;

const $ = id => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stripHtml = h => { const d = document.createElement('div'); d.innerHTML = h || ''; return d.textContent || ''; };

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
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    setSaveStatus('💾 gespeichert');
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
function newPage() { return { id: uid(), strokes: [], texts: [], images: [] }; }
function newBook(title, withStarter) {
  const b = { id: uid(), title: title || 'Neues Buch', paper: '', updatedAt: Date.now(), pages: [newPage()] };
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
      + '<button class="mini-button" onclick="duplicateBook(\'' + b.id + '\',event)">Duplizieren</button>'
      + '<button class="mini-button" onclick="deleteBook(\'' + b.id + '\',event)">Löschen</button>'
      + '</div></div></div>';
  }).join('');
}

/* ---------- Seiten ---------- */
function snapshot() {
  const p = currentPage(); if (!p) return;
  undoStack.push(JSON.stringify({ strokes: p.strokes, texts: p.texts, images: p.images }));
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
}
function restore(json) {
  const p = currentPage(); if (!p) return;
  const s = JSON.parse(json);
  p.strokes = s.strokes; p.texts = s.texts; p.images = s.images;
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
  return { x: (ev.clientX - r.left) / r.width * CANVAS_W, y: (ev.clientY - r.top) / r.height * CANVAS_H, nx: (ev.clientX - r.left) / r.width, ny: (ev.clientY - r.top) / r.height };
}
function drawStroke(c, s) {
  if (!s.points.length) return;
  c.save();
  c.strokeStyle = s.color;
  c.lineWidth = s.size;
  c.lineCap = 'round'; c.lineJoin = 'round';
  if (s.tool === 'marker') c.globalAlpha = 0.35;
  c.beginPath();
  c.moveTo(s.points[0].x, s.points[0].y);
  for (let i = 1; i < s.points.length; i++) c.lineTo(s.points[i].x, s.points[i].y);
  if (s.points.length === 1) { c.fillStyle = s.color; c.arc(s.points[0].x, s.points[0].y, s.size / 2, 0, 7); c.fill(); }
  else c.stroke();
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
function distToStroke(pt, s, radius) {
  return s.points.some(q => Math.hypot(q.x - pt.x, q.y - pt.y) <= radius + s.size / 2);
}

function bindStage() {
  const stage = $('stage');
  stage.addEventListener('pointerdown', ev => {
    if ($('viewBook').classList.contains('active') === false) return;
    const pos = stagePos(ev);
    const p = currentPage(); if (!p) return;
    if (tool === 'pen' || tool === 'marker') {
      snapshot();
      stage.setPointerCapture(ev.pointerId);
      drawing = { tool, color: penColor, size: tool === 'marker' ? penSize * 3 : penSize, points: [{ x: pos.x, y: pos.y }] };
      previewStroke(drawing.points, drawing.color, drawing.size, drawing.tool);
    } else if (tool === 'eraser') {
      snapshot();
      drawing = { erasing: true };
      eraseAt(pos);
      stage.setPointerCapture(ev.pointerId);
    } else if (tool === 'text') {
      const el = ev.target.closest('.text-box');
      if (el) return; // Klick auf Box wird dort behandelt
      snapshot();
      const box = { id: uid(), x: pos.nx, y: pos.ny, html: 'Neuer Text – doppelklicken für Editor' };
      p.texts.push(box);
      selectedBox = box.id;
      touchBook(); persistSoon(); renderTextLayer();
    }
  });
  stage.addEventListener('pointermove', ev => {
    if (!drawing) return;
    const pos = stagePos(ev);
    if (drawing.erasing) { eraseAt(pos); return; }
    drawing.points.push({ x: pos.x, y: pos.y });
    previewStroke(drawing.points, drawing.color, drawing.size, drawing.tool);
  });
  const finish = () => {
    if (!drawing) return;
    const p = currentPage();
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
  const before = p.strokes.length;
  p.strokes = p.strokes.filter(s => !distToStroke(pos, s, 12));
  if (p.strokes.length !== before) { touchBook(); persistSoon(); renderCanvas(); renderRail(); }
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
    img.src = im.src; img.draggable = false;
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
  const f = ev.target.files && ev.target.files[0]; if (!f) return;
  const p = currentPage(); if (!p) return;
  const img = new Image();
  img.onload = () => {
    const max = 800;
    const sc = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    snapshot();
    p.images.push({ id: uid(), x: 0.15, y: 0.25, w: 0.5, src: c.toDataURL('image/jpeg', 0.85) });
    touchBook(); persistSoon(); renderImgLayer();
    setTool('move');
  };
  img.src = URL.createObjectURL(f);
  ev.target.value = '';
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
    c.width = 140; c.height = 182;
    const g = c.getContext('2d');
    g.fillStyle = '#fffdf6'; g.fillRect(0, 0, 140, 182);
    g.save(); g.scale(140 / CANVAS_W, 182 / CANVAS_H);
    p.strokes.forEach(s => drawStroke(g, s));
    g.restore();
    const label = document.createElement('div');
    label.className = 'thumb-label';
    label.textContent = 'Seite ' + (i + 1);
    d.appendChild(c); d.appendChild(label);
    d.onclick = () => gotoPage(p.id);
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
function renderAll() { applyPaper(); renderCanvas(); renderTextLayer(); renderImgLayer(); renderRail(); }

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
  download('grimoire-export.json', JSON.stringify(state, null, 2));
}
function exportBookJSON(id, ev) {
  if (ev) ev.stopPropagation();
  const b = state.books.find(x => x.id === id); if (!b) return;
  download('grimoire-' + (b.title || 'buch').replace(/[^\wäöüÄÖÜß-]+/gi, '_') + '.json', JSON.stringify(b, null, 2));
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
    r.onload = () => {
      try {
        const p = JSON.parse(r.result);
        const books = Array.isArray(p) ? p.map(normalizeBook).filter(Boolean)
          : (p.books ? p.books.map(normalizeBook).filter(Boolean)
          : (normalizeBook(p) ? (Array.isArray(normalizeBook(p)) ? normalizeBook(p) : [normalizeBook(p)]) : []));
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
async function buildBookFromGN(doc, fileName) {
  const DPI = 132 / 72;
  const book = { id: uid(), title: doc.title || fileName.replace(/\.goodnotes$/i, ''), paper: '', updatedAt: Date.now(), pages: [] };
  for (const pg of doc.pages) {
    const m = GoodNotes.mapPage(pg);
    const page = { id: uid(), strokes: m.strokes, texts: [], images: [] };
    const iw = pg.dim.w * DPI, ih = pg.dim.h * DPI;
    const sc = 1000 / iw, offY = (1294 - ih * sc) / 2;
    for (const im of pg.images) {
      const dataUrl = await gnImageToDataURL(im.bytes, im.mime);
      if (!dataUrl) continue;
      page.images.push({
        id: uid(),
        x: Math.round((im.ie.x * sc) / 1000 * 10000) / 10000,
        y: Math.round((im.ie.y * sc + offY) / 1294 * 10000) / 10000,
        w: Math.round((im.ie.w * sc) / 1000 * 10000) / 10000,
        src: dataUrl
      });
    }
    book.pages.push(page);
  }
  if (!book.pages.length) book.pages.push(newPage());
  if (doc.stats.pdfBg && book.pages.length) {
    book.pages[0].texts.push({ id: uid(), x: 0.06, y: 0.015, html: '<p><i>GoodNotes-Import: PDF-Hintergrund des Originals nicht übernommen.</i></p>' });
  }
  return book;
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
      const book = await buildBookFromGN(doc, f.name);
      const nStrokes = book.pages.reduce((n, p) => n + p.strokes.length, 0);
      const nImg = book.pages.reduce((n, p) => n + p.images.length, 0);
      state.books.unshift(book);
      persistNow();
      ok.push('• ' + book.title + ' (' + book.pages.length + ' S., ' + nStrokes + ' Striche, ' + nImg + ' Bilder)');
    } catch (err) {
      console.warn('GoodNotes-Import fehlgeschlagen:', f.name, err);
      fail.push('• ' + f.name);
    }
  }
  renderLibrary(); showLibrary();
  let msg = ok.length ? ok.length + ' Dokument(e) importiert:\n' + ok.join('\n') : 'Nichts importiert.';
  msg += '\n\nv1-Limits: Shapes und getippte Textboxen werden noch nicht übernommen.';
  if (fail.length) msg += '\nFehlgeschlagen:\n' + fail.join('\n');
  alert(msg);
}
function exportPagePNG() {
  const p = currentPage(); if (!p) return;
  const c = document.createElement('canvas');
  c.width = CANVAS_W; c.height = CANVAS_H;
  const g = c.getContext('2d');
  g.fillStyle = '#fffdf6'; g.fillRect(0, 0, CANVAS_W, CANVAS_H);
  const jobs = p.images.map(im => new Promise(res => {
    const img = new Image();
    img.onload = () => { g.drawImage(img, im.x * CANVAS_W, im.y * CANVAS_H, im.w * CANVAS_W, img.height * (im.w * CANVAS_W / img.width)); res(); };
    img.onerror = res; img.src = im.src;
  }));
  Promise.all(jobs).then(() => {
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
  });
}

/* ---------- Init ---------- */
window.addEventListener('resize', () => { if (openBook()) renderCanvas(); });
load();
bindStage();
renderLibrary();
if (state.openBookId && openBook()) openBookView(state.openBookId, state.openPageId);
else showLibrary();
setTool('pen');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
