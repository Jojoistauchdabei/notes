'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const S = require('../js/sync.js');

const H1 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const H2 = 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb';

describe('sync/datei', () => {
  it('ist ohne DOM ladbar', () => {
    assert.ok(S && typeof S.planRows === 'function');
    assert.deepEqual(S.loadRowMap(), {});
    assert.deepEqual(S.loadFolders(), {});
  });
  it('exportiert die vereinbarte API', () => {
    for (const k of ['msToIso', 'isoToMs', 'docIdForBook', 'isFileRef',
      'hashFromFileRef', 'rewriteRefs', 'bookContentJson', 'parseContentJson',
      'folderHash', 'planRows', 'makeConflictTitle', 'rowToNoteMeta',
      'isDeckBook', 'bookEnvelope', 'parseEnvelope', 'applyEnvelopeToBook',
      'hashableBook', 'normDeckCards', 'normDeckOptions', 'normReviewLog',
      'syncNow', 'syncFolders', 'startRealtime', 'stopRealtime', 'rtChannels']) {
      assert.equal(typeof S[k], 'function', k);
    }
  });
});

describe('sync/zeit-und-ids', () => {
  it('ISO roundtrip, robust bei Müll', () => {
    assert.equal(S.isoToMs(S.msToIso(1700000000000)), 1700000000000);
    assert.equal(S.isoToMs('kein-datum'), 0);
    assert.equal(S.isoToMs(null), 0);
  });
  it('docId: gültige bleiben, Rest wird gemappt', () => {
    assert.equal(S.docIdForBook('abc123XYZ'), 'abc123XYZ');
    const m = S.docIdForBook('Buch mit Leerzeichen!');
    assert.match(m, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/);
    assert.match(S.docIdForBook(''), /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/);
  });
  it('awfile-Refs erkennen', () => {
    assert.ok(S.isFileRef('awfile:' + H1));
    assert.equal(S.hashFromFileRef('awfile:' + H1), H1);
    assert.ok(!S.isFileRef('blob:xyz'));
    assert.equal(S.hashFromFileRef('blob:xyz'), null);
  });
});

describe('sync/refs', () => {
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
  it('notebook bleibt v1 (kompakt, abwärtskompatibel)', () => {
    const j = S.bookContentJson({ title: 'N', pages });
    assert.deepEqual(JSON.parse(j), { v: 1, pages });
  });
  it('deck reist als v2-Envelope mit Karten', () => {
    const book = {
      title: 'Deck', kind: 'flashcards', pages,
      cards: [{ id: 'c1', front: 'F', back: 'B' }],
      deckOptions: { newPerDay: 5, maxReviewsPerDay: 50 },
      reviewLog: [{ t: 1700000000000, g: 'good', id: 'c1' }],
    };
    const env = S.parseEnvelope(S.bookContentJson(book));
    assert.equal(env.kind, 'flashcards');
    assert.deepEqual(env.pages, pages);
    assert.equal(env.cards.length, 1);
    assert.equal(env.cards[0].front, 'F');
    assert.deepEqual(env.deckOptions, { newPerDay: 5, maxReviewsPerDay: 50 });
    assert.deepEqual(env.reviewLog, [{ t: 1700000000000, g: 'good', id: 'c1' }]);
    // parseContentJson liefert weiter nur Seiten (Bestands-API)
    assert.deepEqual(S.parseContentJson(S.bookContentJson(book)), pages);
  });
  it('parseEnvelope heilt v1/Altbestand/Müll tolerant', () => {
    const v1 = S.parseEnvelope(JSON.stringify({ v: 1, pages }));
    assert.equal(v1.kind, 'notebook');
    assert.deepEqual(v1.pages, pages);
    assert.deepEqual(v1.cards, []);
    const bad = S.parseEnvelope('müll');
    assert.equal(bad.pages, null);
    assert.equal(bad.kind, 'notebook');
    const legacyDeck = S.parseEnvelope(JSON.stringify({ v: 1, pages, kind: 'deck' }));
    assert.equal(legacyDeck.kind, 'flashcards');
  });
  it('applyEnvelopeToBook übernimmt Decks, löscht Karten nie still', () => {
    const b = { title: 'X', kind: 'notebook', pages };
    S.applyEnvelopeToBook(b, S.parseEnvelope(S.bookContentJson({
      kind: 'flashcards', pages, cards: [{ front: 'a', back: 'b' }],
    })));
    assert.equal(b.kind, 'flashcards');
    assert.equal(b.cards.length, 1);
    assert.equal(b.deckOptions.newPerDay, 20);
    // Notebook-Envelope fasst lokale Karten nicht an (nur kind kippt)
    S.applyEnvelopeToBook(b, S.parseEnvelope(JSON.stringify({ v: 1, pages })));
    assert.equal(b.kind, 'notebook');
    assert.equal(b.cards.length, 1);
  });
  it('hashableBook unterscheidet Kartenstände', () => {
    const h1 = JSON.stringify(S.hashableBook({ title: 'D', kind: 'flashcards', pages, cards: [{ front: 'a', back: 'b' }] }));
    const h2 = JSON.stringify(S.hashableBook({ title: 'D', kind: 'flashcards', pages, cards: [{ front: 'a', back: 'c' }] }));
    const h3 = JSON.stringify(S.hashableBook({ title: 'D', kind: 'notebook', pages }));
    assert.notEqual(h1, h2);
    assert.notEqual(h1, h3);
  });
});

describe('sync/plan', () => {
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

describe('sync/folders', () => {
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

describe('sync/realtime', () => {
  it('Channels benennen Dokumente und Ordner', () => {
    const ch = S.rtChannels();
    assert.ok(ch.includes('docs'));
    assert.ok(ch.includes('folders'));
  });
  it('stop ohne Start crasht nicht', () => {
    S.stopRealtime();
    assert.equal(S.rtStatus(), 'aus');
  });
});
