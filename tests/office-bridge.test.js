'use strict';
// tests/office-bridge.test.js – Mapping zwischen Office-Modell und dem
// WordCraft-JSON (office-wasm) ohne Browser: Überschriften, Listen, Trenner,
// Auszeichnung im Text und der Dateiname. Zusätzlich die Verdrahtung in
// index.html, damit Import/Export nicht stumm verschwinden (SPEC-40).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Bridge = require('../js/office-bridge.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function buch(blocks, titel) {
  return { title: titel || 'Test', office: { kind: 'doc', blocks } };
}

describe('office-bridge: Federwerk -> WordCraft', () => {
  it('setzt core.title aus dem Buchnamen', () => {
    const doc = JSON.parse(Bridge.toDocJson(buch([{ type: 'p', html: 'Hallo' }], 'Mein Bericht')));
    assert.equal(doc.core.title, 'Mein Bericht');
  });

  it('bildet Überschriften auf die eingebauten Style-IDs ab', () => {
    const body = JSON.parse(Bridge.toDocJson(buch([
      { type: 'h1', html: 'Titel' },
      { type: 'h2', html: 'Kapitel' },
      { type: 'h3', html: 'Abschnitt' },
      { type: 'p', html: 'Fließtext' },
    ]))).body;
    assert.equal(body[0].props.style, 'Heading1');
    assert.equal(body[1].props.style, 'Heading2');
    assert.equal(body[2].props.style, 'Heading3');
    assert.equal(body[3].props, undefined, 'Fließtext bekommt keinen Style');
  });

  it('bildet beide Listentypen auf ListParagraph ab', () => {
    const body = JSON.parse(Bridge.toDocJson(buch([
      { type: 'ul', html: 'punkt' },
      { type: 'ol', html: 'strich' },
    ]))).body;
    assert.equal(body[0].props.style, 'ListParagraph');
    assert.equal(body[1].props.style, 'ListParagraph');
  });

  it('schreibt hr als Absatz mit der Trennmarke', () => {
    const body = JSON.parse(Bridge.toDocJson(buch([{ type: 'hr', html: '' }]))).body;
    assert.deepEqual(body, [{ kind: 'para', text: Bridge.HR_MARK, runs: [] }]);
  });

  it('gibt Runs nur bei Auszeichnung aus', () => {
    const body = JSON.parse(Bridge.toDocJson(buch([
      { type: 'p', html: 'nur Text' },
      { type: 'p', html: 'a<strong>fett</strong>b<em>kursiv</em>' },
    ]))).body;
    assert.deepEqual(body[0].runs, [], 'ohne Auszeichnung keine Runs');
    assert.equal(body[1].text, 'afettbkursiv');
    assert.deepEqual(body[1].runs, [
      { len: 1, props: {} },
      { len: 4, props: { bold: true } },
      { len: 1, props: {} },
      { len: 6, props: { italic: true } },
    ]);
  });

  it('verschmilzt benachbarte Runs mit gleicher Auszeichnung', () => {
    const body = JSON.parse(Bridge.toDocJson(buch([
      { type: 'p', html: '<strong>a</strong><strong>b</strong>c' },
    ]))).body;
    assert.deepEqual(body[0].runs, [
      { len: 2, props: { bold: true } },
      { len: 1, props: {} },
    ]);
  });

  it('escaped Text und schluckt unbekannte Inline-Tags', () => {
    const body = JSON.parse(Bridge.toDocJson(buch([
      { type: 'p', html: '<a href="x">Link</a> &amp; <span>Rest</span>' },
    ]))).body;
    assert.equal(body[0].text, 'Link & Rest');
  });

  it('schickt bei leerem Dokument einen leeren Absatz', () => {
    // WordCraft braucht body; ein leeres Array erzeugt kein gültiges DOCX.
    assert.deepEqual(JSON.parse(Bridge.toDocJson(buch([]))).body, [
      { kind: 'para', text: '', runs: [] },
    ]);
  });

  it('kennt nur die Blockarten des Writers', () => {
    const body = JSON.parse(Bridge.toDocJson(buch([
      { type: 'h1', html: 'A' },
      { type: 'unsinn', html: 'B' },
    ]))).body;
    assert.equal(body[1].props, undefined, 'unbekannter Typ wird zu Fließtext');
  });
});

