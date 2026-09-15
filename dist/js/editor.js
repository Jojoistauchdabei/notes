/* Texteditor – übernommen aus DND-Character-sheet-generator/js/editor.js
   Verhalten identisch, nur save() -> persistSoon() für das Grimoire. */
let currentEditorTargetId = null;
let currentEditorBoxId = null;

function openTextEditor(targetId, title) {
  currentEditorTargetId = targetId;
  const targetEl = document.getElementById(targetId);
  if (!targetEl) return;
  const overlay = document.getElementById('editorOverlay');
  const titleSpan = document.getElementById('editorTargetTitle');
  const editorContent = document.getElementById('editorContent');
  if (titleSpan) titleSpan.textContent = (title || targetId).toUpperCase();
  if (editorContent) editorContent.innerHTML = targetEl.innerHTML;
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
  if (editorContent) editorContent.innerHTML = box.html || '';
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
}

function saveTextEditor() {
  const editorContent = document.getElementById('editorContent');
  if (currentEditorBoxId && editorContent) {
    const page = currentPage();
    const box = page ? page.texts.find(t => t.id === currentEditorBoxId) : null;
    if (box) {
      box.html = editorContent.innerHTML;
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
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    saveTextEditor();
  }
});
