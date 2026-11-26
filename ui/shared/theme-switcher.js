/* ============================================================================
 * ui/shared/theme-switcher.js  —  window.FWTheme
 *
 * Zwei Achsen:
 *   1) Helligkeit: 'light' | 'dark' | 'auto'   (data-scheme + .dark)
 *   2) UI-Variante: 'shadcn' | 'liquid'        (data-ui-variant + Variant-CSS)
 *
 * Theme-Switcher zwischen shadcn und Liquid Glass (#4 der Aufgabe) +
 * Dark/Light Mode. Zustand in localStorage. Laeuft synchron im <head>
 * (data-boot) VOR dem ersten Paint, um Flackern zu vermeiden.
 * ========================================================================== */
(function () {
  'use strict';
  var W = window, D = document;
  var KEY_SCHEME = 'fw-ui-scheme';
  var KEY_VARIANT = 'fw-ui-variant';

  /* Variant-CSS-Ziele; liquid laedt zusaetzlich das Liquid-Glass-Overlay. */
  var VARIANTS = {
    shadcn: { id: 'shadcn', name: 'shadcn', label: 'shadcn/ui', css: 'ui/shadcn/css/app.css' },
    liquid: { id: 'liquid', name: 'liquid', label: 'shadcn + Liquid Glass', css: 'ui/liquid/css/liquid-glass.css' }
  };
  var ORDER = ['shadcn', 'liquid'];

  function store(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }
  function read(key, def) { try { return localStorage.getItem(key) || def; } catch (e) { return def; } }

  function systemDark() { return !!(W.matchMedia && W.matchMedia('(prefers-color-scheme: dark)').matches); }

  function base() {
    var b = D.querySelector('base[href]');
    if (b && b.href) return b.href;
    var p = location.pathname; return p.slice(0, p.lastIndexOf('/') + 1) || './';
  }

  /* ---- Helligkeit ------------------------------------------------------- */
  function effectiveScheme(s) { if (s === 'light' || s === 'dark') return s; return systemDark() ? 'dark' : 'light'; }

  function applyScheme(s, persist) {
    var root = D.documentElement;
    var choice = (s === 'light' || s === 'dark' || s === 'auto') ? s : 'auto';
    var eff = effectiveScheme(choice);
    root.setAttribute('data-scheme', eff);
    root.classList.toggle('dark', eff === 'dark');
    root.setAttribute('data-scheme-choice', choice);
    if (persist) store(KEY_SCHEME, choice);
    syncToggles();
    dispatch();
    return eff;
  }

  function scheme() { return D.documentElement.getAttribute('data-scheme-choice') || read(KEY_SCHEME, 'auto'); }
  function effectiveSchemeNow() { return D.documentElement.getAttribute('data-scheme') || 'light'; }
  function toggleScheme() { applyScheme(effectiveSchemeNow() === 'dark' ? 'light' : 'dark', true); }

  /* ---- Variante --------------------------------------------------------- */
  function applyVariant(v, persist) {
    var id = VARIANTS[v] ? v : 'shadcn';
    var root = D.documentElement;
    root.setAttribute('data-ui-variant', id);
    /* Variant-CSS umschalten (nicht fuer shadcn-Basis noetig, aber explizit) */
    var link = D.getElementById('fw-variant-css');
    var href = base() + VARIANTS[id].css;
    if (link) {
      link.setAttribute('href', href);
    } else {
      link = D.createElement('link'); link.id = 'fw-variant-css'; link.rel = 'stylesheet';
      link.setAttribute('href', href); D.head.appendChild(link);
    }
    if (persist) store(KEY_VARIANT, id);
    syncToggles();
    dispatch();
    return id;
  }

  function variant() { return D.documentElement.getAttribute('data-ui-variant') || 'shadcn'; }
  function toggleVariant() { var cur = variant(); var i = ORDER.indexOf(cur); applyVariant(ORDER[(i + 1) % ORDER.length], true); }

  /* ---- UI sync ---------------------------------------------------------- */
  function syncToggles() {
    var dark = effectiveSchemeNow() === 'dark';
    D.querySelectorAll('[data-fw-scheme-toggle]').forEach(function (b) {
      b.setAttribute('aria-pressed', dark ? 'true' : 'false');
      var ic = b.querySelector('[data-fw-scheme-icon]');
      if (ic) ic.innerHTML = (W.FWUI && W.FWUI.icon) ? W.FWUI.icon(dark ? 'sun' : 'moon') : (dark ? '☀' : '☾');
      if (b.hasAttribute('data-fw-scheme-label')) b.setAttribute('title', dark ? 'Hellmodus' : 'Dunkelmodus');
    });
    D.querySelectorAll('[data-fw-variant-toggle]').forEach(function (b) {
      b.setAttribute('aria-pressed', variant() === 'liquid' ? 'true' : 'false');
      var lbl = b.querySelector('[data-fw-variant-label]');
      if (lbl) lbl.textContent = VARIANTS[variant()].label;
    });
    D.querySelectorAll('[data-fw-variant-name]').forEach(function (el) { el.textContent = VARIANTS[variant()].label; });
  }

  /* ---- events ----------------------------------------------------------- */
  var listeners = [];
  function dispatch() { var s = current(); listeners.forEach(function (fn) { try { fn(s); } catch (e) {} }); try { W.dispatchEvent(new CustomEvent('fw-theme-change', { detail: s })); } catch (e) {} }
  function current() { return { scheme: effectiveSchemeNow(), schemeChoice: scheme(), variant: variant() }; }

  /* System-Folgen im auto-Modus */
  if (W.matchMedia) {
    var mq = W.matchMedia('(prefers-color-scheme: dark)');
    var onSys = function () { if (scheme() === 'auto') applyScheme('auto', false); };
    if (mq.addEventListener) mq.addEventListener('change', onSys); else if (mq.addListener) mq.addListener(onSys);
  }

  /* ---- Boot (synchron im head) ----------------------------------------- */
  (function boot() {
    var root = D.documentElement;
    /* Variante: URL ?ui=liquid|shadcn > gespeichert */
    var url = '';
    try { url = new URLSearchParams(location.search).get('ui') || ''; } catch (e) {}
    var v = VARIANTS[url] ? url : read(KEY_VARIANT, root.getAttribute('data-ui-variant') || 'shadcn');
    applyVariant(v, false);
    applyScheme(read(KEY_SCHEME, 'auto'), false);
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', syncToggles); else syncToggles();
  })();

  W.FWTheme = {
    applyScheme: applyScheme, scheme: scheme, effectiveScheme: effectiveSchemeNow,
    toggleScheme: toggleScheme, isDark: function () { return effectiveSchemeNow() === 'dark'; },
    applyVariant: applyVariant, variant: variant, toggleVariant: toggleVariant,
    variants: Object.keys(VARIANTS).map(function (k) { return VARIANTS[k]; }),
    current: current, onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    KEY_SCHEME: KEY_SCHEME, KEY_VARIANT: KEY_VARIANT
  };
})();
