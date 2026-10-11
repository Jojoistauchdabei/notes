/* Federwerk Craft-Bruecke (js/craft-bridge.js)
 *
 * Diese Datei laeuft NICHT in der App, sondern IM Craft-Verzeichnis
 * (dist/crafts/<id>/fw-bridge.js) – also im gleichen Dokument wie die
 * Upstream-App (WordCraft, GridCraft, DeckCraft, PhotoCraft …). Sie ist die
 * einzige Stelle, an der Fremd-App und Federwerk sich beruehren:
 *
 *   Laden   Federwerk schickt die Dokumentdatei herueber -> die Bruecke schiebt
 *           sie in die App (Drag-&-Drop-Ereignis, oder die Agent-API, falls die
 *           App eine anbietet: window.filmcraft.openProject).
 *   Speichern  Die App erzeugt beim Speichern/Exportieren einen Download
 *           (Blob-URL + <a download>.click()). Die Bruecke faengt genau diesen
 *           Klick ab, liest die Bytes und schickt sie an Federwerk – statt sie
 *           in den Download-Ordner zu legen. Damit landet die Datei in
 *           Federwerks Ablage (lokal + Server-Sync), ohne zweiten Weg.
 *   Start   Der Upstream-Build laedt sein WASM selbst (index.html des Releases).
 *           Ist eine Datei groesser als das 25-MiB-Limit von Cloudflare, legt
 *           scripts/build-crafts.js sie als .gz ab und haengt
 *           js/craft-gz-shim.js in die Seite – diese Bruecke bleibt davon
 *           unberuehrt und kennt aus engine.json nur Id, Tag und Dateinamen.
 *
 * Kommunikation mit der App-Seite (craft.html) laeuft ueber postMessage, weil
 * die Upstream-App in einem iframe liegt. Bewusst ohne Abhaengigkeiten und ohne
 * Annahmen ueber das Innenleben der Fremd-App: hier steht nur, was jede
 * Web-App im Browser anbietet.
 */
