'use strict';
/* Voller MCP-Workflow wie ein Mensch: Notizen, Ordner, Decks, Suche, Graph.
 * Läuft gegen das In-Memory-Demo-Backend (ohne Cloud-Credentials). */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createDemoHandler } = require('../mcpserver/cli');
const C = require('../mcpserver/content');

async function call(handler, name, args, id = 1) {
  const res = await handler({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  if (res.error) throw new Error(`Tool ${name}: ${res.error.message}`);
  return res.result.structuredContent;
}

describe('mcp demo-backend: Notizen wie ein Mensch', () => {
  it('create/get/update/append/duplicate/move/delete', async () => {
    const handler = createDemoHandler();
    const created = await call(handler, 'create_document', {
      title: 'Einkaufsliste', content: '# Markt\n\n- [ ] Äpfel\n- [ ] Brot',
    });
    assert.ok(created.id);
    assert.equal(created.title, 'Einkaufsliste');
    assert.match(created.markdown, /Äpfel/);

    const read = await call(handler, 'get_document', { id: created.id });
    assert.equal(read.pages, 1);

    const updated = await call(handler, 'update_document', { id: created.id, title: 'Markt' });
    assert.equal(updated.title, 'Markt');

    const appended = await call(handler, 'update_document', {
      id: created.id, content: '- [ ] Käse', append: true,
    });
    assert.match(appended.markdown, /Käse/);
    assert.match(appended.markdown, /Äpfel/);

    const hits = await call(handler, 'search_documents', { query: 'käse' });
    assert.ok(hits.some((h) => h.id === created.id));

    const adv = await call(handler, 'advanced_search', { query: 'task-todo:käse' });
    assert.ok(adv.some((h) => h.id === created.id));
    const neg = await call(handler, 'advanced_search', { query: 'käse -brot' });
    assert.ok(!neg.some((h) => h.id === created.id));

    const copy = await call(handler, 'duplicate_document', { id: created.id });
    assert.notEqual(copy.id, created.id);
    assert.match(copy.title, /Kopie/);

    const folder = await call(handler, 'create_folder', { name: 'Haushalt' });
    const moved = await call(handler, 'move_document', { id: created.id, folderId: folder.id });
    assert.equal(moved.folderId, folder.id);

    const del = await call(handler, 'delete_document', { id: copy.id });
    assert.equal(del.deleted, true);
    await assert.rejects(call(handler, 'get_document', { id: copy.id }), /not found/i);
  });

  it('text-Format und Ordner-Verwaltung mit Dokumentenumzug', async () => {
    const handler = createDemoHandler();
    const doc = await call(handler, 'create_document', {
      title: 'Plain', content: 'einfach nur Text', contentFormat: 'text',
    });
    assert.match(doc.markdown, /einfach nur Text/);

    const parent = await call(handler, 'create_folder', { name: 'A' });
    const child = await call(handler, 'create_folder', { name: 'B', parentId: parent.id });
    assert.equal(child.parentId, parent.id);
    await call(handler, 'move_document', { id: doc.id, folderId: child.id });
    const renamed = await call(handler, 'rename_folder', { id: child.id, name: 'B2' });
    assert.equal(renamed.name, 'B2');
    const gone = await call(handler, 'delete_folder', { id: child.id });
    assert.equal(gone.documentsMoved, 1);
    const back = await call(handler, 'get_document', { id: doc.id });
    assert.equal(back.folderId, null);
  });
});

describe('mcp demo-backend: Karteikarten (SM-2)', () => {
  it('deck anlegen, Karten pflegen, lernen, Statistik', async () => {
    const handler = createDemoHandler();
    const deck = await call(handler, 'create_deck', {
      title: 'Französisch',
      cards: [{ front: 'Apfel', back: 'pomme' }, { front: 'Brot', back: 'pain' }],
    });
    assert.equal(deck.kind, 'flashcards');
    assert.equal(deck.cardsTotal, 2);

    const added = await call(handler, 'add_cards', {
      deckId: deck.id, cards: [{ front: 'Käse', back: 'fromage' }],
    });
    assert.equal(added.length, 1);

    const due = await call(handler, 'list_cards', { deckId: deck.id, filter: 'due' });
    assert.equal(due.length, 3);

    const graded = await call(handler, 'review_card', {
      deckId: deck.id, cardId: due[0].id, grade: 'good',
    });
    assert.equal(graded.card.reps, 1);
    assert.equal(graded.card.interval, 1);
    assert.ok(graded.preview);

    const stats = await call(handler, 'deck_stats', { deckId: deck.id });
    assert.equal(stats.total, 3);
    assert.equal(stats.learned, 1);
    assert.equal(stats.fresh, 2);
    assert.equal(stats.forecast.length, 7);

    const edited = await call(handler, 'update_card', {
      deckId: deck.id, cardId: due[1].id, back: 'pain (m)',
    });
    assert.equal(edited.back, 'pain (m)');

    const removed = await call(handler, 'delete_card', { deckId: deck.id, cardId: due[1].id });
    assert.equal(removed.deleted, true);
    const rest = await call(handler, 'list_cards', { deckId: deck.id });
    assert.equal(rest.length, 2);

    await assert.rejects(
      call(handler, 'review_card', { deckId: deck.id, cardId: rest[0].id, grade: 'super' }),
      /grade/,
    );
  });

  it('lehnt Kartenaktionen auf Notizbüchern ab', async () => {
    const handler = createDemoHandler();
    const doc = await call(handler, 'create_document', { title: 'Kein Deck' });
    await assert.rejects(call(handler, 'add_cards', { deckId: doc.id, cards: [{ front: 'a', back: 'b' }] }), /not a deck/);
    await assert.rejects(call(handler, 'deck_stats', { deckId: doc.id }), /not a deck/);
  });
});

describe('mcp demo-backend: Graph', () => {
  it('verlinkt Dokumente über [[Wikilinks]]', async () => {
    const handler = createDemoHandler();
    const a = await call(handler, 'create_document', { title: 'Ziel', content: 'Inhalt' });
    const b = await call(handler, 'create_document', { title: 'Start', content: `Siehe [[${a.title}]] und [[Nirgendwo]]` });
    const graph = await call(handler, 'get_graph', {});
    const edge = graph.edges.find((e) => e.from === b.id && e.toTitle === a.title);
    assert.ok(edge);
    assert.equal(edge.to, a.id);
    const dangling = graph.edges.find((e) => e.from === b.id && e.toTitle === 'Nirgendwo');
    assert.equal(dangling.to, null);

    const local = await call(handler, 'get_graph', { id: b.id, depth: 1 });
    assert.ok(local.nodes.some((n) => n.id === a.id));
  });
});

describe('mcpserver/content', () => {
  it('Envelope v1/v2 Roundtrip', () => {
    const pages = C.contentToPages('# Hallo', 'markdown');
    const v1 = C.decodeContent(JSON.stringify({ v: 1, pages }));
    assert.equal(v1.kind, 'notebook');
    const v2str = C.encodeContent({ pages, kind: 'flashcards', cards: [C.newCard('f', 'b')], deckOptions: null, reviewLog: [] });
    const v2 = C.decodeContent(v2str);
    assert.equal(v2.kind, 'flashcards');
    assert.equal(v2.cards.length, 1);
  });

  it('Markdown-lite Roundtrip behält Struktur', () => {
    const md = '# Titel\n\n- [ ] offen\n- [x] fertig\n\n**fett** und `code`';
    const html = C.mdToHtmlLite(md);
    assert.match(html, /<h1>/);
    assert.match(html, /data-marker/);
    const back = C.htmlToMdLite(html);
    assert.match(back, /# Titel/);
    assert.match(back, /- \[ \]/);
  });

  it('SM-2: again resettet, good steigert', () => {
    const card = C.newCard('f', 'b');
    C.gradeCardInPlace(card, 'good');
    assert.equal(card.reps, 1);
    assert.equal(card.interval, 1);
    C.gradeCardInPlace(card, 'again');
    assert.equal(card.reps, 0);
    assert.equal(card.interval, 0);
    assert.equal(card.lapses, 1);
  });

  it('validiert Titel, Kartenmengen und Pflichtfelder', () => {
    assert.throws(() => C.checkTitle('x'.repeat(201)), /zu lang/);
    assert.throws(() => C.checkCards([], true), /leer/);
    assert.throws(() => C.checkCards(new Array(101).fill({ front: 'a', back: 'b' }), true), /max 100/);
  });
});
