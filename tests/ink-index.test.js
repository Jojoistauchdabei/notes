'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_PATH = path.join(__dirname, '..', 'js', 'ink-index.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const IDX = require('../js/ink-index.js');

function bookFixture() {
  return {
    id: 'b1',
    title: 'Strahd Kampagne',
    updatedAt: 1700000000000,
    pages: [
      {
        id: 'p1',
        strokes: [{}, {}, {}],
        texts: [
          { id: 't1', html: '<h2>Strahd</h2><p>Auftakt in Barovia #dnd #Quest/Haupt</p>' },
          { id: 't2', html: '<ul><li>[ ] Wein besorgen</li><li>[x] Kerzen anzünden</li></ul>' },
        ],
      },
      {
        id: 'p2',
        strokes: [{}],
        texts: [{ id: 't3', html: '<p>Notiz über den Turm<br>zweite Zeile #DnD</p>' }],
      },
    ],
  };
}

describe('ink-index/datei', () => {
  it('ist ohne DOM ladbar (reine Funktionen, kein Browser-Zugriff)', () => {
    assert.ok(IDX && typeof IDX.indexBook === 'function');
    assert.ok(!/\bdocument\b/.test(SRC), 'kein document-Zugriff');
    assert.ok(!/\blocalStorage\b/.test(SRC), 'kein localStorage-Zugriff');
    assert.ok(!/\balert\b/.test(SRC), 'kein alert');
    assert.ok(!/\bindexedDB\b/.test(SRC), 'kein indexedDB (offline, kein Cloud)');
    // navigator nur guarded für Default-Sprache erlaubt
    const navUses = (SRC.match(/\bnavigator\b/g) || []).length;
    assert.ok(navUses >= 1 && navUses <= 10, 'navigator nur für defaultLang, got ' + navUses);
    assert.ok(/typeof navigator/.test(SRC), 'navigator-Zugriff muss guarded sein');
  });
  it('exportiert die vereinbarte API', () => {
    for (const k of ['buildPageText', 'extractTags', 'extractTasks', 'indexBook',
      'registerHtrProvider', 'isHtrAvailable', 'searchBooks', 'matchBook',
      'getBookLang', 'setBookLang', 'defaultLang', 'queryHtr',
      'HTR_UNAVAILABLE_MSG']) {
      assert.ok(IDX[k] !== undefined, k + ' muss exportiert sein');
    }
    assert.equal(typeof IDX.buildPageText, 'function');
    assert.equal(typeof IDX.extractTags, 'function');
    assert.equal(typeof IDX.extractTasks, 'function');
    assert.equal(typeof IDX.indexBook, 'function');
    assert.equal(typeof IDX.registerHtrProvider, 'function');
    assert.equal(typeof IDX.isHtrAvailable, 'function');
  });
  it('HTR-Hinweis behauptet ehrlich kein Fake-OCR', () => {
    assert.equal(IDX.HTR_UNAVAILABLE_MSG, 'HSR nicht verfügbar (V1: nur getippter Text durchsuchbar)');
    assert.ok(!/handschrift.*(erkannt|durchsuchbar)/i.test(IDX.HTR_UNAVAILABLE_MSG),
      'darf keine Handschrift-Treffer behaupten');
  });
});

describe('ink-index/buildPageText', () => {
  it('strippt HTML ohne DOM, <br>/<p> werden Zeilen', () => {
    const page = { texts: [{ html: '<h2>Strahd</h2><p>Zeile1<br>Zeile2</p>' }] };
    const t = IDX.buildPageText(page);
    assert.ok(t.includes('Strahd'), t);
    assert.ok(t.includes('Zeile1'), t);
    assert.ok(t.includes('Zeile2'), t);
    assert.ok(!t.includes('<'), 'keine Tags übrig: ' + t);
  });
  it('dekodiert Entities, robust bei kaputten/leeren Eingaben', () => {
    assert.equal(IDX.buildPageText({ texts: [{ html: '<p>a &lt; b &amp; c</p>' }] }), 'a < b & c');
    assert.equal(IDX.buildPageText(null), '');
    assert.equal(IDX.buildPageText({}), '');
    assert.equal(IDX.buildPageText({ texts: null }), '');
    assert.equal(IDX.buildPageText({ texts: [{ html: null }, { html: '' }] }), '');
  });
});

