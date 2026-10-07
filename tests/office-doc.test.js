'use strict';
// tests/office-doc.test.js – Office-Dokumentmodell: Erzeugen, Reparieren,
// Klartext/Statistik. Reine Logik ohne DOM (SPEC-40).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Doc = require('../js/office-doc.js');

function leerDoc(html, type) {
  const b = Doc.create('doc', 'T');
  b.office.blocks = [{ id: 'b1', type: type || 'p', html: html || '' }];
  return b;
}

describe('office-doc/isOfficeBook', () => {
  it('erkennt Office-Bücher und lässt alles andere in Ruhe', () => {
    assert.equal(Doc.isOfficeBook(Doc.create('doc')), true);
    assert.equal(Doc.isOfficeBook(Doc.create('sheet')), true);
    assert.equal(Doc.isOfficeBook(Doc.create('slides')), true);
    assert.equal(Doc.isOfficeBook({ id: 'b', pages: [] }), false, 'Handschriftbuch');
    assert.equal(Doc.isOfficeBook({ id: 'b', office: { kind: 'quatsch' } }), false, 'unbekannte Art');
    assert.equal(Doc.isOfficeBook(null), false);
    assert.equal(Doc.isOfficeBook(undefined), false);
  });

  it('kindOf liefert die Art oder null', () => {
    assert.equal(Doc.kindOf(Doc.create('sheet')), 'sheet');
    assert.equal(Doc.kindOf({ id: 'b' }), null);
  });
});

describe('office-doc/create', () => {
  it('legt je Art eine sinnvolle Startstruktur an', () => {
    const d = Doc.create('doc', 'Bericht');
    assert.equal(d.title, 'Bericht');
    assert.deepEqual(d.pages, [], 'keine Handschriftseiten');
    assert.equal(d.office.blocks.length, 1);
    assert.equal(d.office.blocks[0].type, 'p');

    const s = Doc.create('sheet');
    assert.equal(s.office.sheets.length, 1);
    assert.equal(s.office.sheets[0].rows, 40);
    assert.deepEqual(s.office.sheets[0].cells, {});

    const p = Doc.create('slides');
    assert.equal(p.office.slides.length, 1);
    assert.equal(p.office.slides[0].items.length, 1);
  });

  it('unbekannte Art fällt auf Dokument zurück, leerer Titel auf Art+1', () => {
    const b = Doc.create('nope', '   ');
    assert.equal(b.office.kind, 'doc');
    assert.equal(b.title, 'Dokument 1');
  });

  it('IDs sind eindeutig', () => {
    const ids = new Set();
    for (let i = 0; i < 50; i++) ids.add(Doc.create('doc').id);
    assert.equal(ids.size, 50);
  });
});

describe('office-doc/normalize', () => {
  it('repariert fehlende Blockliste', () => {
    const b = Doc.create('doc');
    b.office.blocks = null;
    Doc.normalize(b);
    assert.equal(b.office.blocks.length, 1);
  });

  it('repariert kaputte Absatztypen auf p', () => {
    const b = leerDoc('x', 'unsinn');
    Doc.normalize(b);
    assert.equal(b.office.blocks[0].type, 'p');
  });

  it('gibt Blöcken ohne id eine', () => {
    const b = Doc.create('doc');
    b.office.blocks = [{ type: 'p', html: 'ohne id' }];
    Doc.normalize(b);
    assert.ok(b.office.blocks[0].id, 'id wurde ergänzt');
  });

  it('hängt bei komplett leerem Dokument wieder einen Absatz an', () => {
    const b = Doc.create('doc');
    b.office.blocks = [];
    Doc.normalize(b);
    assert.equal(b.office.blocks.length, 1);
    assert.equal(b.office.blocks[0].html, '');
  });

  it('lässt nichtleere Inhalte unangetastet', () => {
    const b = leerDoc('<b>Hallo</b>', 'h1');
    Doc.normalize(b);
    assert.equal(b.office.blocks[0].type, 'h1');
    assert.equal(b.office.blocks[0].html, '<b>Hallo</b>');
    assert.equal(b.office.blocks[0].id, 'b1', 'vorhandene id bleibt');
  });

  it('begrenzt Blattgrößen und repariert fehlende Seiten', () => {
    const b = Doc.create('sheet');
    b.office.sheets = [{ rows: 99999, cols: -3, cells: 'nope' }];
    Doc.normalize(b);
    assert.equal(b.office.sheets[0].rows, 1000, 'auf Maximum geklemmt');
    assert.equal(b.office.sheets[0].cols, 1, ' negatives Minimum geklemmt');
    assert.deepEqual(b.office.sheets[0].cells, {});
    delete b.pages;
    Doc.normalize(b);
    assert.deepEqual(b.pages, []);
  });

  it('begrenzt Folien-Elementpositionen', () => {
    const b = Doc.create('slides');
    b.office.slides = [{ items: [{ text: 'a', x: 999, y: -20, w: 0.5, h: 900 }] }];
    Doc.normalize(b);
    const it0 = b.office.slides[0].items[0];
    assert.equal(it0.x, 100);
    assert.equal(it0.y, 0);
    assert.equal(it0.w, 4, 'untere Grenze');
    assert.equal(it0.h, 100);
  });

  it('fremde Bücher bleiben unverändert', () => {
    const b = { id: 'x', pages: [{ id: 'p1' }] };
    assert.equal(Doc.normalize(b), b);
    assert.deepEqual(b.pages, [{ id: 'p1' }]);
  });
});

