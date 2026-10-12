'use strict';
// tests/craft-sync.test.js – Craft-Dokumente im Server-Sync (Envelope v3).
// Der Inhalt eines Craft-Dokuments ist eine DATEI, kein Seitenmodell. Sie muss
// denselben Weg gehen wie Bilder (awfile:<sha>, Dedupe, Upload) und beim Pull
// wieder als lokale Ref ankommen – sonst liegt das Dokument nur auf einem
// Geraet.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Sync = require('../js/appwrite-sync.js');
const Store = require('../js/craft-store.js');

const HASH = 'a'.repeat(64);
const seiten = () => [{ id: 'p1', strokes: [], texts: [], images: [], bg: null }];

function craftBuch(file) {
  const b = Store.create('wordcraft', 'Bericht');
  b.craft.file = file === undefined ? 'blob:lokal1' : file;
  b.craft.size = 2048;
  b.pages = seiten();
  return b;
}

describe('craft-sync: Envelope v3', () => {
  it('schreibt ein Craft-Dokument als v3 mit App und Datei', () => {
    const env = JSON.parse(Sync.bookContentJson(craftBuch()));
    assert.equal(env.v, 3);
    assert.equal(env.kind, 'craft');
    assert.deepEqual(env.craft, {
      id: 'wordcraft', ext: 'docx', mime: Store.describe(craftBuch()).mime,
      name: 'Bericht.docx', size: 2048, file: 'blob:lokal1',
    });
    assert.deepEqual(env.pages, seiten());
  });

  it('liest v3 zurueck', () => {
    const env = Sync.parseEnvelope(Sync.bookContentJson(craftBuch()));
    assert.equal(env.kind, 'craft');
    assert.equal(env.craft.id, 'wordcraft');
    assert.equal(env.craft.file, 'blob:lokal1');
    assert.equal(env.pages.length, 1);
  });

  it('laesst Notizbuecher und Decks unveraendert', () => {
    const nb = Sync.parseEnvelope(JSON.stringify({ v: 1, pages: seiten() }));
    assert.equal(nb.kind, 'notebook');
    assert.equal(nb.craft, null);
    const deck = Sync.parseEnvelope(JSON.stringify({ v: 2, pages: seiten(), kind: 'flashcards', cards: [{ front: 'a', back: 'b' }] }));
    assert.equal(deck.kind, 'flashcards');
    assert.equal(deck.craft, null);
    assert.equal(Sync.bookEnvelope({ id: 'b', pages: seiten() }).v, 1);
    assert.equal(Sync.bookEnvelope({ id: 'b', pages: seiten(), kind: 'flashcards', cards: [] }).v, 2);
  });

  it('uebernimmt die Datei ins lokale Buch und behaelt savedAt', () => {
    const env = Sync.parseEnvelope(Sync.bookContentJson(craftBuch('awfile:' + HASH)));
    const b = craftBuch('blob:alt');
    b.craft.savedAt = 12345;
    Sync.applyEnvelopeToBook(b, env);
    assert.equal(b.kind, 'craft');
    assert.equal(b.craft.file, 'awfile:' + HASH);
    assert.equal(b.craft.savedAt, 12345, 'der lokale Speicherzeitpunkt bleibt');
  });

  it('macht aus einem Notizbuch kein Craft-Dokument', () => {
    const b = { id: 'b', kind: 'notebook', pages: seiten() };
    Sync.applyEnvelopeToBook(b, Sync.parseEnvelope(Sync.bookContentJson(craftBuch())));
    assert.equal(b.kind, 'craft', 'das Envelope sagt, was das Dokument ist');
    assert.equal(b.craft.id, 'wordcraft');
  });

  it('loescht die Datei nicht, wenn das Envelope keine hat', () => {
    const b = craftBuch('blob:lokal1');
    Sync.applyEnvelopeToBook(b, Sync.parseEnvelope(JSON.stringify({ v: 1, pages: seiten() })));
    assert.equal(b.kind, 'notebook');
    assert.equal(b.craft.file, 'blob:lokal1', 'kein stiller Datenverlust');
  });
});

describe('craft-sync: Refs umschreiben', () => {
  it('macht beim Push aus der lokalen Ref den Hash', () => {
    const out = Sync.rewriteCraftRef({ id: 'wordcraft', file: 'blob:lokal1' }, { 'blob:lokal1': HASH }, 'push');
    assert.equal(out.file, 'awfile:' + HASH);
  });

  it('macht beim Pull aus dem Hash die lokale Ref', () => {
    const out = Sync.rewriteCraftRef({ id: 'wordcraft', file: 'awfile:' + HASH }, { [HASH]: 'blob:neu' }, 'pull');
    assert.equal(out.file, 'blob:neu');
  });

  it('laesst den Server-Ref stehen, wenn der Download nicht klappt', () => {
    const out = Sync.rewriteCraftRef({ id: 'wordcraft', file: 'awfile:' + HASH }, {}, 'pull');
    assert.equal(out.file, 'awfile:' + HASH, 'die Ansicht laedt die Datei dann direkt vom Server');
  });

  it('laesst Dokumente ohne Datei in Ruhe', () => {
    assert.equal(Sync.rewriteCraftRef({ id: 'wordcraft', file: null }, {}, 'push').file, null);
    assert.equal(Sync.rewriteCraftRef(null, {}, 'push'), null);
  });

  it('fasst Seitenrefs weiterhin wie bisher an', () => {
    const pages = [{ id: 'p1', images: [{ id: 'i1', src: 'blob:bild' }], bg: null }];
    const push = Sync.rewriteRefs(pages, { 'blob:bild': HASH }, 'push');
    assert.equal(push.pages[0].images[0].src, 'awfile:' + HASH);
  });
});

describe('craft-sync: Aenderungserkennung', () => {
  it('nimmt App und Datei in den Hash auf', () => {
    const a = JSON.stringify(Sync.hashableBook(craftBuch('blob:lokal1')));
    const b = JSON.stringify(Sync.hashableBook(craftBuch('blob:lokal2')));
    assert.notEqual(a, b, 'eine neue Datei ist eine Aenderung');
    assert.match(a, /"kind":"craft"/);
    assert.equal(JSON.stringify(Sync.hashableBook(craftBuch('blob:lokal1'))), a, 'gleicher Stand, gleicher Hash');
  });

  it('unterscheidet Craft-Dokumente von Notizbuechern', () => {
    const craft = JSON.stringify(Sync.hashableBook(craftBuch('blob:x')));
    const notebook = JSON.stringify(Sync.hashableBook({ title: 'Bericht', pages: seiten() }));
    assert.notEqual(craft, notebook);
  });

  it('haelt die Hash-Version fest (v3)', () => {
    assert.equal(Sync.hashableBook(craftBuch()).v, 3);
  });
});
