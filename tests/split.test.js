'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Split = require('../js/split.js');

describe('split/create', () => {
  it('Start: aus, aktiv 0, Pane 0 mit Doku', () => {
    const s = Split.createSplitState('b1', 'p1');
    assert.equal(s.enabled, false);
    assert.equal(Split.activeIndex(s), 0);
    assert.deepEqual(Split.getPane(s, 0), { bookId: 'b1', pageId: 'p1' });
    assert.deepEqual(Split.getPane(s, 1), { bookId: null, pageId: null });
  });
});

describe('split/enable-disable', () => {
  it('einschalten mit zweitem Dokument', () => {
    const s = Split.createSplitState('b1', 'p1');
    Split.enableSplit(s, 'b2', 'p9');
    assert.equal(Split.isEnabled(s), true);
    assert.deepEqual(Split.getPane(s, 1), { bookId: 'b2', pageId: 'p9' });
  });
  it('einschalten ohne Angabe kopiert Pane 0', () => {
    const s = Split.createSplitState('b1', 'p1');
    Split.enableSplit(s);
    assert.deepEqual(Split.getPane(s, 1), { bookId: 'b1', pageId: 'p1' });
  });
  it('ausschalten behält aktiven Pane als Pane 0', () => {
    const s = Split.createSplitState('b1', 'p1');
    Split.enableSplit(s, 'b2', 'p2');
    Split.setActive(s, 1);
    Split.disableSplit(s);
    assert.equal(Split.isEnabled(s), false);
    assert.deepEqual(Split.getPane(s, 0), { bookId: 'b2', pageId: 'p2' });
    assert.equal(Split.activeIndex(s), 0);
  });
});

describe('split/panes', () => {
  it('setPaneDoc + setActive clampen Index', () => {
    const s = Split.createSplitState('b1', 'p1');
    Split.setPaneDoc(s, 1, 'b2', 'p2');
    assert.deepEqual(Split.getPane(s, 1), { bookId: 'b2', pageId: 'p2' });
    assert.equal(Split.setActive(s, 7), 0);
    assert.equal(Split.setActive(s, 1), 1);
  });
  it('swap tauscht Inhalte + Aktivität', () => {
    const s = Split.createSplitState('b1', 'p1');
    Split.enableSplit(s, 'b2', 'p2');
    Split.setActive(s, 0);
    Split.swapPanes(s);
    assert.deepEqual(Split.getPane(s, 0), { bookId: 'b2', pageId: 'p2' });
    assert.deepEqual(Split.getPane(s, 1), { bookId: 'b1', pageId: 'p1' });
    assert.equal(Split.activeIndex(s), 1);
  });
  it('handleBookDeleted setzt Fallback', () => {
    const s = Split.createSplitState('b1', 'p1');
    Split.enableSplit(s, 'b2', 'p2');
    assert.equal(Split.handleBookDeleted(s, 'b2', { bookId: 'b1', pageId: 'p1' }), true);
    assert.deepEqual(Split.getPane(s, 1), { bookId: 'b1', pageId: 'p1' });
    assert.equal(Split.handleBookDeleted(s, 'bx', null), false);
  });
});

describe('split/ratio-serialize', () => {
  it('ratio wird auf 0.2..0.8 geclampt', () => {
    const s = Split.createSplitState();
    assert.equal(Split.setRatio(s, 0.05), 0.2);
    assert.equal(Split.setRatio(s, 0.99), 0.8);
    assert.equal(Split.setRatio(s, ' Mist '), 0.5);
  });
  it('serialize/restore Roundtrip', () => {
    const s = Split.createSplitState('b1', 'p1');
    Split.enableSplit(s, 'b2', 'p2');
    Split.setActive(s, 1);
    Split.setRatio(s, 0.33);
    const raw = Split.serialize(s);
    const back = Split.restore(raw);
    assert.deepEqual(Split.serialize(back), raw);
  });
  it('restore mit Müll -> Defaults', () => {
    const back = Split.restore({ enabled: true, active: 9, ratio: 99, panes: [{ bookId: 5 }] });
    assert.equal(Split.activeIndex(back), 0);
    assert.equal(back.ratio, 0.8);
    assert.deepEqual(Split.getPane(back, 0), { bookId: null, pageId: null });
  });
});
