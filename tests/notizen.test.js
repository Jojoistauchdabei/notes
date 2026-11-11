'use strict';
/* Integrationstest gegen die reale Beispieldatei Notizen.goodnotes
   (tests/fixtures/Notizen.goodnotes, mit dem goodnotesmcp erzeugt):
   Import (parseDocument + mapPage) und Export-Roundtrip
   (Federwerk-Buch -> exportGoodNotes -> Re-Import) muessen fehlerfrei
   durchlaufen und alle Inhalte ueberleben. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const GNZip = require('../js/gnzip.js');
const GoodNotes = require('../js/goodnotes.js');

const SAMPLE = path.join(__dirname, 'fixtures', 'Notizen.goodnotes');

let members, doc;

describe('Notizen.goodnotes Import/Export', async () => {
  members = await GNZip.readZip(new Uint8Array(fs.readFileSync(SAMPLE)));
  doc = GoodNotes.parseDocument(members, 'Notizen');

  it('titel + 2 seiten', () => {
    assert.equal(doc.title, 'Notizen');
    assert.equal(doc.pages.length, 2);
  });

  it('seite 1: smiley-strokes + textboxen', () => {
    const pg = doc.pages[0];
    // Kreis, Auge links, Auge rechts, Mund
    assert.equal(pg.strokes.length, 4);
    const texts = pg.textBoxes.map(t => t.runs.map(r => r.text).join(''));
    const all = texts.join('\n');
    assert.match(all, /Willkommen!/);
    assert.match(all, /Demo-Notizbuch/);
  });

  it('seite 2: checkliste mit kaestchen', () => {
    const pg = doc.pages[1];
    // 3 Checkbox-Rechtecke
    assert.equal(pg.strokes.length, 3);
    const all = pg.textBoxes.map(t => t.runs.map(r => r.text).join('')).join('\n');
    assert.match(all, /Checkliste/);
    assert.match(all, /Beispiel-Aufgabe 1/);
    assert.match(all, /Beispiel-Aufgabe 3/);
  });

  it('mapPage laeuft fehlerfrei, punkte im canvas-raum', () => {
    for (const pg of doc.pages) {
      const m = GoodNotes.mapPage(pg);
      assert.equal(m.strokes.length, pg.strokes.length);
      assert.equal(m.texts.length, pg.textBoxes.length);
      for (const s of m.strokes)
        for (const p of s.points)
          assert.ok(p.x >= -50 && p.x <= 1050 && p.y >= -50 && p.y <= 1350,
            'punkt auerhalb: ' + JSON.stringify(p));
    }
  });
});

describe('Notizen.goodnotes Export-Roundtrip', async () => {

  // Buch bauen wie buildBookFromGN in app.js (ohne DOM/Bilder)
  function bookFromDoc() {
    return {
      title: doc.title,
      pages: doc.pages.map(pg => {
        const m = GoodNotes.mapPage(pg);
        return {
          strokes: m.strokes,
          texts: m.texts.map(t => ({ x: t.x, y: t.y, html: t.html })),
          images: []
        };
      })
    };
  }

  it('import -> export -> import: inhalte ueberleben', async () => {
    const book = bookFromDoc();
    const zip = GoodNotes.exportGoodNotes(book);
    assert.ok(zip instanceof Uint8Array);
    assert.equal(zip[0], 0x50); // PK
    const members2 = await GNZip.readZip(zip);
    const doc2 = GoodNotes.parseDocument(members2, 'Notizen');

    assert.equal(doc2.pages.length, 2);
    const texts0 = doc2.pages[0].textBoxes.map(t => t.runs.map(r => r.text).join('')).join('\n');
    const texts1 = doc2.pages[1].textBoxes.map(t => t.runs.map(r => r.text).join('')).join('\n');
    assert.match(texts0, /Willkommen!/);
    assert.match(texts0, /Demo-Notizbuch/);
    assert.match(texts1, /Checkliste/);
    assert.match(texts1, /Beispiel-Aufgabe 1/);
    assert.match(texts1, /Beispiel-Aufgabe 2/);
    assert.match(texts1, /Beispiel-Aufgabe 3/);

    // Strokes: Zahlen mit geduldeten Rundungsdifferenzen vergleichen
    const cnt1 = doc2.pages.map(pg => pg.strokes.length);
    assert.deepEqual(cnt1, [4, 3]);

    // Smileys-Stroke: Farbe + Punktanzahl ueberleben
    const pg0 = doc2.pages[0];
    assert.ok(pg0.strokes.every(s => s.color === '#2040e4'.toLowerCase() || /^#[0-9a-f]{6}$/i.test(s.color)));
    const mapped = GoodNotes.mapPage(pg0);
    assert.ok(mapped.strokes.some(s => s.points.length >= 5), 'kreis-punkte erwartet');
  });

  it('zweiter roundtrip bleibt stabil', async () => {
    const book = bookFromDoc();
    const zip1 = GoodNotes.exportGoodNotes(book);
    const doc2 = GoodNotes.parseDocument(await GNZip.readZip(zip1), 'Notizen');
    const book2 = {
      title: doc2.title,
      pages: doc2.pages.map(pg => {
        const m = GoodNotes.mapPage(pg);
        return { strokes: m.strokes, texts: m.texts.map(t => ({ x: t.x, y: t.y, html: t.html })), images: [] };
      })
    };
    const zip2 = GoodNotes.exportGoodNotes(book2);
    const doc3 = GoodNotes.parseDocument(await GNZip.readZip(zip2), 'Notizen');
    assert.equal(doc3.pages.length, 2);
    const all = doc3.pages.map(pg => pg.textBoxes.map(t => t.runs.map(r => r.text).join('')).join(' ')).join(' ');
    assert.match(all, /Willkommen!/);
    assert.match(all, /Checkliste/);
  });
});
