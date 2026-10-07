'use strict';
// tests/office-writer.test.js – Writer-Logik ohne Browser: das Aufteilen der
// contenteditable-Umbrüche in Blöcke, die Toolbar-Tabellen und die HTML-Anbindung
// in index.html/styles.css (SPEC-40).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Writer = require('../js/office-writer.js');
const Doc = require('../js/office-doc.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');

/* Minimale Attrappe für einen contenteditable-Block: nur die Felder, die
 * readBack tatsächlich liest. */
function fakeBlock(blockId, blockType, html, rows) {
  return {
    tagName: blockType === 'hr' ? 'HR' : 'DIV',
    innerHTML: html,
    dataset: { blockId, blockType },
    children: (rows || []).map((h) => ({ tagName: 'DIV', innerHTML: h })),
  };
}

function leeresBuch() {
  const b = Doc.create('doc', 'T');
  b.office.blocks = [];
  return b;
}

describe('office-writer/readBack', () => {
  it('übernimmt einen einfachen Absatz unverändert', () => {
    const b = leeresBuch();
    const host = { children: [fakeBlock('b1', 'p', 'Hallo <b>Welt</b>')] };
    Writer.readBack(b, host);
    assert.deepEqual(b.office.blocks, [{ id: 'b1', type: 'p', html: 'Hallo <b>Welt</b>' }]);
  });

  // Enter erzeugt im contenteditable <div>-Kinder. Ohne Aufteilung wären alle
  // Zeilen ein Block und die Blockstruktur ginge verloren.
  it('teilt Enter-Umbrüche in je einen Block', () => {
    const b = leeresBuch();
    const host = { children: [fakeBlock('b1', 'p', '', ['eins', 'zwei', 'drei'])] };
    Writer.readBack(b, host);
    assert.equal(b.office.blocks.length, 3);
    assert.deepEqual(b.office.blocks.map((x) => x.html), ['eins', 'zwei', 'drei']);
  });

  it('vergibt für geteilte Zeilen eigene, eindeutige IDs', () => {
    const b = leeresBuch();
    const host = { children: [fakeBlock('b1', 'p', '', ['a', 'b'])] };
    Writer.readBack(b, host);
    const ids = b.office.blocks.map((x) => x.id);
    assert.equal(new Set(ids).size, 2, 'zwei Zeilen brauchen zwei IDs');
  });

  it('erniedrigt Überschriften beim Teilen auf Absatz', () => {
    // Eine h1 über mehrere Zeilen soll nicht drei Überschriften ergeben.
    const b = leeresBuch();
    const host = { children: [fakeBlock('b1', 'h1', '', ['Teil 1', 'Teil 2'])] };
    Writer.readBack(b, host);
    assert.deepEqual(b.office.blocks.map((x) => x.type), ['p', 'p']);
  });

  it('behält Absatztypen, die beim Teilen sinnvoll bleiben', () => {
    const b = leeresBuch();
    const host = { children: [fakeBlock('b1', 'quote', '', ['zitat a', 'zitat b'])] };
    Writer.readBack(b, host);
    assert.deepEqual(b.office.blocks.map((x) => x.type), ['quote', 'quote']);
  });

  it('behandelt hr als eigenen Block ohne HTML', () => {
    const b = leeresBuch();
    const host = { children: [fakeBlock('b1', 'hr', '<span></span>'), fakeBlock('b2', 'p', 'nach')] };
    Writer.readBack(b, host);
    assert.deepEqual(b.office.blocks, [
      { id: 'b1', type: 'hr', html: '' },
      { id: 'b2', type: 'p', html: 'nach' },
    ]);
  });

  it('überlebt ein leeres Board und legt einen Absatz an', () => {
    const b = leeresBuch();
    Writer.readBack(b, { children: [] });
    assert.equal(b.office.blocks.length, 1);
    assert.equal(b.office.blocks[0].html, '');
  });

  it('überspringt Knoten ohne data-block-id', () => {
    const b = leeresBuch();
    const host = { children: [
      { tagName: 'DIV', innerHTML: 'fremd', dataset: {}, children: [] },
      fakeBlock('b9', 'p', 'echt'),
    ] };
    Writer.readBack(b, host);
    assert.deepEqual(b.office.blocks, [{ id: 'b9', type: 'p', html: 'echt' }]);
  });

  it('macht null zu leerem Text', () => {
    const b = leeresBuch();
    const host = { children: [fakeBlock('b1', 'p', null)] };
    Writer.readBack(b, host);
    assert.equal(b.office.blocks[0].html, '');
  });
});

describe('office-writer/sanitize + stripTags', () => {
  it('lässt HTML ohne Sanitizer unverändert (Node hat keinen)', () => {
    assert.equal(Writer.sanitize('<b>x</b>'), '<b>x</b>');
    assert.equal(Writer.sanitize(null), '');
  });

  it('stripTags holt reinen Text', () => {
    assert.equal(Writer.stripTags('<b>fett</b> <i>kursiv</i>'), 'fett kursiv');
    assert.equal(Writer.stripTags(null), '');
  });
});

