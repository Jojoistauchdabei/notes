'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const PI = require('../js/pages-import.js');
const GoodNotes = require('../js/goodnotes.js');

describe('Seitenformat/sanitizePageSize', () => {
  it('null/undefined -> null (Default A4, wird nicht persistiert)', () => {
    assert.equal(PI.sanitizePageSize(null), null);
    assert.equal(PI.sanitizePageSize(undefined), null);
  });
  it('Preset-Keys', () => {
    assert.deepEqual(PI.sanitizePageSize('a4l'), { w: 1414, h: 1000 });
    assert.deepEqual(PI.sanitizePageSize('square'), { w: 1000, h: 1000 });
    assert.equal(PI.sanitizePageSize('a4p'), null); // Default -> null
    assert.equal(PI.sanitizePageSize('unsinn'), null);
  });
  it('gültiges Objekt bleibt, Default kollabiert', () => {
    assert.deepEqual(PI.sanitizePageSize({ w: 1414, h: 1000 }), { w: 1414, h: 1000 });
    assert.equal(PI.sanitizePageSize({ w: 1000, h: 1414 }), null);
  });
  it('clamping + Rundung, ungültig -> null', () => {
    assert.deepEqual(PI.sanitizePageSize({ w: 50, h: 5000 }), { w: 200, h: 2400 });
    assert.deepEqual(PI.sanitizePageSize({ w: 1000.6, h: 999.4 }), { w: 1001, h: 999 });
    assert.equal(PI.sanitizePageSize({ w: 'x', h: 1 }), null);
    assert.equal(PI.sanitizePageSize({ w: NaN, h: 5 }), null);
    assert.equal(PI.sanitizePageSize(42), null);
  });
});

describe('Seitenformat/pageDims + match + label', () => {
  it('fehlende size -> A4-Default (winzig numerisch -> geclampt)', () => {
    assert.deepEqual(PI.pageDims({}), { w: 1000, h: 1414 });
    assert.deepEqual(PI.pageDims(null), { w: 1000, h: 1414 });
    assert.deepEqual(PI.pageDims({ size: { w: 'x', h: 2 } }), { w: 1000, h: 1414 });
    assert.deepEqual(PI.pageDims({ size: { w: 1, h: 2 } }), { w: 200, h: 200 });
  });
  it('custom bleibt', () => {
    assert.deepEqual(PI.pageDims({ size: { w: 1414, h: 1000 } }), { w: 1414, h: 1000 });
  });
  it('matchPageFormat', () => {
    assert.equal(PI.matchPageFormat(null), 'a4p');
    assert.equal(PI.matchPageFormat({ w: 1414, h: 1000 }), 'a4l');
    assert.equal(PI.matchPageFormat({ w: 1000, h: 1000 }), 'square');
    assert.equal(PI.matchPageFormat({ w: 1000, h: 500 }), null);
  });
  it('formatLabel', () => {
    assert.equal(PI.formatLabel(null), 'A4 Hoch');
    assert.equal(PI.formatLabel({ w: 1414, h: 1000 }), 'A4 Quer');
    assert.match(PI.formatLabel({ w: 1000, h: 500 }), /Bildformat 1000×500/);
  });
});

describe('Seitenformat/sizeForImage', () => {
  it('quer 2000x1000 -> 1000x500', () => {
    assert.deepEqual(PI.sizeForImage(2000, 1000), { w: 1000, h: 500 });
  });
  it('hoch 1000x2000 -> 1000x2000', () => {
    assert.deepEqual(PI.sizeForImage(1000, 2000), { w: 1000, h: 2000 });
  });
  it('quadrat -> 1000x1000 (custom, bleibt erhalten)', () => {
    assert.deepEqual(PI.sizeForImage(800, 800), { w: 1000, h: 1000 });
  });
  it('A4-Verhältnis -> null (Default)', () => {
    assert.equal(PI.sizeForImage(1000, 1414), null);
  });
  it('ungültig -> null', () => {
    assert.equal(PI.sizeForImage(0, 5), null);
    assert.equal(PI.sizeForImage(-3, 5), null);
    assert.equal(PI.sizeForImage(NaN, 5), null);
  });
});

