'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const L = require('../js/liveshare.js');

describe('liveshare/code-und-link', () => {
  it('makeShareCode erzeugt gültige Codes', () => {
    for (let i = 0; i < 20; i++) {
      const c = L.makeShareCode();
      assert.ok(L.isValidShareCode(c), c);
    }
  });
  it('Codes sind eindeutig genug', () => {
    const set = new Set();
    for (let i = 0; i < 200; i++) set.add(L.makeShareCode());
    assert.ok(set.size > 190);
  });
  it('ungültige Codes werden abgelehnt', () => {
    assert.ok(!L.isValidShareCode(''));
    assert.ok(!L.isValidShareCode('abc'));
    assert.ok(!L.isValidShareCode('sSHORT'));
    assert.ok(!L.isValidShareCode(null));
    assert.ok(!L.isValidShareCode('SABCDEFGHIJK')); // nur klein
  });
  it('Link roundtrip', () => {
    const code = L.makeShareCode();
    const link = L.encodeShareLink('https://notes.ponnet.org', '/', code);
    assert.ok(link.includes('#share=' + code));
    assert.equal(L.parseShareCodeFromHash('#share=' + code), code);
    assert.equal(L.parseShareCode(link), code);
    assert.equal(L.parseShareCode('tritt bei: ' + code + ' !'), code);
  });
  it('encode wirft bei Müll', () => {
    assert.throws(() => L.encodeShareLink('https://x', '/', 'nonsense'));
  });
});

describe('liveshare/ablauf-und-rechte', () => {
  it('expiryIso + isExpired', () => {
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const iso = L.expiryIso(24, base);
    assert.ok(!L.isExpired(iso, base + 1000));
    assert.ok(L.isExpired(iso, base + 25 * 3600 * 1000));
    assert.ok(!L.isExpired(null, base + 1e12)); // nie
  });
  it('shareUsable erkennt revoke/ablauf', () => {
    assert.deepEqual(L.shareUsable({ shareId: L.makeShareCode(), revoked: true }).ok, false);
    const code = L.makeShareCode();
    assert.equal(L.shareUsable({ shareId: code }).ok, true);
    assert.equal(L.shareUsable({ shareId: code, expiresAt: L.msToIso(Date.now() - 1000) }).reason, 'abgelaufen');
    assert.equal(L.shareUsable({}).reason, 'unbekannt');
  });
  it('canWrite: Owner immer, Gast nur bei edit', () => {
    assert.ok(L.canWrite('read', true));
    assert.ok(L.canWrite('edit', false));
    assert.ok(!L.canWrite('read', false));
    assert.equal(L.normalizeMode('edit'), 'edit');
    assert.equal(L.normalizeMode('quatsch'), 'read');
  });
  it('pickColor ist deterministisch', () => {
    assert.equal(L.pickColor('u1'), L.pickColor('u1'));
    assert.ok(typeof L.pickColor('u1') === 'string');
  });
});

describe('liveshare/events', () => {
  const base = { shareId: L.makeShareCode(), userId: 'u1', userName: 'Jonas', userColor: '#c0392b' };
  it('buildEvent + validateEvent roundtrip', () => {
    for (const kind of L.KINDS) {
      const ev = L.buildEvent(Object.assign({}, base, { kind, payload: { a: 1 } }));
      assert.ok(L.validateEvent(ev), kind);
      assert.equal(typeof ev.payload, 'string');
    }
  });
  it('buildEvent wirft bei Fehlern', () => {
    assert.throws(() => L.buildEvent(Object.assign({}, base, { kind: 'nope' })));
    assert.throws(() => L.buildEvent(Object.assign({}, base, { kind: 'cursor', shareId: 'bad' })));
    assert.throws(() => L.buildEvent({ kind: 'cursor', shareId: base.shareId }));
  });
  it('Objekt-Payload wird JSON', () => {
    const ev = L.buildEvent(Object.assign({}, base, { kind: 'cursor', payload: { nx: 0.5 } }));
    assert.equal(JSON.parse(ev.payload).nx, 0.5);
  });
});

