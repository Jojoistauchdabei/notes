'use strict';
// tests/craft-store.test.js – das Dokumentmodell der Craft-Dokumente.
// Geprueft wird die reine Logik: Anlegen, Titel-Nummerierung, Dateiname,
// Datei-Vermerk und die Anzeige-Daten der Bibliothekskarte.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Store = require('../js/craft-store.js');
const Catalog = require('../js/craft-catalog.js');

const buch = (titel, craftId) => Store.create(craftId || 'wordcraft', titel);

describe('craft-store: erkennen', () => {
  it('erkennt Craft-Dokumente und laesst alles andere in Ruhe', () => {
    assert.equal(Store.isCraftBook(Store.create('wordcraft')), true);
    assert.equal(Store.isCraftBook({ id: 'b', pages: [], kind: 'notebook' }), false);
    assert.equal(Store.isCraftBook({ id: 'b', kind: 'flashcards', cards: [] }), false);
    assert.equal(Store.isCraftBook({ id: 'b', kind: 'craft' }), false, 'ohne craft-Feld kein Craft-Dokument');
    assert.equal(Store.isCraftBook({ id: 'b', kind: 'craft', craft: { id: 'gibtsnicht' } }), false,
      'unbekannte App zaehlt nicht');
    assert.equal(Store.isCraftBook(null), false);
    assert.equal(Store.isCraftBook(undefined), false);
  });

  it('liefert die App-Id', () => {
    assert.equal(Store.craftIdOf(Store.create('photocraft')), 'photocraft');
    assert.equal(Store.craftIdOf({ id: 'b' }), null);
  });
});

describe('craft-store: anlegen', () => {
  it('nimmt Endung und MIME aus dem Katalog', () => {
    const b = Store.create('wordcraft', 'Bericht');
    assert.equal(b.kind, 'craft');
    assert.equal(b.title, 'Bericht');
    assert.deepEqual(b.pages, [], 'keine Handschriftseiten');
    assert.equal(b.craft.id, 'wordcraft');
    assert.equal(b.craft.ext, 'docx');
    assert.match(b.craft.mime, /wordprocessingml/);
    assert.equal(b.craft.file, null, 'neue Dokumente haben noch keine Datei');
    assert.equal(b.craft.name, 'Bericht.docx');
  });

  it('kennt den Anzeigenamen je App', () => {
    assert.equal(Store.docLabel('wordcraft'), 'Dokument');
    assert.equal(Store.docLabel('gridcraft'), 'Tabelle');
    assert.equal(Store.docLabel('deckcraft'), 'Präsentation');
    assert.equal(Store.docLabel('unbekannt'), 'Dokument');
  });

  it('legt kein Dokument fuer eine unbekannte App an', () => {
    assert.throws(() => Store.create('nichtda', 'X'), /Unbekannter Craft/);
  });

  it('nimmt eine vorgegebene Endung an (Import einer CSV in GridCraft)', () => {
    const b = Store.create('gridcraft', 'Liste', { ext: 'csv', name: 'liste.csv' });
    assert.equal(b.craft.ext, 'csv');
    assert.equal(b.craft.mime, 'text/csv');
    assert.equal(b.craft.name, 'liste.csv');
  });
});

