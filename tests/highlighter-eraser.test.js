'use strict';
// SPEC-25: Highlighter & Radierer (+ Undo-Gesten). Reine Funktionen, keine DOM-Abhängigkeit.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../js/erase.js');

const pen = (pts) => ({ tool: 'pen', color: '#2a1a0e', size: 3, points: pts });
const marker = (pts) => ({ tool: 'marker', color: '#ffff00', size: 9, points: pts });
const P = (x, y) => ({ x, y });

describe('SPEC-25 marker-konstanten', () => {
  it('alpha 0.35, multiply', () => {
    assert.equal(E.MARKER_ALPHA, 0.35);
    assert.equal(E.MARKER_COMPOSITE, 'multiply');
  });

  it('app.js drawStroke nutzt multiply + alpha 0.35 für marker', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
    assert.match(src, /tool\s*===\s*['"]marker['"]/);
    assert.match(src, /globalCompositeOperation\s*=\s*['"]multiply['"]/);
    assert.match(src, /globalAlpha\s*=\s*0\.35/);
  });
});

describe('SPEC-25 scribble-erkennung', () => {
  // schnelles Hin-und-Her auf X: 100 -> 130 -> 105 -> 128, alles in 300ms, Radius klein
  const scribble = [
    { x: 100, y: 100, t: 0 },
    { x: 130, y: 102, t: 100 },
    { x: 105, y: 99, t: 200 },
    { x: 128, y: 101, t: 300 },
  ];

  it('positiv: >=2 Richtungswechsel in 400ms, kleiner Radius', () => {
    assert.equal(E.isScribbleGesture(scribble), true);
  });

  it('negativ: gerade Linie (kein Richtungswechsel)', () => {
    const line = [
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 1, t: 50 },
      { x: 20, y: 2, t: 100 },
      { x: 30, y: 3, t: 150 },
    ];
    assert.equal(E.isScribbleGesture(line), false);
  });

  it('negativ: zu langsam (Wechsel ausserhalb 400ms-Fenster)', () => {
    const slow = [
      { x: 100, y: 100, t: 0 },
      { x: 130, y: 100, t: 1000 },
      { x: 105, y: 100, t: 2000 },
      { x: 128, y: 100, t: 3000 },
    ];
    assert.equal(E.isScribbleGesture(slow), false);
  });

  it('negativ: zu grosser Radius (kein Gekritzel auf der Stelle)', () => {
    const wide = [
      { x: 0, y: 0, t: 0 },
      { x: 200, y: 5, t: 100 },
      { x: 10, y: 0, t: 200 },
      { x: 190, y: 5, t: 300 },
    ];
    assert.equal(E.isScribbleGesture(wide), false);
  });

  it('negativ: zu wenige Punkte', () => {
    assert.equal(E.isScribbleGesture([{ x: 1, y: 1, t: 0 }]), false);
    assert.equal(E.isScribbleGesture([]), false);
  });

  it('scribble-opfer: ziel-stroke weg, nachbar bleibt', () => {
    const target = pen([P(100, 100), P(130, 100)]);
    const neighbor = pen([P(500, 500), P(530, 500)]);
    const victims = E.collectScribbleVictims([target, neighbor], scribble, undefined, { mode: 'stroke' });
    assert.equal(victims.length, 1);
    assert.equal(victims[0], target);
  });
});

describe('SPEC-25 eraser-filter', () => {
  const hl = marker([P(50, 50), P(60, 50)]);
  const ink = pen([P(50, 50), P(60, 50)]);
  const far = pen([P(900, 900), P(910, 910)]);
  const pt = { x: 55, y: 50 };

  it('nur-highlighter: marker weg, tinte intakt', () => {
    const res = E.filterStrokesForErase([hl, ink, far], pt, 12, { mode: 'standard', highlighterOnly: true });
    assert.deepEqual(res.removed, [hl]);
    assert.deepEqual(res.kept, [ink, far]);
  });

  it('standard: alles berührte weg, fernes bleibt', () => {
    const res = E.filterStrokesForErase([hl, ink, far], pt, 12, { mode: 'standard', highlighterOnly: false });
    assert.equal(res.removed.length, 2);
    assert.ok(res.removed.includes(hl) && res.removed.includes(ink));
    assert.deepEqual(res.kept, [far]);
  });

  it('stroke-modus: voll-stroke bei berührung', () => {
    const res = E.filterStrokesForErase([hl, ink], pt, 12, { mode: 'stroke', highlighterOnly: false });
    assert.equal(res.removed.length, 2);
    assert.equal(res.kept.length, 0);
  });

  it('precision vs. standard unterscheidbar (teil vs. voll)', () => {
    const long = pen([P(0, 0), P(55, 50), P(500, 500)]);
    const std = E.filterStrokesForErase([long], pt, 12, { mode: 'standard' });
    assert.equal(std.removed.length, 1); // ganz weg
    const pre = E.filterStrokesForErase([long], pt, 12, { mode: 'precision' });
    assert.equal(pre.removed.length, 0); // nichts komplett weg
    assert.equal(pre.kept.length, 1);
    assert.ok(pre.kept[0].points.length < long.points.length); // nur treffer-punkte raus
    assert.ok(pre.kept[0].points.length >= 1);
  });

  it('alte strokes ohne tool-flag: standard löscht, highlighter-only schont', () => {
    const legacy = { color: '#000', size: 2, points: [P(55, 50)] };
    const a = E.filterStrokesForErase([legacy], pt, 12, { mode: 'standard', highlighterOnly: false });
    assert.equal(a.removed.length, 1);
    const b = E.filterStrokesForErase([legacy], pt, 12, { mode: 'standard', highlighterOnly: true });
    assert.equal(b.removed.length, 0);
    assert.equal(b.kept.length, 1);
  });
});

describe('SPEC-25 undo/redo-gesten', () => {
  it('zwei-finger-tap = undo, drei-finger-tap = redo', () => {
    assert.equal(E.gestureActionForTap(2, 150, 5), 'undo');
    assert.equal(E.gestureActionForTap(3, 150, 5), 'redo');
  });

  it('kein konflikt mit pinch-zoom (lang oder viel bewegung)', () => {
    assert.equal(E.gestureActionForTap(2, 500, 5), null);
    assert.equal(E.gestureActionForTap(3, 150, 50), null);
    assert.equal(E.gestureActionForTap(2, 299, 11), 'undo'); // grenzwert noch tap
    assert.equal(E.gestureActionForTap(1, 100, 2), null);
    assert.equal(E.gestureActionForTap(4, 100, 2), null);
  });
});

describe('SPEC-25 eraser-persistenz', () => {
  const mem = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
  };

  it('roundtrip modus + toggle', () => {
    const s = mem();
    E.saveEraserSettings({ mode: 'stroke', highlighterOnly: true }, s);
    assert.deepEqual(E.loadEraserSettings(s), { mode: 'stroke', highlighterOnly: true });
    assert.equal(s.getItem('grimoireEraserMode').includes('stroke'), true);
  });

  it('defaults bei leer/kaputt', () => {
    assert.deepEqual(E.loadEraserSettings(mem()), { highlighterOnly: false, mode: 'standard' });
    const bad = mem();
    bad.setItem('grimoireEraserMode', '{kaputt');
    assert.deepEqual(E.loadEraserSettings(bad), { highlighterOnly: false, mode: 'standard' });
  });
});