describe('liveshare/stroke-lww', () => {
  it('ensureStrokeIds vergibt fehlende IDs', () => {
    const list = [{ tool: 'pen', points: [] }, { id: 'x', points: [] }];
    const fixed = L.ensureStrokeIds(list);
    assert.equal(fixed, 1);
    assert.ok(list[0].id && list[0].updatedAt > 0);
    assert.equal(list[1].id, 'x');
  });
  it('mergeStroke: add, stale, replace', () => {
    const list = [];
    const s1 = { id: 'a', updatedAt: 100, points: [1] };
    assert.equal(L.mergeStroke(list, s1).applied, 'added');
    assert.equal(L.mergeStroke(list, { id: 'a', updatedAt: 50 }).applied, 'stale');
    assert.equal(list.length, 1);
    assert.equal(L.mergeStroke(list, { id: 'a', updatedAt: 200 }).applied, 'replaced');
    assert.equal(list[0].updatedAt, 200);
    assert.equal(L.mergeStroke(list, null).applied, 'ignored');
  });
  it('applyStrokeDeletes löscht nur genannte', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const r = L.applyStrokeDeletes(list, ['a', 'c', 'zzz']);
    assert.equal(r.removed, 2);
    assert.deepEqual(r.strokes.map(s => s.id), ['b']);
  });
  it('mergeText: LWW mit >= (gleichzeitig gewinnt remote)', () => {
    const list = [{ id: 't1', html: 'alt', updatedAt: 10 }];
    const r = L.mergeText(list, { id: 't1', html: 'neu', updatedAt: 10 });
    assert.ok(r.changed);
    assert.equal(list[0].html, 'neu');
  });
});

describe('liveshare/snapshot-und-chunks', () => {
  const page = {
    id: 'p1',
    strokes: [{ id: 'a', tool: 'pen', color: '#000', size: 3, points: [{ x: 1, y: 2 }] }],
    texts: [{ id: 't1', x: 0.1, y: 0.2, html: '<p>hi</p>' }],
  };
  it('Snapshot baut + passt + mergt', () => {
    const snap = L.buildPageSnapshot(page);
    assert.equal(snap.pageId, 'p1');
    assert.ok(L.snapshotFits(snap));
    const target = { id: 'p1', strokes: [], texts: [] };
    const r = L.applyPageSnapshot(target, snap);
    assert.equal(r.added, 1);
    assert.equal(r.tAdded, 1);
    // Zweites Apply: nichts Neues (stale/>= bei Text ersetzt, zählt als changed)
    const r2 = L.applyPageSnapshot(target, snap);
    assert.equal(r2.added, 0);
  });
  it('Chunk-Transfer roundtrip', () => {
    const big = 'x'.repeat(70000);
    const evs = L.makeSyncChunks(L.makeShareCode(),
      { userId: 'u1', userName: 'n', userColor: 'c' }, big);
    assert.ok(evs.length >= 3 && evs.length <= L.CHUNK_MAX);
    const store = {};
    let done = null;
    for (const e of evs) done = L.collectSyncChunks(store, e);
    assert.ok(done.complete);
    assert.equal(done.json, big);
  });
  it('zu großer Snapshot wirft', () => {
    const huge = 'y'.repeat(L.CHUNK_SIZE * L.CHUNK_MAX + 1);
    assert.throws(() => L.makeSyncChunks(L.makeShareCode(),
      { userId: 'u', userName: 'n', userColor: 'c' }, huge));
  });
});

