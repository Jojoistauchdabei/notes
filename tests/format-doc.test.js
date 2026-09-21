'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Format = require('../js/format-doc.js');
const GNZip = require('../js/gnzip.js');
const GoodNotes = require('../js/goodnotes.js');

const ROOT = path.join(__dirname, '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'federwerk.schema.json'), 'utf8'));

function sampleBook() {
  return {
    id: 'b1', title: 'Testbuch', paper: 'grid', updatedAt: 1, folderId: null, lang: 'de',
    pages: [{
      id: 'p1',
      strokes: [{ tool: 'pen', color: '#000000', size: 3, points: [{ x: 10, y: 20, p: 0.5 }] }],
      texts: [{ id: 't1', x: 0.1, y: 0.1, html: '<p>Hallo</p>' }],
      images: [{ id: 'i1', x: 0.1, y: 0.2, w: 0.5, src: 'data:image/png;base64,AAA' }],
      bg: null,
    }],
  };
}

describe('format-doc (federwerk-1)', () => {
  it('Konstanten stimmen mit Schema + llms.txt + Doku überein', () => {
    assert.equal(Format.FORMAT_VERSION, 'federwerk-1');
    assert.equal(SCHEMA.$defs.formatMeta.properties.formatVersion.const, 'federwerk-1');
    assert.equal(SCHEMA.$defs._ai, undefined); // _ai steckt in formatMeta, nicht als eigenes $def
    assert.equal(SCHEMA.$defs.formatMeta.properties._ai.properties.version.const, 'federwerk-1');
    for (const f of ['FEDERWERK_FORMAT.md', 'federwerk.schema.json', 'llms.txt']) {
      assert.ok(fs.existsSync(path.join(ROOT, f)), f + ' fehlt im Repo-Root');
    }
    const llms = fs.readFileSync(path.join(ROOT, 'llms.txt'), 'utf8');
    assert.match(llms, /FEDERWERK_FORMAT\.md/);
    assert.match(llms, /federwerk\.schema\.json/);
    const doc = fs.readFileSync(path.join(ROOT, 'FEDERWERK_FORMAT.md'), 'utf8');
    assert.match(doc, /federwerk-1/);
    assert.match(doc, /x,\s*y,\s*p/);
  });

  it('aiHint liefert vollständigen KI-Hinweis', () => {
    const h = Format.aiHint();
    assert.equal(h.format, 'federwerk-notebook');
    assert.equal(h.version, 'federwerk-1');
    assert.equal(typeof h.schema, 'string');
    assert.ok(h.fields && typeof h.fields.strokes === 'string');
    assert.match(h.fields.strokes, /\{x,y,p\}/);
    assert.match(h.fields.texts, /html/);
    assert.match(h.fields.images, /dataURL/);
    assert.match(String(h.promptHint), /Strokes sind Handschrift-Pfade/);
  });

  it('attachFormatMeta bettet $schema/formatVersion/formatDoc/_ai ein (Buch + Gesamt)', () => {
    const book = Format.attachFormatMeta(sampleBook());
    assert.equal(book.$schema, Format.SCHEMA_URL);
    assert.equal(book.formatVersion, 'federwerk-1');
    assert.equal(book.formatDoc, Format.FORMAT_DOC);
    assert.equal(book._ai.format, 'federwerk-notebook');
    assert.equal(book.title, 'Testbuch'); // Nutzdaten bleiben

    const all = Format.attachFormatMeta({ books: [sampleBook()], folders: [], openBookId: null, openPageId: null });
    assert.equal(all.formatVersion, 'federwerk-1');
    assert.equal(all._ai.version, 'federwerk-1');
    assert.equal(all.books.length, 1);
  });

  it('validateExport: gültig vs. kaputt (ohne ajv, per Hand)', () => {
    assert.deepEqual(Format.validateExport(Format.attachFormatMeta({ books: [sampleBook()], folders: [] })), []);
    assert.deepEqual(Format.validateExport(sampleBook()), []);
    const bad = Format.validateExport({ books: [{ title: 'ohne pages' }] });
    assert.ok(bad.length > 0, 'fehlende pages müssen auffallen');
    const badStroke = sampleBook();
    badStroke.pages[0].strokes = [{ points: [{ x: 'a', y: 1 }] }];
    assert.ok(Format.validateExport(badStroke).length > 0, 'kaputter Stroke muss auffallen');
    assert.ok(Format.validateExport({}).length > 0, 'leeres Objekt muss auffallen');
  });

  it('Schema deckt Book/Page/Stroke/Text/Image/Folder ab', () => {
    for (const def of ['book', 'page', 'stroke', 'textBox', 'image', 'folder']) {
      assert.ok(SCHEMA.$defs[def], '$def ' + def + ' fehlt');
    }
    assert.deepEqual(SCHEMA.$defs.point.required, ['x', 'y']);
    assert.deepEqual(SCHEMA.$defs.page.required, ['strokes', 'texts', 'images']);
    assert.ok(SCHEMA.$defs.stroke.properties.points, 'stroke.points fehlt');
    assert.ok(SCHEMA.$defs.textBox.properties.html, 'textBox.html fehlt');
    assert.ok(SCHEMA.$defs.image.properties.src, 'image.src fehlt');
  });

  it('.goodnotes-Export enthält federwerk.json mit Format-Version', async () => {
    const zip = GoodNotes.exportGoodNotes(sampleBook());
    const members = await GNZip.readZip(zip);
    assert.ok(members['federwerk.json'], 'federwerk.json fehlt im Container');
    const meta = JSON.parse(Buffer.from(members['federwerk.json']).toString('utf8'));
    assert.equal(meta.formatVersion, 'federwerk-1');
    assert.equal(meta.format, 'federwerk-notebook');
    // Import ignoriert die Metadatei (Seiten unverändert)
    const doc = GoodNotes.parseDocument(members, 'fallback');
    assert.equal(doc.pages.length, 1);
    assert.equal(GoodNotes.federwerkMeta('T', 3).pages, 3);
  });
});
