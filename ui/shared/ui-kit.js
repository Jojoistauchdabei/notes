/* ============================================================================
 * ui/shared/ui-kit.js  —  shadcn/ui Komponenten, Vanilla-JS Reimplementierung
 *
 * Kein React noetig. Gleiche Komponenten-Namen + Struktur + Tokens wie
 * shadcn/ui, aber als plain <script>. Global `window.FWUI`.
 *
 * Komponenten:
 *   Button, Card, Badge, Separator, Label, Input, Kbd,
 *   Dialog (+AlertDialog), Sheet, DropdownMenu, Popover, Tooltip,
 *   Tabs, Accordion/Collapsible, Switch, Slider, Toggle/ToggleGroup,
 *   Sidebar, Sonner (Toast), Skeleton, ScrollArea, Command(mini),
 *   Toolbar, Breadcrumb, Pagination
 *
 * Auto-Wiring per data-Attribut (kein JS noetig):
 *   [data-fw-dialog-open="#id"] / [data-fw-dialog-close]
 *   [data-fw-sheet-open="#id"]  / [data-fw-sheet-close]
 *   [data-fw-dropdown] + [data-fw-dropdown-trigger] + [data-fw-dropdown-menu]
 *   [data-fw-tooltip="Text"]  (haengt sich an beliebiges Element)
 *   [data-fw-tabs] > [role=tablist] [role=tab][data-fw-tab-target="#id"]
 *   [data-sidebar-toggle] -> toggle Sidebar in .fw-app-shell
 *   [data-fw-scheme-toggle] -> Hell/Dunkel (theme-switcher.js)
 *   [data-fw-variant-toggle] -> shadcn <-> liquid (theme-switcher.js)
 *   [data-fw-canvas-fullscreen] -> Canvas-Vollbild
 *   [data-fw-copy="selektor|text"] -> kopieren + Toast
 * ========================================================================== */
