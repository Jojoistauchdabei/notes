'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const PI = require('../js/pages-import.js');

describe('pages-import/calcContainSize', () => {
  it('passt quer in hoch ein (1000x1294)', () => {
    const r = PI.calcContainSize(2000, 1000, 1000, 1294);
    assert.equal(r.w, 1000);
    assert.equal(r.h, 500);
    assert.ok(Math.abs(r.scale - 0.5) < 1e-9);
    assert.ok(Math.abs(r.dx) < 1e-9);
    assert.ok(r.dy > 0);
  });
  it('passt hoch in hoch ein, zentriert', () => {
    const r = PI.calcContainSize(1000, 2000, 1000, 1294);
    assert.ok(r.w <= 1000 && r.h <= 1294);
    assert.ok(Math.abs(r.w - 647) < 1);
    assert.ok(Math.abs(r.h - 1294) < 1);
  });
  it('ungültige Eingaben -> Nullen', () => {
    assert.deepEqual(PI.calcContainSize(0, 10, 100, 100), { w: 0, h: 0, scale: 0, dx: 0, dy: 0 });
    assert.deepEqual(PI.calcContainSize(10, 10, 0, 5), { w: 0, h: 0, scale: 0, dx: 0, dy: 0 });
    assert.deepEqual(PI.calcContainSize(-3, 10, 100, 100), { w: 0, h: 0, scale: 0, dx: 0, dy: 0 });
  });
});

describe('pages-import/scaleForLongEdge', () => {
  it('skaliert lange Kante auf 1600', () => {
    assert.equal(PI.scaleForLongEdge(3200, 2000), 0.5);
    const s = PI.scaledSizeForLimit(3200, 2000, 1600);
    assert.deepEqual([s.w, s.h], [1600, 1000]);
  });
  it('kleine Bilder bleiben (scale 1)', () => {
    assert.equal(PI.scaleForLongEdge(800, 600), 1);
    assert.deepEqual(PI.scaledSizeForLimit(800, 600, 1600), { w: 800, h: 600, scale: 1 });
  });
  it('Hochkant nutzt Höhe als lange Kante', () => {
    assert.equal(PI.scaleForLongEdge(1000, 3200), 0.5);
  });
});

describe('pages-import/buildNewPageModel', () => {
  it('leeres Modell: Ink leer, bg null, Layer-Trennung', () => {
    const p = PI.buildNewPageModel('p1');
    assert.equal(p.id, 'p1');
    assert.deepEqual(p.strokes, []);
    assert.deepEqual(p.texts, []);
    assert.deepEqual(p.images, []);
    assert.equal(p.bg, null);
  });
  it('generiert id ohne Argument', () => {
    const p = PI.buildNewPageModel();
    assert.ok(typeof p.id === 'string' && p.id.length > 0);
  });
  it('übernimmt bg-Ref, Ink bleibt leer', () => {
    const p = PI.buildNewPageModel({ id: 'px', bg: 'blob:abc' });
    assert.equal(p.bg, 'blob:abc');
    assert.deepEqual(p.strokes, []);
    assert.deepEqual(p.texts, []);
  });
  it('Titel-Option legt keine Textbox an (Ink leer)', () => {
    const p = PI.buildNewPageModel({ id: 't1', title: 'Scan 1' });
    assert.deepEqual(p.strokes, []);
    assert.deepEqual(p.texts, []);
  });
});

describe('pages-import/parsePageRange', () => {
  it('„1-3,5" bei 10 Seiten', () => {
    assert.deepEqual(PI.parsePageRange('1-3,5', 10), [1, 2, 3, 5]);
    assert.deepEqual(PI.pageRangeParser('1-3,5', 10), [1, 2, 3, 5]);
  });
  it('leer -> alle Seiten', () => {
    assert.deepEqual(PI.parsePageRange('', 3), [1, 2, 3]);
    assert.deepEqual(PI.parsePageRange(null, 3), [1, 2, 3]);
    assert.deepEqual(PI.parsePageRange(undefined, 2), [1, 2]);
  });
  it('Spaces, Duplikate, Sortierung', () => {
    assert.deepEqual(PI.parsePageRange(' 5 , 2-3, 2', 6), [2, 3, 5]);
  });
  it('gedrehter Bereich wird normalisiert', () => {
    assert.deepEqual(PI.parsePageRange('3-1', 5), [1, 2, 3]);
  });
  it('Out-of-Range wird geclampt/ignoriert', () => {
    assert.deepEqual(PI.parsePageRange('0,2,99', 3), [2]);
    assert.deepEqual(PI.parsePageRange('2-99', 3), [2, 3]);
  });
  it('ungültige Tokens tolerant ignorieren', () => {
    assert.deepEqual(PI.parsePageRange('abc,,2-, -,4', 5), [4]);
    assert.deepEqual(PI.parsePageRange('abc', 5), []);
  });
  it('total<=0 -> []', () => {
    assert.deepEqual(PI.parsePageRange('1-3', 0), []);
    assert.deepEqual(PI.parsePageRange('', 0), []);
  });
});

describe('pages-import/offline-fallback', () => {
  it('enthält Kennsatz „PDF-Hintergrund offline nicht ladbar"', () => {
    const html = PI.offlinePdfFallbackHtml('abenteuer.pdf', 2);
    assert.match(html, /PDF-Hintergrund offline nicht ladbar/);
    assert.match(html, /abenteuer\.pdf/);
  });
  it('Status-Text nennt Fortschritt', () => {
    assert.match(PI.pdfImportStatus(2, 7, 'a.pdf'), /2\/7/);
  });
});
