/* FederwerkCraftEngine - die Grafik-Engine als WebAssembly.
 *
 * Zweite WASM neben FederwerkOfficeEngine: diese hier liest PSD (PhotoCraft),
 * SVG (VectorCraft) und IDML (DesignCraft), jene DOCX/XLSX/PPTX (WordCraft,
 * GridCraft, DeckCraft). Getrennt gehalten, weil die beiden nie gleichzeitig
 * gebraucht werden und craft_wasm_bg.wasm rund 13 MB wiegt - das darf nicht
 * beim Oeffnen eines Textdokuments mitgeladen werden.
 *
 * Aufbau absichtlich 1:1 nach office-engine.js: dieselbe Basis-Ableitung
 * ueber den Script-Tag (damit es auch unter einem Unterpfad sitzt), derselbe
 * lazy-load, dieselbe Fehlerform { ok, value } / { ok, error }. Der Import
 * ist hier bewusst NICHT verdrahtet: die drei Formate landen in ganz
 * verschiedenen Modellen (Bild-Pixel, Vektor-Dokument, Satzspur) und
 * brauchen je einen eigenen Zielort in der Bibliothek. Die Engine laedt,
 * snifft und konvertiert - wer ein Ergebnis verwenden will, ruft die
 * einzelnen Funktionen auf.
 *
 * Ein fehlendes WASM darf die App nie lahmlegen: `ready()` gibt dann
 * { ok: false } zurueck und die Oberflaeche zeigt den Fehler an.
 */
(function () {
  'use strict';

  const WASM_JS = 'craft_wasm.js';
  const WASM_BIN = 'craft_wasm_bg.wasm';

  let ladePromise = null;
  let geladen = false;
  let fehlerText = '';

  /* Das WASM liegt neben der Seite, nicht neben craft-wasm/ - scripts/build.js
   * kopiert es nach dist/. Die Basis aus diesem Script holen, damit es auch
   * unter einem Unterpfad (/foo/) sitzt: `document.currentScript` zeigt
   * waehrend der Ausfuehrung genau auf dieses Tag, auch wenn die Seite
   * gebuendelt wurde. Der querySelector ist der Rueckfall fuer den Fall,
   * dass der Bundler den Pfad umgeschrieben hat. */
  const EIGENE_BASIS = (function () {
    const s = document.currentScript;
    if (s && s.src) return s.src.replace(/[^/]*$/, '');
    const q = document.querySelector('script[src*="craft"], script[src*="craft_wasm"]');
    return (q && q.src) ? q.src.replace(/[^/]*$/, '') : null;
  })();

  function basisAusDocument() {
    return EIGENE_BASIS || location.origin + '/';
  }

  /* Laedt das Modul genau einmal. Nach dem Aufruf ist `mod` das
   * wasm-bindgen-Init, das die .wasm nachlaedt. */
  function lade() {
    if (ladePromise) return ladePromise;
    ladePromise = (async () => {
      const url = basisAusDocument() + WASM_JS;
      const mod = await import(/* webpackIgnore: true */ url);
      // Ohne Objekt-URL laedt wasm-bindgen die .wasm relativ zum Skript; das
      // ist genau das gewuenschte Verhalten, darum hier bewusst nichts
      // weiterreichen.
      await mod.default({});
      geladen = true;
      return mod;
    })().catch((e) => {
      // Promise zuruecksetzen, damit ein spaeterer Versuch es erneut versucht.
      ladePromise = null;
      fehlerText = e && e.message ? e.message : String(e);
      return null;
    });
    return ladePromise;
  }

  function bytesOf(blobOderArray) {
    if (blobOderArray instanceof Uint8Array) return blobOderArray;
    if (blobOderArray instanceof ArrayBuffer) return new Uint8Array(blobOderArray);
    if (ArrayBuffer.isView(blobOderArray)) {
      return new Uint8Array(blobOderArray.buffer, blobOderArray.byteOffset, blobOderArray.byteLength);
    }
    throw new TypeError('bytesOf: erwartet Uint8Array oder ArrayBuffer.');
  }

  async function asArrayBuffer(blobOderArray) {
    if (blobOderArray instanceof Blob) return blobOderArray.arrayBuffer();
    const u8 = bytesOf(blobOderArray);
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  const Engine = {
    geladen: () => geladen,
    fehler: () => fehlerText,
    pfad: () => basisAusDocument() + WASM_BIN,

    ready() { return lade(); },

    /* Alle Aufrufe laufen ueber hier: einmal laden, dann ausfuehren. Fehler
     * werden zu { ok: false } -- die Aufrufer zeigen das an, statt eine
     * Exception in die Oberflaeche zu schieben. */
    async call(fnName, arg) {
      const mod = await lade();
      if (!mod) return { ok: false, error: 'Grafik-Engine nicht verfügbar: ' + (fehlerText || 'unbekannt') };
      const fn = mod[fnName];
      if (typeof fn !== 'function') return { ok: false, error: 'Unbekannte Engine-Funktion: ' + fnName };
      try {
        return { ok: true, value: await fn(arg) };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    },

    async sniff(bytes) {
      const r = await Engine.call('sniff', bytesOf(bytes));
      if (!r.ok) return r;
      try {
        return { ok: true, value: JSON.parse(r.value) };
      } catch (e) {
        return { ok: false, error: 'sniff lieferte kein JSON: ' + e.message };
      }
    },

    psdToJson(bytes) { return Engine.call('psdToJson', bytesOf(bytes)); },
    svgToJson(bytes) { return Engine.call('svgToJson', bytesOf(bytes)); },
    jsonToSvg(json) { return Engine.call('jsonToSvg', String(json)); },
    idmlToJson(bytes) { return Engine.call('idmlToJson', bytesOf(bytes)); },
    jsonToIdml(json) { return Engine.call('jsonToIdml', String(json)); },

    /* Import-Hilfe: erkennt die Art und liefert { kind, json, bytes }.
     * Gegenlaeufig zum Office-`import()` kommt hier `bytes` mit: bei PSD gibt
     * psdToJson nur eine Zusammenfassung (Ebenen, Groesse) zurueck, die
     * gerenderten Pixel muss sich der Aufrufer selbst holen. */
    async import(bytes) {
      const s = await Engine.sniff(bytes);
      if (!s.ok) return s;
      const kind = s.value.kind;
      if (!kind) return { ok: false, error: 'Keine Grafik-Datei erkannt.' };
      const r = kind === 'psd' ? await Engine.psdToJson(bytes)
        : kind === 'svg' ? await Engine.svgToJson(bytes)
        : await Engine.idmlToJson(bytes);
      if (!r.ok) return r;
      return { ok: true, kind, json: r.value };
    },

    /* Aus einem Blob eine Datei machen - fuer den Export-Download. */
    async dateiAusBytes(bytes, mime, name) {
      const buf = await asArrayBuffer(bytes);
      return new File([buf], name, { type: mime || 'application/octet-stream' });
    },

    async internals() {
      return { geladen, fehlerText, pfad: Engine.pfad() };
    },
  };

  window.FederwerkCraftEngine = Engine;
})();