describe('office-writer/Tabellen', () => {
  it('jeder Inline-Befehl ist eine bekannte execCommand-Kommando-Zeichenkette', () => {
    const erlaubt = new Set([
      'bold', 'italic', 'underline', 'strikeThrough',
      'insertUnorderedList', 'insertOrderedList', 'createLink', 'removeFormat',
    ]);
    for (const item of Writer.INLINE) {
      assert.ok(erlaubt.has(item.cmd), 'unbekanntes Kommando: ' + item.cmd);
      assert.ok(item.label, 'Button ohne Beschriftung: ' + item.cmd);
      assert.ok(item.key === null || /^Mod\+[A-Z]$/.test(item.key),
        'Tastenkürzel unerwartet: ' + item.key);
    }
  });

  it('jeder Absatztyp ist im Modell bekannt', () => {
    for (const t of Writer.BLOCK_TYPES) {
      assert.ok(Doc.BLOCK_TYPES.includes(t.type), 'Modell kennt den Typ nicht: ' + t.type);
      assert.ok(t.label);
    }
  });

  it('der Autosave ist kurz genug und noch als Timer erkennbar', () => {
    assert.ok(Writer.SAVE_DEBOUNCE >= 200 && Writer.SAVE_DEBOUNCE <= 2000,
      'Autosave-Fenster unplausibel: ' + Writer.SAVE_DEBOUNCE);
  });
});

describe('office/HTML-Anbindung', () => {
  it('die Office-Ansicht existiert mit allen Ankerpunkten', () => {
    assert.match(html, /id="viewOffice"/);
    for (const id of ['officeBlocks', 'officeToolbar', 'officeBack', 'officeTitle', 'officeKind', 'officeStatus']) {
      assert.ok(html.includes('id="' + id + '"'), 'fehlt: #' + id);
    }
  });

  it('die Module laden vor app.js und in Abhängigkeitsreihenfolge', () => {
    const iDoc = html.indexOf('js/office-doc.js');
    const iWriter = html.indexOf('js/office-writer.js');
    const iApp = html.indexOf('js/app.js');
    assert.ok(iDoc > 0 && iWriter > 0 && iApp > 0);
    assert.ok(iDoc < iWriter, 'office-doc.js muss vor office-writer.js laden');
    assert.ok(iWriter < iApp, 'app.js braucht isOfficeDoc() beim Rendern der Karten');
  });

  it('die Skripte sind als einfache Tags geschrieben, damit sie gebündelt werden', () => {
    // build-dist.js bündelt nur <script src="js/..."> ohne Zusatzattribute.
    assert.match(html, /<script src="js\/office-doc\.js"><\/script>/);
    assert.match(html, /<script src="js\/office-writer\.js"><\/script>/);
  });

  it('der Anlege-Knopf ruft createOfficeDoc', () => {
    assert.match(html, /createOfficeDoc\('doc'\)/);
  });

  it('styles.css trägt die Office-Klassen (kein zweites Stylesheet)', () => {
    for (const sel of ['.fw-office-page', '.fw-office-paper', '.fw-office-toolbar', '.fw-office-block', '.fw-office-b-h1', '.fw-office-hr']) {
      assert.ok(css.includes(sel), 'CSS fehlt: ' + sel);
    }
  });
});

describe('office/app.js-Anbindung', () => {
  it('openBookView leitet Office-Bücher um, bevor es an den Zeichen-Canvas geht', () => {
    const iOpen = app.indexOf('function openBookView');
    const iRoute = app.indexOf('isOfficeDoc(b0)', iOpen);
    // Ab openBookView suchen: 'const api = splitApi();' kommt im File 13-mal,
    // die erste Stelle liegt vor der Funktion und würde den Vergleich kippen.
    const iSplit = app.indexOf('const api = splitApi();', iOpen);
    assert.ok(iOpen > 0 && iRoute > 0, 'Office-Umleitung nicht gefunden');
    assert.ok(iSplit > 0, 'Canvas-Pfad nicht gefunden');
    assert.ok(iRoute > iOpen && iRoute < iSplit,
      'Office-Umleitung muss vor dem Canvas-Pfad stehen');
  });

  it('die Bibliothekskarte behandelt Office gesondert von Decks und Heft', () => {
    assert.match(app, /const office = isOfficeDoc\(b\);/);
    assert.match(app, /const deck = !office && isFlashDeck\(b\);/);
  });

  it('Office-Karten bieten weder Split noch GoodNotes-Export', () => {
    // Beides setzt Handschriftseiten voraus, die ein Office-Dokument nicht hat.
    assert.match(app, /\(deck \|\| office \? deckActions :/);
    assert.match(app, /\(deck \|\| office \? '' :/);
  });

  it('die Karten-Vorschau nutzt den Klartext aus dem Modell', () => {
    assert.match(app, /OD\.plainText\(b\)/);
    assert.match(app, /OD\.stats\(b\)/);
  });
});