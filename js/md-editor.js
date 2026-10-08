/* Federwerk Markdown-Editor - Seitenlogik (js/md-editor.js)
 *
 * Aufbau der Seite md.html:
 *   Kopfzeile  Titel, Modus (Live / Quelle / Lesen), Werkzeuge, Design
 *   Seitenleiste  Dokumentliste mit Filter, Gliederung, Kennzahlen
 *   Buehne    entweder die contenteditable-Flaeche (Live) oder die
 *             Quelltext-Textarea oder die reine Leseansicht
 *
 * Live-Ansicht nach markText: Der getippte Text IST das Dokument, die
 * Markdown-Zeichen stehen in .md-marker-Spans und werden per CSS nur dann
 * gezeigt, wenn der Cursor im selben Block steht (md-active). Deshalb wird
 * beim Tippen Nichts neu gerendert - der Browser liefert die WYSIWYG-DOM.
 * Neu gerendert wird nur an sicheren Stellen (Moduswechsel, Esc, Blur,
 * Einfuegen, Toolbar) und der Cursor kommt ueber Blockindex + Textoffset
 * zurueck.
 *
 * Die Quelle bleibt die Wahrheit: serialize() liest die DOM, setzt daraus
 * Markdown, und das erst wird gespeichert.
 */
(function () {
  'use strict';

  var state = {
    doc: null,
    docs: [],
    mode: 'live',       // live | source | preview
    dirty: false,
    filter: '',
    captureTimer: null,
    saveTimer: null,
    activeBlock: null,
    lastSavedAt: 0,
    rafPending: false
  };

  function el(id) { return document.getElementById(id); }
  function md() { return window.FederwerkMarkdown || null; }
  function store() { return window.FederwerkMarkdownStore || null; }
  function dlg() { return window.FederwerkDialog || null; }

  /* ---------- Buehne ---------- */
  function stage() { return el('mdStage'); }
  function editable() { return el('mdLive'); }
  function sourceBox() { return el('mdSource'); }
  function previewBox() { return el('mdPreview'); }

  /* ---------- Rendern ---------- */
  function renderLive() {
    var box = editable();
    if (!box || !state.doc) return;
    box.innerHTML = md() ? md().render(state.doc.source, { editable: true })
      : '<p class="md-plain">' + escapeHtml(state.doc.source) + '</p>';
    box.classList.toggle('md-empty', !state.doc.source.trim());
    updateActiveBlock();
  }

  function renderPreview() {
    var box = previewBox();
    if (!box || !state.doc || !md()) return;
    box.innerHTML = md().render(state.doc.source, { editable: false });
    /* Anker nur im Editier-Modus vergibt - hier nachziehen, damit die
     * Gliederung in der Leseansicht ebenfalls springen kann. */
    var heads = md().outline(state.doc.source);
    var tags = box.querySelectorAll('h1, h2, h3, h4, h5, h6');
    heads.forEach(function (h, i) { if (tags[i]) tags[i].id = h.id; });
  }

  function renderSource() {
    var box = sourceBox();
    if (!box || !state.doc) return;
    if (box.value !== state.doc.source) box.value = state.doc.source;
  }

  function paintAll() {
    if (state.mode === 'live') renderLive();
    else if (state.mode === 'source') renderSource();
    else renderPreview();
    renderDocList();
    renderOutline();
    renderStats();
    renderTitleBar();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------- Quelle aus der Live-DOM lesen ---------- */
  function capture() {
    if (state.mode !== 'live' || !state.doc || !md()) return;
    var box = editable();
    if (!box) return;
    var next;
    try { next = md().serialize(box.innerHTML); }
    catch (e) { return; }
    if (next === state.doc.source) return;
    state.doc.source = next;
    markDirty();
    renderStats();
    renderOutline();
    scheduleSave();
  }

  function captureSoon() {
    clearTimeout(state.captureTimer);
    state.captureTimer = setTimeout(capture, 350);
  }

  function markDirty() {
    state.dirty = true;
    renderStats();
  }

  function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () { save(); }, 700);
  }

  async function save() {
    if (!state.doc || !store()) return;
    clearTimeout(state.saveTimer);
    state.doc.updatedAt = Date.now();
    try {
      await store().put(state.doc);
      state.dirty = false;
      state.lastSavedAt = state.doc.updatedAt;
      renderStats();
      renderDocList();
    } catch (e) {
      setStatus('Speichern fehlgeschlagen: ' + (e && e.message ? e.message : e));
    }
  }

  /* ---------- Cursor: Blockindex + Textoffset ---------- */
  function blockOf(node) {
    var box = editable();
    while (node && node !== box) {
      if (node.parentNode === box) return node;
      node = node.parentNode;
    }
    return null;
  }

  function caretMark() {
    var box = editable();
    var sel = window.getSelection ? window.getSelection() : null;
    if (!box || !sel || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    var node = range.startContainer;
    if (!box.contains(node)) return null;
    var block = blockOf(node);
    if (!block) return null;
    var offset = 0;
    try {
      var r = document.createRange();
      r.selectNodeContents(block);
      r.setEnd(node, range.startOffset);
      offset = r.toString().length;
    } catch (e) { offset = 0; }
    return { index: Array.prototype.indexOf.call(box.children, block), offset: offset };
  }

  function restoreCaret(mark) {
    var box = editable();
    if (!box || !mark) return;
    var block = box.children[mark.index];
    if (!block) block = box.lastElementChild;
    if (!block) return;
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    var node, left = mark.offset;
    var lastText = null;
    while ((node = walker.nextNode())) {
      lastText = node;
      var len = node.nodeValue.length;
      if (left <= len) {
        placeCaret(node, left);
        return;
      }
      left -= len;
    }
    if (lastText) placeCaret(lastText, lastText.nodeValue.length);
  }

  function placeCaret(node, offset) {
    try {
      /* Erst fokussieren, dann setzen: focus() kann die Auswahl an den Anfang
       * zuruecksetzen – danach waere der gesetzte Cursor wieder weg. */
      box_focus();
      var sel = window.getSelection();
      var r = document.createRange();
      r.setStart(node, Math.max(0, Math.min(offset, node.nodeValue.length)));
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) { /* ignore */ }
  }

  function box_focus() {
    var box = editable();
    try { if (box) box.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  /* Neu rendern, ohne den Cursor zu verlieren. */
  function rerender(keepCaret) {
    if (state.mode !== 'live') return;
    var mark = keepCaret === false ? null : caretMark();
    renderLive();
    if (mark) restoreCaret(mark);
    else if (keepCaret === false) { /* Position egal */ }
  }

  /* ---------- Marker nur im aktiven Block zeigen ---------- */
  function updateActiveBlock() {
    var box = editable();
    if (!box) return;
    var sel = window.getSelection ? window.getSelection() : null;
    var node = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
    var block = node && box.contains(node) ? blockOf(node) : null;
    if (state.activeBlock === block) return;
    if (state.activeBlock && state.activeBlock.classList) {
      state.activeBlock.classList.remove('md-active');
    }
    state.activeBlock = block;
    if (block && block.classList) block.classList.add('md-active');
  }

  /* ---------- Dokumente ---------- */
  async function openDoc(doc) {
    if (!doc) return;
    if (state.dirty) await save();
    if (state.doc) capture();
    state.doc = doc;
    state.dirty = false;
    if (store()) store().setCurrentId(doc.id);
    try { if (location.hash.slice(1) !== doc.id) history.replaceState(null, '', '#' + doc.id); } catch (e) { /* ignore */ }
    paintAll();
    updateModeButtons();
    if (state.mode === 'live') setTimeout(function () { box_focus(); }, 0);
  }

  async function newDoc(title, source) {
    if (!store()) return null;
    if (state.dirty) await save();
    var doc = await store().create(title || 'Ohne Titel', source || '');
    await refreshDocs();
    await openDoc(doc);
    return doc;
  }

  async function refreshDocs() {
    if (!store()) return;
    state.docs = await store().list();
  }

  function docByTitle(title) {
    var needle = String(title || '').trim().toLowerCase();
    if (!needle) return null;
    for (var i = 0; i < state.docs.length; i++) {
      if (String(state.docs[i].title || '').trim().toLowerCase() === needle) return state.docs[i];
    }
    return null;
  }

  /* Wikilink-Klick: Dokument suchen, sonst mit Ueberschrift anlegen. */
  async function followTarget(target) {
    var name = String(target || '').split('#')[0].trim();
    if (!name) return;
    var hit = docByTitle(name);
    if (hit) { await openDoc(hit); return; }
    await newDoc(name, '# ' + name + '\n\n');
    setStatus('Neues Dokument "' + name + '" angelegt.');
  }

  /* ---------- Seitenleiste ---------- */
  function filteredDocs() {
    var needle = state.filter.trim().toLowerCase();
    if (!needle) return state.docs;
    return state.docs.filter(function (d) {
      return String(d.title || '').toLowerCase().indexOf(needle) >= 0
        || String(d.source || '').toLowerCase().indexOf(needle) >= 0;
    });
  }

  function renderDocList() {
    var list = el('mdDocList');
    if (!list) return;
    var docs = filteredDocs();
    if (!docs.length) {
      list.innerHTML = '<li class="md-doc-empty">' + (state.docs.length ? 'Keine Treffer.' : 'Noch keine Dokumente.') + '</li>';
      return;
    }
    list.innerHTML = docs.map(function (d) {
      var active = state.doc && d.id === state.doc.id ? ' active' : '';
      var when = timeAgo(d.updatedAt);
      return '<li class="md-doc' + active + '" data-id="' + escapeHtml(d.id) + '" role="button" tabindex="0">'
        + '<span class="md-doc-title">' + escapeHtml(d.title || 'Ohne Titel') + '</span>'
        + '<span class="md-doc-meta">' + escapeHtml(when) + '</span></li>';
    }).join('');
  }

  function timeAgo(ts) {
    var t = Number(ts) || 0;
    if (!t) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 45) return 'gerade eben';
    if (s < 90) return 'vor 1 Min.';
    if (s < 3600) return 'vor ' + Math.round(s / 60) + ' Min.';
    if (s < 7200) return 'vor 1 Std.';
    if (s < 86400) return 'vor ' + Math.round(s / 3600) + ' Std.';
    return new Date(t).toLocaleDateString('de-DE');
  }

  function renderOutline() {
    var box = el('mdOutline');
    if (!box || !state.doc || !md()) return;
    var heads = md().outline(state.doc.source);
    if (!heads.length) {
      box.innerHTML = '<div class="md-outline-empty">Keine Überschriften.</div>';
      return;
    }
    box.innerHTML = heads.map(function (h) {
      return '<button type="button" class="md-outline-item" data-lvl="' + h.level + '" data-id="' + h.id + '">'
        + escapeHtml(h.text || '—') + '</button>';
    }).join('');
  }

  function renderStats() {
    var box = el('mdStats');
    if (!box || !state.doc || !md()) return;
    var s = md().stats(state.doc.source);
    var when = state.dirty ? 'ungesichert…' : (state.lastSavedAt ? 'gesichert ' + timeAgo(state.lastSavedAt) : 'gesichert');
    box.innerHTML = '<span>' + s.words + ' Wörter</span>'
      + '<span>' + s.chars + ' Zeichen</span>'
      + '<span>' + s.minutes + ' Min. Lesezeit</span>'
      + '<span class="' + (state.dirty ? 'md-dirty' : 'md-saved') + '">' + escapeHtml(when) + '</span>';
  }

  function renderTitleBar() {
    var input = el('mdTitle');
    if (input && state.doc && document.activeElement !== input && input.value !== state.doc.title) {
      input.value = state.doc.title;
    }
    var doc = el('mdDocTitle');
    if (doc) doc.textContent = state.doc ? (state.doc.title || 'Ohne Titel') : '—';
  }

  function setStatus(text) {
    var box = el('mdStatus');
    if (!box) return;
    box.textContent = String(text || '');
    box.classList.add('flash');
    setTimeout(function () { if (box) box.classList.remove('flash'); }, 1600);
  }

  /* ---------- Modus ---------- */
  function setMode(mode) {
    mode = (mode === 'source' || mode === 'preview') ? mode : 'live';
    if (mode === state.mode) return;
    if (state.mode === 'live') capture();
    else if (state.mode === 'source' && state.doc) {
      state.doc.source = sourceBox() ? sourceBox().value : state.doc.source;
      markDirty();
      scheduleSave();
    }
    state.mode = mode;
    var wrap = el('mdStageWrap');
    if (wrap) wrap.setAttribute('data-mode', mode);
    ['live', 'source', 'preview'].forEach(function (m) {
      var box = el('md' + m.charAt(0).toUpperCase() + m.slice(1));
      if (box) box.hidden = (m !== mode);
    });
    var tb = el('mdToolbar');
    if (tb) tb.classList.toggle('is-hidden', mode !== 'live');
    updateModeButtons();
    paintAll();
    if (mode === 'live') setTimeout(function () { box_focus(); }, 0);
  }

  function toggleMode() {
    setMode(state.mode === 'live' ? 'source' : 'live');
  }

  function updateModeButtons() {
    ['live', 'source', 'preview'].forEach(function (m) {
      var btn = el('mdMode' + m.charAt(0).toUpperCase() + m.slice(1));
      if (btn) {
        btn.classList.toggle('picked', state.mode === m);
        btn.setAttribute('aria-pressed', state.mode === m ? 'true' : 'false');
      }
    });
  }

  /* ---------- Werkzeuge (wirken auf die Live-DOM) ---------- */
  function selectionRange() {
    var box = editable();
    var sel = window.getSelection ? window.getSelection() : null;
    if (!box || !sel || !sel.rangeCount) return null;
    var r = sel.getRangeAt(0);
    return box.contains(r.startContainer) ? r : null;
  }

  function insertHtml(html) {
    var box = editable();
    if (!box) return;
    box.focus();
    var ok = false;
    try { ok = document.execCommand('insertHTML', false, html); } catch (e) { ok = false; }
    if (!ok) {
      var r = selectionRange();
      if (!r) return;
      r.deleteContents();
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      var frag = document.createDocumentFragment();
      while (tmp.firstChild) frag.appendChild(tmp.firstChild);
      r.insertNode(frag);
    }
    capture();
    rerender();
  }

  /* Auswahl in ein Element gleicher Art einschliessen (fett, code, ...). */
  function wrapSelection(tag, attrs) {
    var r = selectionRange();
    if (!r) return;
    var sel = window.getSelection();
    var text = r.toString();
    var wrap = document.createElement(tag);
    if (attrs) for (var k in attrs) wrap.setAttribute(k, attrs[k]);
    wrap.textContent = text;
    r.deleteContents();
    r.insertNode(wrap);
    try {
      var nr = document.createRange();
      if (text) { nr.selectNodeContents(wrap); nr.collapse(false); }
      else { nr.setStart(wrap, 0); nr.setEnd(wrap, 0); }
      sel.removeAllRanges();
      sel.addRange(nr);
    } catch (e) { /* ignore */ }
    capture();
    rerender();
  }

  function blockWrap(tag) {
    var box = editable();
    var r = selectionRange();
    if (!box || !r) return;
    try {
      document.execCommand('formatBlock', false, '<' + tag + '>');
    } catch (e) { /* ignore */ }
    capture();
    rerender();
  }

  async function askLink(kind) {
    var r = selectionRange();
    var text = r ? r.toString() : '';
    var d = dlg();
    var target = '';
    if (d && d.prompt) {
      target = await d.prompt(
        kind === 'wiki' ? 'Wikilink-Ziel (Notizname)' : 'Link-Adresse (https://…)',
        kind === 'wiki' ? text : 'https://',
        { title: kind === 'wiki' ? 'Wikilink' : 'Link', placeholder: kind === 'wiki' ? 'Notizname' : 'https://beispiel.de' }
      ).catch(function () { return null; });
    } else {
      target = window.prompt(kind === 'wiki' ? 'Wikilink-Ziel:' : 'Link-Adresse:', kind === 'wiki' ? text : 'https://');
    }
    if (target == null) return;
    target = String(target).trim();
    if (!target) return;
    if (kind === 'wiki') {
      insertHtml('<a class="wikilink" href="#wl:' + escapeHtml(target) + '">'
        + escapeHtml(text || target) + '</a>');
    } else {
      insertHtml('<a href="' + escapeHtml(target) + '">' + escapeHtml(text || target) + '</a>');
    }
    setStatus(kind === 'wiki' ? 'Wikilink eingefügt.' : 'Link eingefügt.');
  }

  function insertTable() {
    insertHtml('<table><thead><tr><th>Spalte</th><th>Spalte</th></tr></thead>'
      + '<tbody><tr><td></td><td></td></tr></tbody></table><p></p>');
    setStatus('Tabelle eingefügt.');
  }

  function insertTask() {
    insertHtml('<input type="checkbox" class="md-check" contenteditable="false"> ');
    setStatus('Aufgabe eingefügt.');
  }

  var TOOLS = {
    bold: function () { wrapSelection('b'); },
    italic: function () { wrapSelection('i'); },
    strike: function () { wrapSelection('del'); },
    code: function () { wrapSelection('code'); },
    highlight: function () { wrapSelection('mark'); },
    h1: function () { blockWrap('h1'); },
    h2: function () { blockWrap('h2'); },
    h3: function () { blockWrap('h3'); },
    quote: function () { blockWrap('blockquote'); },
    ul: function () { execOr('insertUnorderedList'); },
    ol: function () { execOr('insertOrderedList'); },
    task: insertTask,
    table: insertTable,
    hr: function () { insertHtml('<hr><p></p>'); },
    link: function () { askLink('link'); },
    wikilink: function () { askLink('wiki'); },
    rerender: function () { capture(); rerender(); }
  };

  function execOr(cmd) {
    var box = editable();
    if (!box) return;
    box.focus();
    try { document.execCommand(cmd, false, null); } catch (e) { /* ignore */ }
    capture();
    rerender();
  }

  /* ---------- Import / Export ---------- */
  function exportMd() {
    if (!state.doc) return;
    var name = (state.doc.title || 'notiz').replace(/[^\w\-. äöüÄÖÜß]+/g, '_').slice(0, 60) || 'notiz';
    var blob = new Blob([state.doc.source], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name + '.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    setStatus('Exportiert: ' + name + '.md');
  }

  function safeName(filename) {
    return String(filename || 'notiz').replace(/\.(md|markdown|txt|mdx)$/i, '').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'notiz';
  }

  async function importFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length || !store()) return;
    var made = [];
    for (var i = 0; i < list.length; i++) {
      var file = list[i];
      var text = '';
      try { text = await file.text(); }
      catch (e) {
        try {
          text = await new Promise(function (res, rej) {
            var fr = new FileReader();
            fr.onload = function () { res(String(fr.result || '')); };
            fr.onerror = function () { rej(fr.error); };
            fr.readAsText(file);
          });
        } catch (e2) { text = ''; }
      }
      var title = md() ? md().titleFromSource(text) : safeName(file.name);
      if (!title) title = safeName(file.name);
      made.push(await store().create(title, text));
    }
    await refreshDocs();
    if (made.length) await openDoc(made[made.length - 1]);
    setStatus(made.length + ' Datei(en) importiert.');
  }

  /* ---------- Tastatur ---------- */
  function onKeyDown(e) {
    var mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if (state.mode === 'live') {
        /* Esc rendert den Block neu: die Marker des aktuellen Blocks werden
         * wieder da, wo man gerade schreibt. */
        capture();
        rerender();
        e.preventDefault();
      }
      return;
    }
    if (!mod) {
      if (e.key === 'Tab' && state.mode === 'live') {
        var r = selectionRange();
        if (!r) return;
        e.preventDefault();
        try { document.execCommand('insertText', false, '  '); } catch (e2) { /* ignore */ }
        captureSoon();
        return;
      }
      return;
    }
    var key = String(e.key || '').toLowerCase();
    if (key === 's') { e.preventDefault(); save(); return; }
    if (key === 'e') { e.preventDefault(); toggleMode(); return; }
    if (key === 'b' && state.mode === 'live') { e.preventDefault(); TOOLS.bold(); return; }
    if (key === 'i' && state.mode === 'live') { e.preventDefault(); TOOLS.italic(); return; }
    if (key === 'k' && state.mode === 'live') { e.preventDefault(); askLink('link'); return; }
    if (/^[1-3]$/.test(key) && state.mode === 'live') {
      e.preventDefault();
      blockWrap('h' + key);
    }
  }

  /* ---------- Ereignisse ---------- */
  var wired = false;

  function wire() {
    /* Idempotent: boot() darf mehrfach laufen (DOMContentLoaded + manueller
     * Aufruf im Test), sonst waere jeder Listener doppelt registriert und
     * z. B. ein Klick auf ein Aufgaben-Kaestchen wuerde den Zustand zweimal
     * weiterschalten. */
    if (wired) return;
    wired = true;
    var box = editable();
    if (box) {
      box.addEventListener('input', function () { captureSoon(); });
      box.addEventListener('blur', function () {
        setTimeout(function () { if (state.mode === 'live') { capture(); rerender(); } }, 120);
      });
      box.addEventListener('paste', function (e) {
        e.preventDefault();
        var text = '';
        try { text = (e.clipboardData || window.clipboardData).getData('text/plain'); } catch (e2) { text = ''; }
        if (!text) return;
        /* Markdown-Paste soll Markdown bleiben (und damit live werden),
         * Fliesstext soll Fliesstext bleiben. */
        if (/(\n\s*\n)|(^#{1,6}\s)|(\*\*)|(\[\[)|(^\s*[-*+]\s)/m.test(text)) {
          insertHtml(md() ? md().render(text, { editable: true }) : escapeHtml(text).replace(/\n/g, '<br>'));
        } else {
          insertHtml(escapeHtml(text).replace(/\n/g, '<br>'));
        }
      });
      box.addEventListener('click', function (e) {
        var a = e.target && e.target.closest ? e.target.closest('a.wikilink, a.md-embed') : null;
        if (a) {
          e.preventDefault();
          var href = a.getAttribute('href') || '';
          followTarget(href.indexOf('#wl:') === 0 ? href.slice(4) : href);
        }
      });
      box.addEventListener('change', function (e) {
        var input = e.target;
        if (!input || input.type !== 'checkbox') return;
        cycleTask(input);
      });
    }

    var src = sourceBox();
    if (src) {
      src.addEventListener('input', function () {
        if (!state.doc) return;
        state.doc.source = src.value;
        markDirty();
        renderStats();
        renderOutline();
        scheduleSave();
      });
    }

    document.addEventListener('selectionchange', function () {
      if (state.mode !== 'live' || state.rafPending) return;
      state.rafPending = true;
      requestAnimationFrame(function () { state.rafPending = false; updateActiveBlock(); });
    });

    document.addEventListener('keydown', onKeyDown);

    window.addEventListener('beforeunload', function (e) {
      if (!state.dirty) return;
      capture();
      if (!state.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });

    var filter = el('mdFilter');
    if (filter) filter.addEventListener('input', function () { state.filter = filter.value || ''; renderDocList(); });

    var title = el('mdTitle');
    if (title) {
      title.addEventListener('input', function () {
        if (!state.doc) return;
        state.doc.title = title.value.slice(0, 200);
        markDirty();
        renderDocList();
        renderTitleBar();
        scheduleSave();
      });
    }

    var list = el('mdDocList');
    if (list) {
      list.addEventListener('click', function (e) {
        var item = e.target.closest ? e.target.closest('.md-doc') : null;
        if (!item) return;
        var doc = docById(item.getAttribute('data-id'));
        if (doc) {
          document.body.classList.remove('md-sidebar-open');
          openDoc(doc);
        }
      });
      list.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var item = e.target.closest ? e.target.closest('.md-doc') : null;
        if (!item) return;
        e.preventDefault();
        var doc = docById(item.getAttribute('data-id'));
        if (doc) openDoc(doc);
      });
    }

    var outline = el('mdOutline');
    if (outline) {
      outline.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.md-outline-item') : null;
        if (!btn) return;
        jumpTo(btn.getAttribute('data-id'));
      });
    }

    bind('mdNewBtn', function () { newDoc(); });
    bind('mdSidebarToggle', function () {
      document.body.classList.toggle('md-sidebar-open');
    });
    bind('mdSaveBtn', function () { save(); });
    bind('mdExportBtn', function () { exportMd(); });
    bind('mdImportBtn', function () { var i = el('mdImportFile'); if (i) i.click(); });
    bind('mdPrintBtn', function () { window.print(); });
    bind('mdRenameBtn', function () { renameDoc(); });
    bind('mdDuplicateBtn', function () { duplicateDoc(); });
    bind('mdDeleteBtn', function () { deleteDoc(); });
    bind('mdModeLive', function () { setMode('live'); });
    bind('mdModeSource', function () { setMode('source'); });
    bind('mdModePreview', function () { setMode('preview'); });
    bind('mdThemeBtn', function () {
      var t = window.FederwerkThemes;
      if (t && t.openPicker) t.openPicker();
      else setStatus('Designauswahl nicht verfügbar.');
    });
    bind('mdHelpBtn', function () { var h = el('mdHelp'); if (h) h.hidden = !h.hidden; });

    var toolbar = el('mdToolbar');
    if (toolbar) {
      toolbar.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-tool]') : null;
        if (!btn) return;
        e.preventDefault();
        var fn = TOOLS[btn.getAttribute('data-tool')];
        if (fn) fn();
      });
      toolbar.addEventListener('mousedown', function (e) {
        /* Toolbar-Klick darf dem Editor nicht den Cursor nehmen. */
        if (e.target.closest && e.target.closest('button')) e.preventDefault();
      });
    }

    var importFile = el('mdImportFile');
    if (importFile) {
      importFile.addEventListener('change', function () {
        importFiles(importFile.files);
        importFile.value = '';
      });
    }
  }

  function bind(id, fn) {
    var node = el(id);
    if (node) node.addEventListener('click', function () { try { fn(); } catch (e) { setStatus('Fehler: ' + (e && e.message ? e.message : e)); } });
  }

  function docById(id) {
    for (var i = 0; i < state.docs.length; i++) if (state.docs[i].id === id) return state.docs[i];
    return null;
  }

  /* Aufgaben-Kästchen: offen -> erledigt -> halb -> offen. Der Zustand landet
   * im DOM (Attribut checked bzw. Halb-Marker-Span), damit serialize() ihn
   * korrekt als [ ] / [x] / [/] zurueckschreibt.
   *
   * Gelesen wird das ATTRIBUT, nicht die Eigenschaft: der Browser hat beim
   * Klick schon umgeschaltet, bevor 'change' ausloest – checked waere damit
   * schon der Zielzustand. Das Attribut aendert ein Klick nicht, und
   * serialize() liest ohnehin das Attribut. */
  function cycleTask(input) {
    var li = input.closest ? input.closest('li') : null;
    var half = li ? li.querySelector('.md-half') : null;
    var current = half ? '/' : (input.hasAttribute('checked') ? 'x' : ' ');
    var next = current === ' ' ? 'x' : (current === 'x' ? '/' : ' ');
    if (next === '/') {
      input.checked = false;
      input.removeAttribute('checked');
      if (!half && li) {
        var span = document.createElement('span');
        span.className = 'md-half';
        input.parentNode.insertBefore(span, input.nextSibling);
      }
    } else {
      if (half && half.parentNode) half.parentNode.removeChild(half);
      input.checked = (next === 'x');
      if (input.checked) input.setAttribute('checked', '');
      else input.removeAttribute('checked');
    }
    capture();
    save();
  }

  function jumpTo(id) {
    var box = editable();
    if (!box) return;
    var target = id ? box.querySelector('[id="' + String(id).replace(/"/g, '') + '"]') : null;
    if (!target && state.mode === 'source') target = null;
    if (target) {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      try {
        var r = document.createRange();
        r.selectNodeContents(target);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        box_focus();
      } catch (e) { /* ignore */ }
      return;
    }
    setStatus('Überschrift nur in der Live- oder Quelltextansicht springbar.');
  }

  async function renameDoc() {
    if (!state.doc || !dlg()) return;
    var name = await dlg().prompt('Neuer Titel', state.doc.title, { title: 'Umbenennen' }).catch(function () { return null; });
    if (name == null) return;
    name = String(name).trim();
    if (!name) return;
    state.doc.title = name.slice(0, 200);
    markDirty();
    await save();
    renderDocList();
    renderTitleBar();
  }

  async function duplicateDoc() {
    if (!state.doc || !store()) return;
    if (state.dirty) await save();
    var copy = await store().duplicate(state.doc.id);
    await refreshDocs();
    if (copy) await openDoc(copy);
  }

  async function deleteDoc() {
    if (!state.doc || !store()) return;
    var ok = dlg()
      ? await dlg().confirm('"' + state.doc.title + '" endgültig löschen?', { title: 'Löschen', danger: true }).catch(function () { return false; })
      : window.confirm('Wirklich löschen?');
    if (!ok) return;
    var rest = state.docs.filter(function (d) { return d.id !== state.doc.id; });
    await store().remove(state.doc.id);
    await refreshDocs();
    state.dirty = false;
    await openDoc(state.docs[0] || await newDoc());
  }

  /* ---------- Start ---------- */
  async function boot() {
    if (!store() || !md()) {
      var stage0 = stage();
      if (stage0) stage0.innerHTML = '<p class="md-error">Editor-Dateien fehlen (js/md-render.js, js/md-store.js).</p>';
      return;
    }
    wire();
    var status = el('mdEngineStatus');
    try {
      await md().ready();
      if (status) { status.textContent = 'markdown-wasm bereit'; status.classList.remove('is-bad'); }
    } catch (e) {
      if (status) { status.textContent = 'markdown-wasm fehlt – nur Quelltext'; status.classList.add('is-bad'); }
    }
    await refreshDocs();
    var hashId = location.hash ? location.hash.slice(1) : '';
    var doc = (hashId && docById(hashId)) || (store().currentId() && docById(store().currentId())) || null;
    if (!doc) {
      try { doc = await store().init(); }
      catch (e) { doc = await newDoc('Ohne Titel', '# Neues Dokument\n\n'); }
    }
    await refreshDocs();
    await openDoc(doc || state.docs[0]);
    setMode('live');
    setStatus('Bereit.');
  }

  if (typeof window !== 'undefined') {
    window.FederwerkMdEditor = { boot: boot, state: state, save: save, setMode: setMode, renderAll: paintAll };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
