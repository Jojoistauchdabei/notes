/* Federwerk Office Writer – Blöcke, Inline-Formatierung, Toolbar.
 *
 * Bewusst contenteditable statt contenteditable-freiem Zeilenmodell: Federwerk
 * speichert Textboxen bereits als sanitiztes HTML über GrimoireSanitize
 * (js/sanitize.js), und dieses Sicherheitsmodell wird hier übernommen statt ein
 * eigenes erfunden. Jeder Block ist { id, type, html } – der Typ kommt aus
 * FederwerkOfficeDoc.BLOCK_TYPES.
 *
 * Formatierung läuft über execCommand: es ist die einzige API, die in allen
 * Browsern Auswahl-Formatierung über die Blockgrenze hinweg kann. Was danach
 * gespeichert wird, wird sanitiziert – execCommand erzeugt keine Tags, die das
 * sanitizeHtml nicht kennt.
 *
 * Autosave: zeitversetzt (600 ms) in den Federwerk-Speicher über den von
 * app.js gesetzten Hook OfficeDoc = { save(book) }.
 */
(function () {
  'use strict';

  const D = () => (typeof window !== 'undefined' ? window.FederwerkOfficeDoc : null);
  const S = () => (typeof window !== 'undefined' ? window.GrimoireSanitize : null);

  const BLOCK_TYPES = [
    { type: 'p', label: 'Absatz' },
    { type: 'h1', label: 'Überschrift 1' },
    { type: 'h2', label: 'Überschrift 2' },
    { type: 'h3', label: 'Überschrift 3' },
    { type: 'quote', label: 'Zitat' },
    { type: 'code', label: 'Code' },
    { type: 'hr', label: 'Trennlinie' },
  ];

  const INLINE = [
    { cmd: 'bold', label: 'Fett', key: 'Mod+B' },
    { cmd: 'italic', label: 'Kursiv', key: 'Mod+I' },
    { cmd: 'underline', label: 'Unterstrichen', key: 'Mod+U' },
    { cmd: 'strikeThrough', label: 'Durchgestrichen', key: null },
    { cmd: 'insertUnorderedList', label: 'Aufzählung', key: null },
    { cmd: 'insertOrderedList', label: 'Nummerierung', key: null },
    { cmd: 'createLink', label: 'Link', key: null },
    { cmd: 'removeFormat', label: 'Format zurücksetzen', key: null },
  ];

  const SAVE_DEBOUNCE = 600;

  function el(id) { return document.getElementById(id); }

  function currentView() {
    if (typeof state === 'undefined') return null;
    const id = state.openOfficeId;
    if (!id) return null;
    return (state.books || []).find((b) => b && b.id === id) || null;
  }

  function officeContext() {
    return (typeof state !== 'undefined' && state.office) ? state.office : null;
  }

  function requestSave(book) {
    const ctx = officeContext();
    if (ctx && typeof ctx.save === 'function') { ctx.save(book); return; }
    if (typeof persistNow === 'function') persistNow();
  }

  /* -- Rendern ----------------------------------------------------------- */

function renderBlocks(book, host) {
  host.innerHTML = '';
  for (const block of book.office.blocks) {
    host.appendChild(renderBlock(block));
  }
}

function renderBlock(block) {
  const el_ = document.createElement(block.type === 'hr' ? 'hr' : 'div');
  el_.className = 'fw-office-block fw-office-b-' + block.type;
  el_.dataset.blockId = block.id;
  el_.dataset.blockType = block.type;
  el_.contentEditable = block.type === 'hr' ? 'false' : 'true';
  el_.spellcheck = block.type === 'code' ? 'false' : 'true';
  el_.innerHTML = block.type === 'hr' ? '<span class="fw-office-hr" contenteditable="false"></span>' : (block.html || '');
  return el_;
}

  /* Aktuellen Block aus der Auswahl ermitteln (für Absatztyp-Wechsel). */
  function blockOf(node, host) {
    let n = node;
    while (n && n !== host) {
      if (n.dataset && n.dataset.blockId) return n;
      n = n.parentNode;
    }
    return null;
  }

  function setBlockType(book, block, type) {
    if (!block) return;
    const idx = book.office.blocks.findIndex((b) => b.id === block.dataset.blockId);
    if (idx < 0) return;
    const html = block.dataset.blockType === 'hr' ? '' : block.innerHTML;
    book.office.blocks[idx] = {
      id: block.dataset.blockId,
      type: type,
      html: type === 'hr' ? '' : html,
    };
const host = block.parentNode;
    const neu = renderBlock(book.office.blocks[idx]);
    host.replaceChild(neu, block);
    focusEnd(neu);
    requestSave(book);
    updateToolbar();
  }

  function focusEnd(node) {
    if (!node) return;
    const r = document.createRange();
    r.selectNodeContents(node);
    r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  /* -- Speichern aus dem DOM --------------------------------------------- */

  /* Liest die aktuellen Blöcke zurück aus dem DOM. contentEditable-Umbrüche
   * (Div/Enter) erzeugen <div>-Verschachtelung – die wird zu einem Block pro
   * Zeile flachgezogen, damit das Modell wieder Blockform hat. */
  function readBack(book, host) {
    const out = [];
    const nodes = host.children;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node.dataset || !node.dataset.blockId) continue;
      const type = node.dataset.blockType || 'p';
      if (type === 'hr') {
        out.push({ id: node.dataset.blockId, type: 'hr', html: '' });
        continue;
      }
      const rows = Array.from(node.children).filter((c) => c.tagName === 'DIV');
      if (rows.length) {
        for (const row of rows) {
          out.push({
            id: node.dataset.blockId + ':' + out.length,
            type: /^[h][1-3]$/.test(type) ? 'p' : type,
            html: sanitize(row.innerHTML),
          });
        }
      } else {
        out.push({ id: node.dataset.blockId, type, html: sanitize(node.innerHTML) });
      }
    }
    if (!out.length) out.push({ id: nodeIdFallback(), type: 'p', html: '' });
    book.office.blocks = out;
    return out;
  }

  let idSeq = 0;
  function nodeIdFallback() {
    idSeq += 1;
    return 'o-split-' + Date.now().toString(36) + '-' + idSeq.toString(36);
  }

  function sanitize(html) {
    const s = S();
    const h = String(html == null ? '' : html);
    return s && s.sanitizeHtml ? s.sanitizeHtml(h) : h;
  }

  /* -- Toolbar ----------------------------------------------------------- */

  function execInline(book, cmd, value) {
    const host = el('officeBlocks');
    if (!host) return;
    const block = blockOf(window.getSelection().anchorNode, host);
    if (!block) return;
    try {
      if (cmd === 'createLink') {
        const url = prompt('Link-Adresse (https://…)', 'https://');
        if (!url) return;
        document.execCommand('createLink', false, url);
      } else {
        document.execCommand(cmd, false, value || null);
      }
    } catch { /* execCommand ist nicht ueberall erlaubt */ }
    const idx = book.office.blocks.findIndex((b) => b.id === block.dataset.blockId);
    if (idx >= 0) {
      const s = S();
      book.office.blocks[idx].html = s && s.sanitizeHtml
        ? s.sanitizeHtml(block.innerHTML)
        : sanitize(block.innerHTML);
      requestSave(book);
    }
    updateToolbar();
  }

  function updateToolbar() {
    if (!document.querySelector('.fw-office-toolbar')) return;
    for (const btn of document.querySelectorAll('[data-fw-office-cmd]')) {
      const cmd = btn.dataset.fwOfficeCmd;
      let active = false;
      try { active = !!document.queryCommandState(cmd); } catch { active = false; }
      btn.classList.toggle('is-active', active);
    }
    const host = el('officeBlocks');
    const sel = window.getSelection();
    const block = host && sel && sel.anchorNode ? blockOf(sel.anchorNode, host) : null;
    const type = block ? block.dataset.blockType : '';
    for (const sel2 of document.querySelectorAll('[data-fw-office-type]')) {
      sel2.classList.toggle('is-active', sel2.dataset.fwOfficeType === type);
    }
    updateStatusBar();
  }

  function updateStatusBar() {
    const book = currentView();
    const host = el('officeStatus');
    if (!host) return;
    if (!book) { host.textContent = ''; return; }
    const doc = D();
    const s = doc.stats(book);
    host.textContent = s.words + ' Wörter · ' + s.chars + ' Zeichen · ' + s.unit;
  }

  /* -- Autosave ---------------------------------------------------------- */

  function scheduleSave() {
    const ctx = officeContext();
    if (ctx && typeof ctx.dirty === 'function') ctx.dirty();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; flushSave(); }, SAVE_DEBOUNCE);
  }
  let saveTimer = null;

  /* -- Öffnen / Schließen ----------------------------------------------- */

  function openBook(id) {
    const doc = D();
    const book = (state.books || []).find((b) => b && b.id === id);
    if (!book || !doc.isOfficeBook(book)) return;
    doc.normalize(book);

    if (typeof state !== 'undefined') state.openOfficeId = id;
    el('viewLibrary').classList.remove('active');
    const vp = el('viewBook');
    if (vp) vp.classList.remove('active');
    const vo = el('viewOffice');
    vo.classList.add('active');

    el('officeTitle').textContent = book.title;
    el('officeKind').textContent = doc.kindLabel(book.office.kind);

    if (book.office.kind !== 'doc') {
      // Stufe 2/3: Tabelle und Präsentation folgen. Der Writer ist hier der
      // einzige vollwertige Editor.
      el('officeBlocks').innerHTML = '';
      const hint = document.createElement('p');
      hint.className = 'fw-office-placeholder';
      hint.textContent = doc.kindLabel(book.office.kind) + ' ist für Stufe 2/3 vorgesehen – derzeit nur der Texteditierer.';
      el('officeBlocks').appendChild(hint);
      el('officeToolbar').hidden = true;
      updateStatusBar();
      return;
    }

    el('officeToolbar').hidden = false;
    renderBlocks(book, el('officeBlocks'));
    if (book.office.blocks.length === 1 && !book.office.blocks[0].html) {
      focusEnd(el('officeBlocks').firstElementChild);
    }
    updateStatusBar();
    updateToolbar();
    if (typeof renderLibrary === 'function') renderLibrary();
  }

  function closeOffice() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const book = currentView();
    if (book) {
      const host = el('officeBlocks');
      if (host && host.querySelector('[data-block-id]')) readBack(book, host);
      if (typeof state !== 'undefined') state.openOfficeId = null;
      if (typeof renderLibrary === 'function') renderLibrary();
    }
    const vo = el('viewOffice');
    if (vo) vo.classList.remove('active');
    const vl = el('viewLibrary');
    if (vl) vl.classList.add('active');
  }

  /* -- Taste ------------------------------------------------------------- */

  function onKeydown(ev) {
    const book = currentView();
    if (!book) return;
    const host = el('officeBlocks');
    const sel = window.getSelection();
    const block = host && sel && sel.anchorNode ? blockOf(sel.anchorNode, host) : null;

    // Strg+S: sofort sichern statt den Browsern "Seite speichern" zu ueberlassen.
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      flushSave();
      return;
    }

    // Enter: neue Zeile anhaengen, damit readBack sie als eigenen Block sieht.
    // Shift+Enter bleibt der weiche Umbruch im selben Block.
    if (ev.key === 'Enter' && block && block.dataset.blockType !== 'hr') {
      setTimeout(() => {
        if (!block.isConnected) return;
        const rows = Array.from(block.children).filter((c) => c.tagName === 'DIV');
        if (rows.length) focusEnd(rows[rows.length - 1]);
        scheduleSave();
      }, 0);
      return;
    }

    // Inline-Kuerzel (Strg+B/I/U).
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && !ev.shiftKey && !ev.altKey) {
      const key = ev.key.toLowerCase();
      const map = { b: 'bold', i: 'italic', u: 'underline' };
      if (map[key]) {
        ev.preventDefault();
        execInline(book, map[key]);
      }
    }
  }

  /* Sofort sichern (Strg+S): Autosave-Timer leeren, nicht den 600-ms-Weg
   * abwarten – sonst schließt der Tab kurz danach und der Stand fehlt. */
  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const book = currentView();
    const host = el('officeBlocks');
    if (!book || !host) return;
    if (host.querySelector('[data-block-id]')) readBack(book, host);
    book.updatedAt = Date.now();
    requestSave(book);
    updateStatusBar();
  }

  function stripTags(html) {
    return String(html == null ? '' : html).replace(/<[^>]*>/g, '');
  }

  /* -- Start ------------------------------------------------------------- */

  function boot() {
    if (!el('viewOffice')) return;

    const toolbar = el('officeToolbar');
    for (const item of INLINE) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fw-office-btn';
      b.dataset.fwOfficeCmd = item.cmd;
      b.textContent = item.label;
      b.title = item.key ? item.key + ' – ' + item.label : item.label;
      b.onclick = (ev) => { ev.preventDefault(); const book = currentView(); if (book) execInline(book, item.cmd); };
      toolbar.appendChild(b);
    }
    const typeSel = document.createElement('select');
    typeSel.className = 'fw-office-type';
    typeSel.id = 'officeType';
    for (const t of BLOCK_TYPES) {
      const o = document.createElement('option');
      o.value = t.type;
      o.textContent = t.label;
      typeSel.appendChild(o);
    }
    typeSel.onchange = () => {
      const book = currentView();
      const host = el('officeBlocks');
      const block = host && window.getSelection().anchorNode ? blockOf(window.getSelection().anchorNode, host) : null;
      if (book && block) setBlockType(book, block, typeSel.value);
    };
    toolbar.appendChild(typeSel);

    el('officeBack').onclick = closeOffice;

    el('officeBlocks').addEventListener('input', () => { updateToolbar(); scheduleSave(); });
    el('officeBlocks').addEventListener('keyup', updateToolbar);
    el('officeBlocks').addEventListener('mouseup', updateToolbar);
    document.addEventListener('selectionchange', () => {
      if (el('viewOffice').classList.contains('active')) updateToolbar();
    });

    // Klick auf einen Absatz setzt den Typ-Selektor.
    el('officeBlocks').addEventListener('click', (ev) => {
      const host = el('officeBlocks');
      const block = blockOf(ev.target, host);
      const typeSel2 = el('officeType');
      if (block && typeSel2) typeSel2.value = block.dataset.blockType || 'p';
    });

    document.addEventListener('keydown', onKeydown);
  }

  // document fehlt in Node – ohne diese Abfrage waere das Modul dort nicht
  // einmal ladbar, und die reine Logik (readBack, sanitize) waere nicht testbar.
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  if (typeof window !== 'undefined') window.FederwerkOfficeWriter = {
    openBook, closeOffice, readBack, sanitize, stripTags, updateToolbar,
    BLOCK_TYPES, INLINE, SAVE_DEBOUNCE,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { readBack, sanitize, stripTags, BLOCK_TYPES, INLINE, SAVE_DEBOUNCE };
  }
})();