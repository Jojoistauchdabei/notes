/* Federwerk – eigene Dialoge (Bestätigen/Eingabe) statt nativer Blockier-Dialoge.
 *
 * Warum: `confirm()`/`prompt()` sind synchron blockierend, auf Mobilgeräten
 * und in der PWA unzuverlässig gestylt und lassen sich nicht automatisiert
 * testen. Dieses Modul zeigt stattdessen ein gestyltes Overlay (gleiche
 * Optik wie Texteditor/Graph) und löst per Promise auf:
 * - confirm(message, opts) -> Promise<boolean> (true = OK, false = Abbruch)
 * - prompt(message, def, opts)  -> Promise<string|null> (null = Abbruch)
 * Tastatur: Enter = OK, Escape = Abbruch. Gleichzeitige Aufrufe werden in
 * einer FIFO-Queue nacheinander gezeigt (kein Überlappen).
 *
 * - Kein Build, plain <script> (global `FederwerkDialog`) + Node-export.
 * - DOM wird erst beim Aufruf angefasst (lazy); ohne DOM rejecten die
 *   Aufrufe mit Fehler statt zu crashen (testbar in tests/dialog.test.js
 *   mit gefälschtem document).
 */
(function () {
  'use strict';

  var queue = [];
  var current = null;

  function getDoc() {
    if (typeof document !== 'undefined' && document) return document;
    throw new Error('FederwerkDialog: kein DOM verfügbar');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function mk(doc, tag, cls, text) {
    var el = doc.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  // Baut das Overlay einmalig (wird wiederverwendet). Gibt Referenzen zurück.
  function ensureOverlay(doc) {
    var ov = doc.getElementById('fwDlgOverlay');
    if (ov && ov._fwDlg) return ov._fwDlg;
    ov = doc.createElement('div');
    ov.id = 'fwDlgOverlay';
    ov.className = 'editor-overlay fw-dlg-overlay';
    var modal = mk(doc, 'div', 'editor-modal fw-dlg-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    var head = mk(doc, 'div', 'editor-header');
    var title = mk(doc, 'div', 'editor-header-title');
    title.id = 'fwDlgTitle';
    head.appendChild(title);
    var body = mk(doc, 'div', 'fw-dlg-body');
    var msg = doc.createElement('p');
    msg.id = 'fwDlgMsg';
    msg.className = 'fw-dlg-msg';
    var input = doc.createElement('input');
    input.id = 'fwDlgInput';
    input.type = 'text';
    input.className = 'fw-dlg-input';
    input.style.display = 'none';
    body.appendChild(msg);
    body.appendChild(input);
    var foot = mk(doc, 'div', 'editor-footer fw-dlg-foot');
    var cancel = mk(doc, 'button', 'inactive', 'Abbrechen');
    cancel.type = 'button';
    cancel.id = 'fwDlgCancel';
    var ok = mk(doc, 'button', '', 'OK');
    ok.type = 'button';
    ok.id = 'fwDlgOk';
    foot.appendChild(cancel);
    foot.appendChild(ok);
    modal.appendChild(head);
    modal.appendChild(body);
    modal.appendChild(foot);
    ov.appendChild(modal);
    // Klick auf die Abdunklung = Abbrechen (wie Editor-/Graph-Overlay).
    ov.addEventListener('click', function (e) {
      if (e && e.target === ov) cancelTop();
    });
    doc.body.appendChild(ov);
    var refs = { ov: ov, title: title, msg: msg, input: input, cancel: cancel, ok: ok };
    ov._fwDlg = refs;
    cancel.addEventListener('click', function () { cancelTop(); });
    ok.addEventListener('click', function () { okTop(); });
    return refs;
  }

  function onKey(e) {
    if (!current) return;
    try {
      if (e.key === 'Escape') { e.preventDefault(); cancelTop(); }
      else if (e.key === 'Enter') {
        // In der Eingabe bestätigt Enter immer; sonst nur, wenn der Fokus
        // nicht auf Abbrechen liegt (Barrierearmut: kein Doppel-Feuer).
        if (current.mode !== 'prompt' && e.target === current.refs.cancel) return;
        e.preventDefault();
        okTop();
      }
    } catch (err) { /* ignore */ }
  }

  function showCurrent(doc) {
    var refs = ensureOverlay(doc);
    current.refs = refs;
    refs.title.textContent = current.title;
    refs.msg.textContent = current.message;
    refs.cancel.textContent = current.cancelLabel;
    refs.ok.textContent = current.okLabel;
    refs.ok.className = current.danger ? 'fw-dlg-danger' : '';
    if (current.mode === 'prompt') {
      refs.input.style.display = '';
      refs.input.value = current.def;
      refs.input.placeholder = current.placeholder || '';
      refs.input.maxLength = current.maxLength > 0 ? current.maxLength : 524288;
      try { refs.input.focus(); refs.input.select(); } catch (err) { /* ignore */ }
    } else {
      refs.input.style.display = 'none';
      try { refs.ok.focus(); } catch (err) { /* ignore */ }
    }
    refs.ov.classList.add('active');
    try { doc.addEventListener('keydown', onKey); } catch (err) { /* ignore */ }
  }

  function closeCurrent(doc, result) {
    var job = current;
    current = null;
    try {
      var refs = job && job.refs;
      if (refs && refs.ov && refs.ov.classList) refs.ov.classList.remove('active');
    } catch (err) { /* ignore */ }
    try { doc.removeEventListener('keydown', onKey); } catch (err) { /* ignore */ }
    if (job) {
      try { job.resolve(result); } catch (err) { /* ignore */ }
    }
    var next = queue.shift();
    if (next) {
      current = next;
      try { showCurrent(doc); }
      catch (err) {
        // DOM ging verloren (z. B. Navigation): Queue ehrlich ablehnen.
        current = null;
        try { next.reject(err); } catch (e2) { /* ignore */ }
        queue.forEach(function (j) { try { j.reject(err); } catch (e3) { /* ignore */ } });
        queue = [];
      }
    }
  }

  function cancelTop() {
    if (!current) return;
    var doc = null;
    try { doc = getDoc(); } catch (err) { /* trotzdem auflösen */ }
    var fallback = current.mode === 'prompt' ? null : false;
    if (doc) closeCurrent(doc, fallback);
    else {
      var job = current;
      current = null;
      try { job.resolve(fallback); } catch (err) { /* ignore */ }
    }
  }

  function okTop() {
    if (!current) return;
    var doc = null;
    try { doc = getDoc(); } catch (err) { /* ignore */ }
    var result;
    if (current.mode === 'prompt') {
      try { result = String(current.refs.input.value); }
      catch (err) { result = String(current.def || ''); }
    } else {
      result = true;
    }
    if (doc) closeCurrent(doc, result);
    else {
      var job = current;
      current = null;
      try { job.resolve(result); } catch (err) { /* ignore */ }
    }
  }

  function enqueue(mode, message, a, b) {
    var doc;
    try { doc = getDoc(); }
    catch (err) { return Promise.reject(err); }
    var opts = (mode === 'prompt' && b && typeof b === 'object') ? b
      : (mode === 'confirm' && a && typeof a === 'object') ? a : {};
    var job = {
      mode: mode,
      message: String(message == null ? '' : message),
      title: String(opts.title || (mode === 'prompt' ? 'Eingabe' : 'Bitte bestätigen')),
      okLabel: String(opts.okLabel || (mode === 'prompt' ? 'Übernehmen'
        : (opts.danger ? 'Löschen' : 'OK'))),
      cancelLabel: String(opts.cancelLabel || 'Abbrechen'),
      danger: !!opts.danger,
      def: mode === 'prompt' ? String((typeof a === 'string' ? a : (a == null ? '' : a))) : '',
      placeholder: String(opts.placeholder || ''),
      maxLength: Math.max(0, Math.floor(Number(opts.maxLength) || 0)),
      refs: null,
      resolve: null,
      reject: null,
    };
    // prompt(message, defaultWert, opts) vs. prompt(message, opts)
    if (mode === 'prompt' && a && typeof a === 'object' && !b) {
      job.def = '';
    }
    var p = new Promise(function (res, rej) { job.resolve = res; job.reject = rej; });
    // Synchronen Throw-Schutz: resolve nie werfen lassen (Promise fängt).
    if (current) {
      queue.push(job);
    } else {
      current = job;
      try { showCurrent(doc); }
      catch (err) {
        current = null;
        job.reject(err);
      }
    }
    return p;
  }

  function confirmDlg(message, opts) {
    return enqueue('confirm', message, opts);
  }

  function promptDlg(message, def, opts) {
    if (def && typeof def === 'object' && !opts) return enqueue('prompt', message, def);
    return enqueue('prompt', message, def, opts);
  }

  function _reset() {
    queue = [];
    current = null;
    try {
      var doc = getDoc();
      var ov = doc.getElementById('fwDlgOverlay');
      if (ov && ov.classList) ov.classList.remove('active');
      try { doc.removeEventListener('keydown', onKey); } catch (err) { /* ignore */ }
    } catch (err) { /* kein DOM: nur State zurücksetzen */ }
  }

  var api = {
    confirm: confirmDlg,
    prompt: promptDlg,
    _reset: _reset,
    _internals: { esc: esc, enqueue: enqueue },
  };

  if (typeof window !== 'undefined') window.FederwerkDialog = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
