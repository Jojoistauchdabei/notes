/* Federwerk Craft-Ansicht (js/craft-ui.js)
 *
 * Die Oberflaeche fuer Craft-Dokumente: das "+ Neu"-Menue, die Ansicht
 * #viewCraft (Upstream-App im iframe) und der Weg der Datei in Federwerks
 * Ablage.
 *
 * Warum ein iframe und kein direktes Einbetten: die Upstream-Apps sind
 * eigenstaendige Seiten mit eigenem Canvas, eigenen Workern und eigenen
 * globalen Namen. Im iframe bleiben sie genau das – nichts kollidiert mit
 * Federwerk. Gleich-origin bleibt es trotzdem (eigene Dateien unter /crafts/),
 * nur deshalb greift der Service Worker und nur deshalb darf die App-Seite die
 * Seite ansprechen.
 *
 * Der Datenaustausch laeuft ueber postMessage an js/craft-bridge.js:
 *   hin      { fw:'host',  art:'open', bytes, name, mime }
 *   zurueck  { fw:'craft', art:'ready' | 'opened' | 'save' | 'error' }
 *
 * Speichern: Die App schickt beim Speichern/Exportieren die Bytes; sie werden
 * wie jede andere Datei abgelegt (GrimoireStore.putBlob -> blob:<id>, danach
 * Server-Sync, der daraus awfile:<sha> macht). Damit liegt das Dokument auf dem
 * Server und wird mit allen anderen Dokumenten mitgezogen.
 */
