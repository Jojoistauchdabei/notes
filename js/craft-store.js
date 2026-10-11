/* Federwerk Craft-Dokumente (js/craft-store.js)
 *
 * Ein Craft-Dokument ist ein Buch mit `craft`-Feld – kein eigener Bestand:
 * Ordner, Suche, Duplizieren, Loeschen und der Server-Sync laufen unveraendert
 * mit (derselbe Weg wie bei Karteikarten-Decks ueber `kind: 'flashcards'`).
 *
 * Der Unterschied zu Notizbuechern und Decks: der Inhalt ist KEIN JSON-Modell,
 * sondern eine Datei – DOCX, XLSX, PPTX, PSD, SVG, IDML, PDF, DXF, WAV … Genau
 * die Datei, die die Upstream-App (WordCraft, GridCraft, DeckCraft, PhotoCraft
 * …) schreibt. Gespeichert wird sie wie jedes andere Bild oder PDF in
 * Federwerk:
 *
 *   lokal  `blob:<id>`   (IndexedDB ueber GrimoireStore.putBlob)
 *   Server `awfile:<sha256>` (content-adressiert, Dedupe, js/appwrite-files.js)
 *
 * Der Sync tauscht die beiden Refs beim Push/Pull gegeneinander aus
 * (js/appwrite-sync.js, Envelope v3) – dadurch liegt die Datei auf dem Server
 * und wird mit den anderen Dokumenten mitgezogen, ohne zweiten Weg.
 *
 * Bewusst DOM-frei: alles hier ist in Node testbar.
 */
