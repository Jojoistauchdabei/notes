'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const GNZip = require('../js/gnzip.js');
const GoodNotes = require('../js/goodnotes.js');
const I = GoodNotes._internals;

function smallBook() {
  return {
    title: 'Export-Test',
    pages: [{
      strokes: [{
        points: [{ x: 100, y: 200 }, { x: 150, y: 250 }, { x: 180, y: 300 }],
        color: '#ff0000', size: 2.5
      }],
      texts: [{ x: 0.1, y: 0.1, html: '<p>Hallo Export</p>' }],
      images: []
    }]
  };
}

describe('gnexport', () => {
  it('export produziert nicht-leeres Uint8Array mit PK-Magie', () => {
    const zip = GoodNotes.exportGoodNotes(smallBook());
    assert.ok(zip instanceof Uint8Array);
    assert.ok(zip.length > 100);
    assert.equal(zip[0], 0x50); // 'P'
    assert.equal(zip[1], 0x4b); // 'K'
  });

  it('ZIP enthält document.pb, notes/<uuid>/page1.pb, index.notes.pb (SPEC-34)', async () => {
    const zip = GoodNotes.exportGoodNotes(smallBook());
    const members = await GNZip.readZip(zip);
    assert.ok(members['document.pb'], 'document.pb fehlt');
    assert.ok(members['index.notes.pb'], 'index.notes.pb fehlt');
    const pageKeys = Object.keys(members).filter(k => k.startsWith('notes/') && k.endsWith('.pb'));
    assert.equal(pageKeys.length, 1);
    const m = /^notes\/([0-9a-f-]{36})\/page1\.pb$/.exec(pageKeys[0]);
    assert.ok(m, 'Pfad nicht SPEC-34-förmig: ' + pageKeys[0]);
    assert.ok(members[pageKeys[0]].length > 0);
  });

  it('writeZip roundtrip (local headers + central directory)', async () => {
    const z = I.writeZip([['a.txt', new TextEncoder().encode('hallo')], ['n/b.bin', new Uint8Array([1, 2, 3])]]);
    assert.equal(z[0], 0x50);
    assert.equal(z[1], 0x4b);
    const out = await GNZip.readZip(z);
    assert.deepEqual(Object.keys(out).sort(), ['a.txt', 'n/b.bin']);
    assert.equal(Buffer.from(out['a.txt']).toString(), 'hallo');
    assert.deepEqual(Array.from(out['n/b.bin']), [1, 2, 3]);
  });

  it('strokeRecord -> decodeMessage/decodeTpl/extractPoints', () => {
    const pts = [{ x: 100, y: 200 }, { x: 150, y: 250 }, { x: 180, y: 300 }];
    const raw = I.strokeRecord('stroke-0-0', pts, '#0000ff', 2.5);
    const msg = I.decodeMessage(raw);
    assert.ok(msg.fields.length >= 2);
    const f7 = msg.fields.find(f => f.n === 7);
    assert.ok(f7 && f7.v instanceof Uint8Array);
    const inner = I.decodeMessage(f7.v);
    const f2 = inner.fields.find(f => f.n === 2);
    assert.ok(f2 && f2.v instanceof Uint8Array);
    const { bytes } = I.decodeAppleLz4(f2.v);
    const tpl = I.decodeTpl(bytes);
    const { groups, width } = I.extractPoints(tpl);
    assert.equal(width, 2.5);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].map(p => [p.x, p.y]), [[100, 200], [150, 250], [180, 300]]);
  });

  it('textRecord -> parseTexts', () => {
    const runs = I.parseHtmlToRuns('<p>Hallo <b>Welt</b></p>');
    assert.ok(runs.length >= 1);
    const raw = I.textRecord('text-0-0', 50, 60, 200, 100, '<p>Hallo Welt</p>', runs);
    const rec = I.decodeMessage(raw);
    const { boxes } = I.parseTexts([rec]);
    assert.equal(boxes.length, 1);
    assert.match(boxes[0].runs.map(r => r.text).join(' '), /Hallo/);
  });

  it('roundtrip: 1 Seite, 1 Stroke (3+ Punkte), 1 Text überlebt', async () => {
    const zip = GoodNotes.exportGoodNotes(smallBook());
    const members = await GNZip.readZip(zip);
    const doc = GoodNotes.parseDocument(members, 'fallback');
    assert.equal(doc.pages.length, 1);
    const pg = doc.pages[0];
    assert.equal(pg.strokes.length, 1);
    assert.ok(pg.strokes[0].points.length >= 3);
    assert.deepEqual(pg.strokes[0].points.map(p => [Math.round(p.x), Math.round(p.y)]), [[100, 200], [150, 250], [180, 300]]);
    assert.equal(pg.textBoxes.length, 1);
    assert.match(pg.textBoxes[0].runs.map(r => r.text).join(' '), /Hallo Export/);
  });

  it('attachment-UUID von Record und Datei stimmen überein', async () => {
    const book = {
      title: 'Img-Test',
      pages: [{ strokes: [], texts: [], images: [{ x: 0.1, y: 0.1, w: 0.5, src: null }] }]
    };
    const zip = GoodNotes.exportGoodNotes(book);
    const members = await GNZip.readZip(zip);
    const attKeys = Object.keys(members).filter(k => k.startsWith('attachments/'));
    assert.equal(attKeys.length, 1);
    const attUuid = attKeys[0].slice('attachments/'.length);
    assert.ok(/^[0-9a-f-]{36}$/.test(attUuid), 'keine UUID: ' + attUuid);
    const pageKey = Object.keys(members).find(k => k.startsWith('notes/'));
    const pageRaw = Buffer.from(members[pageKey]).toString('latin1');
    assert.ok(pageRaw.includes(attUuid), 'Record verweist nicht auf ' + attUuid);
  });

  it('stripHtml-Fallback funktioniert in Node ohne ReferenceError', () => {
    assert.doesNotThrow(() => I.stripHtml('<p>Hallo <b>Welt</b></p>'));
    const t = I.stripHtml('<p>Hallo <b>Welt</b></p>');
    assert.ok(t.includes('Hallo') && t.includes('Welt'));
    assert.ok(!t.includes('<p>'));
    assert.doesNotThrow(() => I.parseHtmlToRuns('<h1>Titel</h1><p>Text</p>'));
    assert.ok(I.parseHtmlToRuns('<p>abc</p>').length >= 1);
    assert.deepEqual(I.parseHtmlToRuns(''), []);
  });

  it('CRC-32-Felder in Local-Headern sind non-zero und korrekt', () => {
    const zip = GoodNotes.exportGoodNotes(smallBook());
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.length);
    let p = 0, n = 0;
    while (p + 30 <= zip.length) {
      if (dv.getUint32(p, true) !== 0x04034b50) break;
      const crc = dv.getUint32(p + 14, true);
      const cSize = dv.getUint32(p + 18, true);
      const nameLen = dv.getUint16(p + 26, true), extraLen = dv.getUint16(p + 28, true);
      const start = p + 30 + nameLen + extraLen;
      const data = zip.subarray(start, start + cSize);
      assert.equal(crc, I.crc32(data), 'CRC mismatch bei Eintrag ' + n);
      if (cSize > 0) assert.ok(crc !== 0, 'CRC ist 0 bei nicht-leerem Eintrag ' + n);
      p = start + cSize; n++;
    }
    assert.ok(n >= 5, 'zu wenige Einträge: ' + n);
  });

  it('thumbnail.jpg ist valides JPEG (FF D8 ... FF D9)', async () => {
    const zip = GoodNotes.exportGoodNotes(smallBook());
    const members = await GNZip.readZip(zip);
    const thumb = members['thumbnail.jpg'];
    assert.ok(thumb, 'thumbnail.jpg fehlt');
    assert.equal(thumb[0], 0xff);
    assert.equal(thumb[1], 0xd8);
    assert.equal(thumb[thumb.length - 2], 0xff);
    assert.equal(thumb[thumb.length - 1], 0xd9);
    assert.ok(thumb.length > 100, 'Thumbnail zu klein: ' + thumb.length);
  });

  it('dataURL-Bild ergibt Attachment > 100 Bytes', async () => {
    const raw = I.makeThumbnail();
    const b64 = Buffer.from(raw).toString('base64');
    const book = {
      title: 'Img-DataURL-Test',
      pages: [{ strokes: [], texts: [], images: [{ x: 0.1, y: 0.1, w: 0.5, src: 'data:image/jpeg;base64,' + b64 }] }]
    };
    const zip = GoodNotes.exportGoodNotes(book);
    const members = await GNZip.readZip(zip);
    const attKey = Object.keys(members).find(k => k.startsWith('attachments/'));
    assert.ok(attKey, 'kein Attachment, keys: ' + Object.keys(members).join(','));
    assert.ok(members[attKey].length > 100, 'Attachment zu klein/korrupt: ' + members[attKey].length);
  });

  it('marker bleibt marker (alpha 0.35), stift bleibt stift', async () => {
    const book = {
      title: 'Marker-Test',
      pages: [{
        strokes: [
          { points: [{ x: 10, y: 10 }, { x: 20, y: 20 }], color: '#000000', size: 3, tool: 'pen' },
          { points: [{ x: 30, y: 30 }, { x: 40, y: 40 }], color: '#ffff00', size: 9, tool: 'marker' },
        ],
        texts: [], images: [],
      }]
    };
    const members = await GNZip.readZip(GoodNotes.exportGoodNotes(book));
    const doc = GoodNotes.parseDocument(members, 'fallback');
    assert.equal(doc.pages[0].strokes.length, 2);
    assert.equal(doc.pages[0].strokes[0].highlighter, false);
    assert.equal(doc.pages[0].strokes[1].highlighter, true);
    const mapped = GoodNotes.mapPage(doc.pages[0]);
    assert.equal(mapped.strokes[0].tool, 'pen');
    assert.equal(mapped.strokes[1].tool, 'marker');
  });

  it('einzelpunkt-stroke (dot) überlebt export→import', async () => {
    const book = {
      title: 'Dot-Test',
      pages: [{ strokes: [{ points: [{ x: 100, y: 200 }], color: '#000000', size: 2.5 }], texts: [], images: [] }]
    };
    const members = await GNZip.readZip(GoodNotes.exportGoodNotes(book));
    const doc = GoodNotes.parseDocument(members, 'fallback');
    assert.equal(doc.pages[0].strokes.length, 1);
    assert.equal(doc.pages[0].strokes[0].points.length, 1);
    assert.deepEqual(
      doc.pages[0].strokes[0].points.map(p => [Math.round(p.x), Math.round(p.y)]),
      [[100, 200]]);
  });

  it('record-IDs sind UUID-förmig (erased-map, bild-refs)', async () => {
    const members = await GNZip.readZip(GoodNotes.exportGoodNotes(smallBook()));
    const pageKey = Object.keys(members).find(k => k.startsWith('notes/'));
    const recs = I.decodeDelimited(members[pageKey]);
    const ids = [];
    for (const rec of recs) {
      for (const f of rec.fields) {
        if (f.n === 1 && f.v instanceof Uint8Array) {
          const s = Buffer.from(f.v).toString('utf8');
          if (s) ids.push(s);
        }
      }
    }
    assert.ok(ids.length >= 2, 'zu wenige IDs: ' + ids.length);
    for (const id of ids) assert.ok(I.looksLikeUuid(id), 'keine UUID: ' + id);
  });

  it('textstil überlebt (fett/größe/farbe/ausrichtung)', async () => {
    const book = {
      title: 'Stil-Test',
      pages: [{
        strokes: [], images: [],
        texts: [{ x: 0.1, y: 0.1, html: '<h1>Head</h1><p style="text-align:center"><b>Fett</b> und <span style="color:#ff0000">rot</span></p>' }],
      }]
    };
    const members = await GNZip.readZip(GoodNotes.exportGoodNotes(book));
    const doc = GoodNotes.parseDocument(members, 'fallback');
    const runs = doc.pages[0].textBoxes[0].runs;
    const byText = Object.fromEntries(runs.map(r => [r.text, r]));
    assert.equal(byText['Head'].size, 40);
    assert.equal(byText['Fett'].bold, true);
    assert.equal(byText['Fett'].align, 'center');
    assert.equal(byText['rot'].color.toLowerCase(), '#ff0000');
    assert.equal(byText['rot'].align, 'center');
  });

  it('bildgeometrie: seitenrichtiges Rechteck, seitenverhältnis aus PNG', async () => {
    const png2x2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEElEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const book = {
      title: 'Geo-Test',
      pages: [{ strokes: [], texts: [], images: [{ x: 0.1, y: 0.2, w: 0.5, src: png2x2 }] }]
    };
    const members = await GNZip.readZip(GoodNotes.exportGoodNotes(book));
    const doc = GoodNotes.parseDocument(members, 'fallback');
    assert.equal(doc.pages[0].images.length, 1);
    const ie = doc.pages[0].images[0].ie;
    assert.ok(Math.abs(ie.x - 0.1 * 612) < 0.01, 'x=' + ie.x);
    assert.ok(Math.abs(ie.y - 0.2 * 792) < 0.01, 'y=' + ie.y);
    assert.ok(Math.abs(ie.w - 0.5 * 612) < 0.01, 'w=' + ie.w);
    assert.ok(Math.abs(ie.h - ie.w) < 0.01, 'h=' + ie.h + ' (2x2 quadratisch erwartet)');
  });

  it('seiten-hintergrund wird als bild exportiert und reimportiert', async () => {
    const png2x2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEElEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const book = {
      title: 'BG-Test',
      pages: [{ strokes: [], texts: [], images: [], bg: png2x2 }]
    };
    const members = await GNZip.readZip(GoodNotes.exportGoodNotes(book));
    const doc = GoodNotes.parseDocument(members, 'fallback');
    assert.equal(doc.pages[0].images.length, 1);
    const ie = doc.pages[0].images[0].ie;
    assert.ok(Math.abs(ie.w - 612) < 1, 'bg-Breite seitenfüllend erwartet, ist ' + ie.w);
    assert.ok(ie.h > 0 && ie.h <= 792);
  });

  it('mehrseiten: index-pfade lösen alle auf, reihenfolge stabil', async () => {
    const book = {
      title: 'Multi-Test',
      pages: [0, 1, 2].map(i => ({
        strokes: [{ points: [{ x: 10 + i, y: 10 }, { x: 20, y: 20 }], color: '#000000', size: 2 }],
        texts: [], images: [],
      })),
    };
    const members = await GNZip.readZip(GoodNotes.exportGoodNotes(book));
    const idx = I.decodeDelimited(members['index.notes.pb']);
    const td = new TextDecoder();
    const paths = idx.map(rec => {
      for (const f of rec.fields) {
        if (f.v instanceof Uint8Array) {
          const s = td.decode(f.v);
          if (s.startsWith('notes/')) return s;
        }
      }
      return null;
    });
    assert.equal(paths.length, 3);
    for (const p of paths) assert.ok(members[p], 'Index-Pfad fehlt im ZIP: ' + p);
    const doc = GoodNotes.parseDocument(members, 'fallback');
    assert.equal(doc.pages.length, 3);
    assert.deepEqual(doc.pages.map(p => p.strokes.length), [1, 1, 1]);
  });

  it('imageFileDims: PNG + JPEG, müll → null', () => {
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEElEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    assert.deepEqual(I.imageFileDims(png), { w: 2, h: 2 });
    assert.equal(I.imageFileDims(new Uint8Array([1, 2, 3])), null);
    assert.equal(I.imageFileDims(null), null);
    const thumb = I.makeThumbnail();
    assert.deepEqual(I.imageFileDims(thumb), { w: 1, h: 1 });
  });
});