(function () {
  'use strict';

  const VIEW = 'viewCraft';
  const CRAFT_NEW_ID = 'newCraftBtn';
  const CRAFT_MENU_ID = 'newCraftMenu';
  const CRAFT_BACK_ID = 'craftBack';
  const CRAFT_EXPORT_ID = 'craftExport';
  const CRAFT_IMPORT_ID = 'craftImport';
  const CRAFT_FILE_ID = 'craftFile';
  const FRAME_TIMEOUT_MS = 12000;

  let zustand = { bookId: null, craftId: null, bereit: false, wartend: null, uhr: null };

  function $(id) { return document.getElementById(id); }
  function catalog() { return window.FederwerkCraftCatalog; }
  function store() { return window.FederwerkCraftStore; }

  function buch(id) {
    const gesucht = id || zustand.bookId;
    try { return (window.state.books || []).find((b) => b && b.id === gesucht) || null; }
    catch { return null; }
  }

  function sage(text, art) {
    const el = $('craftStatus');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'fw-craft-status' + (art ? ' fw-craft-status-' + art : '');
  }

  /* ---- Datei holen ------------------------------------------------------- */

  /* Lokale Blob-Ref oder Server-Ref (awfile:<sha>) in Bytes verwandeln. Beide
   * Wege sind die, die Federwerk auch fuer Bilder und PDFs geht. */
  async function bytesAusRef(ref) {
    if (!ref) return null;
    if (typeof ref === 'string' && ref.indexOf('awfile:') === 0) {
      const F = window.FederwerkFiles;
      if (!F) throw new Error('Datei liegt nur auf dem Server (js/appwrite-files.js fehlt).');
      const h = ref.slice('awfile:'.length);
      const { bytes } = await F.downloadEntry(h);
      return new Uint8Array(bytes);
    }
    const S = window.GrimoireStore;
    if (!S) throw new Error('Lokaler Speicher nicht verfuegbar.');
    const du = await S.dataUrl(ref);
    if (!du) return null;
    const F = window.FederwerkFiles;
    if (F && F.dataUrlToBytes) return F.dataUrlToBytes(du).bytes;
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(du);
    if (!m) return null;
    return m[2]
      ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(m[3]));
  }

  /* ---- Engine vorhanden? ------------------------------------------------- */

  /* Ohne gebaute Engine (dist/crafts/<id>/) laeuft die App nicht. Das wird VOR
   * dem iframe geprueft, damit die Ansicht eine Erklaerung zeigt statt einer
   * weissen Flaeche. */
  async function engineVorhanden(craftId) {
    try {
      const r = await fetch('crafts/' + craftId + '/engine.json', { cache: 'no-cache' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  function zeigeFehlendeEngine(craft, engine) {
    const box = $('craftMissing');
    if (!box) return;
    const tag = engine && engine.tag ? ' (Upstream ' + engine.tag + ')' : '';
    box.innerHTML = '<div class="fw-craft-missing-inner">'
      + '<h3>' + craft.icon + ' ' + craft.name + ' ist nicht eingebaut' + tag + '</h3>'
      + '<p>Die Engine ist ein WebAssembly-Build aus dem Upstream-Release und wird beim Bauen nach '
      + '<code>dist/crafts/' + craft.id + '/</code> geholt (<code>node scripts/build-crafts.js</code>). '
      + 'Im Cloudflare-Deploy steckt sie im Web-ZIP; im lokalen Checkout fehlt sie, solange nicht gebaut wurde.</p>'
      + '<p class="fw-craft-hint">Upstream: <code>' + craft.repo + '</code></p>'
      + '</div>';
    box.hidden = false;
  }


  /* ---- Ansicht ----------------------------------------------------------- */

  function zeigeAnsicht() {
    document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'));
    const v = $(VIEW);
    if (v) v.classList.add('active');
  }

  function setzeKopf(b, craft) {
    const d = store().describe(b);
    const t = $('craftTitle');
    if (t) t.textContent = b.title || d.fileName;
    const k = $('craftKind');
    if (k) {
      k.textContent = craft.icon + ' ' + craft.label;
      k.style.borderColor = craft.color;
      k.style.color = craft.color;
      k.title = craft.vendor + ' (' + craft.name + ')';
    }
    const v = $(VIEW);
    if (v) v.dataset.craft = craft.id;
  }

  async function open(craftId, bookId) {
    const C = catalog();
    const S = store();
    const craft = C.byId(craftId);
    const b = (window.state.books || []).find((x) => x && x.id === bookId) || null;
    if (!craft || !b) { if (typeof showLibrary === 'function') showLibrary(); return; }

    zustand = { bookId: b.id, craftId: craft.id, bereit: false, wartend: null, uhr: null };
    setzeKopf(b, craft);
    zeigeAnsicht();

    const box = $('craftMissing');
    if (box) { box.hidden = true; box.innerHTML = ''; }
    const frame = $('craftFrame');
    const engine = await engineVorhanden(craft.id);
    if (!engine) {
      if (frame) { frame.hidden = true; frame.removeAttribute('src'); }
      zeigeFehlendeEngine(craft, null);
      sage('Engine fehlt – das Dokument bleibt gespeichert, bearbeiten geht ohne Engine nicht.', 'warn');
      return;
    }
    if (frame) {
      frame.hidden = false;
      if (frame.dataset.geladen !== craft.id) {
        frame.dataset.geladen = craft.id;
        frame.src = 'crafts/' + craft.id + '/index.html';
      } else {
        try { frame.contentWindow.location.reload(); } catch { /* erster Aufbau */ }
      }
    }
    sage('Wird geladen …');
    /* Fallback-Uhr: meldet sich die Bruecke nicht, ist die Seite zwar da, die
     * App startet aber nicht (z. B. kein WebGPU/WebGL2). Dann sagen wir das,
     * statt ewig "Wird geladen" zu zeigen. */
    if (zustand.uhr) clearTimeout(zustand.uhr);
    zustand.uhr = setTimeout(() => {
      if (!zustand.bereit) {
        sage('Die App meldet sich nicht. Sie braucht WebGPU oder WebGL2 (aktuelles Chrome, Edge oder Firefox).', 'warn');
      }
    }, FRAME_TIMEOUT_MS);

    /* Die Datei schon jetzt holen: sie wird beim "ready" hineingeschoben. */
    if (b.craft.file) {
      try {
        const bytes = await bytesAusRef(b.craft.file);
        if (bytes && bytes.length) {
          zustand.wartend = { bytes, name: b.craft.name || S.fileNameFor(b), mime: b.craft.mime };
        }
      } catch (e) {
        sage('Datei liess sich nicht laden: ' + (e && e.message ? e.message : e), 'warn');
      }
    }
  }

  function schiebeDateiHinein() {
    const frame = $('craftFrame');
    if (!frame || !frame.contentWindow || !zustand.wartend) return;
    const w = zustand.wartend;
    frame.contentWindow.postMessage({ fw: 'host', art: 'open', bytes: w.bytes, name: w.name, mime: w.mime }, '*');
    sage('Datei wird an ' + (catalog().byId(zustand.craftId) || {}).name + ' uebergeben …');
  }

  /* ---- Speichern --------------------------------------------------------- */

  /* Bytes als Dokumentdatei ablegen: lokal als Blob-Ref, dann Sync (der Push
   * macht awfile:<sha> daraus). `exportieren` laedt die Datei zusaetzlich als
   * Download herunter – das ist der ausdrueckliche Export-Knopf, nicht der
   * automatische Weg beim Speichern in der App. */
  async function ablegen(bytes, name, mime, exportieren) {
    const S = store();
    const C = catalog();
    const b = buch();
    if (!b) return;
    const craft = C.byId(zustand.craftId);
    const ext = C.extOf(name || '') || b.craft.ext || C.primaryExt(craft);
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    try {
      const blob = new Blob([u8], { type: mime || C.mimeFor(craft, ext) });
      const ref = await window.GrimoireStore.putBlob(blob);
      S.setFile(b, {
        ref: ref, size: u8.length, name: name || S.fileNameFor(b, ext),
        ext: ext, mime: mime || C.mimeFor(craft, ext),
      });
      if (typeof touchBook === 'function') touchBook();
      if (typeof persistNow === 'function') persistNow();
      if (typeof renderLibrary === 'function') renderLibrary();
      sage('In Federwerk gespeichert (' + S.sizeText(u8.length) + ') – der Sync uebernimmt den Rest.', 'ok');
      if (exportieren) herunterladen(u8, b.craft.name, b.craft.mime);
      /* Sync anstossen, aber nicht blockieren: er meldet seine Fehler selbst
       * und die Ansicht bleibt bedienbar. */
      try {
        if (window.FederwerkSync && typeof window.FederwerkSync.syncNow === 'function') window.FederwerkSync.syncNow();
      } catch { /* egal */ }
    } catch (e) {
      sage('Speichern fehlgeschlagen: ' + (e && e.message ? e.message : e), 'warn');
    }
  }

  function herunterladen(bytes, name, mime) {
    const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'dokument';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* egal */ } }, 10000);
  }

  /* Export-Knopf: die abgelegte Datei noch einmal als Download. */
  async function exportiere(bookId) {
    const b = buch(bookId);
    if (!b || !b.craft.file) { sage('Noch keine Datei vorhanden – zuerst in der App speichern.', 'warn'); return; }
    try {
      const bytes = await bytesAusRef(b.craft.file);
      herunterladen(bytes, b.craft.name, b.craft.mime);
      sage('Datei heruntergeladen: ' + b.craft.name);
    } catch (e) {
      sage('Export fehlgeschlagen: ' + (e && e.message ? e.message : e), 'warn');
    }
  }

  /* Import: eine bestehende Datei in ein neues Craft-Dokument legen. Die Art
   * ergibt sich aus der Endung (Katalog), nicht aus einer Auswahlliste. */
  async function importiere(file) {
    const C = catalog();
    const S = store();
    const craft = C.forFileName(file.name);
    if (!craft) { sage('Unbekannte Dateiendung: ' + file.name, 'warn'); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const b = S.create(craft.id, S.docLabel(craft.id) + ' ' + S.nextNumber(window.state.books, craft.id), { name: file.name });
    try {
      const ref = await window.GrimoireStore.putBlob(new Blob([bytes], { type: file.type || craft.mime }));
      S.setFile(b, { ref: ref, size: bytes.length, name: file.name, ext: C.extOf(file.name), mime: file.type || craft.mime });
    } catch { /* ohne Blob-Store bleibt das Dokument ohne Datei */ }
    try {
      if (activeFolderId && activeFolderId !== 'all' && activeFolderId !== 'unsorted'
        && (window.state.folders || []).some((f) => f.id === activeFolderId)) {
        b.folderId = activeFolderId;
      }
    } catch { /* ohne Ordner */ }
    window.state.books.unshift(b);
    if (typeof persistNow === 'function') persistNow();
    if (typeof renderLibrary === 'function') renderLibrary();
    open(craft.id, b.id);
  }

  /* ---- Nachrichten der Bruecke ------------------------------------------ */

  function horcheAufBruecke() {
    window.addEventListener('message', (ev) => {
      const d = ev && ev.data;
      if (!d || d.fw !== 'craft') return;
      if (d.art === 'ready') {
        zustand.bereit = true;
        if (zustand.uhr) clearTimeout(zustand.uhr);
        sage('Bereit. In der App speichern (Strg+S) – die Datei landet automatisch in Federwerk.');
        schiebeDateiHinein();
      } else if (d.art === 'opened') {
        sage('Datei geoeffnet (' + (d.weg === 'api' ? 'Agent-API' : 'Drag & Drop') + ').', 'ok');
      } else if (d.art === 'save') {
        ablegen(d.bytes, d.name, d.mime, false);
      } else if (d.art === 'error') {
        sage(d.text || 'Unbekannter Fehler in der Craft-App.', 'warn');
      }
    });
  }

  /* ---- Menue und Anlegen ------------------------------------------------ */

  /* Das "+ Neu"-Menue wird aus dem Katalog gebaut, nicht im HTML gepflegt:
   * eine neue Upstream-App ist damit eine Zeile in js/craft-catalog.js und
   * erscheint sofort in der Leiste. Crafts ohne eigenes Dateiformat (LightCraft)
   * tauchen nicht auf – dort gibt es nichts anzulegen, nur zu importieren. */
  function baueMenue() {
    const box = $('newCraftMenu');
    const C = catalog();
    if (!box || !C) return;
    const gruppen = [['office', 'Office'], ['adobe', 'Adobe- und andere Klone']];
    let html = '';
    for (const [key, titel] of gruppen) {
      const liste = C.CRAFTS.filter((c) => c.group === key && c.create !== false);
      if (!liste.length) continue;
      html += '<div class="fw-new-craft-group">' + titel + '</div>';
      for (const c of liste) {
        html += '<button type="button" class="fw-new-craft-item" data-craft="' + c.id + '"'
          + ' title="' + c.vendor + ' (' + c.name + ') – ' + c.note + '">'
          + '<span class="fw-new-craft-icon" style="color:' + c.color + '">' + c.icon + '</span>'
          + '<span>' + c.label + '</span>'
          + '<span class="fw-new-craft-ext">.' + c.exts[0] + '</span>'
          + '</button>';
      }
    }
    html += '<div class="fw-new-craft-group">Import</div>'
      + '<button type="button" class="fw-new-craft-item" id="newCraftImport">'
      + '<span class="fw-new-craft-icon">📥</span><span>Datei öffnen</span></button>';
    box.innerHTML = html;
    box.querySelectorAll('[data-craft]').forEach((el) => {
      el.addEventListener('click', () => { schliesseMenue(); createDoc(el.dataset.craft); });
    });
    const imp = $('newCraftImport');
    if (imp) imp.addEventListener('click', () => { schliesseMenue(); $('craftFile').click(); });
  }

  function schliesseMenue() {
    const box = $('newCraftMenu');
    const btn = $('newCraftBtn');
    if (box) box.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function toggleMenue(ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    const box = $('newCraftMenu');
    const btn = $('newCraftBtn');
    if (!box) return;
    if (box.hidden) { baueMenue(); box.hidden = false; if (btn) btn.setAttribute('aria-expanded', 'true'); }
    else schliesseMenue();
  }

  /* Neues Dokument anlegen und direkt oeffnen. Landet wie ein Notizbuch im
   * aktiven Ordner. */
  function createDoc(craftId) {
    const C = catalog();
    const S = store();
    const craft = C.byId(craftId);
    if (!craft) return null;
    const b = S.create(craftId, S.docLabel(craftId) + ' ' + S.nextNumber(window.state.books, craftId));
    try {
      if (activeFolderId && activeFolderId !== 'all' && activeFolderId !== 'unsorted'
        && (window.state.folders || []).some((f) => f.id === activeFolderId)) {
        b.folderId = activeFolderId;
      }
    } catch { /* ohne Ordner */ }
    window.state.books.unshift(b);
    if (typeof persistNow === 'function') persistNow();
    if (typeof renderLibrary === 'function') renderLibrary();
    open(craftId, b.id);
    return b;
  }

  /* Badge fuer die Bibliothekskarte (app.js baut die Karte). */
  function badgeHtml(b) {
    const C = catalog();
    if (!C || !b || !b.craft) return '';
    const craft = C.byId(b.craft.id);
    if (!craft) return '';
    return '<span class="fw-craft-badge" style="--fw-craft-color:' + craft.color + '" title="'
      + craft.vendor + ' (' + craft.name + ')">' + craft.icon + ' ' + craft.label + '</span>';
  }

  /* ---- Verdrahtung der Leiste ------------------------------------------- */

  /* Die Knoepfe der Ansicht haengen hier, nicht in app.js: die Craft-Ansicht ist
   * ein eigener Baustein (wie der Markdown-Editor), app.js soll dafuer nicht
   * wachsen. Laeuft erst nach dem DOM-Aufbau – craft-ui.js wird vor app.js
   * geladen, showLibrary() gibt es also erst zur Laufzeit. */
  function wire() {
    const back = $(CRAFT_BACK_ID);
    if (back) back.addEventListener('click', () => {
      const v = $(VIEW);
      if (v) v.classList.remove('active');
      if (typeof showLibrary === 'function') showLibrary();
    });
    const exp = $(CRAFT_EXPORT_ID);
    if (exp) exp.addEventListener('click', () => exportiere());
    const imp = $(CRAFT_IMPORT_ID);
    if (imp) imp.addEventListener('click', () => { const f = $(CRAFT_FILE_ID); if (f) f.click(); });
    const file = $(CRAFT_FILE_ID);
    if (file) file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (f) importiere(f);
    });
    baueMenue();
    /* Klick daneben schliesst das Menue – sonst bleibt es offen, wenn man
     * woanders in der Bibliothek arbeitet. */
    document.addEventListener('click', (ev) => {
      const box = $(CRAFT_MENU_ID);
      const btn = $(CRAFT_NEW_ID);
      if (!box || box.hidden) return;
      if (box.contains(ev.target) || (btn && btn.contains(ev.target))) return;
      schliesseMenue();
    });
  }

  /* ---- Oeffentliche Schnittstelle --------------------------------------- */

  const CraftUI = {
    open, exportiere, importiere, ablegen, wire, createDoc, toggleMenue, schliesseMenue, baueMenue, badgeHtml,
    currentCraft: () => zustand.craftId,
    _internals: { bytesAusRef, engineVorhanden, horcheAufBruecke, zustand },
  };

  if (typeof window !== 'undefined') {
    window.FederwerkCraftUI = CraftUI;
    const starte = () => { horcheAufBruecke(); wire(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', starte);
    else starte();
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = CraftUI;
})();