(function () {
  'use strict';

  const KIND = 'craft';

  function catalog() {
    if (typeof window !== 'undefined' && window.FederwerkCraftCatalog) return window.FederwerkCraftCatalog;
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try { return require('./craft-catalog.js'); } catch { /* Browser ohne require */ }
    }
    return null;
  }

  function uid() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }

  function isCraftBook(b) {
    if (!b || typeof b !== 'object' || b.kind !== KIND) return false;
    const c = catalog();
    return !!(b.craft && b.craft.id && (!c || c.byId(b.craft.id)));
  }

  function craftIdOf(b) {
    return isCraftBook(b) ? b.craft.id : null;
  }

  /* Anzeigename eines neuen Dokuments ("Dokument 1", "Tabelle 2", ...).
   * Bewusst ohne Markenname im Titel: "Word 1" waere eine Markenaussage, die
   * das Dokument nicht braucht – der Badge zeigt die App. */
  const DOC_LABEL = {
    wordcraft: 'Dokument', gridcraft: 'Tabelle', deckcraft: 'Präsentation',
    pdfcraft: 'PDF', photocraft: 'Bild', vectorcraft: 'Vektor',
    designcraft: 'Layout', lightcraft: 'Foto', filmcraft: 'Schnitt',
    effectcraft: 'Composition', cadcraft: 'Zeichnung', soundcraft: 'Audio',
  };

  function docLabel(craftId) {
    return DOC_LABEL[craftId] || 'Dokument';
  }

  /* Naechste freie Nummer fuer einen Titel dieser Art.
   *
   * Warum nicht einfach zaehlen: nach dem Loeschen entstanden doppelte Namen
   * (Dokument 1 und 2 geloescht, Dokument 3 lebt -> wieder "Dokument 1").
   * Deshalb die hoechste vergebene Nummer suchen und hochzaehlen; ein Titel
   * exakt ohne Zahl zaehlt als 1. */
  function nextNumber(books, craftId, label) {
    const basis = String(label || docLabel(craftId));
    const re = new RegExp('^' + basis.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+(\\d+)$');
    let max = 0;
    for (const b of books || []) {
      if (!isCraftBook(b) || b.craft.id !== craftId) continue;
      const t = String(b.title || '').trim();
      const m = re.exec(t);
      if (m) max = Math.max(max, parseInt(m[1], 10));
      else if (t === basis) max = Math.max(max, 1);
    }
    return max + 1;
  }


  /* Neues Craft-Dokument. `file: null` heisst: noch keine Datei da (die App
   * legt beim ersten Speichern eine an). */
  function create(craftId, title, opts) {
    const c = catalog();
    const craft = c && c.byId(craftId);
    if (!craft) throw new Error('Unbekannter Craft: ' + craftId);
    const o = opts || {};
    const ext = String(o.ext || c.primaryExt(craft)).toLowerCase();
    const b = {
      id: o.id || uid(),
      kind: KIND,
      title: String(title || (docLabel(craftId) + ' 1')).slice(0, 200),
      updatedAt: Number(o.updatedAt) || Date.now(),
      folderId: o.folderId == null ? null : o.folderId,
      pages: [],
      craft: {
        id: craft.id,
        ext,
        mime: String(o.mime || c.mimeFor(craft, ext)),
        name: String(o.name || ''),
        file: null,
        size: 0,
        savedAt: 0,
      },
    };
    b.craft.name = b.craft.name || fileNameFor(b);
    return b;
  }

  /* Dateiname im Export/Download. Nur Zeichen, die auf allen Plattformen
   * Aerger machen, werden ersetzt – Umlaute bleiben. */
  function fileNameFor(b, ext) {
    const craft = (b && b.craft) || {};
    const e = String(ext || craft.ext || 'bin');
    const roh = String((b && b.title) || 'Dokument')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 80);
    return (roh || 'Dokument') + '.' + e;
  }

  /* Datei am Dokument vermerken. `ref` ist die lokale Blob-Ref; auf dem Weg zum
   * Server wird daraus `awfile:<sha>` (js/appwrite-sync.js). */
  function setFile(b, input) {
    if (!isCraftBook(b)) return null;
    const i = input || {};
    b.craft.file = i.ref ? String(i.ref) : null;
    b.craft.size = Math.max(0, Number(i.size) || 0);
    if (i.ext) b.craft.ext = String(i.ext).toLowerCase().replace(/^\./, '');
    if (i.mime) b.craft.mime = String(i.mime);
    if (i.name) b.craft.name = String(i.name);
    else b.craft.name = fileNameFor(b);
    b.craft.savedAt = Number(i.savedAt) || Date.now();
    b.updatedAt = Date.now();
    return b;
  }

  function sizeText(bytes) {
    const n = Number(bytes) || 0;
    if (!n) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /* Alles, was die Bibliothekskarte und der Kopf der Ansicht brauchen. */
  function describe(b) {
    const c = catalog();
    const craft = c && b && b.craft ? c.byId(b.craft.id) : null;
    if (!craft) return null;
    const f = b.craft;
    return {
      id: craft.id,
      name: craft.name,
      label: craft.label,
      vendor: craft.vendor,
      icon: craft.icon,
      color: craft.color,
      kind: craft.kind,
      ext: f.ext,
      mime: f.mime,
      fileName: f.name || fileNameFor(b),
      size: f.size || 0,
      sizeText: sizeText(f.size),
      hasFile: !!f.file,
      savedAt: f.savedAt || 0,
      preview: (f.size ? sizeText(f.size) + ' · ' : '') + String(f.ext || '').toUpperCase() +
        (f.savedAt ? ' · gespeichert' : ' · noch nicht gespeichert'),
    };
  }

  /* Ist die Ref schon serverfaehig (Push erledigt)? Wird von der Ansicht fuer
   * den Status "auf dem Server" benutzt. */
  function isSyncedRef(ref) {
    return typeof ref === 'string' && ref.indexOf('awfile:') === 0;
  }

  const CraftStore = {
    KIND, DOC_LABEL, isCraftBook, craftIdOf, docLabel, nextNumber, create, setFile,
    fileNameFor, describe, sizeText, isSyncedRef,
    _internals: { catalog, uid },
  };

  if (typeof window !== 'undefined') window.FederwerkCraftStore = CraftStore;
  if (typeof module !== 'undefined' && module.exports) module.exports = CraftStore;
})();
