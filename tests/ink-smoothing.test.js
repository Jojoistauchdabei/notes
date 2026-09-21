'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/pencil.js');
const PI = require('../js/pages-import.js');

describe('Cleaner-Stroke: Stabilizer', () => {
  it('erster Punkt kommt immer durch', () => {
    const s = P.createStabilizer({ minDistance: 5 });
    const r = s.push({ x: 10, y: 10, p: 0.5 }, 0);
    assert.ok(r && typeof r.x === 'number');
  });
  it('Micro-Jitter wird geschluckt (null)', () => {
    const s = P.createStabilizer({ minDistance: 5 });
    s.push({ x: 100, y: 100, p: 0.5 }, 0);
    const r = s.push({ x: 100.2, y: 100.1, p: 0.5 }, 8);
    assert.equal(r, null);
  });
  it('große Bewegung kommt durch', () => {
    const s = P.createStabilizer({ minDistance: 0.9 });
    s.push({ x: 0, y: 0, p: 0.5 }, 0);
    const r = s.push({ x: 50, y: 0, p: 0.7 }, 16);
    assert.ok(r && r.x > 1);
  });
  it('reset startet neu', () => {
    const s = P.createStabilizer({ minDistance: 50 });
    s.push({ x: 0, y: 0 }, 0);
    s.reset();
    const r = s.push({ x: 0.1, y: 0.1 }, 100);
    assert.ok(r);
  });
});

describe('Cleaner-Stroke: Chaikin + Midpoint', () => {
  it('chaikin erhält Endpunkte, vermehrt Punkte', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    const out = P.chaikinSmooth(pts, 1);
    assert.equal(out.length, 6);
    assert.deepEqual({ x: out[0].x, y: out[0].y }, { x: 0, y: 0 });
    const last = out[out.length - 1];
    assert.deepEqual({ x: last.x, y: last.y }, { x: 10, y: 10 });
  });
  it('chaikin mit <3 Punkten ist Identität', () => {
    assert.equal(P.chaikinSmooth([{ x: 1, y: 1 }], 1).length, 1);
  });
  it('midpointSegments liefert Kurven', () => {
    const seg = P.midpointSegments([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    assert.ok(seg.move && seg.curves.length === 2);
  });
  it('midpointSegments leer/einzeln', () => {
    assert.deepEqual(P.midpointSegments([]).curves, []);
    assert.equal(P.midpointSegments([{ x: 1, y: 2 }]).curves.length, 0);
  });
});

describe('Pencil-vs-Finger', () => {
  it('Pen schreibt immer (auch bei fingerDraw=false)', () => {
    assert.equal(P.shouldInkForPointer({ pointerType: 'pen' }, { fingerDraw: false }), true);
  });
  it('Finger scrollt by default (kein Ink)', () => {
    assert.equal(P.shouldInkForPointer({ pointerType: 'touch' }, { fingerDraw: false }), false);
  });
  it('Finger zeichnet nur mit Toggle', () => {
    assert.equal(P.shouldInkForPointer({ pointerType: 'touch' }, { fingerDraw: true }), true);
  });
  it('Maus links schreibt, rechts nicht', () => {
    assert.equal(P.shouldInkForPointer({ pointerType: 'mouse', button: 0, buttons: 1 }, { fingerDraw: false }), true);
    assert.equal(P.shouldInkForPointer({ pointerType: 'mouse', button: 2, buttons: 2 }, { fingerDraw: false }), false);
  });
  it('Palm-Guard sperrt Touch kurz nach Pen', () => {
    const g = P.createPalmGuard(1200);
    g.markPen(1000);
    assert.equal(g.isPalmTouch(1500), true);
    assert.equal(g.isPalmTouch(5000), false);
  });
  it('Input-Prefs Roundtrip + Sanitize', () => {
    const mem = (() => { const d = {}; return { getItem: k => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); } }; })();
    const back = P.setInputPrefs({ fingerDraw: true }, mem);
    assert.deepEqual(back, { fingerDraw: true, penOnly: true });
    assert.deepEqual(P.getInputPrefs(mem), { fingerDraw: true, penOnly: true });
    assert.deepEqual(P.sanitizeInputPrefs(null), { fingerDraw: false, penOnly: true });
  });
  it('collectCoalesced fallback ohne OS-API', () => {
    const ev = { clientX: 1 };
    assert.equal(P.collectCoalesced(ev).length, 1);
    const multi = { getCoalescedEvents: () => [{ a: 1 }, { a: 2 }] };
    assert.equal(P.collectCoalesced(multi).length, 2);
  });
});

describe('Dokument-in-Dokument + Vorlage', () => {
  const pages = () => ([
    { id: 'p1', strokes: [{ tool: 'pen', color: '#000', size: 3, points: [{ x: 1, y: 1 }] }, { tool: 'marker', color: '#ff0', size: 9, points: [{ x: 2, y: 2 }] }], texts: [{ id: 't1', html: 'hi' }], images: [{ id: 'i1', src: 'blob:x' }], bg: 'blob:bg1' },
    { id: 'p2', strokes: [], texts: [], images: [], bg: null },
  ]);
  it('clonePagesForImport: alle Seiten, frische IDs, Inhalt erhalten', () => {
    const cl = PI.clonePagesForImport(pages(), null);
    assert.equal(cl.length, 2);
    assert.notEqual(cl[0].id, 'p1');
    assert.notEqual(cl[0].texts[0].id, 't1');
    assert.equal(cl[0].strokes.length, 2);
    assert.equal(cl[0].bg, 'blob:bg1');
  });
  it('clonePagesForImport: Bereichsauswahl 2', () => {
    const cl = PI.clonePagesForImport(pages(), [2]);
    assert.equal(cl.length, 1);
    assert.equal(cl[0].bg, null);
  });
  it('buildTemplatePage: ohne Handschrift/Text/Marker, mit Hintergrund', () => {
    const tpl = PI.buildTemplatePage(pages()[0]);
    assert.deepEqual(tpl.strokes, []);
    assert.deepEqual(tpl.texts, []);
    assert.deepEqual(tpl.images, []);
    assert.equal(tpl.bg, 'blob:bg1');
    assert.ok(tpl.id);
  });
});
