/* ui/liquid/js/app.js — Varianten-Init fuer shadcn/ui + Liquid Glass.
 * GLEICHE App-Logik wie ui/shadcn (js/ + ui/shared); nur Variante=liquid. */
(function () {
  'use strict';
  document.documentElement.setAttribute('data-ui-variant', 'liquid');
  if (window.FWTheme) window.FWTheme.applyVariant('liquid', false);
})();
