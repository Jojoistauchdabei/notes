'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/paper-templates.js');

describe('paper-templates/Katalog', () => {
  it('enthält ~8-12 gültige Vorlagen mit eindeutigen IDs', () => {
    assert.ok(P.TEMPLATES.length >= 8 && P.TEMPLATES.length <= 12);
    const ids = P.TEMPLATES.map(t => t.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const t of P.TEMPLATES) {
      assert.ok(typeof t.id === 'string' && t.id);
      assert.ok(typeof t.name === 'string' && t.name);
      assert.ok(Number.isInteger(t.w) && t.w >= 200 && t.w <= 2400);
      assert.ok(Number.isInteger(t.h) && t.h >= 200 && t.h <= 2400);
      assert.ok(typeof t.pattern === 'string' && t.pattern);
      assert.ok(typeof t.cssClass === 'string');
      assert.ok(typeof t.group === 'string' && t.group);
    }
  });
  it('A4-Maße 1000x1414, A5-Verhältnis 148:210, Quadrat, US-Letter', () => {
    assert.deepEqual(P.dimsFor('blank-a4'), { w: 1000, h: 1414 });
    const a5 = P.dimsFor('blank-a5');
    assert.equal(a5.w, 1000);
    assert.ok(Math.abs(a5.h / a5.w - 210 / 148) < 0.002);
    assert.deepEqual(P.dimsFor('blank-square'), { w: 1000, h: 1000 });
    const letter = P.dimsFor('blank-letter');
    assert.equal(letter.w, 1000);
    assert.ok(Math.abs(letter.h / letter.w - 11 / 8.5) < 0.002);
  });
  it('alle cssClasses sind in allCssClasses abgedeckt (Legacy inkl.)', () => {
    const all = P.allCssClasses();
    assert.ok(all.includes('lined') && all.includes('grid'));
    for (const t of P.TEMPLATES) {
      for (const c of P.cssClasses(t.id)) assert.ok(all.includes(c), c);
    }
  });
  it('groups() liefert Optgroups mit allen Vorlagen', () => {
    const g = P.groups();
    assert.ok(g.length >= 2);
    const n = g.reduce((a, x) => a + x.items.length, 0);
    assert.equal(n, P.TEMPLATES.length);
  });
});

describe('paper-templates/Legacy-Mapping', () => {
  it("'' -> blank-a4, 'lined' -> lined-a4, 'grid' -> grid-a4", () => {
    assert.equal(P.normalizeId(''), 'blank-a4');
    assert.equal(P.normalizeId('lined'), 'lined-a4');
    assert.equal(P.normalizeId('grid'), 'grid-a4');
  });
  it('neue IDs bleiben stabil', () => {
    for (const t of P.TEMPLATES) assert.equal(P.normalizeId(t.id), t.id);
  });
  it('resolve() fällt nie auf null (Default blank-a4)', () => {
    assert.equal(P.resolve('gibts-nicht').id, P.DEFAULT_ID);
    assert.equal(P.resolve(null).id, P.DEFAULT_ID);
    assert.equal(P.resolve(undefined).id, P.DEFAULT_ID);
  });
});

describe('paper-templates/Maß-Auflösung', () => {
  it('sizeForPersistence: A4-Default -> null (kein State-Ballast)', () => {
    assert.equal(P.sizeForPersistence(1000, 1414), null);
    assert.equal(P.sizeForTemplateId('blank-a4'), null);
    assert.equal(P.sizeForTemplateId('lined-a4'), null);
    assert.deepEqual(P.sizeForTemplateId('blank-square'), { w: 1000, h: 1000 });
  });
  it('effectiveDims: page.size gewinnt, sonst Buch-Vorlage, sonst A4', () => {
    assert.deepEqual(P.effectiveDims({ size: { w: 1414, h: 1000 } }, 'blank-square'), { w: 1414, h: 1000 });
    assert.deepEqual(P.effectiveDims({}, 'blank-square'), { w: 1000, h: 1000 });
    assert.deepEqual(P.effectiveDims({}, 'unbekannt'), { w: 1000, h: 1414 });
    assert.deepEqual(P.effectiveDims({ size: { w: 5, h: 5 } }, 'blank-square'), { w: 1000, h: 1000 });
  });
  it('followsTemplate: nur template-folgende Seiten umformatieren', () => {
    const a4 = { w: 1000, h: 1414 };
    assert.equal(P.followsTemplate({}, a4), true);
    assert.equal(P.followsTemplate({ size: { w: 1000, h: 1414 } }, a4), true);
    assert.equal(P.followsTemplate({ size: { w: 1414, h: 1000 } }, a4), false); // PDF-Querformat
    assert.equal(P.followsTemplate({ size: { w: 1000, h: 1000 } }, a4), false); // Quadrat-Bildseite
  });
  it('bgFor/patternFor: Raster hell, Rest creme', () => {
    assert.equal(P.bgFor('grid-a4'), '#ffffff');
    assert.equal(P.bgFor('grid-large-a4'), '#ffffff');
    assert.equal(P.bgFor('lined-a4'), '#fffdf6');
    assert.equal(P.patternFor('unbekannt'), 'blank');
  });
});