describe('ink-index/extractTags', () => {
  it('findet einfache Tags kleingeschrieben', () => {
    assert.deepEqual(IDX.extractTags('heute #Strahd gespielt'), ['strahd']);
  });
  it('nested a/b bleibt ein Pfad-Tag', () => {
    assert.deepEqual(IDX.extractTags('#Quest/Haupt erledigt'), ['quest/haupt']);
    assert.deepEqual(IDX.extractTags('#a/b/c tief'), ['a/b/c']);
  });
  it('Duplikate + Case werden zusammengeführt', () => {
    assert.deepEqual(IDX.extractTags('#DnD und #dnd und #DND'), ['dnd']);
  });
  it('Satzzeichen am Ende gehört nicht zum Tag, kein a#b', () => {
    assert.deepEqual(IDX.extractTags('siehe #tag, und #tag2. ok'), ['tag', 'tag2']);
    assert.deepEqual(IDX.extractTags('mail a#b ist kein Tag'), []);
  });
  it('robust bei leer/kaputt', () => {
    assert.deepEqual(IDX.extractTags(''), []);
    assert.deepEqual(IDX.extractTags(null), []);
    assert.deepEqual(IDX.extractTags('# allein'), []);
  });
});

describe('ink-index/extractTasks', () => {
  it('zählt offen/erledigt', () => {
    assert.deepEqual(IDX.extractTasks('- [ ] a\n- [x] b\n- [X] c'), { open: 1, done: 2 });
  });
  it('ignoriert halb [/] und Normalzeilen', () => {
    assert.deepEqual(IDX.extractTasks('- [/] halb\n- normal\nText'), { open: 0, done: 0 });
  });
  it('robust bei leer/null', () => {
    assert.deepEqual(IDX.extractTasks(''), { open: 0, done: 0 });
    assert.deepEqual(IDX.extractTasks(null), { open: 0, done: 0 });
  });
});

describe('ink-index/indexBook', () => {
  it('liefert Kennzahlen (Titel, Seiten, Striche, Tags, Tasks, Textlänge)', () => {
    const idx = IDX.indexBook(bookFixture());
    assert.equal(idx.title, 'Strahd Kampagne');
    assert.equal(idx.pageCount, 2);
    assert.equal(idx.strokeCount, 4);
    assert.deepEqual(idx.tags, ['dnd', 'quest/haupt']);
    assert.equal(idx.tasksOpen, 1);
    assert.equal(idx.tasksDone, 1);
    assert.ok(idx.textLen > 20, 'getippter Text muss Länge haben, got ' + idx.textLen);
    assert.equal(idx.updatedAt, 1700000000000);
    assert.equal(typeof idx.lang, 'string');
  });
  it('leeres/kaputtes Buch crasht nicht', () => {
    const idx = IDX.indexBook({ title: '', pages: [] });
    assert.equal(idx.pageCount, 0);
    assert.equal(idx.strokeCount, 0);
    assert.deepEqual(idx.tags, []);
    assert.deepEqual([idx.tasksOpen, idx.tasksDone], [0, 0]);
    assert.equal(idx.textLen, 0);
  });
});

