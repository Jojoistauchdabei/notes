/* Texteditor – übernommen aus DND-Character-sheet-generator/js/editor.js
   Verhalten identisch, nur save() -> persistSoon() für das Grimoire. */
let currentEditorTargetId = null;
let currentEditorBoxId = null;
let editorMode = 'rich'; // 'rich' (contenteditable) | 'source' (Markdown-Textarea)

function openTextEditor(targetId, title) {
  currentEditorTargetId = targetId;
  const targetEl = document.getElementById(targetId);
  if (!targetEl) return;
  const overlay = document.getElementById('editorOverlay');
  const titleSpan = document.getElementById('editorTargetTitle');
  const editorContent = document.getElementById('editorContent');
  if (titleSpan) titleSpan.textContent = (title || targetId).toUpperCase();
  if (editorContent) editorContent.innerHTML = targetEl.innerHTML;
  resetEditorToRich(); // alte Inhalte laden immer unveraendert als Rich
  if (overlay) {
    overlay.classList.add('active');
    setTimeout(() => { if (editorContent) editorContent.focus(); }, 50);
  }
}

/* Variante für dynamische Textboxen (GoodNotes-Seiten): Ziel ist eine Box-ID statt DOM-ID */
function openTextEditorForBox(boxId, title) {
  const page = currentPage();
  if (!page) return;
  const box = page.texts.find(t => t.id === boxId);
  if (!box) return;
  currentEditorTargetId = null;
  currentEditorBoxId = boxId;
  const overlay = document.getElementById('editorOverlay');
  const titleSpan = document.getElementById('editorTargetTitle');
  const editorContent = document.getElementById('editorContent');
  if (titleSpan) titleSpan.textContent = (title || 'Textbox').toUpperCase();
  resetEditorToRich(); // alte HTML-Textboxen laden unveraendert als Rich
  if (editorContent) {
    editorContent.innerHTML = box.html || '';
    // Textfeld-Upgrade: Box-Stil (bzw. Default-Stil) in den Editor übernehmen,
    // damit computed-Auslese und "Als Standard" darauf aufbauen können.
    try {
      let st = null;
      if (typeof GrimoirePencil !== 'undefined' && GrimoirePencil.getTextDefault) {
        st = GrimoirePencil.getTextDefault();
        if (box.fontSize != null) st.fontSize = box.fontSize;
        if (box.color != null) st.color = box.color;
        if (box.align != null) st.align = box.align;
        st = GrimoirePencil.sanitizeTextStyle(st);
      } else {
        st = { fontSize: box.fontSize || 17, color: box.color || '#2a1a0e', align: box.align || 'left' };
      }
      editorContent.style.fontSize = st.fontSize + 'px';
      editorContent.style.color = st.color;
      editorContent.style.textAlign = st.align;
    } catch { /* Editor bleibt auch ohne Stil-Init nutzbar */ }
  }
  if (overlay) {
    overlay.classList.add('active');
    setTimeout(() => { if (editorContent) editorContent.focus(); }, 50);
  }
}

function closeTextEditor() {
  const overlay = document.getElementById('editorOverlay');
  if (overlay) overlay.classList.remove('active');
  currentEditorTargetId = null;
  currentEditorBoxId = null;
  resetEditorToRich();
}

function saveTextEditor() {
  syncSourceToRich(); // Source-Ansicht erst nach HTML zurueckwandeln
  const editorContent = document.getElementById('editorContent');
  if (currentEditorBoxId && editorContent) {
    const page = currentPage();
    const box = page ? page.texts.find(t => t.id === currentEditorBoxId) : null;
    if (box) {
      box.html = editorContent.innerHTML;
      // Box-Stil aus dem Editor-Container übernehmen (Roundtrip zum Default-Stil).
      const st = collectEditorStyle();
      if (st) { box.fontSize = st.fontSize; box.color = st.color; box.align = st.align; }
      persistSoon();
      renderTextLayer();
      renderRail();
    }
  } else if (currentEditorTargetId && editorContent) {
    const targetEl = document.getElementById(currentEditorTargetId);
    if (targetEl) {
      targetEl.innerHTML = editorContent.innerHTML;
      if (typeof persistSoon === 'function') persistSoon();
    }
  }
  closeTextEditor();
}

/* Textfeld-Upgrade: aktuellen Editor-Stil auslesen (computed des contenteditable)
   bzw. als Default-Stil (grimoireTextDefault, localStorage) speichern. */
function collectEditorStyle() {
  const editorContent = document.getElementById('editorContent');
  if (!editorContent) return null;
  let cs = null;
  try { cs = window.getComputedStyle(editorContent); } catch { return null; }
  if (!cs) return null;
  try {
    if (typeof GrimoirePencil !== 'undefined' && GrimoirePencil.editorStyleFromComputed) {
      return GrimoirePencil.editorStyleFromComputed({ fontSize: cs.fontSize, color: cs.color, textAlign: cs.textAlign });
    }
  } catch { /* ignore */ }
  return null;
}