(function () {
  'use strict';
  var W = window, D = document;

  /* ---------- Icons (inline SVG, lucide-Stil, 24px, currentColor) -------- */
  var ICONS = {
    menu: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    pen: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
    marker: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
    eraser: '<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.6-9.6a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
    type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
    move: '<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>',
    laser: '<path d="m9 11 6-6"/><circle cx="12" cy="12" r="2"/><path d="M2 12h3"/><path d="M19 12h3"/><path d="M12 2v3"/><path d="M12 19v3"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
    redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>',
    panelLeft: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
    library: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    maximize: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
    minimize: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
    keyboard: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/><path d="M7 16h10"/>',
    chevronsUpDown: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    palette: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
    library2: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>'
  };
  function icon(name, cls) {
    var inner = ICONS[name] || '';
    return '<svg class="fw-ico' + (cls ? ' ' + cls : '') + '" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + inner + '</svg>';
  }

  /* ---------- Dialog ---------- */
  function openDialog(target) {
    var el = typeof target === 'string' ? D.querySelector(target) : target;
    if (!el) return;
    el.classList.add('active'); el.removeAttribute('hidden');
    el.setAttribute('data-state', 'open');
    var ac = el.querySelector('[autofocus], input, button');
    if (ac && ac.focus) { try { ac.focus(); } catch (e) {} }
    D.documentElement.style.overflow = 'hidden';
  }
  function closeDialog(target) {
    var el = typeof target === 'string' ? D.querySelector(target) : target;
    if (!el) { /* close topmost */ el = D.querySelector('.editor-overlay.active, .dialog-overlay.active'); }
    if (!el) return;
    el.classList.remove('active'); el.setAttribute('data-state', 'closed');
    if (!D.querySelector('.editor-overlay.active, .dialog-overlay.active, .fw-sheet.active')) D.documentElement.style.overflow = '';
  }

  /* ---------- Sheet ---------- */
  function openSheet(target) { openDialog(target); }
  function closeSheet(target) { closeDialog(target); }

  /* ---------- DropdownMenu ---------- */
  var openMenus = [];
  function closeAllMenus() { openMenus.slice().forEach(function (m) { closeMenu(m); }); }
  function closeMenu(menu) {
    menu.classList.remove('active'); menu.setAttribute('data-state', 'closed');
    var i = openMenus.indexOf(menu); if (i >= 0) openMenus.splice(i, 1);
  }
  function toggleMenu(menu, trigger) {
    if (menu.classList.contains('active')) { closeMenu(menu); return; }
    closeAllMenus();
    menu.classList.add('active'); menu.setAttribute('data-state', 'open');
    openMenus.push(menu);
    /* Position relativ zum Trigger, falls nicht im Flow */
    if (trigger && menu.classList.contains('fw-menu-float')) {
      var r = trigger.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.top = Math.round(r.bottom + 4) + 'px';
      menu.style.left = Math.round(r.left) + 'px';
    }
  }

  /* ---------- Tooltip ---------- */
  var tip = null;
  function ensureTip() { if (tip) return tip; tip = D.createElement('div'); tip.className = 'fw-tooltip'; tip.setAttribute('role', 'tooltip'); D.body.appendChild(tip); return tip; }
  function showTip(el) {
    var txt = el.getAttribute('data-fw-tooltip') || el.getAttribute('title') || el.getAttribute('aria-label');
    if (!txt) return;
    var t = ensureTip(); t.textContent = txt; t.classList.add('active');
    var r = el.getBoundingClientRect();
    t.style.top = Math.round(r.top - t.offsetHeight - 6) + 'px';
    t.style.left = Math.round(r.left + r.width / 2 - t.offsetWidth / 2) + 'px';
  }
  function hideTip() { if (tip) tip.classList.remove('active'); }

  /* ---------- Tabs ---------- */
  function activateTab(tab) {
    var root = tab.closest('[data-fw-tabs]') || tab.closest('[role="tablist"]') || D;
    var list = root.querySelector('[role="tablist"]') || root;
    list.querySelectorAll('[role="tab"]').forEach(function (t) {
      t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      t.setAttribute('data-state', t === tab ? 'active' : 'inactive');
      t.classList.toggle('active', t === tab);
    });
    var targetSel = tab.getAttribute('data-fw-tab-target');
    var scope = tab.closest('[data-fw-tabs]') || D;
    scope.querySelectorAll('[role="tabpanel"]').forEach(function (p) {
      var on = targetSel && (p.id === targetSel.replace('#', '') || p.matches(targetSel));
      p.hidden = !on; p.classList.toggle('active', !!on); p.setAttribute('data-state', on ? 'active' : 'inactive');
    });
    if (targetSel && !scope.querySelector('[role="tabpanel"]')) {
      var p = D.querySelector(targetSel); if (p) { p.hidden = false; }
    }
  }

  /* ---------- Sidebar ---------- */
  var SIDEBAR_KEY = 'fw-ui-sidebar-collapsed';
  function shell() { return D.querySelector('.fw-app-shell'); }
  function setSidebarCollapsed(collapsed, persist) {
    var s = shell(); if (!s) return;
    s.setAttribute('data-sidebar-collapsed', collapsed ? 'true' : 'false');
    s.querySelectorAll('[data-sidebar-toggle]').forEach(function (b) { b.setAttribute('aria-expanded', collapsed ? 'false' : 'true'); });
    if (persist) { try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch (e) {} }
  }
  function toggleSidebar() {
    var s = shell(); if (!s) return;
    if (window.matchMedia && window.matchMedia('(max-width: 899px)').matches) {
      s.setAttribute('data-mobile-open', s.getAttribute('data-mobile-open') === 'true' ? 'false' : 'true');
    } else {
      setSidebarCollapsed(s.getAttribute('data-sidebar-collapsed') !== 'true', true);
    }
  }
  function initSidebar() {
    var s = shell(); if (!s) return;
    var saved = null; try { saved = localStorage.getItem(SIDEBAR_KEY); } catch (e) {}
    if (saved === '1') setSidebarCollapsed(true, false);
  }

  /* ---------- Canvas fullscreen ---------- */
  function toggleCanvasFullscreen() {
    var b = D.body; var on = b.classList.toggle('fw-canvas-fullscreen');
    D.querySelectorAll('[data-fw-canvas-fullscreen]').forEach(function (btn) { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    try { window.dispatchEvent(new Event('resize')); } catch (e) {}
    return on;
  }

  /* ---------- Sonner / Toast ---------- */
  function toaster() { var t = D.querySelector('.fw-toaster'); if (!t) { t = D.createElement('div'); t.className = 'fw-toaster'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); D.body.appendChild(t); } return t; }
  function toast(msg, opts) {
    opts = opts || {}; var el = D.createElement('div'); el.className = 'fw-toast' + (opts.variant ? ' fw-toast-' + opts.variant : '');
    el.textContent = String(msg); toaster().appendChild(el);
    var ms = opts.duration == null ? 2600 : opts.duration;
    if (ms > 0) setTimeout(function () { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; setTimeout(function () { el.remove(); }, 220); }, ms);
    return el;
  }

  /* ---------- Copy ---------- */
  function copyText(text, what) {
    var done = function () { toast((what || 'Kopiert') + ' ✓'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text); done(); });
    else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) { var ta = D.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; D.body.appendChild(ta); ta.select(); try { D.execCommand('copy'); } catch (e) {} ta.remove(); }

  /* ---------- Command (mini palette trigger -> FederwerkDialog fallback) - */
  function openCommandPalette() {
    /* app.js hat eigene Suche; wir fokussieren die Library-Suche */
    var s = D.getElementById('librarySearch'); if (s) { s.focus(); s.select(); return; }
    toast('Keine Suche verfügbar');
  }

  /* ---------- Auto-Wiring ---------- */
  function on(el, ev, fn) { el.addEventListener(ev, fn); }

  D.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-fw-dialog-open],[data-fw-dialog-close],[data-fw-sheet-open],[data-fw-sheet-close],[data-fw-dropdown-trigger],[data-sidebar-toggle],[data-fw-scheme-toggle],[data-fw-variant-toggle],[data-fw-canvas-fullscreen],[data-fw-copy],[data-fw-tab],[role="tab"]');
    if (!t) return;

    var sel;
    if ((sel = t.getAttribute('data-fw-dialog-open'))) { e.preventDefault(); openDialog(sel); }
    else if (t.hasAttribute('data-fw-dialog-close')) { e.preventDefault(); closeDialog(t.getAttribute('data-fw-dialog-close') || null); }
    else if ((sel = t.getAttribute('data-fw-sheet-open'))) { e.preventDefault(); openSheet(sel); }
    else if (t.hasAttribute('data-fw-sheet-close')) { e.preventDefault(); closeSheet(t.getAttribute('data-fw-sheet-close') || null); }
    else if (t.hasAttribute('data-fw-dropdown-trigger')) {
      e.preventDefault();
      var dd = t.closest('[data-fw-dropdown]') || D;
      var menu = dd.querySelector(t.getAttribute('data-fw-dropdown-trigger') || '[data-fw-dropdown-menu]');
      if (menu) toggleMenu(menu, t);
    }
    else if (t.hasAttribute('data-sidebar-toggle')) { e.preventDefault(); toggleSidebar(); }
    else if (t.hasAttribute('data-fw-scheme-toggle')) { e.preventDefault(); if (W.FWTheme) W.FWTheme.toggleScheme(); }
    else if (t.hasAttribute('data-fw-variant-toggle')) { e.preventDefault(); if (W.FWTheme) W.FWTheme.toggleVariant(); }
    else if (t.hasAttribute('data-fw-canvas-fullscreen')) { e.preventDefault(); toggleCanvasFullscreen(); }
    else if (t.hasAttribute('data-fw-copy')) { e.preventDefault(); var v = t.getAttribute('data-fw-copy'); var txt = v; try { if (v.charAt(0) === '#' || v.charAt(0) === '.') { var n = D.querySelector(v); txt = n ? (n.value || n.textContent || '') : v; } } catch (err) {} copyText(txt); }
    else if (t.getAttribute('role') === 'tab' || t.hasAttribute('data-fw-tab')) { e.preventDefault(); activateTab(t); }
  });

  /* click outside closes menus */
  D.addEventListener('click', function (e) { if (!e.target.closest('[data-fw-dropdown]')) closeAllMenus(); });

  /* tooltip */
  D.addEventListener('mouseover', function (e) { var el = e.target.closest && e.target.closest('[data-fw-tooltip]'); if (el) showTip(el); });
  D.addEventListener('mouseout', function (e) { var el = e.target.closest && e.target.closest('[data-fw-tooltip]'); if (el) hideTip(); });
  D.addEventListener('focusin', function (e) { var el = e.target.closest && e.target.closest('[data-fw-tooltip]'); if (el) showTip(el); });
  D.addEventListener('focusout', hideTip);

  /* dialog close on overlay click + Esc handled in keyboard.js; overlay click here */
  D.addEventListener('click', function (e) { if (e.target.classList && (e.target.classList.contains('editor-overlay') || e.target.classList.contains('dialog-overlay') || e.target.classList.contains('fw-sheet-overlay'))) { /* app.js handles its own; only close kit ones */ if (e.target.hasAttribute('data-fw-kit')) closeDialog(e.target); } });
  D.addEventListener('click', function (e) { if (e.target.classList && e.target.classList.contains('fw-sheet-overlay')) closeSheet(); if (e.target.classList && e.target.classList.contains('fw-mobile-scrim')) { var s = shell(); if (s) s.setAttribute('data-mobile-open', 'false'); } });

  /* inject tooltip CSS once */
  (function injectCss() {
    if (D.getElementById('fw-ui-kit-css')) return;
    var s = D.createElement('style'); s.id = 'fw-ui-kit-css';
    s.textContent =
      '.fw-tooltip{position:fixed;z-index:400;background:var(--foreground,#111);color:var(--background,#fff);font-size:12px;padding:3px 8px;border-radius:6px;pointer-events:none;opacity:0;transition:opacity .12s;box-shadow:0 4px 12px rgb(0 0 0 / .2);white-space:nowrap;max-width:280px;}' +
      '.fw-tooltip.active{opacity:1;}' +
      '.fw-ico{width:1rem;height:1rem;flex:0 0 auto;vertical-align:-0.15em;}' +
      '[data-fw-dropdown-menu][hidden]{display:none;}';
    D.head.appendChild(s);
  })();

  function ready(fn) { if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', fn); else fn(); }
  ready(initSidebar);

  /* ---------- Public API: shadcn-Namen ---------- */
  W.FWUI = {
    /* Button */ Button: {},
    Card: {}, Badge: {}, Separator: {}, Label: {}, Input: {}, Kbd: {}, Skeleton: {}, ScrollArea: {},
    Dialog: { open: openDialog, close: closeDialog },
    AlertDialog: { open: openDialog, close: closeDialog },
    Sheet: { open: openSheet, close: closeSheet },
    DropdownMenu: { open: toggleMenu, close: closeMenu, closeAll: closeAllMenus },
    Popover: { open: toggleMenu, close: closeMenu },
    Tooltip: { show: showTip, hide: hideTip },
    Tabs: { activate: activateTab },
    Collapsible: { toggle: function (el) { var t = typeof el === 'string' ? D.querySelector(el) : el; if (t) { var o = t.classList.toggle('is-open'); t.setAttribute('data-state', o ? 'open' : 'closed'); } } },
    Accordion: { toggle: function (el) { var t = typeof el === 'string' ? D.querySelector(el) : el; if (t) t.classList.toggle('is-open'); } },
    Switch: {}, Slider: {}, Toggle: {}, ToggleGroup: {},
    Sidebar: { toggle: toggleSidebar, setCollapsed: setSidebarCollapsed, collapsed: function () { var s = shell(); return s && s.getAttribute('data-sidebar-collapsed') === 'true'; } },
    Sonner: { toast: toast }, Toast: { toast: toast }, toast: toast,
    Command: { open: openCommandPalette },
    Toolbar: {}, Breadcrumb: {}, Pagination: {},
    CanvasFullscreen: { toggle: toggleCanvasFullscreen },
    copy: copyText,
    icon: icon,
    icons: ICONS,
    ready: ready,
    version: 'shadcn-vanilla-1.0'
  };
})();
