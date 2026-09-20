'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const S = require('../js/appwrite-sync.js');

const H1 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const H2 = 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb';

describe('appwrite-sync/datei', () => {
  it('ist ohne DOM ladbar', () => {
    assert.ok(S && typeof S.planRows === 'function');
    assert.deepEqual(S.loadRowMap(), {});
    assert.deepEqual(S.loadFolders(), {});
  });
  it('exportiert die vereinbarte API', () => {
    for (const k of ['msToIso', 'isoToMs', 'rowIdForBook', 'isAwFileRef',
      'hashFromAwRef', 'rewriteRefs', 'bookContentJson', 'parseContentJson',
      'folderHash', 'planRows', 'makeConflictTitle', 'rowToNoteMeta',
      'syncNow', 'syncFolders', 'startRealtime', 'stopRealtime', 'rtChannels']) {
      assert.equal(typeof S[k], 'function', k);
    }
  });
});

describe('appwrite-sync/queries', () => {
  it('baut JSON-Queries im 2.x-Format', () => {
    assert.deepEqual(JSON.parse(S.Q.limit(100)), { method: 'limit', values: [100] });
    assert.deepEqual(JSON.parse(S.Q.orderAsc('updatedAt')), { method: 'orderAsc', attribute: 'updatedAt' });
    assert.deepEqual(JSON.parse(S.Q.equal('userId', 'u1')), { method: 'equal', attribute: 'userId', values: ['u1'] });
    assert.deepEqual(JSON.parse(S.Q.greaterThan('updatedAt', 'iso')), { method: 'greaterThan', attribute: 'updatedAt', values: ['iso'] });
    assert.deepEqual(JSON.parse(S.Q.cursorAfter('abc')), { method: 'cursorAfter', values: ['abc'] });
  });
});

describe('appwrite-sync/zeit-und-ids', () => {
  it('ISO roundtrip, robust bei Müll', () => {
    assert.equal(S.isoToMs(S.msToIso(1700000000000)), 1700000000000);
    assert.equal(S.isoToMs('kein-datum'), 0);
    assert.equal(S.isoToMs(null), 0);
  });
  it('rowId: gültige bleiben, Rest wird gemappt', () => {
    assert.equal(S.rowIdForBook('abc123XYZ'), 'abc123XYZ');
    const m = S.rowIdForBook('Buch mit Leerzeichen!');
    assert.match(m, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/);
    assert.match(S.rowIdForBook(''), /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/);
  });
  it('awfile-Refs erkennen', () => {
    assert.ok(S.isAwFileRef('awfile:' + H1));
    assert.equal(S.hashFromAwRef('awfile:' + H1), H1);
    assert.ok(!S.isAwFileRef('blob:xyz'));
    assert.equal(S.hashFromAwRef('blob:xyz'), null);
  });
});

describe('appwrite-sync/refs', () => {
  const pages = [{ images: [{ src: 'blob:a' }, { src: 'data:x' }], bg: 'blob:b' }];
  it('push: ref -> awfile-Hash', () => {
    const { pages: out, missing } = S.rewriteRefs(pages, { 'blob:a': H1, 'blob:b': H2 }, 'push');
    assert.equal(out[0].images[0].src, 'awfile:' + H1);
    assert.equal(out[0].images[1].src, 'data:x');
    assert.equal(out[0].bg, 'awfile:' + H2);
    assert.deepEqual(missing, []);
    // Original unverändert (Clone)
    assert.equal(pages[0].images[0].src, 'blob:a');
  });
  it('pull: hash -> ref, Fehlendes wird gedroppt', () => {
    const inp = [{ images: [{ src: 'awfile:' + H1 }, { src: 'awfile:' + H2 }], bg: 'awfile:' + H2 }];
    const { pages: out, missing } = S.rewriteRefs(inp, { [H1]: 'blob:neu' }, 'pull');
    assert.equal(out[0].images.length, 1);
    assert.equal(out[0].images[0].src, 'blob:neu');
    assert.equal(out[0].bg, null);
    assert.deepEqual(missing, [H2]);
  });
  it('content roundtrip', () => {
    const j = S.bookContentJson({ pages });
    assert.deepEqual(S.parseContentJson(j), pages);
    assert.equal(S.parseContentJson('müll'), null);
  });
});

