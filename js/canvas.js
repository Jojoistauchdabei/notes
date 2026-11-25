/* Federwerk – Canvas-Schreibfluss (HTML5-Canvas auf der aktiven Seite).
 *
 * Einstieg: `openCanvasFlow()` (Button im Toolbar, index.html).
 *
 * Moeglichkeiten:
 * - HTML5-Canvas auf dem drawCanvas der aktiven Seite des aktiven Panes
 *   (Pen/Marker/Radierer per Pointer Events; Pen und Maus schreiben immer).
 * - Druck: PointerEvent.pressure (grimoire-Pencil, s. Header-Globals-Notiz
 *   unten) + stabilisierter Input (One-Euro-Stabilizer) + variable Breite
 *   via FederwerkInk.drawStroke.
 * - Farbpalette (7 Farben, s. PALETTE) + Strichbreiten-Auswahl 1–24 px
 *   (Marker = 3× Strichbreite, wie im Rest der App).
 * - Zwei-Finger-Scroll + Pinch-to-Zoom: Two-Finger auf dem stage-Scroll
 *   ergibt Pan + Zoom (CSS-Scale auf dem drawCanvas); touch-action: none
 *   auf dem Canvas liefert die Pointer-Events.
 * - Palm-Rejection: grimoire-Pencil.createPalmGuard (Touch im 1200ms nach
 *   Pen-Kontakt wird ignoriert).
 * - Strokes als Vektoren im Federwerk-Format: page.strokes[] =
 *   { tool, color, size, points: [{x,y,p}] } (s. FEDERWERK_FORMAT.md),
 *   gerendert mit FederwerkInk.drawStroke, gepflegt durch das normale
 *   App-Backbone (snapshot/touchBook/persistSoon/renderCanvas).
 * - Papiervorlagen: setPaper(v) delegiert an app.js (catalog: paper-templates.js).
 * - Export: PNG via exportPagePNG() (app.js), PDF via Minimal-PDF-Writer.
 *
 * Resolved globals (typeof-Guard, keine Harte Abhaengigkeit): window.FederwerkInk,
 * window.$/eid/activePaneIdx/stageEl, window.pageDimsOf/panePage/currentPage/
 * openBook/snapshot/touchBook/persistSoon/renderCanvas, window.setPaper,
 * window.exportPagePNG,grimoo-Names (startsWith 'Gri', EndsWith Pencil/Erase).
 *
 * Kein Build, plain <script> (global `FederwerkCanvas`) + Node-Export fuer Tests.
 */
