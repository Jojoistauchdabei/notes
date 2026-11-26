/* ============================================================================
 * ui/shared/keyboard-shortcuts.js
 * Zusaetzliche UI-Shortcuts der shadcn/Liquid-Shells. Die App-eigenen
 * Shortcuts (P=Stift, L=Laser, Esc, PageUp/Down, Home/End, Ctrl+Shift+B
 * Split, Ctrl+Alt+Pfeil Pane, Ctrl+E Editor, …) bleiben unberuehrt;
 * hier nur nicht-kollidierende Ergaenzungen.
 * ========================================================================== */
(function () {
  'use strict';
  var W = window, D = document;

  function typing() {
    var a = D.activeElement; if (!a) return false;
    var tag = (a.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable;
  }
  function mod(e) { return e.ctrlKey || e.metaKey; }

  var SHORTCUTS = [
    { keys: ['Ctrl', 'B'], desc: 'Sidebar ein-/ausklappen', group: 'UI' },
    { keys: ['Ctrl', 'Shift', 'D'], desc: 'Dunkel-/Hellmodus', group: 'UI' },
    { keys: ['Ctrl', 'Shift', 'L'], desc: 'Variante shadcn ⇄ Liquid Glass', group: 'UI' },
    { keys: ['Ctrl', 'K'], desc: 'Suche fokussieren / Command', group: 'UI' },
    { keys: ['Ctrl', '/'], desc: 'Diese Übersicht', group: 'UI' },
    { keys: ['P'], desc: 'Stift', group: 'Canvas' },
    { keys: ['L'], desc: 'Laserpointer', group: 'Canvas' },
    { keys: ['Ctrl', 'Z'], desc: 'Rückgängig (App)', group: 'Canvas' },
    { keys: ['Ctrl', 'Shift', 'Z'], desc: 'Wiederherstellen (App)', group: 'Canvas' },
    { keys: ['Ctrl', 'Shift', 'B'], desc: 'Split-Screen', group: 'Canvas' },
    { keys: ['Ctrl', 'Alt', '←/→'], desc: 'Pane wechseln', group: 'Canvas' },
    { keys: ['PgUp', 'PgDn'], desc: 'Seite blättern', group: 'Canvas' },
    { keys: ['Home', 'End'], desc: 'Erste / letzte Seite', group: 'Canvas' },
    { keys: ['Esc'], desc: 'Dialog/Overlay schließen', group: 'UI' }
  ];

  function kbd(keys) { return keys.map(function (k) { return '<kbd>' + k + '</kbd>'; }).join(' '); }

  function showShortcuts() {
    var rows = SHORTCUTS.map(function (s) {
      return '<tr><td style="padding:.3rem .6rem;white-space:nowrap">' + kbd(s.keys) + '</td><td style="padding:.3rem .6rem;color:var(--muted-foreground)">' + s.desc + '</td></tr>';
    }).join('');
    var html =
      '<div id="fwShortcuts" class="editor-overlay active" role="dialog" aria-modal="true" aria-label="Tastatur-Shortcuts" data-fw-kit="1">' +
      '<div class="editor-modal" style="max-width:520px">' +
      '<div class="editor-header"><div class="editor-header-title">Tastatur-Shortcuts</div>' +
      '<button type="button" class="btn btn-ghost btn-icon" data-fw-dialog-close aria-label="Schließen">✕</button></div>' +
      '<div style="padding:10px 14px;max-height:60vh;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">' + rows + '</table></div>' +
      '<div class="editor-footer" style="justify-content:flex-end"><button type="button" class="btn btn-outline" data-fw-dialog-close>Schließen</button></div>' +
      '</div></div>';
    var old = D.getElementById('fwShortcuts'); if (old) old.remove();
    var wrap = D.createElement('div'); wrap.innerHTML = html; var el = wrap.firstChild;
    D.body.appendChild(el);
    el.addEventListener('click', function (e) { if (e.target === el || e.target.closest('[data-fw-dialog-close]')) el.remove(); });
  }

  D.addEventListener('keydown', function (e) {
    var key = e.key;
    /* Esc schliesst kit-Overlay + Mobile-Sheet (app.js schliesst eigene) */
    if (key === 'Escape') {
      var sc = D.querySelector('#fwShortcuts'); if (sc) { sc.remove(); return; }
      var shell = D.querySelector('.fw-app-shell'); if (shell && shell.getAttribute('data-mobile-open') === 'true') shell.setAttribute('data-mobile-open', 'false');
      var kit = D.querySelector('[data-fw-kit].active, .dialog-overlay.active'); if (kit && kit.hasAttribute('data-fw-kit')) kit.classList.remove('active');
    }

    if (typing()) return; /* in Feldern nicht eingreifen */

    if (mod(e) && !e.altKey && (key === 'z' || key === 'Z')) {
      e.preventDefault();
      if (W.FederwerkCore) { if (e.shiftKey) W.FederwerkCore.call('redo'); else W.FederwerkCore.call('undo'); }
      else if (e.shiftKey && typeof W.redo === 'function') W.redo(); else if (typeof W.undo === 'function') W.undo();
    }
    else if (mod(e) && !e.shiftKey && !e.altKey && (key === 'b' || key === 'B')) { e.preventDefault(); if (W.FWUI) W.FWUI.Sidebar.toggle(); }
    else if (mod(e) && e.shiftKey && (key === 'd' || key === 'D')) { e.preventDefault(); if (W.FWTheme) W.FWTheme.toggleScheme(); }
    else if (mod(e) && e.shiftKey && (key === 'l' || key === 'L')) { e.preventDefault(); if (W.FWTheme) W.FWTheme.toggleVariant(); }
    else if (mod(e) && !e.shiftKey && !e.altKey && (key === 'k' || key === 'K')) { e.preventDefault(); if (W.FWUI) W.FWUI.Command.open(); }
    else if (mod(e) && (key === '/' || key === '?')) { e.preventDefault(); showShortcuts(); }
  });

  W.FWShortcuts = { list: SHORTCUTS.slice(), show: showShortcuts };
})();
