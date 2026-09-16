'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_PATH = path.join(__dirname, '..', 'js', 'search.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const S = require('../js/search.js');

// Fixture-Bücher im Grimoire-Format { title, pages: [{ texts: [{ html }] }] }.
function mkBook(title, htmls) {
  return {
    id: 'b-' + String(title).slice(0, 8),
    title,
    updatedAt: Date.now(),
    pages: [{ id: 'p1', strokes: [], images: [], bg: null, texts: (htmls || []).map((html, i) => ({ id: 't' + i, html })) }],
  };
}
const bDrachen = mkBook('Drachenbuch', ['<p>Feuer und <b>Schuppen</b></p>', '<p>#projekt Notizen zum Hort</p>']);
const bQuest = mkBook('Questlog', [
  '<p>- [ ] Goblinlager ausheben</p>',
  '<p>- [x] Dorf retten</p>',
  '<p>#projekt #offen Pläne</p>',
]);
const bKraut = mkBook('Kräuterkunde', ['<p>Heiltrank: nächste Schritte planen</p>', '<p>siehe line:12 im Herbarium</p>']);
const bTaskHtml = mkBook('Werkstatt', [
  '<ul class="task-list"><li class="task-list-item"><input type="checkbox" disabled data-marker=" "> Pilze sammeln</li>'
  + '<li class="task-list-item"><input type="checkbox" disabled data-marker="x" checked> Trank brauen</li></ul>',
]);
const bLeer = mkBook('Leeres Buch', []);
const ALL = [bDrachen, bQuest, bKraut, bTaskHtml, bLeer];

describe('search/datei', () => {
  it('ist ohne DOM ladbar (reine Funktionen, kein Browser-Zugriff)', () => {
    assert.ok(S && typeof S.parseQuery === 'function');
    assert.ok(!/\b(document|window|navigator|localStorage|alert)\b/.test(SRC),
      'js/search.js muss ohne DOM auskommen');
  });
  it('exportiert parseQuery/matchBook/rankBooks (+ Helfer)', () => {
    for (const k of ['parseQuery', 'matchBook', 'rankBooks', 'scoreBook', 'stripHtml', 'extractTags', 'extractTasks']) {
      assert.equal(typeof S[k], 'function', k);
    }
    assert.equal(S.QUERY_MAX_RESULTS, 5);
  });
});

describe('search/parse', () => {
  it('leere Query ist leer', () => {
    for (const q of ['', '   ', null, undefined]) {
      const p = S.parseQuery(q);
      assert.equal(p.isEmpty, true, JSON.stringify(q));
      assert.deepEqual(p.groups, []);
    }
  });
  it('Default AND via Leerzeichen (eine Gruppe)', () => {
    const p = S.parseQuery('Drachen Hort');
    assert.equal(p.isEmpty, false);
    assert.equal(p.groups.length, 1);
    assert.deepEqual(p.groups[0].map(t => t.value), ['Drachen', 'Hort']);
    assert.ok(p.groups[0].every(t => t.field === 'text' && !t.negated && !t.phrase));
  });
  it('OR trennt Gruppen (nur Großschreibung)', () => {
    const p = S.parseQuery('Drachen OR Kräuter');
    assert.equal(p.groups.length, 2);
    assert.equal(p.groups[0][0].value, 'Drachen');
    assert.equal(p.groups[1][0].value, 'Kräuter');
    const low = S.parseQuery('a or b');
    assert.equal(low.groups.length, 1, 'kleines "or" ist Text, kein Operator');
    assert.deepEqual(low.groups[0].map(t => t.value), ['a', 'or', 'b']);
    const mixed = S.parseQuery('a Or b');
    assert.equal(mixed.groups.length, 1, '"Or" ist Text');
  });
  it('AND/OR-Kombination: "a b OR c d" -> (a&b)|(c&d)', () => {
    const p = S.parseQuery('a b OR c d');
    assert.equal(p.groups.length, 2);
    assert.equal(p.groups[0].length, 2);
    assert.equal(p.groups[1].length, 2);
  });
  it('-Negation (Wort und Phrase)', () => {
    const p = S.parseQuery('Quest -Dorf');
    assert.equal(p.groups[0][1].negated, true);
    assert.equal(p.groups[0][1].value, 'Dorf');
    const ph = S.parseQuery('-"archiviert"');
    assert.equal(ph.groups.length, 1);
    assert.equal(ph.groups[0][0].negated, true);
    assert.equal(ph.groups[0][0].phrase, true);
    assert.equal(ph.groups[0][0].value, 'archiviert');
  });
  it('""-Phrasen bleiben ein Term', () => {
    const p = S.parseQuery('"nächste Schritte"');
    assert.equal(p.groups.length, 1);
    assert.equal(p.groups[0].length, 1);
    assert.equal(p.groups[0][0].phrase, true);
    assert.equal(p.groups[0][0].value, 'nächste Schritte');
  });
  it('Operatoren file:/path:/tag:/task-todo:/task-done: (case-insensitiv)', () => {
    assert.equal(S.parseQuery('tag:#projekt').groups[0][0].field, 'tag');
    assert.equal(S.parseQuery('FILE:Dra').groups[0][0].field, 'file');
    assert.equal(S.parseQuery('Path:Quest').groups[0][0].field, 'path');
    assert.equal(S.parseQuery('task-todo:Goblin').groups[0][0].field, 'task-todo');
    assert.equal(S.parseQuery('TASK-DONE:Dorf').groups[0][0].field, 'task-done');
    const neg = S.parseQuery('-path:Archiv');
    assert.equal(neg.groups[0][0].field, 'path');
    assert.equal(neg.groups[0][0].negated, true);
  });
  it('unbekannte Operatoren tolerant als Text', () => {
    for (const q of ['line:12', 'section:Einleitung', 'foo:bar']) {
      const p = S.parseQuery(q);
      assert.equal(p.isEmpty, false, q);
      assert.equal(p.groups[0][0].field, 'text', q);
      assert.equal(p.groups[0][0].value, q);
    }
  });
  it('leere Operatorwerte file:/path:/tag: sind neutral, task-Existenz bleibt', () => {
    assert.equal(S.parseQuery('tag:').isEmpty, true);
    assert.equal(S.parseQuery('file:').isEmpty, true);
    const t = S.parseQuery('task-todo:');
    assert.equal(t.isEmpty, false);
    assert.equal(t.groups[0][0].field, 'task-todo');
  });
});