function saveEditorStyleAsDefault() {
  const st = collectEditorStyle();
  if (!st) { alert('Kein Stil auslesbar.'); return; }
  try {
    if (typeof GrimoirePencil !== 'undefined' && GrimoirePencil.setTextDefault) GrimoirePencil.setTextDefault(st);
    else localStorage.setItem('grimoireTextDefault', JSON.stringify(st));
  } catch { /* ignore */ }
  if (typeof setSaveStatus === 'function') setSaveStatus('★ Standardstil gespeichert');
  else alert('Standardstil gespeichert.');
}

/* Markdown-Source-Toggle (SPEC-06 light, OFM-Subset SPEC-13):
   "MD"-Button schaltet zwischen Rich (contenteditable) und Source (Textarea).
   Alte HTML-Textboxen laden unveraendert (immer Rich); konvertiert wird nur
   beim Umschalten bzw. beim Speichern aus der Source-Ansicht. */
function grimoireMarkdownLib() {
  return (typeof GrimoireMarkdown !== 'undefined') ? GrimoireMarkdown : null;
}

function isMarkdownSourceMode() { return editorMode === 'source'; }

function updateEditorModeToggle() {
  const toggle = document.getElementById('editorModeToggle');
  const source = isMarkdownSourceMode();
  if (toggle) {
    toggle.textContent = source ? '⌨ MD' : '📝 Rich';
    toggle.classList.toggle('picked', source);
    toggle.title = source
      ? 'Markdown-Quelle aktiv – klicken für Rich-Text (Strg+E)'
      : 'Rich-Text aktiv – klicken für Markdown-Quelle (Strg+E)';
  }
  const overlay = document.getElementById('editorOverlay');
  if (overlay) overlay.classList.toggle('md-source', source);
  // Rich-Werkzeuge (execCommand) sind in der Source-Ansicht sinnlos -> sperren
  try {
    const tools = overlay ? overlay.querySelectorAll('.editor-toolbar button, .editor-toolbar select') : [];
    tools.forEach((el) => { if (el.id !== 'editorModeToggle') el.disabled = source; });
  } catch { /* ignore */ }
}

function resetEditorToRich() {
  editorMode = 'rich';
  const rich = document.getElementById('editorContent');
  const src = document.getElementById('editorSource');
  if (rich) rich.style.display = 'block';
  if (src) { src.style.display = 'none'; src.value = ''; }
  updateEditorModeToggle();
}

function toggleEditorMode() { setEditorMode(isMarkdownSourceMode() ? 'rich' : 'source'); }

function setEditorMode(mode) {
  mode = (mode === 'source') ? 'source' : 'rich';
  if (mode === editorMode) { updateEditorModeToggle(); return; }
  const rich = document.getElementById('editorContent');
  const src = document.getElementById('editorSource');
  if (!rich || !src) { editorMode = 'rich'; updateEditorModeToggle(); return; }
  const lib = grimoireMarkdownLib();
  if (mode === 'source') {
    let mdText = rich.innerHTML || '';
    if (lib) { try { mdText = lib.htmlToMd(mdText); } catch { /* Fallback: Roh-HTML */ } }
    src.value = mdText;
    rich.style.display = 'none';
    src.style.display = 'block';
    editorMode = 'source';
    updateEditorModeToggle();
    setTimeout(() => { try { src.focus(); } catch { /* ignore */ } }, 50);
  } else {
    let html = src.value || '';
    if (lib) { try { html = lib.mdToHtml(html); } catch { html = ''; } }
    rich.innerHTML = html;
    src.style.display = 'none';
    rich.style.display = 'block';
    editorMode = 'rich';
    updateEditorModeToggle();
    setTimeout(() => { try { rich.focus(); } catch { /* ignore */ } }, 50);
  }
}

/* Source-Ansicht vor dem Speichern nach HTML zurueckwandeln, damit der
   bestehende Speicher-Flow (box.html / targetEl.innerHTML) unveraendert bleibt. */
function syncSourceToRich() {
  if (!isMarkdownSourceMode()) return;
  const rich = document.getElementById('editorContent');
  const src = document.getElementById('editorSource');
  if (!rich || !src) return;
  const lib = grimoireMarkdownLib();
  if (lib) { try { rich.innerHTML = lib.mdToHtml(src.value || ''); } catch { /* ignore */ } }
}

function applyEditorFormat(val) {
  if (!val) return;
  if (val === 'p' || val === 'h1' || val === 'h2' || val === 'h3') {
    document.execCommand('formatBlock', false, '<' + val + '>');
  } else if (val.startsWith('font-')) {
    document.execCommand('fontSize', false, val.replace('font-', ''));
  }
}

document.addEventListener('keydown', (e) => {
  const overlay = document.getElementById('editorOverlay');
  if (!overlay || !overlay.classList.contains('active')) return;
  if (e.key === 'Escape') {
    closeTextEditor();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
    e.preventDefault(); // SPEC-06 light: Strg+E rotiert Rich <-> Markdown-Quelle
    toggleEditorMode();
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    saveTextEditor();
  }
});
