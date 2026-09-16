'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/pencil.js');

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// localStorage-Mock (DOM-frei)
function memStore(initial) {
  const data = Object.assign({}, initial);
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
    _data: data,
  };
}

describe('pressureWidth-Mapping', () => {
  it('p=0 wird auf 0.5x geclampt (0.35 roh -> clamp)', () => {
    assert.ok(approx(P.pressureWidth(10, 0), 5), P.pressureWidth(10, 0));
  });
  it('p=0.5 ergibt 0.8x', () => {
    assert.ok(approx(P.pressureWidth(10, 0.5), 8), P.pressureWidth(10, 0.5));
  });
  it('p=1 ergibt 1.25x', () => {
    assert.ok(approx(P.pressureWidth(10, 1), 12.5), P.pressureWidth(10, 1));
  });
  it('clamp oben bei 3x', () => {
    assert.equal(P.pressureWidth(4, 10), 12);
  });
  it('clamp unten bei 0.5x', () => {
    assert.equal(P.pressureWidth(4, -5), 2);
  });
  it('skaliert mit Basis (Stift vs. Marker x3)', () => {
    assert.ok(approx(P.pressureWidth(3, 1), 3.75));
    assert.ok(approx(P.pressureWidth(9, 1), 11.25));
  });
});

describe('Punkte-Normalisierung', () => {
  it('fehlendes p wird 0.5', () => {
    assert.equal(P.normalizePoint({ x: 1, y: 2 }).p, 0.5);
  });
  it('p=0/unbekannt/NaN wird 0.5 (Fallback)', () => {
    assert.equal(P.normalizePoint({ x: 0, y: 0, p: 0 }).p, 0.5);
    assert.equal(P.normalizePressure(0), 0.5);
    assert.equal(P.normalizePressure(undefined), 0.5);
    assert.equal(P.normalizePressure(null), 0.5);
    assert.equal(P.normalizePressure(NaN), 0.5);
  });
  it('gültiges p bleibt, >1 wird auf 1 geclampt', () => {
    assert.equal(P.normalizePoint({ x: 1, y: 1, p: 0.7 }).p, 0.7);
    assert.equal(P.normalizePressure(2.5), 1);
  });
  it('x/y bleiben erhalten', () => {
    assert.deepEqual(P.normalizePoint({ x: 5, y: 7 }), { x: 5, y: 7, p: 0.5 });
  });
  it('strokeHasPressure erkennt Altbestand ohne p', () => {
    assert.equal(P.strokeHasPressure([{ x: 1, y: 1 }, { x: 2, y: 2 }]), false);
    assert.equal(P.strokeHasPressure([{ x: 1, y: 1, p: 0.5 }]), true);
  });
});

describe('Default-Stil (localStorage gemockt)', () => {
  it('get ohne Eintrag liefert Defaults', () => {
    assert.deepEqual(P.getTextDefault(memStore()), { fontSize: 17, color: '#2a1a0e', align: 'left' });
  });
  it('set/get Roundtrip unter Key grimoireTextDefault', () => {
    const s = memStore();
    const back = P.setTextDefault({ fontSize: 24, color: '#ff0000', align: 'center' }, s);
    assert.deepEqual(back, { fontSize: 24, color: '#ff0000', align: 'center' });
    assert.deepEqual(P.getTextDefault(s), { fontSize: 24, color: '#ff0000', align: 'center' });
    assert.equal(JSON.parse(s._data[P.TEXT_DEFAULT_KEY]).fontSize, 24);
  });
  it('ungültige Werte fallen auf Defaults zurück', () => {
    const s = memStore({ grimoireTextDefault: JSON.stringify({ fontSize: 'riesig', color: 'pink', align: 'diagonal' }) });
    assert.deepEqual(P.getTextDefault(s), { fontSize: 17, color: '#2a1a0e', align: 'left' });
  });
  it('kaputtes JSON liefert Defaults', () => {
    assert.deepEqual(
      P.getTextDefault(memStore({ grimoireTextDefault: '{defekt' })),
      { fontSize: 17, color: '#2a1a0e', align: 'left' }
    );
  });
  it('applyDefaultToBox überschreibt keine vorhandenen Felder', () => {
    const box = P.applyDefaultToBox({ id: 'a', fontSize: 30 }, { fontSize: 17, color: '#2a1a0e', align: 'left' });
    assert.equal(box.fontSize, 30);
    assert.equal(box.color, '#2a1a0e');
    assert.equal(box.align, 'left');
  });
  it('editorStyleFromComputed parst computed CSS (fontSize/color/align)', () => {
    assert.deepEqual(
      P.editorStyleFromComputed({ fontSize: '24px', color: 'rgb(255, 0, 0)', textAlign: 'center' }),
      { fontSize: 24, color: '#ff0000', align: 'center' }
    );
  });
});