describe('search/match', () => {
  it('Titel- und Text-Basis', () => {
    assert.equal(S.matchBook(bDrachen, 'Drachen'), true);
    assert.equal(S.matchBook(bDrachen, 'Goblin'), false);
    assert.equal(S.matchBook(bDrachen, S.parseQuery('Feuer Schuppen')), true, 'AND über Text');
    assert.equal(S.matchBook(bDrachen, S.parseQuery('Feuer Goblin')), false);
  });
  it('file:/path: Präfix auf Titel (case-insensitiv, kein Infix)', () => {
    assert.equal(S.matchBook(bDrachen, 'file:Drac'), true);
    assert.equal(S.matchBook(bDrachen, 'file:drachenbuch'), true);
    assert.equal(S.matchBook(bDrachen, 'file:achen'), false, 'Präfix, kein Substring');
    assert.equal(S.matchBook(bQuest, 'path:Quest'), true);
    assert.equal(S.matchBook(bQuest, 'FILE:quest'), true);
  });
  it('file:/path: wirken auch auf Seitenindex', () => {
    assert.equal(S.matchBook(bDrachen, 'file:seite'), true, 'Buch mit Seiten');
  });
  it('tag: mit/ohne #, Präfix, case-insensitiv', () => {
    assert.equal(S.matchBook(bDrachen, 'tag:#projekt'), true);
    assert.equal(S.matchBook(bQuest, 'tag:#projekt'), true);
    assert.equal(S.matchBook(bKraut, 'tag:#projekt'), false);
    assert.equal(S.matchBook(bDrachen, 'tag:proj'), true, 'Präfix-Match');
    assert.equal(S.matchBook(bQuest, 'tag:offen'), true);
    assert.equal(S.matchBook(bDrachen, 'tag:offen'), false);
    assert.equal(S.matchBook(bQuest, 'TAG:PROJEKT'), true);
  });
  it('task-todo:/task-done: (Markdown-Marker und Editor-HTML)', () => {
    assert.equal(S.matchBook(bQuest, 'task-todo:Goblin'), true);
    assert.equal(S.matchBook(bQuest, 'task-done:Dorf'), true);
    assert.equal(S.matchBook(bQuest, 'task-todo:Dorf'), false, 'erledigt ist kein todo');
    assert.equal(S.matchBook(bQuest, 'task-done:Goblin'), false, 'offen ist kein done');
    assert.equal(S.matchBook(bTaskHtml, 'task-todo:Pilze'), true, 'data-marker=" "');
    assert.equal(S.matchBook(bTaskHtml, 'task-done:brauen'), true, 'data-marker="x"');
    assert.equal(S.matchBook(bQuest, 'task-todo:'), true, 'Existenz-Check');
    assert.equal(S.matchBook(bDrachen, 'task-todo:'), false);
    assert.equal(S.matchBook(bDrachen, 'task-done:'), false);
  });
  it('Negation schließt aus', () => {
    assert.equal(S.matchBook(bQuest, S.parseQuery('Quest -Dorf')), false);
    assert.equal(S.matchBook(bQuest, S.parseQuery('Quest -Drachen')), true);
    assert.equal(S.matchBook(bKraut, 'Kraut -"nächste Schritte"'), false);
  });
  it('OR-Alternativen', () => {
    assert.equal(S.matchBook(bDrachen, 'Drachen OR Kräuter'), true);
    assert.equal(S.matchBook(bKraut, 'Drachen OR Kräuter'), true);
    assert.equal(S.matchBook(bQuest, 'Drachen OR Kräuter'), false);
  });
  it('Phrasen sind exakt', () => {
    assert.equal(S.matchBook(bKraut, '"nächste Schritte"'), true);
    assert.equal(S.matchBook(bKraut, '"Schritte nächste"'), false);
  });
  it('Umlaute + case-insensitiv robust', () => {
    assert.equal(S.matchBook(bKraut, 'kräuter'), true);
    assert.equal(S.matchBook(bKraut, 'NÄCHSTE'), true);
    assert.equal(S.matchBook(bKraut, 'heiltrank'), true);
  });
  it('Kombi aus Spec-Beispiel: tag + -Phrase', () => {
    assert.equal(S.matchBook(bQuest, 'tag:#projekt -"archiviert"'), true);
    const bArchiv = mkBook('Archiv', ['<p>#projekt archiviert und alt</p>']);
    assert.equal(S.matchBook(bArchiv, 'tag:#projekt -"archiviert"'), false);
  });
});