describe('ink-index/sprache', () => {
  it('default ist de ohne navigator, get/set pro Buch', () => {
    // „ohne navigator" deterministisch simulieren: Node ≥22 kennt global
    // navigator (CI-Runner: language en-US → 'en'), Container hier: de-DE.
    const hadNav = ('navigator' in globalThis);
    const saved = globalThis.navigator;
    try {
      assert.equal(delete globalThis.navigator, true, 'navigator muss ausblendbar sein');
      assert.equal(typeof globalThis.navigator, 'undefined');
      assert.equal(IDX.defaultLang(), 'de');
      const b = bookFixture();
      assert.equal(IDX.getBookLang(b), 'de');
      assert.equal(IDX.setBookLang(b, 'en'), 'en');
      assert.equal(b.lang, 'en');
      assert.equal(IDX.getBookLang(b), 'en');
    } finally {
      if (hadNav) Object.defineProperty(globalThis, 'navigator', { value: saved, configurable: true, writable: true });
    }
  });
  it('ungültige Sprache ändert nichts', () => {
    const b = bookFixture();
    IDX.setBookLang(b, 'en');
    assert.equal(IDX.setBookLang(b, '???'), 'en');
    assert.equal(b.lang, 'en');
    assert.equal(IDX.setBookLang(b, ''), 'en');
  });
  it('kürzt de-DE auf Basis-Code', () => {
    const b = bookFixture();
    assert.equal(IDX.setBookLang(b, 'de-DE'), 'de');
  });
});

describe('ink-index/provider-registry', () => {
  beforeEach(() => { IDX._resetHtrProviders(); });
  it('default KEIN Provider (ehrlich, keine Fake-Treffer)', () => {
    assert.equal(IDX.isHtrAvailable(), false);
    assert.deepEqual(IDX.getHtrProviderNames(), []);
    return IDX.queryHtr({ id: 'p1' }).then((words) => {
      assert.deepEqual(words, []);
    });
  });
  it('Mock-Provider liefert Treffer nach Registrierung', async () => {
    IDX.registerHtrProvider('mock', async (page) => ['strahd', 'barovia']);
    assert.equal(IDX.isHtrAvailable(), true);
    assert.deepEqual(IDX.getHtrProviderNames(), ['mock']);
    const words = await IDX.queryHtr({ id: 'p1' });
    assert.deepEqual(words, ['strahd', 'barovia']);
  });
  it('unregister schaltet zurück auf nicht verfügbar', async () => {
    IDX.registerHtrProvider('mock', async () => ['x']);
    assert.equal(IDX.unregisterHtrProvider('mock'), true);
    assert.equal(IDX.isHtrAvailable(), false);
    assert.deepEqual(await IDX.queryHtr({}), []);
  });
  it('fehlerhafter Provider -> ehrlich [] statt Crash', async () => {
    IDX.registerHtrProvider('kaputt', async () => { throw new Error('boom'); });
    assert.equal(IDX.isHtrAvailable(), true);
    assert.deepEqual(await IDX.queryHtr({}), []);
  });
});

describe('ink-index/suche', () => {
  const books = [
    { id: '1', title: 'Strahd Kampagne', pages: [{ texts: [{ html: '<p>Barovia #dnd</p>' }], strokes: [] }] },
    { id: '2', title: 'Einkaufsliste', pages: [{ texts: [{ html: '<p>Wein und Brot</p>' }], strokes: [] }] },
  ];
  it('Titel-Treffer (Badge Titel)', () => {
    const res = IDX.searchBooks(books, 'strahd');
    assert.equal(res.length, 1);
    assert.equal(res[0].book.id, '1');
    assert.equal(res[0].match, 'title');
  });
  it('Text-Treffer (Badge Text, nur getippt)', () => {
    const res = IDX.searchBooks(books, 'brot');
    assert.equal(res.length, 1);
    assert.equal(res[0].book.id, '2');
    assert.equal(res[0].match, 'text');
  });
  it('Tag-Treffer auch mit #-Präfix', () => {
    const res = IDX.searchBooks(books, '#dnd');
    assert.equal(res.length, 1);
    assert.equal(res[0].match, 'tag');
    const res2 = IDX.searchBooks(books, 'dnd');
    assert.ok(res2.some((r) => r.book.id === '1' && r.match === 'tag'));
  });
  it('leere Query liefert alle (ohne Filter), Handschrift allein matcht nie', () => {
    const all = IDX.searchBooks(books, '');
    assert.equal(all.length, 2);
    const strokesOnly = [{ id: '9', title: 'Kritzel', pages: [{ texts: [], strokes: [{}, {}] }] }];
    assert.deepEqual(IDX.searchBooks(strokesOnly, 'strahd'), []);
  });
});
