'use strict';
// tests/office-new-doc.test.js – das Anlegen neuer Office-Dokumente: die Nummer
// im Titel und der Knopf, der den Writer öffnet. Aus Bugbildern: Nach dem
// Loeschen eines Dokuments entstand wieder "Dokument 1", obwohl "Dokument 3"
// existierte, weil nur gezaehlt statt nach der hoechsten Nummer gesucht wurde.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');

/* Die echte Funktion aus app.js wird ausgeführt, nicht nachgebaut – ein Test,
 * der eine Kopie prüft, sagt nichts über den Code aus. app.js ist ein
 * Browser-Skript ohne Modulsystem, deshalb wird die Funktion herausgelöst und
 * mit den zwei Abhängigkeiten aus ihrem Modulkontext gefüttert. */
function ladeFunktion(books) {
  const m = app.match(/function nextOfficeNumber\(kind, label\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'nextOfficeNumber steht in app.js');
  const isOfficeDoc = (b) => !!(b && b.office
    && (b.office.kind === 'doc' || b.office.kind === 'sheet' || b.office.kind === 'slides'));
  const state = { books: books || [] };
  return new Function('state', 'isOfficeDoc',
    m[0] + '\nreturn nextOfficeNumber;')(state, isOfficeDoc);
}

const doc = (titel, kind) => ({ title: titel, office: { kind: kind || 'doc', blocks: [] } });

/* naechste Nummer fuer eine Liste von Buechern */
const nummer = (books, kind, label) => ladeFunktion(books)(kind, label);

describe('Office: Nummer im Titel', () => {
  it('zaehlt von 1, wenn noch keins da ist', () => {
    assert.equal(nummer([], 'doc', 'Dokument'), 1);
  });

  it('nimmt nach der hoechsten Nummer die naechste', () => {
    assert.equal(nummer([doc('Dokument 1'), doc('Dokument 2')], 'doc', 'Dokument'), 3);
  });

  it('faengt Luecken auf – Regression aus dem Bugbild', () => {
    // Dokument 1 und 2 geloescht, Dokument 3 lebt: es muss 4 werden, nicht 2.
    assert.equal(nummer([doc('Dokument 3')], 'doc', 'Dokument'), 4);
  });

  it('ignoriert unsortierte Reihenfolge', () => {
    const buecher = [doc('Dokument 3'), doc('Dokument 1'), doc('Dokument 2')];
    assert.equal(nummer(buecher, 'doc', 'Dokument'), 4);
  });

  it('zaehlt je Art getrennt', () => {
    const buecher = [doc('Dokument 1'), doc('Tabelle 1', 'sheet'), doc('Dokument 2')];
    assert.equal(nummer(buecher, 'doc', 'Dokument'), 3);
    assert.equal(nummer(buecher, 'sheet', 'Tabelle'), 2);
  });

  it('geht auch bei zweistelligen Nummern weiter', () => {
    assert.equal(nummer([doc('Dokument 9'), doc('Dokument 10')], 'doc', 'Dokument'), 11);
  });

  it('vermeidet die Doppelung "Dokument" neben "Dokument 1"', () => {
    // Ein vom Nutzer umbenanntes Dokument darf keine 1 erzeugen, die schon da ist.
    assert.equal(nummer([doc('Dokument'), doc('Dokument 1')], 'doc', 'Dokument'), 2);
  });

  it('ignoriert regulaere Notizbucher in der Zaehlung', () => {
    const buecher = [{ title: 'Dokument 1' }, doc('Dokument 2')];
    assert.equal(nummer(buecher, 'doc', 'Dokument'), 3);
  });

  it('verträgt kaputte Einträge ohne Absturz', () => {
    // Ein Eintrag ohne office-Feld (etwa ein normales Notizbuch, das sich in
    // state.books befindet) ist kein Office-Dokument und zaehlt nicht mit.
    const buecher = [null, undefined, { title: 'Dokument 4' }, doc('Dokument 1')];
    assert.equal(nummer(buecher, 'doc', 'Dokument'), 2);
  });
});

describe('Office: Knopf, der den Writer öffnet', () => {
  it('liegt in der Bibliothek und öffnet den Writer direkt', () => {
    assert.match(html, /onclick="createOfficeDoc\('doc'\)"/, 'der Bibliotheks-Knopf ruft createOfficeDoc');
    assert.match(html, /id="newOfficeBtn"/, 'er hat eine id zum Wiederfinden');
  });

  it('gibt es auch im Writer, damit man nicht erst zurückklicken muss', () => {
    assert.match(html, /id="officeNew"/, 'der Writer hat einen Neu-Knopf');
    const writer = fs.readFileSync(path.join(root, 'js', 'office-writer.js'), 'utf8');
    assert.match(writer, /officeNew[\s\S]{0,200}createOfficeDoc\('doc'\)/,
      'und der Knopf ruft auch createOfficeDoc');
  });

  it('legt nicht in den Zeich-Canvas, sondern im Office-Model an', () => {
    // Regression davor: openBookView lieferte bei Office-Büchern an den Canvas
    // weiter, statt den Writer zu öffnen.
    assert.match(app, /if \(b0 && isOfficeDoc\(b0\)\) \{ openOfficeDoc\(id\); return; \}/,
      'ein Klick auf eine Office-Karte oeffnet den Writer');
    assert.match(app, /function openOfficeDoc\(id\)[\s\S]{0,120}FederwerkOfficeWriter\.openBook\(id\)/,
      'openOfficeDoc oeffnet den Writer');
  });

  it('rät die Art nicht, sondern nimmt die übergebene', () => {
    assert.match(app, /kind === 'sheet' \|\| kind === 'slides'\) \? kind : 'doc'/,
      'nur doc, sheet und slides sind zulaessig');
  });

  it('legt in den aktiven Ordner und persistiert', () => {
    assert.match(app, /state\.books\.unshift\(b\)/, 'das neue Buch landet in state.books');
    assert.match(app, /persistNow\(\); renderLibrary\(\);/, 'und wird gespeichert + angezeigt');
    assert.match(app, /b\.folderId = activeFolderId/, 'im aktiven Ordner, wenn es einen gibt');
  });
});