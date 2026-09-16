'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'graph.js'), 'utf8');
const G = require('../js/graph.js');

function mkBook(title, id, htmls) {
  return {
    id: id || String(title).toLowerCase().replace(/\s+/g, '-'),
    title,
    pages: (htmls || []).map((html, i) => ({ id: 'p' + i, texts: [{ id: 't' + i, html }] })),
  };
}

// Build-Fixture: Duplikate, Selbstlink, Case-Insensitivität, Alias/Subpath, unbekanntes Ziel.
function buildFixture() {
  return [
    mkBook('Almanach', 'a', ['Start, siehe [[Bestarium]] und nochmal [[bestarium]].']),
    mkBook('Bestarium', 'b', ['Weiter zu [[Chronik#Kapitel 2|Kapitel zwei]].']),
    mkBook('Chronik', 'c', ['Zurück zu [[Almanach]], zu mir [[Chronik]] und nach [[Nirgendwo]].']),
  ];
}

// Local-Fixture: reine Kette A→B→C + isoliertes D (keine Rückkanten).
function chainFixture() {
  return [
    mkBook('Almanach', 'a', ['Siehe [[Bestarium]].']),
    mkBook('Bestarium', 'b', ['Siehe [[Chronik]].']),
    mkBook('Chronik', 'c', ['Keine Links hier.']),
    mkBook('Drachenhort', 'd', ['Einsam, ohne Links.']),
  ];
}

describe('graph/datei', () => {
  it('ist ohne DOM ladbar (reine Funktionen, kein Browser-Zugriff)', () => {
    assert.ok(G && typeof G.buildGraph === 'function');
    assert.ok(!/\b(document|window|navigator|localStorage|alert)\b/.test(SRC),
      'js/graph.js muss ohne DOM auskommen');
  });
  it('exportiert die vereinbarte API', () => {
    for (const k of ['extractWikilinks', 'buildGraph', 'localGraph']) {
      assert.equal(typeof G[k], 'function', k);
    }
  });
});

describe('graph/extractWikilinks', () => {
  it('einfache Treffer in Reihenfolge', () => {
    assert.deepEqual(G.extractWikilinks('siehe [[B]] und [[C]] ok'), ['B', 'C']);
  });
  it('Alias nach | wird abgetrennt', () => {
    assert.deepEqual(G.extractWikilinks('[[B|Anzeige]]'), ['B']);
    assert.deepEqual(G.extractWikilinks('[[B|a|b]]'), ['B']);
  });
  it('#Subpath und Block-ID werden abgetrennt', () => {
    assert.deepEqual(G.extractWikilinks('[[B#Kapitel 1]]'), ['B']);
    assert.deepEqual(G.extractWikilinks('[[B#^abc123]]'), ['B']);
    assert.deepEqual(G.extractWikilinks('[[B#Kapitel|Anzeige]]'), ['B']);
  });
  it('whitespace wird getrimmt', () => {
    assert.deepEqual(G.extractWikilinks('[[  B  ]]'), ['B']);
  });
  it('funktioniert auf gerendertem HTML (wikilink-Spans)', () => {
    assert.deepEqual(
      G.extractWikilinks('<p>siehe <span class="wikilink">[[B]]</span> ok</p>'),
      ['B']
    );
  });
  it('Duplikate bleiben erhalten (Dedupe passiert in buildGraph)', () => {
    assert.deepEqual(G.extractWikilinks('[[B]] [[B]]'), ['B', 'B']);
  });
  it('Edge-Cases: leer / kein Link / unvollständig / nur Hash/Alias', () => {
    assert.deepEqual(G.extractWikilinks(''), []);
    assert.deepEqual(G.extractWikilinks(null), []);
    assert.deepEqual(G.extractWikilinks(undefined), []);
    assert.deepEqual(G.extractWikilinks('kein link hier'), []);
    assert.deepEqual(G.extractWikilinks('[[]]'), []);
    assert.deepEqual(G.extractWikilinks('[[#nur-hash]]'), []);
    assert.deepEqual(G.extractWikilinks('[[|nur-alias]]'), []);
    assert.deepEqual(G.extractWikilinks('[[   ]]'), []);
    assert.deepEqual(G.extractWikilinks('[[offen'), []);
  });
});