describe('office-doc/stripHtml', () => {
  it('löst Text aus den gängigen Tags', () => {
    assert.equal(Doc.stripHtml('Hallo <b>fett</b> und <i>kursiv</i>'), 'Hallo fett und kursiv');
    assert.equal(Doc.stripHtml('<p>eins</p><p>zwei</p>'), 'eins\nzwei');
    assert.equal(Doc.stripHtml('<li>punkt</li>'), '• punkt');
    assert.equal(Doc.stripHtml('a<br>b'), 'a\nb');
  });

  it('dekodiert Entities', () => {
    assert.equal(Doc.stripHtml('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;'), 'a & b <c> "d" \'e\'');
    assert.equal(Doc.stripHtml('a&nbsp;b'), 'a b');
  });

  it('verkraftet null, Zahlen und kaputtes Markup', () => {
    assert.equal(Doc.stripHtml(null), '');
    assert.equal(Doc.stripHtml(undefined), '');
    assert.equal(Doc.stripHtml(42), '42');
    assert.equal(Doc.stripHtml('<b>offen'), 'offen');
  });

  it('räumt überflüssige Leerzeilen auf', () => {
    assert.equal(Doc.stripHtml('a\n\n\n\nb'), 'a\n\nb');
  });
});

describe('office-doc/escapeHtml', () => {
  it('maskiert alles Gefährliche', () => {
    assert.equal(Doc.escapeHtml('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;');
  });

  it('null wird zu leerem String', () => {
    assert.equal(Doc.escapeHtml(null), '');
  });
});

describe('office-doc/plainText', () => {
  it('holt den Text aus Writer-Blöcken', () => {
    const b = Doc.create('doc');
    b.office.blocks = [
      { id: 'a', type: 'h1', html: 'Titel' },
      { id: 'b', type: 'p', html: 'Fließtext <b>und</b> mehr' },
    ];
    assert.equal(Doc.plainText(b), 'Titel\nFließtext und mehr');
  });

  it('holt Text aus Tabellenzellen, auch Formeln', () => {
    const b = Doc.create('sheet');
    b.office.sheets = [{ name: 'Blatt', rows: 2, cols: 2, cells: {
      A1: { v: '5' }, B1: { f: '=A1*2' }, A2: '',
    } }];
    const t = Doc.plainText(b);
    assert.ok(t.includes('[Blatt]'));
    assert.ok(t.includes('A1 5'));
    assert.ok(t.includes('B1 =A1*2'));
    assert.ok(!t.includes('A2'), 'leere Zellen erscheinen nicht');
  });

  it('holt Text aus Folien', () => {
    const b = Doc.create('slides');
    b.office.slides = [{ name: 'Folie 1', items: [{ text: 'Hallo', x: 0, y: 0, w: 10, h: 10 }] }];
    assert.equal(Doc.plainText(b), '[Folie 1] Hallo');
  });

  it('fremde Bücher ergeben leeren Text', () => {
    assert.equal(Doc.plainText({ id: 'b', pages: [] }), '');
    assert.equal(Doc.plainText(null), '');
  });
});

describe('office-doc/stats + wordCount', () => {
  it('zählt Wörter korrekt', () => {
    assert.equal(Doc.wordCount(''), 0);
    assert.equal(Doc.wordCount('   '), 0);
    assert.equal(Doc.wordCount('eins'), 1);
    assert.equal(Doc.wordCount('  eins   zwei  '), 2);
    assert.equal(Doc.wordCount(null), 0);
  });

  it('liefert Wörter, Zeichen und Einheit je Art', () => {
    const d = leerDoc('eins zwei drei');
    const ds = Doc.stats(d);
    assert.equal(ds.words, 3);
    assert.equal(ds.chars, 14, '4 + 1 + 4 + 1 + 4 Zeichen');
    assert.ok(ds.unit.includes('Absatz'));

    assert.ok(Doc.stats(Doc.create('sheet')).unit.includes('Blatt'));
    assert.ok(Doc.stats(Doc.create('slides')).unit.includes('Folie'));
  });
});

describe('office-doc/outline', () => {
  it('liefert nur Überschriften mit Ebene', () => {
    const b = Doc.create('doc');
    b.office.blocks = [
      { id: 'a', type: 'h1', html: 'Kapitel' },
      { id: 'b', type: 'p', html: 'Fließtext' },
      { id: 'c', type: 'h3', html: 'Detail' },
    ];
    const o = Doc.outline(b);
    assert.deepEqual(o, [{ id: 'a', level: 1, text: 'Kapitel' }, { id: 'c', level: 3, text: 'Detail' }]);
  });

  it('andere Arten haben keine Outline', () => {
    assert.deepEqual(Doc.outline(Doc.create('sheet')), []);
    assert.deepEqual(Doc.outline({ id: 'b' }), []);
  });
});

describe('office-doc/kindLabel', () => {
  it('übersetzt die Art, unbekanntes wird Office', () => {
    assert.equal(Doc.kindLabel('doc'), 'Dokument');
    assert.equal(Doc.kindLabel('sheet'), 'Tabelle');
    assert.equal(Doc.kindLabel('slides'), 'Präsentation');
    assert.equal(Doc.kindLabel('quatsch'), 'Office');
    assert.equal(Doc.kindLabel(undefined), 'Office');
  });
});