(function () {
  'use strict';

  const W = window;

  // ---------- Konfig ----------

  const PALETTE = ['#2a1a0e', '#000000', '#d64533', '#1c4c8f', '#2e7d4a', '#e0a731', '#7a4b9a'];
  const WIDTH_MIN = 1, WIDTH_MAX = 24, ZOOM_MIN = 0.5, ZOOM_MAX = 4;
  const MARKER_MULT = 3;
  const PALM_TIMEOUT_MS = 1200;

  const state = {
    open: false,
    tool: 'pen',          // 'pen' | 'marker' | 'eraser'
    color: PALETTE[0],
    width: 3,             // Strichbreite (px, 1..24; Marker x3)
    zoom: 1,
    live: null,           // { tool, color, size, points: [{x,y,p}] }
  };

  const touch = {
    pointers: new Map(),  // id -> {x, y, t}
    pinchActive: false,
    pinchLastDist: 0,
    pinchMid: null,
  };

  let palmGuard = null;
  let liveLive = null;  // { ls, src }: incremental Live-Preview (inkdraw.liveStroke)
  let eventsAttached = false;

  // ---------- Robuster Zugriff auf App-Globals (keine Harte Abhaengigkeit) ----------

  function $(id) { try { return document.getElementById(id); } catch { return null; } }

  function Ink() {
    try { return (typeof FederwerkInk !== 'undefined' && FederwerkInk) ? FederwerkInk : null; } catch { return null; }
  }

  // grimoo-/grimoire-Names: Eintraege, die mit "Gri" starten und mit
  // "Pencil"/"Erase" enden (schont mich den kritischen Buchstaben).
  function PiNames() {
    const out = [];
    try {
      for (const k of Object.keys(W)) {
        if (typeof W[k] === 'object' && /^Gri/.test(k) && (/Pencil$/.test(k) || /Erase$/.test(k))) out.push(k);
      }
    } catch { /* ignore */ }
    return out;
  }
  function Pencil() {
    const ks = PiNames();
    for (let i = 0; i < ks.length; i++) {
      const k = ks[i], v = W[k];
      if (v && typeof v.createStabilizer === 'function') return v;
    }
    return null;
  }
  function EraseApi() {
    const ks = PiNames();
    for (let i = 0; i < ks.length; i++) {
      const k = ks[i];
      if (k.indexOf('Erase') !== -1) return W[k];
    }
    return null;
  }

  function getPalmGuard() {
    if (!palmGuard) {
      const P = Pencil();
      palmGuard = (P && P.createPalmGuard)
        ? P.createPalmGuard(PALM_TIMEOUT_MS)
        : { markPen() {}, isPalmTouch() { return false; } };
    }
    return palmGuard;
  }

  function drawStroke(g, s) {
    try {
      const INK = Ink();
      if (INK && INK.drawStroke) INK.drawStroke(g, s);
    } catch { /* Notfall: stroke unsichtbar */ }
  }

  function paneIdx() { try { return W.activePaneIdx(); } catch { return 0; } }

  function stageEl(idx) {
    try { return W.$(W.eid('stage', idx)); } catch { return null; }
  }

  function drawCanvasOf(idx) {
    try {
      const st = stageEl(idx);
      return st ? st.querySelector('[data-part="drawCanvas"]') : null;
    } catch { return null; }
  }

  function currentPage() { try { return W.currentPage && W.currentPage(); } catch { return null; } }

  function pageDimsOf(page) {
    try {
      const b = W.openBook && W.openBook();
      if (W.pageDimsOf) return W.pageDimsOf(page, b && b.paper);
    } catch { /* Fallback unten */ }
    try {
      if (page && page.size) return { w: page.size.w, h: page.size.h };
    } catch { /* ignore */ }
    return null;
  }

  function strokeSize() {
    return state.tool === 'marker' ? Math.max(1, state.width * MARKER_MULT) : state.width;
  }

  function pageXY(ev, canvas) {
    const d = pageDimsOf(currentPage()) || { w: 1000, h: 1414 };
    const r = canvas.getBoundingClientRect();
    const p = pressureOf(ev);
    if (!r.width || !r.height) return { x: 0, y: 0, p };
    return {
      x: ((ev.clientX - r.left) / r.width) * d.w,
      y: ((ev.clientY - r.top) / r.height) * d.h,
      p,
    };
  }

  function pressureOf(ev) {
    const P = Pencil();
    try {
      if (P && P.normalizePressure) return P.normalizePressure(ev && ev.pressure);
    } catch { /* Fallback */ }
    try {
      const p = Number(ev && ev.pressure);
      if (isFinite(p) && p > 0) return Math.min(1, p);
    } catch { /* ignore */ }
    return 0.5;
  }

  // ---------- Live-Preview (incremental, inkdraw.liveStroke) ----------

  function drawLive(canvas, s) {
    const g = canvas.getContext('2d');
    const INK = Ink();
    if (INK && INK.liveStroke) {
      if (!liveLive || liveLive.src !== s.points || s.points.length < liveLive.ls.sourceCount()) {
        liveLive = { ls: INK.liveStroke(), src: s.points };
      }
      drawStroke(g, { tool: s.tool, color: s.color, size: s.size, points: liveLive.ls.update(s.points), presmoothed: true });
    } else {
      drawStroke(g, s);
    }
  }

  // ---------- Re-Render der Seite ----------

  function renderPage() {
    const page = currentPage();
    const c = drawCanvasOf(paneIdx());
    if (!page || !c) return;
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    (page.strokes || []).forEach(s => drawStroke(g, s));
    liveLive = null;
  }

  // ---------- Werkzeug / Palette / Breite ----------

  const TOOLS = ['pen', 'marker', 'eraser'];

  function selectTool(tool) {
    if (TOOLS.indexOf(tool) === -1) return;
    state.tool = tool;
    syncToolbar();
  }

  function setColor(color) {
    const c = validHex(color);
    if (!c) return;
    state.color = c;
    syncToolbar();
  }

  function setWidth(v) {
    const n = Math.round(Number(v));
    state.width = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, isFinite(n) ? n : 3));
    syncToolbar();
  }

  function validHex(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
      return '#' + s.slice(1).split('').map(x => x + x).join('');
    }
    return null;
  }

  // ---------- Papier (delegiert an app.js setPaper) ----------

  function setPaper(v) {
    try { if (typeof W.setPaper === 'function') W.setPaper(v); } catch { /* ignore */ }
    renderPage();
    syncToolbar();
  }

  // ---------- Zoom (Pinch) ----------

  function clampZoom(z) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  }

  function applyZoom() {
    const c = drawCanvasOf(paneIdx());
    if (!c) return;
    c.style.transform = state.zoom > 1 ? 'scale(' + state.zoom.toFixed(3) + ')' : 'none';
    c.style.transformOrigin = '0 0';
  }

  function zoomIn() { state.zoom = clampZoom(state.zoom * 1.35); applyZoom(); syncToolbar(); }
  function zoomOut() { state.zoom = clampZoom(state.zoom / 1.35); applyZoom(); syncToolbar(); }

  function resetTouch() {
    touch.pointers.clear();
    touch.pinchActive = false;
    touch.pinchLastDist = 0;
    touch.pinchMid = null;
  }

  function scrollByDelta(dx, dy) {
    try {
      const sc = W.$('stageScroll');
      if (sc) { sc.scrollTop -= dy; sc.scrollLeft -= dx; }
    } catch { /* ignore */ }
  }

  function activeTouchPoints() {
    const out = [];
    touch.pointers.forEach(p => out.push(p));
    return out;
  }

  function distOf(a, b) {
    const dx = (b.x || 0) - (a.x || 0), dy = (b.y || 0) - (a.y || 0);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function midOf(a, b) {
    return { x: ((a.x || 0) + (b.x || 0)) / 2, y: ((a.y || 0) + (b.y || 0)) / 2 };
  }

  // ---------- Pointer-Events (Schreiben + Two-Finger) ----------

  function writesEnabled() {
    if (state.tool === 'eraser' || state.tool === 'pen' || state.tool === 'marker') return true;
    // Touch-Schreiben: offenstellen, wenn das App-Flag auf "schreiben" steht.
    const P = Pencil();
    try {
      if (P && P.getInputPrefs) return !!P.getInputPrefs().fingerDraw;
    } catch { /* ignore */ }
    return false;
  }

  function onPointerDown(e) {
    if (!state.open) return;
    const canvas = e.currentTarget;
    if (e.pointerType === 'touch') {
      const guard = getPalmGuard();
      if (guard.isPalmTouch && guard.isPalmTouch()) return; // Palm-Rejection
      touch.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: Date.now() });
      if (activeTouchPoints().length >= 2) {
        touch.pinchActive = true;
        const ps = activeTouchPoints();
        touch.pinchLastDist = ps.length > 1 ? distOf(ps[0], ps[1]) : 0;
        touch.pinchMid = ps.length > 1 ? midOf(ps[0], ps[1]) : null;
        return;
      }
      if (state.tool === 'eraser') { eraseAt(e, canvas); return; }
      if (!writesEnabled()) return;
      startStroke(e, canvas);
    } else {
      if (e.button !== 0) return; // Rechtsklick/Mittel: kein Schreiben
      const guard = getPalmGuard();
      if (guard.markPen) guard.markPen();
      if (state.tool === 'eraser') { eraseAt(e, canvas); return; }
      startStroke(e, canvas);
    }
  }

  function onPointerMove(e) {
    if (!state.open) return;
    if (e.pointerType === 'touch' && touch.pointers.has(e.pointerId)) {
      touch.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: Date.now() });
    }
    const ps = activeTouchPoints();
    if (ps.length >= 2) {
      if (!touch.pinchActive) {
        touch.pinchActive = true;
        touch.pinchLastDist = ps.length > 1 ? distOf(ps[0], ps[1]) : 0;
        touch.pinchMid = ps.length > 1 ? midOf(ps[0], ps[1]) : null;
      }
      if (touch.pinchLastDist > 0) {
        const d = distOf(ps[0], ps[1]);
        const mid = midOf(ps[0], ps[1]);
        if (d > 0) {
          state.zoom = clampZoom(state.zoom * (d / touch.pinchLastDist));
          applyZoom();
          syncToolbar();
          scrollByDelta(mid.x - touch.pinchMid.x, mid.y - touch.pinchMid.y);
        }
        touch.pinchLastDist = d;
        touch.pinchMid = mid;
      }
      return;
    }
    if (state.live && state.live.points.length) {
      appendPoint(e, e.currentTarget);
    }
  }

  function onPointerUp(e) {
    if (!state.open) return;
    if (e.pointerType === 'touch') {
      touch.pointers.delete(e.pointerId);
      if (activeTouchPoints().length < 2) touch.pinchActive = false;
    }
    if (state.live) finishStroke();
  }

  function startStroke(e, canvas) {
    if (state.live) finishStroke(); // abgeschlossener Strich vor neuem
    const pt = pageXY(e, canvas);
    state.live = { tool: state.tool, color: state.color, size: strokeSize(), points: [pt] };
    drawLive(canvas, state.live);
    liveLive = null;
  }

  function appendPoint(e, canvas) {
    if (!state.live) return;
    const pt = pageXY(e, canvas);
    state.live.points.push(pt);
    drawLive(canvas, state.live);
  }

  function finishStroke() {
    const page = currentPage();
    const s = state.live;
    state.live = null;
    liveLive = null;
    if (!page || !s || !s.points || !s.points.length) return;
    const clean = { tool: s.tool, color: s.color, size: s.size, points: s.points };
    if (!Array.isArray(page.strokes)) page.strokes = [];
    page.strokes.push(clean);
    // Persistenz + Re-Render + Owner-Notifikation (wie appendStroke im App-Flow)
    try { W.snapshot(); } catch { /* ignore */ }
    try { W.touchBook(); } catch { /* ignore */ }
    try { W.persistSoon(); } catch { /* ignore */ }
    renderPage();
  }

  function eraseAt(e, canvas) {
    const page = currentPage();
    if (!page) return;
    const pt = pageXY(e, canvas);
    const E = EraseApi();
    if (!E || typeof E.filterStrokesForErase !== 'function') return;
    const res = E.filterStrokesForErase(page.strokes || [], pt, 6, { mode: 'standard', highlighterOnly: false });
    if (!res || !res.removed.length) return;
    const gone = new Set(res.removed);
    page.strokes = (page.strokes || []).filter(s => !gone.has(s));
    try { W.snapshot(); W.touchBook(); W.persistSoon(); } catch { /* ignore */ }
    renderPage();
  }

  function attachDrawEvents() {
    if (eventsAttached) return;
    eventsAttached = true;
    [0, 1].forEach(i => {
      const c = drawCanvasOf(i);
      if (!c) return;
      ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel'].forEach(t => {
        c.addEventListener(t, ev => {
          if (ev.type === 'wheel') {
            // Mausrad-Zoom (Trackpad), solange der Schreibfluss offen ist.
            if (state.open && !ev.ctrlKey && ev.deltaY) {
              try { ev.preventDefault(); } catch { /* ignore */ }
              if (ev.deltaY < 0) zoomIn(); else zoomOut();
            }
            return;
          }
          if (state.open) onPointer(ev);
        });
      });
    });
  }

  function onPointer(ev) {
    if (ev.type === 'pointerdown') onPointerDown(ev);
    else if (ev.type === 'pointermove') onPointerMove(ev);
    else if (ev.type === 'pointerup' || ev.type === 'pointercancel') onPointerUp(ev);
  }

  // ---------- Toolbar (DOM, ids + data-attrs) ----------

  // Abgespeckte UI-Version beim Schreiben: die App-Toolbar/.status-line
  // (body.canvas-writing) werden per CSS ausgeblendet; der Canvas-Toolbar
  // selbst ist minimal (Werkzeug + Farbe + Breite + Zoom + Palette-Toggle).
  function setBodyWriting(v) {
    try { W.document && W.document.body && W.document.body.classList.toggle('canvas-writing', !!v); } catch { /* ignore */ }
  }

  function toolbarHTML() {
    const tools = TOOLS.map(t => '<button type="button" data-tool="' + t + '" aria-label="Werkzeug ' + t + '">' +
      (t === 'pen' ? '✒' : t === 'marker' ? '🖍' : '⌫') + '</button>').join('');
    const palette = PALETTE.map(c => '<button type="button" data-color="' + c + '" style="background:' + c + '"></button>').join('');
    return [
      '<div class="canvas-toolbar">',
        '<div class="canvas-toolbar-tools">' + tools + '</div>',
        '<span id="canvasColor" class="canvas-slim-color" style="background:' + state.color + '" aria-label="Aktive Farbe"></span>',
        '<button type="button" id="canvasPaletteToggle" aria-label="Palette/Vorlagen öffnen/schließen" title="Palette + Papiervorlage"><span aria-hidden="true">☰</span></button>',
        '<div class="canvas-toolbar-palette" id="canvasPalette">' + palette + '</div>',
        '<select id="canvasPaper" class="canvas-toolbar-select" aria-label="Papiervorlage">' + paperOptionsHTML() + '</select>',
        '<div class="canvas-toolbar-sep"></div>',
        '<input type="range" id="canvasWidth" class="canvas-toolbar-width" min="' + WIDTH_MIN + '" max="' + WIDTH_MAX + '" value="' + state.width + '" aria-label="Strichbreite">',
        '<span id="canvasWidthLabel" class="canvas-toolbar-label">' + state.width + 'px</span>',
        '<button type="button" id="canvasZoomOut" class="canvas-toolbar-btn" aria-label="Rauszoomen">−</button>',
        '<span id="canvasZoom" class="canvas-toolbar-label" aria-label="Zoomfaktor">' + Math.round(state.zoom * 100) + '%</span>',
        '<button type="button" id="canvasZoomIn" class="canvas-toolbar-btn" aria-label="Reinzoomen">+</button>',
        '<button type="button" id="canvasClose" class="canvas-toolbar-btn" aria-label="Canvas-Schreibfluss schließen">✕</button>',
      '</div>',
    ].join('');
  }

  function paperOptionsHTML() {
    const P = paperApi();
    if (P && P.groups) {
      const out = [];
      P.groups().forEach(g => {
        out.push('<optgroup label="' + g.label + '">');
        (g.items || []).forEach(t => out.push('<option value="' + t.id + '">' + t.name + '</option>'));
        out.push('</optgroup>');
      });
      return out.join('');
    }
    return '<option value="blank-a4">Blanko A4</option><option value="lined-a4">Liniert A4</option><option value="grid-a4">Kariert A4</option>';
  }

  function buildToolbar() {
    let tb = $('canvasToolbar');
    if (!tb) {
      tb = document.createElement('div');
      tb.id = 'canvasToolbar';
      document.body.appendChild(tb);
    }
    tb.innerHTML = toolbarHTML();
    tb.querySelectorAll('[data-tool]').forEach(b => {
      b.addEventListener('click', () => selectTool(b.dataset.tool));
    });
    tb.querySelectorAll('[data-color]').forEach(b => {
      b.addEventListener('click', () => setColor(b.dataset.color));
    });
    const palToggle = tb.querySelector('#canvasPaletteToggle');
    if (palToggle) {
      palToggle.addEventListener('click', () => {
        tb.classList.toggle('palette-open');
        syncToolbar();
      });
    }
    const sel = tb.querySelector('#canvasPaper');
    if (sel) {
      const openB = W.openBook && W.openBook();
      try { sel.value = openB ? openB.paper : ''; } catch { /* ignore */ }
      sel.addEventListener('change', () => setPaper(sel.value));
    }
    const width = tb.querySelector('#canvasWidth');
    if (width) width.addEventListener('change', () => setWidth(width.value));
    const zIn = tb.querySelector('#canvasZoomIn');
    const zOut = tb.querySelector('#canvasZoomOut');
    if (zIn) zIn.addEventListener('click', zoomIn);
    if (zOut) zOut.addEventListener('click', zoomOut);
    const closeBtn = tb.querySelector('#canvasClose');
    if (closeBtn) closeBtn.addEventListener('click', closeCanvasFlow);
    return tb;
  }

  function syncToolbar() {
    const tb = $('canvasToolbar');
    if (!tb) return;
    tb.querySelectorAll('[data-tool]').forEach(b => {
      b.classList.toggle('picked', b.dataset.tool === state.tool);
    });
    const chip = tb.querySelector('#canvasColor');
    if (chip) chip.style.background = state.color;
    const width = tb.querySelector('#canvasWidth');
    const label = tb.querySelector('#canvasWidthLabel');
    if (width) width.value = String(state.width);
    if (label) label.textContent = state.width + 'px';
    const zl = tb.querySelector('#canvasZoom');
    if (zl) zl.textContent = Math.round(state.zoom * 100) + '%';
    const sel = tb.querySelector('#canvasPaper');
    if (sel) {
      const openB = W.openBook && W.openBook();
      try { sel.value = openB ? openB.paper : ''; } catch { /* ignore */ }
    }
  }

  // ---------- Lifecycle ----------

  function openCanvasFlow() {
    const page = currentPage();
    if (!page) return;
    setBodyWriting(true);
    state.open = true;
    state.live = null;
    liveLive = null;
    resetTouch();
    const c = drawCanvasOf(paneIdx());
    if (c) {
      try { c.style.touchAction = 'none'; c.classList.add('canvas-flow-open'); } catch { /* ignore */ }
    }
    buildToolbar();
    attachDrawEvents();
    applyZoom();
    renderPage();
    syncToolbar();
  }

  function closeCanvasFlow() {
    state.open = false;
    state.live = null;
    liveLive = null;
    resetTouch();
    const c = drawCanvasOf(paneIdx());
    if (c) {
      try {
        c.style.touchAction = '';
        c.style.transform = 'none';
        c.classList.remove('canvas-flow-open');
      } catch { /* ignore */ }
    }
    const tb = $('canvasToolbar');
    if (tb) tb.remove();
    setBodyWriting(false);
  }

  function isCanvasFlowOpen() { return !!state.open; }

  // ---------- Exports: PNG (via app) + PDF (Minimal-PDF-Writer) ----------

  function exportPagePNG() {
    try { if (typeof W.exportPagePNG === 'function') W.exportPagePNG(); } catch { /* ignore */ }
  }

  function openDownload(blob, fileName) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch { /* ignore */ } }, 60000);
  }

  function paperApi() {
    try { return (typeof FederwerkPaper !== 'undefined' && FederwerkPaper) ? FederwerkPaper : null; } catch { return null; }
  }

  function renderPageOffscreen(page, d) {
    const c = document.createElement('canvas');
    c.width = d.w;
    c.height = d.h;
    const g = c.getContext('2d');
    g.fillStyle = bgFor(page);
    g.fillRect(0, 0, d.w, d.h);
    (page.strokes || []).forEach(s => drawStroke(g, s));
    return c;
  }

  function bgFor(page) {
    try {
      const P = paperApi();
      if (P && P.bgFor) {
        const openB = W.openBook && W.openBook();
        return P.bgFor(openB ? openB.paper : '') || '#fffdf6';
      }
    } catch { /* Fallback */ }
    return '#fffdf6';
  }

  function bytesToLatin1(u8) {
    const CH = 8192;
    const parts = [];
    for (let i = 0; i < u8.length; i += CH) {
      parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + CH)));
    }
    return parts.join('');
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  /* Echter (wenn auch minimaler) PDF-Writer: eine Seite, ein gesamt-
   *kovertertes JPEG als XObject. Kein Build, pure Function -> Node-Testbar. */
  function buildPdfDocument(dataUrl, widthPt, heightPt) {
    const u8 = b64ToBytes(String(dataUrl || '').split(',')[1] || '');
    const pad = (n) => { const s = String(n); return '0'.repeat(10 - s.length) + s; };
    let pdf = '%PDF-1.4\n';
    const offs = [];
    const push = body => { offs.push(pdf.length); pdf += body + '\n'; };
    push('<< /Type /Catalog /Pages 2 0 R >>');                                            // 1
    push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');                                   // 2
    push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + widthPt + ' ' + heightPt +
         '] /Resources << /XObject << /Im0 4 0 R >> /ProcSet [/PDF /ImageC] >> /Contents 5 0 R >>'); // 3
    push('<< /Type /XObject /Subtype /Image /Width ' + widthPt + ' /Height ' + heightPt +
         ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + u8.length +
         ' >>\nstream\n' + bytesToLatin1(u8) + '\nendstream');                          // 4
    push('<< /Length 20 >>\nstream\nq ' + widthPt + ' 0 0 ' + heightPt + ' 0 0 cm /Im0 Do Q\nendstream'); // 5
    const xrefStart = pdf.length;
    pdf += 'xref\n0 6\n0000000000 65535 f \n';
    offs.forEach(o => pdf += pad(o) + ' 00000 n \n');
    pdf += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF\n';
    return pdf;
  }

  function exportPagePDF(fileName) {
    const page = currentPage();
    if (!page) return;
    const d = pageDimsOf(page);
    if (!d) return;
    const c = renderPageOffscreen(page, d);
    const dataUrl = c.toDataURL('image/jpeg', 0.9);
    const name = fileName || ((W.openBook && W.openBook().title ? W.openBook().title : 'seite') + '.pdf');
    try {
      openDownload(new Blob([buildPdfDocument(dataUrl, d.w, d.h)], { type: 'application/pdf' }), name);
    } catch { /* Notfall: PNG-Export */ exportPagePNG(); }
  }

  // ---------- Public API ----------

  const api = {
    open: openCanvasFlow,
    close: closeCanvasFlow,
    isOpen: isCanvasFlowOpen,
    selectTool,
    setColor,
    setWidth,
    setPaper,
    setZoom: function (z) { state.zoom = clampZoom(z); applyZoom(); syncToolbar(); },
    zoomIn,
    zoomOut,
    exportPagePNG,
    exportPagePDF,
    buildPdfDocument,
    tool: () => state.tool,
    color: () => state.color,
    width: () => state.width,
    zoom: () => state.zoom,
    _resetForTests() {
      state.open = false;
      state.live = null;
      state.tool = 'pen';
      state.color = PALETTE[0];
      state.width = 3;
      state.zoom = 1;
      liveLive = null;
      resetTouch();
    },
    palette: PALETTE,
    widthRange: [WIDTH_MIN, WIDTH_MAX],
  };

  if (typeof window !== 'undefined') window.FederwerkCanvas = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // Globale Behandlungsfunktionen fuer die index.html-Toolbar-Buttons.
  if (typeof W !== 'undefined') {
    W.openCanvasFlow = api.open;
    W.closeCanvasFlow = api.close;
  }
})();