describe('craft-store: Titel-Nummerierung', () => {
  it('zaehlt von 1, wenn noch keins da ist', () => {
    assert.equal(Store.nextNumber([], 'wordcraft'), 1);
  });

  it('nimmt nach der hoechsten Nummer die naechste', () => {
    assert.equal(Store.nextNumber([buch('Dokument 1'), buch('Dokument 2')], 'wordcraft'), 3);
  });

  it('faengt Luecken auf', () => {
    // Dokument 1 und 2 geloescht, Dokument 3 lebt: es muss 4 werden, nicht 2.
    assert.equal(Store.nextNumber([buch('Dokument 3')], 'wordcraft'), 4);
  });

  it('zaehlt je App getrennt', () => {
    const buecher = [buch('Dokument 1'), buch('Tabelle 1', 'gridcraft'), buch('Dokument 2')];
    assert.equal(Store.nextNumber(buecher, 'wordcraft'), 3);
    assert.equal(Store.nextNumber(buecher, 'gridcraft'), 2);
  });

  it('vermeidet "Dokument" neben "Dokument 1"', () => {
    assert.equal(Store.nextNumber([buch('Dokument'), buch('Dokument 1')], 'wordcraft'), 2);
  });

  it('ignoriert Notizbuecher und Decks', () => {
    const buecher = [
      { title: 'Dokument 1', pages: [] },
      { title: 'Tabelle 1', kind: 'flashcards', cards: [] },
      buch('Dokument 2'),
    ];
    assert.equal(Store.nextNumber(buecher, 'wordcraft'), 3);
  });

  it('vertraegt kaputte Eintraege', () => {
    assert.equal(Store.nextNumber([null, undefined, { title: 'Dokument 4' }, buch('Dokument 1')], 'wordcraft'), 2);
  });

describe('craft-store: Datei und Anzeige', () => {
  it('vermerkt die abgelegte Datei', () => {
    const b = buch('Dokument 1');
    Store.setFile(b, { ref: 'blob:abc', size: 4096 });
    assert.equal(b.craft.file, 'blob:abc');
    assert.equal(b.craft.size, 4096);
    assert.ok(b.craft.savedAt > 0);
    assert.equal(b.craft.name, 'Dokument 1.docx', 'Dateiname bleibt der Titel');
  });

  it('uebernimmt Name und Endung aus der App', () => {
    const b = buch('Dokument 1');
    Store.setFile(b, { ref: 'blob:abc', size: 10, name: 'Bericht final.docx', ext: 'docx' });
    assert.equal(b.craft.name, 'Bericht final.docx');
  });

  it('beschreibt die Bibliothekskarte', () => {
    const b = buch('Dokument 1');
    const leer = Store.describe(b);
    assert.equal(leer.label, 'Word');
    assert.equal(leer.icon, '📄');
    assert.equal(leer.hasFile, false);
    assert.match(leer.preview, /noch nicht gespeichert/);
    Store.setFile(b, { ref: 'blob:abc', size: 2048 });
    const voll = Store.describe(b);
    assert.equal(voll.hasFile, true);
    assert.equal(voll.sizeText, '2.0 KB');
    assert.match(voll.preview, /2\.0 KB · DOCX/);
    assert.equal(voll.fileName, 'Dokument 1.docx');
  });

  it('beschreibt fremde Buecher nicht', () => {
    assert.equal(Store.describe({ id: 'b', pages: [] }), null);
  });

  it('macht aus dem Titel einen brauchbaren Dateinamen', () => {
    assert.equal(Store.fileNameFor({ title: 'Quartal 3/4 Plan', craft: { ext: 'xlsx' } }), 'Quartal 3-4 Plan.xlsx');
    assert.equal(Store.fileNameFor({ title: '   ', craft: { ext: 'docx' } }), 'Dokument.docx');
  });

  it('formatiert Groessen lesbar', () => {
    assert.equal(Store.sizeText(0), '—');
    assert.equal(Store.sizeText(512), '512 B');
    assert.equal(Store.sizeText(2048), '2.0 KB');
    assert.equal(Store.sizeText(3 * 1024 * 1024), '3.0 MB');
  });

  it('erkennt serverfaehige Refs', () => {
    assert.equal(Store.isSyncedRef('awfile:' + 'a'.repeat(64)), true);
    assert.equal(Store.isSyncedRef('blob:abc'), false);
    assert.equal(Store.isSyncedRef(null), false);
  });
});

describe('craft-store: Katalog-Bezug', () => {
  it('bietet fuer jede App im Katalog ein Dokument an', () => {
    for (const c of Catalog.CRAFTS) {
      const b = Store.create(c.id, 'Probe');
      assert.equal(b.craft.ext, c.exts[0], c.id + ': falsche Startendung');
      assert.equal(b.craft.mime, c.mime, c.id + ': falscher MIME-Typ');
      assert.ok(Store.docLabel(c.id));
    }
  });
});


  it('maskiert Sonderzeichen im Label', () => {
    assert.equal(Store.nextNumber([buch('PDF 2', 'pdfcraft')], 'pdfcraft', 'PDF'), 3);
  });
});
