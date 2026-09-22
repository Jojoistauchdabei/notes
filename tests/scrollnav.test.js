'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const SN = require('../js/scrollnav.js');

function memStore(initial) {
  const data = Object.assign({}, initial);
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
    _data: data,
  };
}

describe('scrollnav/gate', () => {
  it('vertikales Wheel wird gehandelt (deltaY dominiert)', () => {
    const r = SN.shouldHandleWheel({ deltaX: 2, deltaY: 60, ctrlKey: false });
    assert.equal(r.handle, true);
    assert.equal(r.reason, 'vertical');
  });
  it('horizontales Wheel wird NICHT gehandelt', () => {
    assert.equal(SN.shouldHandleWheel({ deltaX: 80, deltaY: 10 }).handle, false);
    assert.equal(SN.shouldHandleWheel({ deltaX: 50, deltaY: 50 }).handle, false); // Gleichstand: kein Hijack
    assert.equal(SN.shouldHandleWheel({ deltaX: 0, deltaY: 0 }).handle, false);
  });
  it('Pinch-Zoom (ctrlKey/metaKey) wird NIE gehandelt', () => {
    assert.equal(SN.shouldHandleWheel({ deltaX: 0, deltaY: 60, ctrlKey: true }).handle, false);
    assert.equal(SN.shouldHandleWheel({ deltaX: 0, deltaY: -60, metaKey: true }).handle, false);
  });
  it('deltaMode Zeilen werden auf px skaliert', () => {
    const n = SN.normalizeWheel({ deltaX: 0, deltaY: 3, deltaMode: 1 });
    assert.equal(n.dy, 48); // 3 * 16 >= 40 -> flippt
    const r = SN.shouldFlip(n.dy, 0, 1000, -Infinity);
    assert.equal(r.flip, 1);
  });
});

describe('scrollnav/schwelle', () => {
  it('kleine Deltas akkumulieren bis zur Schwelle (ein Flip)', () => {
    let acc = 0, out;
    out = SN.shouldFlip(15, acc, 1000, -Infinity); acc = out.acc;
    assert.equal(out.flip, 0);
    out = SN.shouldFlip(15, acc, 1100, -Infinity); acc = out.acc;
    assert.equal(out.flip, 0);
    out = SN.shouldFlip(15, acc, 1200, -Infinity);
    assert.equal(out.flip, 1); // 45 >= 40
    assert.equal(out.acc, 0);  // Reststand zurückgesetzt
  });
  it('ein Schub über der Schwelle flippt sofort genau einmal', () => {
    const r = SN.shouldFlip(120, 0, 1000, -Infinity);
    assert.equal(r.flip, 1);
    assert.equal(r.acc, 0);
  });
  it('hochscrollen (negativ) flippt zurück', () => {
    assert.equal(SN.shouldFlip(-50, 0, 1000, -Infinity).flip, -1);
  });
  it('Richtungswechsel verwirft den alten Reststand', () => {
    // +30 gesammelt, dann -50: kein Aufschaukeln, -50 allein reicht
    const r = SN.shouldFlip(-50, 30, 1000, -Infinity);
    assert.equal(r.flip, -1);
    // +30 gesammelt, dann -10: kein Flip, Reststand ist -10 (nicht +20)
    const r2 = SN.shouldFlip(-10, 30, 1000, -Infinity);
    assert.equal(r2.flip, 0);
    assert.equal(r2.acc, -10);
  });
});

describe('scrollnav/cooldown', () => {
  it('zweiter Schub im Cooldown flippt nicht (kein Doppelsprung)', () => {
    const r = SN.shouldFlip(120, 0, 1000, 900); // 100ms < 600ms
    assert.equal(r.flip, 0);
    assert.equal(r.acc, 0);
  });
  it('nach dem Cooldown flippt es wieder', () => {
    const r = SN.shouldFlip(120, 0, 1600, 900); // 700ms > 600ms
    assert.equal(r.flip, 1);
  });
  it('Cooldown ist konfigurierbar', () => {
    const o = { cooldownMs: 100, threshold: 40 };
    assert.equal(SN.shouldFlip(50, 0, 150, 100, o).flip, 0); // 50ms < 100ms
    assert.equal(SN.shouldFlip(50, 0, 250, 100, o).flip, 1); // 150ms > 100ms
  });
});

describe('scrollnav/stepWheel (Pane-State)', () => {
  it('Trackpad-Rauschen: viele Mini-Deltas ergeben genau einen Flip + Cooldown', () => {
    const st = SN.createPaneState();
    let flips = 0;
    const ev = { deltaX: 0, deltaY: 12 };
    for (let t = 0; t < 10; t++) {
      const r = SN.stepWheel(st, ev, 1000 + t * 16);
      if (r.flip) flips++;
      assert.equal(r.handled, true);
    }
    assert.equal(flips, 1); // 4x12=48 flippt einmal, Rest im Cooldown
  });
  it('handled=false bei Zoom/horizontal (Browser behält das Event)', () => {
    const st = SN.createPaneState();
    assert.equal(SN.stepWheel(st, { deltaY: 60, ctrlKey: true }, 1000).handled, false);
    assert.equal(SN.stepWheel(st, { deltaX: 90, deltaY: 5 }, 1000).handled, false);
    assert.equal(st.acc, 0); // nichts akkumuliert
  });
  it('Flip setzt lastFlip (Folge-Event im Cooldown wird geschluckt)', () => {
    const st = SN.createPaneState();
    const r1 = SN.stepWheel(st, { deltaY: 100 }, 1000);
    assert.equal(r1.flip, 1);
    const r2 = SN.stepWheel(st, { deltaY: 100 }, 1100);
    assert.equal(r2.flip, 0);
    assert.equal(r2.handled, true); // trotzdem gehandelt (Browser-Scroll bleibt aus)
  });
});

describe('scrollnav/nachbar (kein Wrap)', () => {
  it('Mitte geht vor/zurück', () => {
    assert.equal(SN.neighborIndex(1, 1, 3), 2);
    assert.equal(SN.neighborIndex(1, -1, 3), 0);
  });
  it('Anfang/Ende liefern null (kein Wrap)', () => {
    assert.equal(SN.neighborIndex(0, -1, 3), null);
    assert.equal(SN.neighborIndex(2, 1, 3), null);
  });
  it('Einzelseite + Müll sind sicher', () => {
    assert.equal(SN.neighborIndex(0, 1, 1), null);
    assert.equal(SN.neighborIndex(-1, 1, 3), null);
    assert.equal(SN.neighborIndex(0, 0, 3), null);
  });
});

describe('scrollnav/persistenz', () => {
  it('Default ist AN (kein Eintrag)', () => {
    assert.equal(SN.loadEnabled(memStore()), true);
    assert.equal(SN.loadEnabled(null), true);
  });
  it('Roundtrip an/aus über LS_KEY', () => {
    const s = memStore();
    SN.saveEnabled(s, false);
    assert.equal(s._data[SN.LS_KEY], '0');
    assert.equal(SN.loadEnabled(s), false);
    SN.saveEnabled(s, true);
    assert.equal(SN.loadEnabled(s), true);
  });
  it('fremde Werte bleiben AN (fail-open)', () => {
    assert.equal(SN.loadEnabled(memStore({ [SN.LS_KEY]: 'ja' })), true);
  });
});