(function () {
  'use strict';

  const istRahmen = typeof window !== 'undefined' && window.parent && window.parent !== window;

  function post(nachricht) {
    try {
      if (istRahmen) window.parent.postMessage(Object.assign({ fw: 'craft' }, nachricht), '*');
    } catch { /* ohne Parent (Direktaufruf) passiert nichts */ }
  }

  /* ---- Engine-Metadaten -------------------------------------------------- */

  /* engine.json schreibt scripts/build-crafts.js neben die App: Id, Tag,
   * Dateinamen der Glue/WASM und ob die WASM gzip-komprimiert ausgeliefert wird
   * (dann ist js/craft-gz-shim.js in der Seite aktiv). Die Bruecke braucht das
   * nur, um zu wissen, WELCHE App laeuft – die Bytes holt sich die App selbst. */
  async function ladeEngine() {
    const antwort = await fetch('./engine.json', { cache: 'no-cache' });
    if (!antwort.ok) throw new Error('engine.json fehlt (Craft nicht gebaut?)');
    return antwort.json();
  }

  /* ---- Datei in die App bekommen ---------------------------------------- */

  function dateiAus(bytes, name, mime) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return new File([u8], name || 'dokument', { type: mime || 'application/octet-stream' });
  }

  /* Drag & Drop: Der zuverlaessigste Weg, Bytes in eine fremde Web-App zu
   * bekommen, ist der, den die Apps ohnehin unterstuetzen – ein Drop-Ereignis
   * mit DataTransfer. Die Apps (eframe/winit) lesen die Dateien selbst aus dem
   * Ereignis, es braucht also keine API im Fremdcode. */
  function perDrop(file) {
    if (typeof DataTransfer === 'undefined' || typeof DragEvent === 'undefined') return false;
    const dt = new DataTransfer();
    try { dt.items.add(file); } catch { return false; }
    const ziele = [document.querySelector('canvas'), document.body, window].filter(Boolean);
    for (const ziel of ziele) {
      for (const typ of ['dragenter', 'dragover', 'drop']) {
        let ev;
        try {
          ev = new DragEvent(typ, { bubbles: true, cancelable: true, dataTransfer: dt });
        } catch { return false; }
        ziel.dispatchEvent(ev);
      }
    }
    return true;
  }

  /* Manche Apps bieten eine eigene Agent-API an (im Upstream-Repo dokumentiert).
   * Wenn es sie gibt, ist sie der bessere Weg als ein simulierter Drop. */
  async function perApi(file) {
    const f = window.filmcraft;
    if (f && typeof f.openProject === 'function') {
      const url = URL.createObjectURL(file);
      try { await f.openProject(url); return true; }
      finally { setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* egal */ } }, 30000); }
    }
    return false;
  }

  async function oeffne(bytes, name, mime) {
    const file = dateiAus(bytes, name, mime);
    if (await perApi(file)) return 'api';
    if (perDrop(file)) return 'drop';
    throw new Error('Die App liess sich nicht oeffnen – Datei bitte von Hand hineinziehen.');
  }

  /* ---- Speichern abfangen ------------------------------------------------- */

  /* Die Upstream-Apps speichern ueber einen Browser-Download: Blob ->
   * URL.createObjectURL -> <a download>.click(). Genau dort wird abgegriffen.
   * Beide Haken werden gesetzt, bevor die App laeuft: createObjectURL merkt sich
   * die Blobs, der Klick-Haken liest sie aus und schickt sie an Federwerk. */
  function fangeDownloadsAb() {
    if (typeof URL === 'undefined' || !URL.createObjectURL) return;
    const blobs = new Map();

    const originalCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (obj) {
      const url = originalCreate(obj);
      try { if (obj && typeof obj.size === 'number') blobs.set(url, obj); } catch { /* egal */ }
      return url;
    };

    const originalRevoke = URL.revokeObjectURL ? URL.revokeObjectURL.bind(URL) : null;
    URL.revokeObjectURL = function (url) {
      try { blobs.delete(url); } catch { /* egal */ }
      if (originalRevoke) originalRevoke(url);
    };

    const A = typeof HTMLAnchorElement !== 'undefined' ? HTMLAnchorElement.prototype : null;
    if (!A || !A.click) return;
    const originalClick = A.click;
    A.click = function () {
      try {
        const name = this.getAttribute && this.getAttribute('download');
        const blob = this.href ? blobs.get(this.href) : null;
        if (name && blob && typeof blob.arrayBuffer === 'function') {
          const typ = blob.type || '';
          blob.arrayBuffer().then((buf) => {
            post({ art: 'save', name: name, mime: typ, bytes: new Uint8Array(buf) });
          }).catch(() => { /* dann eben normaler Download */ });
          // Klick schlucken: die Datei geht an Federwerk, nicht in den
          // Downloads-Ordner. Ein echter Export laeuft ueber den Knopf in der
          // Federwerk-Leiste (der laesst den Download absichtlich zu).
          return;
        }
      } catch { /* im Zweifel normal weiterreichen */ }
      return originalClick.apply(this, arguments);
    };
  }

  /* ---- Nachrichten der App-Seite ----------------------------------------- */

  function horche() {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    window.addEventListener('message', (ev) => {
      const d = ev && ev.data;
      if (!d || d.fw !== 'host') return;
      if (d.art === 'open') {
        Promise.resolve()
          .then(() => oeffne(d.bytes, d.name, d.mime))
          .then((weg) => post({ art: 'opened', name: d.name, weg: weg }))
          .catch((e) => post({ art: 'error', text: e && e.message ? e.message : String(e) }));
      }
    });
  }

  async function start() {
    horche();
    fangeDownloadsAb();
    let engine = null;
    try { engine = await ladeEngine(); }
    catch (e) { post({ art: 'error', text: String((e && e.message) || e) }); }
    post({ art: 'ready', id: engine ? engine.id : '', tag: engine ? engine.tag : '' });
  }

  if (typeof window !== 'undefined') {
    window.FederwerkCraftBridge = { oeffne, fangeDownloadsAb, ladeEngine, start };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { dateiAus };
})();
