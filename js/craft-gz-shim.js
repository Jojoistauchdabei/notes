/* Federwerk Craft-Gzip-Schein (js/craft-gz-shim.js)
 *
 * Warum es diese Datei gibt: Cloudflare Workers Static Assets liefern maximal
 * 25 MiB je Datei aus. Die WASM der Upstream-Apps liegt darueber (WordCraft
 * 34,6 MiB, EffectCraft ~58 MiB), als .gz aber bei ~10-20 MiB. scripts/
 * build-crafts.js legt deshalb <name>_bg.wasm.gz ab und haengt DIESES Skript
 * VOR das Modul-Skript der Upstream-Seite in deren index.html.
 *
 * Der Schein biegt genau die WASM-Anfragen der App auf die .gz-Datei um und
 * gibt das entpackte Ergebnis als Antwort mit `Content-Type: application/wasm`
 * zurueck. Damit funktioniert WebAssembly.instantiateStreaming weiter wie
 * bisher, ohne dass am Upstream-Code etwas geaendert wird (kein Fork, kein
 * Patchen des wasm-bindgen-Glues - nur ein anderer Transportweg).
 *
 * Fehlt die .gz-Datei, wird die urspruengliche Anfrage wiederholt: ein Craft
 * ohne Kompression laeuft unveraendert.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  if (typeof DecompressionStream === 'undefined') return; // Browser ohne Entpacken: Original-Weg

  const original = window.fetch.bind(window);
  const IST_WASM = /\.wasm(\?|#|$)/i;
  const IST_GZ = /\.wasm\.gz(\?|#|$)/i;

  function urlVon(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
    } catch { /* egal */ }
    return '';
  }

  function gzUrl(url) {
    return url.replace(/\.wasm(\?|#|$)/i, '.wasm.gz$1');
  }

  window.fetch = function (input, init) {
    const url = urlVon(input);
    if (!url || !IST_WASM.test(url) || IST_GZ.test(url)) return original(input, init);
    return original(gzUrl(url), init).then(async (res) => {
      if (!res || !res.ok || !res.body) return original(input, init);
      try {
        const strom = res.body.pipeThrough(new DecompressionStream('gzip'));
        const bytes = await new Response(strom).arrayBuffer();
        return new Response(bytes, {
          status: 200,
          headers: { 'Content-Type': 'application/wasm', 'Content-Length': String(bytes.byteLength) },
        });
      } catch {
        // Beschaedigte oder halbe .gz: lieber die Originaldatei versuchen, als
        // den Start mit einer kryptischen Fehlermeldung abzubrechen.
        return original(input, init);
      }
    });
  };

  window.FederwerkCraftGzShim = { gzUrl, aktiv: true };
})();