describe('office-bridge: WordCraft -> Federwerk', () => {
  it('mappt Style-IDs auf Blockarten', () => {
    const r = Bridge.fromDocJson(JSON.stringify({ body: [
      { kind: 'para', text: 'T', runs: [], props: { style: 'Heading1' } },
      { kind: 'para', text: 'K', runs: [], props: { style: 'Heading2' } },
      { kind: 'para', text: 'L', runs: [], props: { style: 'ListParagraph' } },
      { kind: 'para', text: 'F', runs: [] },
    ] }));
    assert.deepEqual(r.blocks.map((b) => b.type), ['h1', 'h2', 'ul', 'p']);
  });

  it('setzt hr aus der Trennmarke wieder her', () => {
    const r = Bridge.fromDocJson(JSON.stringify({ body: [
      { kind: 'para', text: 'vor', runs: [] },
      { kind: 'para', text: Bridge.HR_MARK, runs: [] },
    ] }));
    assert.deepEqual(r.blocks.map((b) => b.type), ['p', 'hr']);
  });

  it('macht aus Runs wieder Inline-HTML', () => {
    const r = Bridge.fromDocJson(JSON.stringify({ body: [{
      kind: 'para',
      text: 'afettbkursiv',
      runs: [
        { len: 1, props: {} },
        { len: 4, props: { bold: true } },
        { len: 1, props: {} },
        { len: 6, props: { italic: true } },
      ],
    }] }));
    assert.equal(r.blocks[0].html, 'a<strong>fett</strong>b<em>kursiv</em>');
  });

  it('behält Text hinter der Run-Länge und escaped den Rest', () => {
    const r = Bridge.fromDocJson(JSON.stringify({ body: [{
      kind: 'para', text: 'ab<rest', runs: [{ len: 1, props: { bold: true } }],
    }] }));
    assert.equal(r.blocks[0].html, '<strong>a</strong>b&lt;rest');
  });

  it('übernimmt Tabellen als Text und meldet es', () => {
    const r = Bridge.fromDocJson(JSON.stringify({ body: [{
      kind: 'table', rows: [{ cells: [{ text: 'A1' }, { text: 'B1' }] }],
    }] }));
    assert.equal(r.blocks.length, 1);
    assert.equal(r.blocks[0].type, 'p');
    assert.ok(r.blocks[0].html.includes('A1') && r.blocks[0].html.includes('B1'));
    assert.equal(r.warnungen.length, 1, 'die Tabelle wird gemeldet');
  });

  it('liest core.title und überlebt fehlendes core', () => {
    assert.equal(Bridge.fromDocJson('{"core":{"title":"Titel"}}').title, 'Titel');
    assert.equal(Bridge.fromDocJson('{"body":[]}').title, '');
  });

  it('lässt bei kaputtem JSON eine Exception fliegen', () => {
    // Der Aufrufer im Writer faengt das ab und zeigt es im Status an.
    assert.throws(() => Bridge.fromDocJson('{kein json'));
    assert.throws(() => Bridge.fromDocJson('null'));
  });

  it('liefert bei leerem body einen leeren Absatz statt nichts', () => {
    assert.deepEqual(Bridge.fromDocJson('{}').blocks.map((b) => b.type), ['p']);
  });
});

describe('office-bridge: Round-Trip', () => {
  const bloecke = [
    { type: 'h1', html: 'Titel' },
    { type: 'p', html: 'Fließtext mit <strong>fett</strong> und <em>kursiv</em>.' },
    { type: 'ul', html: 'erster Punkt' },
    { type: 'hr', html: '' },
    { type: 'p', html: 'a &amp; b &lt; c' },
  ];

  it('hält Typ und HTML über den DOCX-Umweg', () => {
    const r = Bridge.fromDocJson(Bridge.toDocJson(buch(bloecke)));
    assert.deepEqual(
      r.blocks.map((b) => [b.type, b.html]),
      bloecke.map((b) => [b.type, b.html]),
    );
  });

  it('meldet beim Rückweg nichts', () => {
    assert.deepEqual(Bridge.fromDocJson(Bridge.toDocJson(buch(bloecke))).warnungen, []);
  });

  it('verliert die ol/ul-Unterscheidung – dokumentiert und geprüft', () => {
    const r = Bridge.fromDocJson(Bridge.toDocJson(buch([{ type: 'ol', html: 'x' }])));
    assert.equal(r.blocks[0].type, 'ul');
  });

  it('vergibt eindeutige Block-IDs', () => {
    const r = Bridge.fromDocJson(Bridge.toDocJson(buch(bloecke)));
    const ids = new Set(r.blocks.map((b) => b.id));
    assert.equal(ids.size, bloecke.length);
  });
});

describe('office-bridge: Dateiname', () => {
  it('macht aus dem Titel einen sicheren Dateinamen', () => {
    assert.equal(Bridge.fileName({ title: 'Mein Bericht' }, 'docx'), 'Mein-Bericht.docx');
    assert.equal(Bridge.fileName({ title: 'a/b:c*d?' }, 'docx'), 'a-b-c-d.docx');
    assert.equal(Bridge.fileName({ title: '   ' }, 'docx'), 'dokument.docx');
    assert.equal(Bridge.fileName({}, 'docx'), 'dokument.docx');
    assert.equal(Bridge.fileName({ title: 'x'.repeat(200) }, 'docx').length, 'x'.repeat(60).length + 5);
  });
});

describe('office-bridge: Verdrahtung', () => {
  it('liefert die Buttons und das Dateifeld mit', () => {
    assert.match(html, /id="officeImport"/);
    assert.match(html, /id="officeExport"/);
    assert.match(html, /id="officeFile"[^>]*accept="[^"]*\.docx/);
    assert.match(html, /id="officeImport"[\s\S]*?hidden>/);
  });

  it('laedt die Bridge nach dem Engine-Adapter', () => {
    const engine = html.indexOf('js/office-engine.js');
    const bridge = html.indexOf('js/office-bridge.js');
    assert.ok(engine >= 0 && bridge > engine, 'office-bridge.js kommt nach office-engine.js');
  });
});