describe('search/rank', () => {
  it('Titel schlägt Text', () => {
    const bText = mkBook('Sonstiges', ['<p>viel Text über Drachen hier</p>']);
    const bTitle = mkBook('Drachen', ['<p>ganz anderer Inhalt</p>']);
    const ranked = S.rankBooks([bText, bTitle], 'Drachen');
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].book.title, 'Drachen');
    assert.ok(ranked[0].score > ranked[1].score, 'Titel-Score > Text-Score');
  });
  it('Titel > Tag > Text (Score-Staffel)', () => {
    const bT = mkBook('Projektplan', ['<p>sonstiges</p>']);
    const bG = mkBook('Sonstiges', ['<p>#projekt hier</p>']);
    const bX = mkBook('Anderes', ['<p>das projekt läuft</p>']);
    const ranked = S.rankBooks([bX, bG, bT], 'projekt');
    assert.deepEqual(ranked.map(r => r.book.title), ['Projektplan', 'Sonstiges', 'Anderes']);
    assert.ok(ranked[0].score > ranked[1].score && ranked[1].score > ranked[2].score);
  });
  it('stabil bei Gleichstand (Originalreihenfolge)', () => {
    const a = mkBook('Gleich A', ['<p>identischer Inhalt</p>']);
    const b = mkBook('Gleich B', ['<p>identischer Inhalt</p>']);
    const ranked = S.rankBooks([a, b], 'identischer');
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].score, ranked[1].score);
    assert.deepEqual(ranked.map(r => r.book.title), ['Gleich A', 'Gleich B']);
  });
  it('filtert Nicht-Treffer aus; leere Query gibt alle (Score 0)', () => {
    const ranked = S.rankBooks(ALL, 'tag:#projekt');
    assert.deepEqual(ranked.map(r => r.book.title).sort(), ['Drachenbuch', 'Questlog']);
    const all = S.rankBooks(ALL, '');
    assert.equal(all.length, ALL.length);
    assert.ok(all.every(r => r.score === 0));
    assert.deepEqual(all.map(r => r.index), [0, 1, 2, 3, 4]);
  });
});

describe('search/fehlertoleranz', () => {
  it('parseQuery wirft nie', () => {
    for (const q of ['"', '-', 'OR', 'OR OR', 'a OR', 'OR b', 'tag:', 'file:', '"offen', '-"x', ':::', 'a:"b c', '-tag:"x y"', 'x'.repeat(5000), 123, {}, [], 'file:  ', ' # ']) {
      assert.doesNotThrow(() => S.parseQuery(q), JSON.stringify(q));
    }
  });
  it('kaputte Syntax zeigt alles (kein Crash)', () => {
    assert.equal(S.parseQuery('"').isEmpty, true, 'einsames " ist neutral (alles zeigen)');
    assert.equal(S.parseQuery('"offen').groups.length, 1, 'unbalanciert mit Inhalt = tolerante Phrase');
    assert.equal(S.parseQuery('-').isEmpty, true);
    assert.equal(S.parseQuery('OR').isEmpty, true);
    assert.equal(S.matchBook(bDrachen, null), true, 'leere Query passt überall');
    assert.equal(S.matchBook(bDrachen, ''), true);
  });
  it('matchBook/rankBooks werfen nie (auch bei schiefem Bestand)', () => {
    assert.doesNotThrow(() => S.matchBook({}, 'foo'));
    assert.doesNotThrow(() => S.matchBook(null, 'foo'));
    assert.doesNotThrow(() => S.matchBook({ title: 42, pages: 'kaputt' }, 'tag:x task-todo:y'));
    assert.doesNotThrow(() => S.rankBooks(null, 'x'));
    assert.doesNotThrow(() => S.rankBooks(ALL, null));
    assert.deepEqual(S.rankBooks(null, 'x'), []);
    assert.equal(S.rankBooks(ALL, null).length, ALL.length);
  });
  it('extractTags/extractTasks-Helfer', () => {
    assert.deepEqual(S.extractTags('a #Quest/haupt und #offen!'), ['quest/haupt', 'offen']);
    const t = S.extractTasks(['<p>- [ ] a</p><p>- [X] b</p>'], '- [ ] a\n- [X] b');
    assert.ok(t.todo.length >= 1 && t.done.length >= 1);
  });
});
