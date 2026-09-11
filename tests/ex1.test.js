'use strict';
/* Konformanz gegen echte GoodNotes-Datei (tmp/ex1.goodnotes, 1,1 MB).
   Wird übersprungen, wenn die Datei fehlt (sie ist gitignoriert und
   wird nicht redistribuiert). Erwartungswerte gegen den Python-
   Referenzparser (Kaih1825/parser-for-goodnotes) verifiziert. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const GNZip = require('../js/gnzip.js');
const GoodNotes = require('../js/goodnotes.js');

const SAMPLE = path.join(__dirname, '..', 'tmp', 'ex1.goodnotes');

describe('ex1.goodnotes konformanz', async () => {
  if (!fs.existsSync(SAMPLE)) {
    it.skip('ex1.goodnotes fehlt (tmp/ ist gitignoriert)', () => {});
    return;
  }
  const members = await GNZip.readZip(new Uint8Array(fs.readFileSync(SAMPLE)));
  const doc = GoodNotes.parseDocument(members, 'ex1');

  it('titel + seiten + masse', () => {
    assert.equal(doc.title, 'Homework04_B11315022');
    assert.equal(doc.pages.length, 1);
    assert.deepEqual([doc.pages[0].dim.w, doc.pages[0].dim.h], [455.04, 588.45]);
  });
  it('1484 strokes, erster stroke exakt', () => {
    const pg = doc.pages[0];
    assert.equal(pg.strokes.length, 1484);
    const s0 = pg.strokes[0];
    assert.equal(s0.points.length, 3);
    assert.equal(s0.color, '#03468f');
    assert.ok(Math.abs(s0.width - 1.56) < 0.005, 'width=' + s0.width);
    assert.equal(s0.highlighter, false);
    assert.deepEqual(s0.points.slice(0, 4).map(p => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]),
      [[426, 157.5], [425.9, 159.2], [425.9, 161.8]]);
  });
  it('bbox + farben', () => {
    const xs = [], ys = [];
    doc.pages[0].strokes.forEach(s => s.points.forEach(p => { xs.push(p.x); ys.push(p.y); }));
    const r = (v) => Math.round(v * 10) / 10;
    assert.deepEqual([r(Math.min(...xs)), r(Math.max(...xs)), r(Math.min(...ys)), r(Math.max(...ys))],
      [46.6, 746.8, 64.8, 1000.8]);
    assert.deepEqual([...new Set(doc.pages[0].strokes.map(s => s.color))], ['#03468f']);
  });
  it('10 shapes wie referenz', () => {
    assert.equal(doc.stats.shapes, 10);
    const s0 = doc.pages[0].shapes[0];
    assert.equal(s0.points.length, 2);
    assert.equal(s0.color, '#03468f');
    assert.deepEqual(s0.points.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]),
      [[136.3, 985.7], [145.1, 985.7]]);
    const greens = doc.pages[0].shapes.filter(s => s.color === '#007355');
    assert.equal(greens.length, 3);
  });
  it('bilder + pdf-hintergrund', () => {
    const pg = doc.pages[0];
    assert.equal(pg.images.length, 3);
    assert.deepEqual(pg.images.map(i => [i.ie.x, i.ie.y, i.ie.w, i.ie.h].map(v => Math.round(v * 100) / 100)),
      [[20.08, 28.26, 257, 26.48], [11.24, 613.47, 591.78, 57.5], [19.49, 382.06, 175.91, 34.1]]);
    assert.equal(doc.stats.pdfBg, true);
    assert.equal(doc.stats.texts, 0);
  });
  it('mapping im canvas', () => {
    const m = GoodNotes.mapPage(doc.pages[0]);
    assert.equal(m.strokes.length, 1484 + 10); // strokes + shapes
    for (const s of m.strokes)
      for (const p of s.points)
        assert.ok(p.x >= -50 && p.x <= 1050 && p.y >= -50 && p.y <= 1350);
  });
});