describe('liveshare/konvergenz', () => {
  function sortedPage(page) {
    const byId = (a, b) => String(a.id).localeCompare(String(b.id));
    return {
      strokes: (page.strokes || []).slice().sort(byId),
      texts: (page.texts || []).slice().sort(byId),
    };
  }
  it('gleiche Ops in anderer Reihenfolge -> gleicher Stand (LWW)', () => {
    const ops = [
      { t: 's', v: { id: 'a', updatedAt: 100, points: [{ x: 1, y: 1 }] } },
      { t: 's', v: { id: 'b', updatedAt: 100, points: [{ x: 2, y: 2 }] } },
      { t: 's', v: { id: 'a', updatedAt: 200, points: [{ x: 9, y: 9 }] } }, // Update gewinnt
      { t: 'sd', v: ['b'] },
      { t: 'x', v: { id: 't1', html: 'eins', updatedAt: 50 } },
      { t: 'x', v: { id: 't1', html: 'zwei', updatedAt: 150 } },
    ];
    const run = (order) => {
      const page = { id: 'p', strokes: [], texts: [] };
      for (const i of order) {
        const op = ops[i];
        if (op.t === 's') L.mergeStroke(page.strokes, JSON.parse(JSON.stringify(op.v)));
        else if (op.t === 'sd') {
          const r = L.applyStrokeDeletes(page.strokes, op.v);
          page.strokes = r.strokes;
        } else L.mergeText(page.texts, JSON.parse(JSON.stringify(op.v)));
      }
      return JSON.stringify(sortedPage(page));
    };
    // Hinweis: Delete-Position zählt (Tombstones gibt es in V1 nicht) –
    // konvergent sind alle Reihenfolgen, bei denen das Delete nach dem
    // Add des betroffenen Strokes kommt (kausale Ordnung, garantiert per
    // createdAt-Sortierung im Event-Stream).
    const causal = [[0, 1, 2, 3, 4, 5], [1, 0, 4, 2, 5, 3], [4, 0, 1, 5, 2, 3]];
    const results = causal.map(run);
    assert.equal(results[1], results[0]);
    assert.equal(results[2], results[0]);
    const final = JSON.parse(results[0]);
    assert.deepEqual(final.strokes.map(s => s.id), ['a']);
    assert.equal(final.strokes[0].points[0].x, 9);
    assert.equal(final.texts[0].html, 'zwei');
  });
  it('Snapshot erhält Stil-Felder', () => {
    const page = {
      id: 'p1',
      strokes: [{ id: 's1', tool: 'pen', color: '#000', size: 3, points: [], dash: [4, 2], fill: '#fff', alpha: 0.5, closed: true }],
      texts: [{ id: 't1', x: 0.1, y: 0.2, html: '<p>hi</p>', fontSize: 22, color: '#a00', align: 'center' }],
    };
    const snap = L.buildPageSnapshot(page);
    assert.deepEqual(snap.strokes[0].dash, [4, 2]);
    assert.equal(snap.strokes[0].fill, '#fff');
    assert.equal(snap.texts[0].fontSize, 22);
    assert.equal(snap.texts[0].align, 'center');
  });
});

describe('liveshare/presence-und-cursor', () => {
  it('see + prune + list', () => {
    let p = L.presenceNew();
    p = L.presenceSee(p, { userId: 'u1', userName: 'B', userColor: 'red' }, 1000);
    p = L.presenceSee(p, { userId: 'u2', userName: 'A', userColor: 'blue' }, 1000);
    assert.deepEqual(L.presenceList(p).map(x => x.userName), ['A', 'B']);
    const kept = L.presencePrune(p, 1000 + L.PRESENCE_TIMEOUT_MS + 1);
    assert.deepEqual(kept, {});
    const kept2 = L.presencePrune(p, 1000 + 5000);
    assert.equal(Object.keys(kept2).length, 2);
  });
  it('shouldSendCursor drosselt', () => {
    assert.ok(L.shouldSendCursor(0, 1000));
    assert.ok(!L.shouldSendCursor(1000, 1000 + 10));
    assert.ok(L.shouldSendCursor(1000, 1000 + L.CURSOR_MIN_MS));
  });
});

describe('liveshare/appwrite-zeilen', () => {
  it('shareRowBody + perms', () => {
    const code = L.makeShareCode();
    const b = L.shareRowBody({ shareId: code, bookId: 'b1', ownerId: 'u1', mode: 'edit' });
    assert.equal(b.shareId, code);
    assert.equal(b.mode, 'edit');
    assert.ok(L.sharePerms('u1').some(s => s.includes('u1')));
    assert.ok(L.eventPerms('u9').some(s => s.includes('u9')));
  });
  it('eventRowBody validiert', () => {
    const code = L.makeShareCode();
    const ev = L.buildEvent({ shareId: code, userId: 'u1', kind: 'cursor', payload: {} });
    const b = L.eventRowBody(ev);
    assert.equal(b.row.shareId, code);
    assert.throws(() => L.eventRowBody({ kind: 'cursor' }));
  });
  it('eventQueries baut 2.x-Queries', () => {
    const code = L.makeShareCode();
    const qs = L.eventQueries(code, '2026-01-01T00:00:00.000Z');
    assert.ok(qs.length >= 3);
    assert.deepEqual(JSON.parse(qs[0]), { method: 'equal', attribute: 'shareId', values: [code] });
  });
});