describe('appwrite-sync/plan', () => {
  const L = (hash, t) => ({ hash, updatedAtMs: t });
  const R = (t, d) => ({ updatedAtMs: t, deletedAtMs: d || null });
  const M = (hash, t) => ({ rowId: 'r', hash, remoteUpdatedAtMs: t });
  it('neu lokal -> push new', () => {
    const p = S.planRows({ a: L(H1, 10) }, {}, {});
    assert.deepEqual(p.push, [{ id: 'a', reason: 'new' }]);
  });
  it('unverändert -> nichts', () => {
    const p = S.planRows({ a: L(H1, 10) }, { a: R(5) }, { a: M(H1, 5) });
    assert.deepEqual([p.push, p.pull, p.conflict, p.localDelete, p.download], [[], [], [], [], []]);
  });
  it('nur remote neuer -> pull', () => {
    const p = S.planRows({ a: L(H1, 10) }, { a: R(20) }, { a: M(H1, 5) });
    assert.deepEqual(p.pull, [{ id: 'a' }]);
  });
  it('nur lokal geändert -> push changed', () => {
    const p = S.planRows({ a: L(H2, 12) }, { a: R(5) }, { a: M(H1, 5) });
    assert.deepEqual(p.push, [{ id: 'a', reason: 'changed' }]);
  });
  it('beide geändert -> konflikt', () => {
    const p = S.planRows({ a: L(H2, 12) }, { a: R(20) }, { a: M(H1, 5) });
    assert.deepEqual(p.conflict, [{ id: 'a' }]);
  });
  it('nur remote vorhanden -> download', () => {
    const p = S.planRows({}, { a: R(5) }, {});
    assert.deepEqual(p.download, [{ id: 'a' }]);
  });
  it('lokal gelöscht (mit Meta) -> pushDelete', () => {
    const p = S.planRows({}, { a: R(5) }, { a: M(H1, 5) });
    assert.deepEqual(p.pushDelete, [{ id: 'a' }]);
  });
  it('remote gelöscht, lokal unverändert -> localDelete', () => {
    const p = S.planRows({ a: L(H1, 10) }, { a: R(20, 30) }, { a: M(H1, 5) });
    assert.deepEqual(p.localDelete, [{ id: 'a' }]);
  });
  it('remote gelöscht, lokal geändert -> revive', () => {
    const p = S.planRows({ a: L(H2, 12) }, { a: R(20, 30) }, { a: M(H1, 5) });
    assert.deepEqual(p.push, [{ id: 'a', reason: 'revive' }]);
  });
  it('remote weg + Meta, lokal weg -> metaDrop', () => {
    const p = S.planRows({}, {}, { a: M(H1, 5) });
    assert.deepEqual(p.metaDrop, [{ id: 'a' }]);
  });
  it('beidseitig ohne Meta -> adopt (Inhaltsvergleich folgt)', () => {
    const p = S.planRows({ a: L(H1, 10) }, { a: R(20) }, {});
    assert.deepEqual(p.adopt, [{ id: 'a' }]);
  });
  it('defensive Eingaben crashen nicht', () => {
    const p = S.planRows(null, null, null);
    assert.deepEqual(p.push, []);
  });
});

describe('appwrite-sync/folders', () => {
  it('folderHash unterscheidet Inhalt', () => {
    assert.equal(S.folderHash({ name: 'A', parentId: null }), S.folderHash({ name: 'A', parentId: null }));
    assert.notEqual(S.folderHash({ name: 'A' }), S.folderHash({ name: 'B' }));
  });
  it('Konflikt-Titel enthält Datum', () => {
    assert.match(S.makeConflictTitle('Buch', 1700000000000), /Konflikt/);
  });
  it('rowToNoteMeta parst Zeiten', () => {
    const m = S.rowToNoteMeta({ updatedAt: '2026-01-01T00:00:00.000Z', deletedAt: null, title: 'T' });
    assert.ok(m.updatedAtMs > 0);
    assert.equal(m.deletedAtMs, null);
  });
});

describe('appwrite-sync/realtime', () => {
  it('Channels benennen Datenbank + Tabellen', () => {
    const ch = S.rtChannels({ databaseId: 'federwerk' });
    assert.ok(ch.some(c => c.includes('notes')));
    assert.ok(ch.some(c => c.includes('folders')));
  });
  it('stop ohne Start crasht nicht', () => {
    S.stopRealtime();
    assert.equal(S.rtStatus(), 'aus');
  });
});