describe('Seitenformat/retargetStrokes', () => {
  const from = { w: 1000, h: 1414 };
  const to = { w: 1414, h: 1000 };
  it('skaliert Punkte + Stiftstärke', () => {
    const out = PI.retargetStrokes(
      [{ tool: 'pen', color: '#000', size: 3, points: [{ x: 100, y: 141.4, p: 0.5 }] }],
      from, to);
    assert.equal(out[0].points[0].x, 141.4);
    assert.equal(out[0].points[0].y, 100);
    assert.equal(out[0].points[0].p, 0.5); // Druck unangetastet
    assert.ok(out[0].size > 2 && out[0].size < 4);
  });
  it('identische Maße -> Referenz zurück', () => {
    const s = [{ points: [{ x: 1, y: 2 }] }];
    assert.equal(PI.retargetStrokes(s, from, from), s);
  });
  it('tolerant bei kaputten Eingaben', () => {
    assert.deepEqual(PI.retargetStrokes(null, from, to), null);
    assert.deepEqual(PI.retargetStrokes('x', from, to), 'x');
  });
  it('dash wird mitskaliert', () => {
    const out = PI.retargetStrokes(
      [{ points: [{ x: 0, y: 0 }], size: 2, dash: [10, 5] }], from, to);
    assert.notDeepEqual(out[0].dash, [10, 5]);
  });
});

describe('Seitenformat/backingForPage', () => {
  it('A4 mit dpr 2 -> 2000x2828', () => {
    const b = PI.backingForPage(1000, 1414, 2);
    assert.deepEqual([b.w, b.h, b.dpr], [2000, 2828, 2]);
  });
  it('Riesenformat deckelt dpr (Speicher-Schutz)', () => {
    const b = PI.backingForPage(2400, 2400, 2);
    assert.ok(b.dpr < 2, 'dpr gedeckelt, ist ' + b.dpr);
    assert.ok(b.w * b.h <= 9500000, 'Backing <= ~9MP');
  });
  it('Fallback ohne dpr', () => {
    const b = PI.backingForPage(1000, 1414, 0);
    assert.equal(b.dpr, 1);
  });
});

describe('Seitenformat/Seitenmodell', () => {
  it('buildNewPageModel ohne size -> kein size-Feld', () => {
    const p = PI.buildNewPageModel({ bg: 'blob:x' });
    assert.ok(!('size' in p));
  });
  it('buildNewPageModel mit Preset', () => {
    const p = PI.buildNewPageModel({ size: 'a4l' });
    assert.deepEqual(p.size, { w: 1414, h: 1000 });
  });
  it('buildTemplatePage übernimmt Format, nicht Inhalt', () => {
    const tpl = PI.buildTemplatePage({ bg: 'blob:x', size: { w: 1000, h: 500 }, strokes: [{}], texts: [{}], images: [{}] });
    assert.deepEqual(tpl.size, { w: 1000, h: 500 });
    assert.deepEqual([tpl.strokes, tpl.texts, tpl.images], [[], [], []]);
  });
  it('clonePagesForImport behält + sanitisiet Format', () => {
    const cl = PI.clonePagesForImport([
      { id: 'a', strokes: [], texts: [], images: [], bg: null, size: { w: 1414, h: 1000 } },
      { id: 'b', strokes: [], texts: [], images: [], bg: null, size: { w: 'x', h: 2 } },
      { id: 'c', strokes: [], texts: [], images: [], bg: null, size: { w: 1, h: 2 } },
    ], null);
    assert.deepEqual(cl[0].size, { w: 1414, h: 1000 });
    assert.ok(!('size' in cl[1]), 'ungültiges Format fällt weg');
    assert.deepEqual(cl[2].size, { w: 200, h: 200 }, 'winzig numerisch -> geclampt');
  });
});

describe('Seitenformat/GoodNotes-Export-Skalierung', () => {
  const PE = GoodNotes._internals.pageExportScale;
  it('ohne size -> 1:1 (Altverhalten)', () => {
    assert.deepEqual(PE({}), { sx: 1, sy: 1 });
    assert.deepEqual(PE({ size: { w: 1000, h: 1414 } }), { sx: 1, sy: 1 });
  });
  it('A4-Quer normiert auf A4-Hoch-Raum', () => {
    const s = PE({ size: { w: 1414, h: 1000 } });
    assert.ok(Math.abs(s.sx - 1000 / 1414) < 1e-9);
    assert.ok(Math.abs(s.sy - 1414 / 1000) < 1e-9);
  });
  it('kaputt -> 1:1', () => {
    assert.deepEqual(PE({ size: { w: 'x', h: 1 } }), { sx: 1, sy: 1 });
  });
});