describe('graph/buildGraph', () => {
  it('Knoten = Bücher mit id/title/bookId/pages', () => {
    const g = G.buildGraph(buildFixture());
    assert.equal(g.nodes.length, 3);
    assert.deepEqual(g.nodes[0], { id: 'a', title: 'Almanach', bookId: 'a', pages: 1 });
  });
  it('Kanten aus [[Ziel]]-Treffern (Alias/Subpath aufgelöst)', () => {
    const g = G.buildGraph(buildFixture());
    const keys = g.edges.map(e => e.from + '->' + e.to).sort();
    assert.deepEqual(keys, ['a->b', 'b->c', 'c->a', 'c->c']);
  });
  it('Duplikate + Case-Varianten ergeben nur eine Kante', () => {
    const g = G.buildGraph(buildFixture());
    assert.equal(g.edges.filter(e => e.from === 'a' && e.to === 'b').length, 1);
  });
  it('Selbstlink ist als Loop-Kante enthalten (genau einmal)', () => {
    const g = G.buildGraph(buildFixture());
    assert.equal(g.edges.filter(e => e.from === 'c' && e.to === 'c').length, 1);
  });
  it('unbekannte Ziele erzeugen keine Kante', () => {
    const g = G.buildGraph(buildFixture());
    assert.ok(g.edges.every(e => e.to !== 'Nirgendwo'));
    assert.equal(g.nodes.length, 3, 'kein Dangling-Knoten für unbekannte Ziele');
  });
  it('leere/defensive Eingaben crashen nicht', () => {
    assert.deepEqual(G.buildGraph([]), { nodes: [], edges: [] });
    assert.deepEqual(G.buildGraph(null), { nodes: [], edges: [] });
    assert.deepEqual(G.buildGraph(undefined), { nodes: [], edges: [] });
  });
});

describe('graph/localGraph', () => {
  it('Depth 1 ab A: nur direkte Nachbarn', () => {
    const g = G.buildGraph(chainFixture());
    const l = G.localGraph(g, 'Almanach', 1);
    assert.deepEqual(l.nodes.map(n => n.id).sort(), ['a', 'b']);
    assert.deepEqual(l.edges, [{ from: 'a', to: 'b' }]);
  });
  it('Depth 2 ab A: Kette wächst, isoliertes Buch bleibt draußen', () => {
    const g = G.buildGraph(chainFixture());
    const l = G.localGraph(g, 'Almanach', 2);
    assert.deepEqual(l.nodes.map(n => n.id).sort(), ['a', 'b', 'c']);
    assert.deepEqual(
      l.edges.map(e => e.from + '->' + e.to).sort(),
      ['a->b', 'b->c']
    );
  });
  it('Rücklink zählt zur Nachbarschaft (ungerichtete BFS)', () => {
    const g = G.buildGraph(chainFixture());
    const l = G.localGraph(g, 'Chronik', 1);
    assert.deepEqual(l.nodes.map(n => n.id).sort(), ['b', 'c']);
  });
  it('Default-Depth ist 1, Titel-Match case-insensitiv', () => {
    const g = G.buildGraph(chainFixture());
    assert.deepEqual(
      G.localGraph(g, 'almanach').nodes.map(n => n.id).sort(),
      ['a', 'b']
    );
  });
  it('unbekannter Titel -> leerer Teilgraph', () => {
    const g = G.buildGraph(chainFixture());
    assert.deepEqual(G.localGraph(g, 'Nirgendwo', 2), { nodes: [], edges: [] });
    assert.deepEqual(G.localGraph(g, '', 1), { nodes: [], edges: [] });
  });
});
