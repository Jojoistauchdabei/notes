'use strict';
/* Audit des GoodNotes .goodnotes IMPORTs gegen echte Fixture (tmp/ex1.goodnotes).
   READ-ONLY: verifiziert GNZip.readZip + GoodNotes.parseDocument + mapPage + runsToHtml.
   Keine Logik-Aenderung. Wird uebersprungen, wenn die Fixture fehlt (gitignoriert). */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const GNZip = require('../js/gnzip.js');
const GoodNotes = require('../js/goodnotes.js');

const SAMPLE = path.join(__dirname, '..', 'tmp', 'ex1.goodnotes');

describe('gnimport audit (ex1.goodnotes)', async () => {
  if (!fs.existsSync(SAMPLE)) {
    it.skip('ex1.goodnotes fehlt (tmp/ ist gitignoriert)', () => {});
    return;
  }
  const raw = fs.readFileSync(SAMPLE);
  const members = await GNZip.readZip(new Uint8Array(raw));
  const doc = GoodNotes.parseDocument(members, 'ex1');

  it('pages>0, title nicht-leer', () => {
    assert.ok(doc.pages.length > 0, 'pages=' + doc.pages.length);
    assert.equal(typeof doc.title, 'string');
    assert.ok(doc.title.trim().length > 0, 'title leer');
  });

  it('strokes haben valide Punkte (finit, sane coords)', () => {
    let n = 0;
    for (const pg of doc.pages) {
      assert.ok(Array.isArray(pg.strokes));
      for (const s of pg.strokes) {
        assert.ok(Array.isArray(s.points) && s.points.length > 0, 'stroke ohne punkte');
        assert.match(s.color, /^#[0-9a-f]{6}$/i);
        assert.ok(Number.isFinite(s.width) && s.width > 0, 'width=' + s.width);
        assert.equal(typeof s.highlighter, 'boolean');
        for (const p of s.points) {
          assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), JSON.stringify(p));
          assert.ok(p.x >= -5000 && p.x <= 5000 && p.y >= -5000 && p.y <= 5000, JSON.stringify(p));
          n++;
        }
      }
    }
    assert.ok(n > 0, 'keine stroke-punkte gefunden');
  });

  it('texts: runsToHtml liefert nicht-leeres HTML', () => {
    // Fixture ex1 hat 0 Textboxen (stats.texts=0) -> Schleife ist leer,
    // Kantenfaelle sichern trotzdem ab, dass runsToHtml nie leer wirft.
    for (const pg of doc.pages) {
      for (const t of (pg.textBoxes || [])) {
        const html = GoodNotes.runsToHtml(t);
        assert.equal(typeof html, 'string');
        assert.ok(html.trim().length > 0);
      }
    }
    assert.ok(GoodNotes.runsToHtml({ runs: [] }).trim().length > 0);
    const h = GoodNotes.runsToHtml({ runs: [{ text: 'audit', size: 24, color: '#000000', align: 'left' }] });
    assert.ok(h.includes('audit'));
  });

  it('images referenzieren existierende attachments', () => {
    let n = 0;
    for (const pg of doc.pages) {
      for (const im of (pg.images || [])) {
        const att = im.ie && im.ie.attachment;
        assert.ok(typeof att === 'string' && att.length > 0, 'attachment fehlt');
        const key = 'attachments/' + att;
        assert.ok(members[key], 'fehlt: ' + key);
        assert.ok(members[key].length > 0, key + ' leer');
        assert.ok(im.mime === 'image/png' || im.mime === 'image/jpeg', 'mime=' + im.mime);
        assert.ok(im.bytes && im.bytes.length > 0);
        for (const v of [im.ie.x, im.ie.y, im.ie.w, im.ie.h])
          assert.ok(Number.isFinite(v), 'ie=' + JSON.stringify(im.ie));
        assert.ok(im.ie.w > 0 && im.ie.h > 0, 'ie wh=' + JSON.stringify(im.ie));
        n++;
      }
    }
    assert.ok(n > 0, 'keine bilder gefunden');
  });

  it('mapPage liegt im A4-Canvas / normierte Text-Koords', () => {
    for (const pg of doc.pages) {
      const m = GoodNotes.mapPage(pg);
      assert.ok(m.strokes.length >= pg.strokes.length, 'mapped strokes < strokes');
      for (const s of m.strokes)
        for (const p of s.points) {
          assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), JSON.stringify(p));
          assert.ok(p.x >= -50 && p.x <= 1050 && p.y >= -50 && p.y <= 1464, JSON.stringify(p));
        }
      for (const t of m.texts) {
        assert.ok(Number.isFinite(t.x) && Number.isFinite(t.y), JSON.stringify(t));
        assert.ok(t.x >= -0.1 && t.x <= 1.1 && t.y >= -0.1 && t.y <= 1.1, JSON.stringify(t));
        assert.ok(typeof t.html === 'string' && t.html.trim().length > 0);
      }
    }
  });

  it('re-parse ist idempotent (kein Throw, gleiche page-count)', async () => {
    const members2 = await GNZip.readZip(new Uint8Array(raw));
    const doc2 = GoodNotes.parseDocument(members2, 'ex1');
    assert.equal(doc2.pages.length, doc.pages.length);
    assert.equal(doc2.title, doc.title);
    assert.deepEqual(
      doc2.pages.map(p => p.strokes.length),
      doc.pages.map(p => p.strokes.length)
    );
  });
});
