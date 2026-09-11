'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const B = require('./build-gn.js');
const GNZip = require('../js/gnzip.js');
const GoodNotes = require('../js/goodnotes.js');

const SUUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EUUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const MUUID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const HUUID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const RUUID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const AUUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const PAGE2 = '99999999-9999-9999-9999-999999999999';

function fixtureDoc() {
  // ACHTUNG: strokeField7 erwartet ROH-Koordinaten (codiert selbst)
  // Seite 1
  const strokeNormal = B.msg([[1, 2, B.str(SUUID)],
    [7, 2, B.strokeField7(SUUID, { pairs: [[100, 200]], quads: [[100, 200, 150, 250]], color: [0, 0, 1, 1], width: 2.5 })]]);
  const strokeErased = B.msg([[1, 2, B.str(EUUID)],
    [7, 2, B.strokeField7(EUUID, { quads: [[10, 10, 20, 20]] })]]);
  const strokeMoved = B.msg([[1, 2, B.str(MUUID)],
    [7, 2, B.strokeField7(MUUID, { quads: [[300, 300, 350, 320]], offset: [10, -5] })]]);
  const strokeHl = B.msg([[1, 2, B.str(HUUID)],
    [7, 2, B.strokeField7(HUUID, { quads: [[330, 200, 370, 200]], color: [1, 1, 0, 0.5] })]]);
  const shape = B.shapeRecordF9(RUUID, 10, 10, 60, 40);
  const text = B.textRecord('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee00', 50, 60, 200, 100, [
    B.textItemPayload('Titel', { size: 32, color: [1, 0, 0, 1], align: 2 }),
    B.textItemPayload('Punkt', { size: 14, color: [0, 0, 0, 1], align: 1, list: 'bullet' }),
  ]);
  const sticky = B.stickyRecord('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee11', 70, 80, 'Merkzettel');
  const img = B.imageRecord(RUUID, AUUID, 20, 30, 100, 50);
  const notes1 = B.delimited([B.metaFrame(EUUID, true), strokeNormal, strokeErased, strokeMoved, strokeHl, shape, text, sticky, img]);
  // Seite 2: ein Strich
  const notes2 = B.delimited([B.msg([[1, 2, B.str(PAGE2)],
    [7, 2, B.strokeField7(PAGE2, { quads: [[0, 0, 50, 50]] })]])]);
  const files = [
    ['index.notes.pb', B.delimited([
      B.msg([[1, 2, B.str('aaaaaaaa-0000-4000-8000-aaaaaaaa0001')], [2, 2, B.str('notes/page1')]]),
      B.msg([[1, 2, B.str('aaaaaaaa-0000-4000-8000-aaaaaaaa0002')], [2, 2, B.str('notes/page2')]]),
    ])],
    ['notes/page1', notes1],
    ['notes/page2', notes2],
    ['index.events.pb', B.eventsWithTitle('Fixture-Buch')],
    ['attachments/' + AUUID, B.png1x1()],
    ['attachments/pdf1', B.minimalPdf(220, 285, 'Hello')],
  ];
  return B.zipStore(files);
}

describe('goodnotes dokument', () => {
  it('titel, seiten, strokes (inkl. radiert/loeschen, offset, marker)', async () => {
    const members = await GNZip.readZip(new Uint8Array(fixtureDoc()));
    const doc = GoodNotes.parseDocument(members, 'fallback');
    assert.equal(doc.title, 'Fixture-Buch');
    assert.equal(doc.pages.length, 2);
    const pg = doc.pages[0];
    assert.equal(pg.strokes.length, 3); // normal, moved, hl (radiert fehlt)
    const [s0, s1, s2] = pg.strokes;
    assert.deepEqual(s0.points.map(p => [p.x, p.y]), [[100, 200], [150, 250]]);
    assert.equal(s0.color, '#0000ff');
    assert.equal(s0.width, 2.5);
    assert.equal(s0.highlighter, false);
    assert.deepEqual(s1.points.map(p => [p.x, p.y]), [[310, 295], [360, 315]]); // offset
    assert.equal(s2.highlighter, true);
    assert.equal(s2.color, '#ffff00');
    assert.equal(doc.pages[1].strokes.length, 1);
  });

  it('shapes, texte, sticky, bilder, pdf', async () => {
    const members = await GNZip.readZip(new Uint8Array(fixtureDoc()));
    const doc = GoodNotes.parseDocument(members, 'fallback');
    const pg = doc.pages[0];
    assert.equal(doc.stats.shapes, 1);
    assert.deepEqual(pg.shapes[0].points, [[10, 10], [60, 40]]);
    assert.equal(pg.shapes[0].color, '#007354'); // f32-Rundung von 0.45/0.33
    assert.equal(doc.stats.texts, 2); // textbox + sticky
    const m = GoodNotes.mapPage(pg);
    assert.equal(m.texts.length, 2);
    const html = m.texts[0].html;
    assert.match(html, /<h2>/);
    assert.match(html, /<ul>/);
    assert.match(html, /color:#ff0000/);
    assert.match(html, /text-align:center/);
    assert.match(m.texts[1].html, /rgba\(250,231,120/);
    assert.match(m.texts[1].html, /Merkzettel/);
    assert.equal(pg.images.length, 1);
    assert.deepEqual([pg.images[0].ie.x, pg.images[0].ie.y, pg.images[0].ie.w, pg.images[0].ie.h], [20, 30, 100, 50]);
    assert.equal(doc.stats.pdfBg, true);
    assert.deepEqual([pg.dim.w, pg.dim.h], [220, 285]);
  });

  it('mapping liegt im canvas', async () => {
    const members = await GNZip.readZip(new Uint8Array(fixtureDoc()));
    const doc = GoodNotes.parseDocument(members, 'fallback');
    for (const pg of doc.pages) {
      const m = GoodNotes.mapPage(pg);
      for (const s of m.strokes)
        for (const p of s.points)
          assert.ok(p.x >= -50 && p.x <= 1050 && p.y >= -50 && p.y <= 1350, JSON.stringify(p));
    }
  });

  it('runsToHtml sonderfaelle', () => {
    assert.equal(GoodNotes.runsToHtml({ runs: [] }), '(leerer Text)');
    const h = GoodNotes.runsToHtml({ runs: [{ text: 'a\nb', bold: true, size: 40, color: '#112233', align: 'right' }] });
    assert.match(h, /<h1>/);
    assert.match(h, /<b>/);
    assert.match(h, /<br>/);
  });
});
