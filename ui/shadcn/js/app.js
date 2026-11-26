/* ui/shadcn/js/app.js — Varianten-Init fuer shadcn/ui.
 * Business-Logik kommt KOMPLETT aus js/ (gemeinsame Basis) + ui/shared.
 * Hier nur shadcn-spezifische Verdrahtung. */
(function () {
  'use strict';
  document.documentElement.setAttribute('data-ui-variant', 'shadcn');
  if (window.FWTheme) window.FWTheme.applyVariant('shadcn', false);
  if (window.FWUI && window.FWUI.ready) window.FWUI.ready(function () {
    /* gemeinsame App bleibt unveraendert; kleine shadcn-Ergaenzungen */
    document.querySelectorAll('[data-slot="button"]').forEach(function (b) { b.classList.add('btn'); });
  });
})();
