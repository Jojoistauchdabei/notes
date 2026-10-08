/* Federwerk Office Engine -- Bindeglied zum WASM (DOCX/XLSX/PPTX).
 *
 * Das WASM stammt aus office-wasm/ und ist Apache-2.0 (WordCraft, GridCraft,
 * DeckCraft). Es wird nur geladen, wenn es wirklich gebraucht wird: 3 MiB
 * sollen nicht jeder beim Oeffnen des ersten Notizbuchs fliessen. Beim ersten
 * Bedarf wird office_wasm.js als Modul nachgeladen und die Datei im Browser
 * gecacht (Cache-Control immutable aus _headers).
 *
 * Vertrag des WASM (alle Fn arbeiten auf Uint8Array/ArrayBuffer und JSON):
 *   await Engine.ready()                       -> bool (true = geladen)
 *   await Engine.sniff(bytes)                  -> { kind, docx, xlsx, pptx }
 *   await Engine.docxToJson(bytes)             -> JSON-String
 *   await Engine.jsonToDocx(json)              -> Uint8Array
 *   await Engine.xlsxToJson(bytes)             -> JSON-String
 *   await Engine.jsonToXlsx(json)              -> Uint8Array
 *   await Engine.pptxToJson(bytes)             -> JSON-String
 *   await Engine.jsonToPptx(json)              -> Uint8Array
 *
 * Fehler werden nicht geworfen, sondern als { ok: false, error } gemeldet:
 * ein fehlendes WASM darf die App nie lahmlegen.
 */
(function () {
  'use strict';

  const WASM_JS = 'office_wasm.js';
  const WASM_BIN = 'office_wasm_bg.wasm';

  let ladePromise = null;
  let geladen = false;
  let fehlerText = '';

  /* Das WASM liegt neben der Seite, nicht neben office-wasm/ -- scripts/build.js
   * kopiert es nach dist/. Basis aus dem Script-Tag nehmen, damit es auch
   * unter einem Unterpfad (/foo/) sitzt. */
  function basisAusDocument() {
    const s = document.querySelector('script[src*="office_wasm"], script[src*="office.bundle"]');
    if (!s || !s.src) return location.origin + '/';
    return s.src.replace(/[^/]*$/, '');
  }

  /* Lädt das Modul genau einmal. Nach dem Aufruf ist `mod` das
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
     * werden zu { ok: false } -- die Aufrufer im Office-View zeigen das an,
     * statt eine Exception in die Oberflaeche zu schieben. */
    async call(fnName, arg) {
      const mod = await lade();
      if (!mod) return { ok: false, error: 'Office-Engine nicht verfügbar: ' + (fehlerText || 'unbekannt') };
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

    docxToJson(bytes) { return Engine.call('docxToJson', bytesOf(bytes)); },
    jsonToDocx(json) { return Engine.call('jsonToDocx', String(json)); },
    xlsxToJson(bytes) { return Engine.call('xlsxToJson', bytesOf(bytes)); },
    jsonToXlsx(json) { return Engine.call('jsonToXlsx', String(json)); },
    pptxToJson(bytes) { return Engine.call('pptxToJson', bytesOf(bytes)); },
    jsonToPptx(json) { return Engine.call('jsonToPptx', String(json)); },

    /* Import-Hilfe: erkennt die Art und liefert { kind, json }. Federwerk
     * braucht das fuer Datei-Import; eine .docx darf nicht als Notizbuch
     * landen und umgekehrt. */
    async import(bytes) {
      const s = await Engine.sniff(bytes);
      if (!s.ok) return s;
      const kind = s.value.kind;
      if (!kind) return { ok: false, error: 'Keine Office-Datei erkannt.' };
      const r = kind === 'docx' ? await Engine.docxToJson(bytes)
        : kind === 'xlsx' ? await Engine.xlsxToJson(bytes)
        : await Engine.pptxToJson(bytes);
      if (!r.ok) return r;
      return { ok: true, kind, json: r.value };
    },

    /* Aus einem Blob eine Datei machen – fuer den Export-Download. */
    async dateiAusBytes(bytes, mime, name) {
      const buf = await asArrayBuffer(bytes);
      return new File([buf], name, { type: mime || 'application/octet-stream' });
    },

    async internals() {
      return { geladen, fehlerText, pfad: Engine.pfad() };
    },
  };

  if (typeof window !== 'undefined') window.FederwerkOfficeEngine = Engine;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { bytesOf, asArrayBuffer, WASM_JS, WASM_BIN };
  }
})();