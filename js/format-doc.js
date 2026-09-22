/* Federwerk-Notizformat (federwerk-1) – maschinenlesbare Format-Metadaten.
 *
 * Zweck (Aufgabe 5): JSON-Exporte sollen für KI-Chats selbsterklärend sein.
 * Dieses Modul liefert die Konstanten + den `_ai`-Hinweis, den
 * `js/app.js` (exportAllJSON/exportBookJSON) in jeden Export einbettet.
 * Doku für Menschen: FEDERWERK_FORMAT.md, Schema: federwerk.schema.json,
 * Einstieg für LLMs: llms.txt (alle im Repo-Root, via scripts/build-dist.js
 * nach dist/ kopiert).
 *
 * - Kein Build, plain <script> (global `GrimoireFormat`) + Node-export.
 * - DOM-frei, testbar (tests/format-doc.test.js).
 */
(function () {
  'use strict';

  // Format-Version aller JSON-Exporte (Gesamt + Einzelbuch).
  var FORMAT_VERSION = 'federwerk-1';
  // Relative Pfade (keine URLs – App ist offline-first, Dateien liegen neben dem Export).
  var SCHEMA_URL = './federwerk.schema.json';
  var FORMAT_DOC = './FEDERWERK_FORMAT.md';

  // Inline-Felderklärung (liegt auch in FEDERWERK_FORMAT.md, hier kompakt für _ai).
  function fieldDocs() {
    return {
      books: 'Array aller Notizbücher.',
      folders: 'Flache Ordnerliste {id,name}; Buch.folderId verweist darauf (null = Unsortiert).',
      openBookId: 'Zuletzt geöffnetes Buch (UI-Hinweis, optional).',
      openPageId: 'Zuletzt geöffnete Seite (UI-Hinweis, optional).',
      book: 'Ein Buch: {id,title,kind?,papers?,updatedAt,folderId,lang,pages[],cards?,deckOptions?}. paper = Papiervorlagen-ID, Buch-weit (Katalog js/paper-templates.js; Legacy ""|lined|grid = blank-a4|lined-a4|grid-a4). kind = notebook (Default, Feld darf fehlen) oder flashcards (Karteikarten-Deck, js/flashcards.js).',
      page: 'Eine Seite: {id,strokes[],texts[],images[],bg,size?}. Canvas-Default 1000x1414 px (A4); size={w,h} bei abweichendem Format (Vorlage/Bild/PDF), fehlt = A4.',
      strokes: 'Handschrift-Pfade: {tool:pen|marker,color,size,points[{x,y,p}]}. x/y in Canvas-px (0..1000, 0..1414), p = Stift-Druck 0..1 (optional, Default 0.5). tool=marker ist halbtransparenter Highlighter.',
      texts: 'Getippte Textboxen: {id,x,y,html}. x/y normiert 0..1 relativ zur Seite, html ist Rich-Text (h1/h2/b/i/u/listen, inline style).',
      images: 'Eingebettete Bilder: {id,x,y,w,src}. x/y/w normiert 0..1 (h aus Seitenverhältnis), src ist dataURL (data:image/...) oder blob:-Ref (nur App-intern auflösbar).',
      bg: 'Seiten-Hintergrund: dataURL-Bild oder null.',
      folderId: 'Ordner-ID des Buchs oder null (= Unsortiert).',
      kind: 'Dokumenttyp: notebook (Notizbuch, Default) oder flashcards (Karteikarten-Deck).',
      cards: 'Karteikarten (nur bei kind=flashcards): [{id,front,back,frontImg?,backImg?,ease,interval,reps,lapses,due,lastReview,suspended,totalReviews,correctReviews}]. front/back = Text (HTML light ok), Bilder als dataURL/blob:-Ref. SM-2: ease 1.3..2.8 (Start 2.5), interval in Tagen (0 = ~10 Min), due/lastReview als ms-Epoch.',
      deckOptions: 'Tages-Limits des Decks: {newPerDay (Default 20), maxReviewsPerDay (Default 100)}.'
    };
  }

  // Kompakter Lesehinweis für LLMs (wird als Export-Feld `_ai` eingebettet).
  function aiHint() {
    return {
      format: 'federwerk-notebook',
      version: FORMAT_VERSION,
      schema: SCHEMA_URL,
      doc: FORMAT_DOC,
      fields: fieldDocs(),
      promptHint: 'Dieses JSON ist ein Federwerk-Notizbuch (Handschrift-App, Canvas 1000x1414). '
        + 'Strokes sind Handschrift-Pfade (points mit x,y in Canvas-px, p = Druck 0..1). '
        + 'Texts enthalten getippten Rich-Text als html. Images verweisen per src auf dataURLs (data:image/...) oder App-interne blob:-URLs. '
        + 'bg ist der Seiten-Hintergrund (Bild-dataURL oder null). '
        + 'folderId ordnet Bücher Ordnern zu (null = Unsortiert). Details: FEDERWERK_FORMAT.md, Typen: federwerk.schema.json.'
    };
  }

  // Hängt $schema/formatVersion/formatDoc/_ai an ein Export-Objekt
  // (Gesamt-Export {books,folders,...} oder Einzelbuch {pages,...}).
  // Mutiert + gibt zurück (Fluent-Stil für JSON.stringify-Aufrufe).
  function attachFormatMeta(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    obj.$schema = SCHEMA_URL;
    obj.formatVersion = FORMAT_VERSION;
    obj.formatDoc = FORMAT_DOC;
    obj._ai = aiHint();
    return obj;
  }

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function checkPoint(p, path, errs) {
    if (!isObj(p)) { errs.push(path + ': Punkt muss {x,y} sein'); return; }
    if (typeof p.x !== 'number' || typeof p.y !== 'number') errs.push(path + ': x/y müssen Zahlen sein');
    if (p.p != null && typeof p.p !== 'number') errs.push(path + ': p (Druck) muss Zahl 0..1 sein');
  }

  function checkPage(pg, path, errs) {
    if (!isObj(pg)) { errs.push(path + ': Seite muss Objekt sein'); return; }
    for (const k of ['strokes', 'texts', 'images']) {
      if (pg[k] != null && !Array.isArray(pg[k])) errs.push(path + '.' + k + ' muss Array sein');
    }
    (pg.strokes || []).forEach((s, i) => {
      if (!isObj(s) || !Array.isArray(s.points)) { errs.push(path + '.strokes[' + i + ']: braucht points[]'); return; }
      s.points.forEach((pt, j) => checkPoint(pt, path + '.strokes[' + i + '].points[' + j + ']', errs));
    });
    (pg.texts || []).forEach((t, i) => {
      if (!isObj(t)) { errs.push(path + '.texts[' + i + ']: muss Objekt sein'); return; }
      if (typeof t.html !== 'string') errs.push(path + '.texts[' + i + '].html muss String sein');
    });
    (pg.images || []).forEach((im, i) => {
      if (!isObj(im)) { errs.push(path + '.images[' + i + ']: muss Objekt sein'); return; }
      if (typeof im.src !== 'string') errs.push(path + '.images[' + i + '].src muss String sein (dataURL/blob)');
    });
    if (pg.bg != null && typeof pg.bg !== 'string') errs.push(path + '.bg muss dataURL-String oder null sein');
  }

  function checkBook(b, path, errs) {
    if (!isObj(b)) { errs.push(path + ': Buch muss Objekt sein'); return; }
    if (!Array.isArray(b.pages)) { errs.push(path + '.pages muss Array sein'); return; }
    b.pages.forEach((pg, i) => checkPage(pg, path + '.pages[' + i + ']', errs));
  }

  // Minimale Hand-Validierung ohne Dependencies: gibt Fehler-Array zurück
  // (leer = ok). Akzeptiert Gesamt-Export ({books:[...]}) oder Einzelbuch ({pages:[...]}).
  function validateExport(obj) {
    const errs = [];
    if (!isObj(obj)) return ['Export muss Objekt sein'];
    if (Array.isArray(obj.books)) {
      obj.books.forEach((b, i) => checkBook(b, 'books[' + i + ']', errs));
      if (obj.folders != null && !Array.isArray(obj.folders)) errs.push('folders muss Array sein');
    } else if (Array.isArray(obj.pages)) {
      checkBook(obj, 'book', errs);
    } else {
      errs.push('Export braucht books[] (gesamt) oder pages[] (Einzelbuch)');
    }
    return errs;
  }

  var api = {
    FORMAT_VERSION: FORMAT_VERSION,
    SCHEMA_URL: SCHEMA_URL,
    FORMAT_DOC: FORMAT_DOC,
    fieldDocs: fieldDocs,
    aiHint: aiHint,
    attachFormatMeta: attachFormatMeta,
    validateExport: validateExport
  };

  if (typeof window !== 'undefined') window.GrimoireFormat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
