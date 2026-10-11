'use strict';
/* Verifiziert den Port auf die eigene Server-API: der Handler aus
 * mcpserver/backend.js läuft gegen eine In-Memory-Fake-API, die sich wie
 * server/docs.js verhält (Timestamps in ms, Tombstones, Last-Write-Wins).
 * Damit ist der Port fachlich geprüft, nicht nur kompiliert. */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createServerHandler } = require('../mcpserver/backend');

function fakeApi() {
  const docs = new Map();
  const folders = new Map();
  const session = { authenticated: false, ownedByMcp: false, userId: '', email: '', expiresAt: null };
  const now = () => Date.now();

  return {
    docs,
    folders,
    async sessionInfo() { return { ...session }; },
    async login() {
      Object.assign(session, { authenticated: true, ownedByMcp: true, userId: 'u1', email: 'demo@federwerk.local' });
      return { ...session };
    },
    async logout() {
      if (!session.authenticated) return { ...session, loggedOut: false, note: 'Keine Session aktiv' };
      Object.assign(session, { authenticated: false, ownedByMcp: false, userId: '', email: '' });
      return { ...session, loggedOut: true };
    },
    async listDocs() { return [...docs.values()]; },
    async getDoc(id) { return docs.get(String(id)) || null; },
    async putDoc(doc) {
      const prev = docs.get(doc.id);
      // Last-Write-Wins wie server/docs.js: ein älterer Stand überschreibt nicht.
      if (prev && Number(doc.updatedAt) < prev.updatedAt) return prev;
      const row = {
        id: doc.id,
        title: doc.title || '',
        folderId: doc.folderId || null,
        content: doc.content || '',
        createdAt: prev ? prev.createdAt : (Number(doc.createdAt) || now()),
        updatedAt: Number(doc.updatedAt) || now(),
        deletedAt: doc.deletedAt ? Number(doc.deletedAt) : null,
      };
      docs.set(row.id, row);
      return row;
    },
    async deleteDoc(id) {
      const t = now();
      const prev = docs.get(id);
      if (prev) { prev.deletedAt = t; prev.updatedAt = t; }
      else docs.set(id, { id, title: '', folderId: null, content: '', createdAt: t, updatedAt: t, deletedAt: t });
      return { id, deletedAt: t };
    },
    async listFolders() { return [...folders.values()]; },
    async putFolder(folder) {
      const prev = folders.get(folder.id);
      if (prev && Number(folder.updatedAt) < prev.updatedAt) return prev;
      const row = {
        id: folder.id, name: folder.name || '', parentId: folder.parentId || null,
        createdAt: prev ? prev.createdAt : now(),
        updatedAt: Number(folder.updatedAt) || now(),
        deletedAt: folder.deletedAt ? Number(folder.deletedAt) : null,
      };
      folders.set(row.id, row);
      return row;
    },
    async deleteFolder(id) {
      const t = now();
      const prev = folders.get(id);
      if (prev) { prev.deletedAt = t; prev.updatedAt = t; }
      else folders.set(id, { id, name: '', parentId: null, createdAt: t, updatedAt: t, deletedAt: t });
      return { id, deletedAt: t };
    },
  };
}

function handlerFor(api) {
  return createServerHandler({ api, user: { id: 'u1', email: 'demo@federwerk.local', name: 'Demo' } });
}

async function call(handler, name, args, id = 1) {
  const res = await handler({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  if (res.error) throw new Error(`Tool ${name}: ${res.error.message}`);
  return res.result.structuredContent;
}

describe('mcp server-backend: Notizen wie ein Mensch', () => {
  it('create/get/update/append/duplicate/move/delete', async () => {
    const handler = handlerFor(fakeApi());
    const created = await call(handler, 'create_document', {
      title: 'Einkaufsliste', content: '# Markt\n\n- [ ] Äpfel\n- [ ] Brot',
    });
    assert.ok(created.id);
    assert.equal(created.title, 'Einkaufsliste');
    assert.equal(created.kind, 'notebook');
    assert.ok(created.updatedAt && !Number.isNaN(Date.parse(created.updatedAt)));
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
    await assert.rejects(call(handler, 'get_document', { id: copy.id }), /deleted|not found/i);
  });

  it('list_documents filtert Tombstones und Ordner', async () => {
    const api = fakeApi();
    const handler = handlerFor(api);
    const a = await call(handler, 'create_document', { title: 'A' });
    const b = await call(handler, 'create_document', { title: 'B' });
    const folder = await call(handler, 'create_folder', { name: 'Ordner' });
    await call(handler, 'move_document', { id: b.id, folderId: folder.id });

    const inFolder = await call(handler, 'list_documents', { folderId: folder.id });
    assert.deepEqual(inFolder.map((d) => d.id), [b.id]);

    await call(handler, 'delete_document', { id: a.id });
    const all = await call(handler, 'list_documents', {});
    assert.ok(!all.some((d) => d.id === a.id));
    // Der Tombstone bleibt im Server-Pull sichtbar, nur der Handler blendet
    // ihn aus – genau wie der App-Sync die Löschung mitbekommt.
    assert.ok(api.docs.get(a.id).deletedAt);
  });
});

describe('mcp server-backend: Ordner', () => {
  it('verschachtelt, umbenennen, löschen mit Dokumentenumzug', async () => {
    const handler = handlerFor(fakeApi());
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
    const folders = await call(handler, 'list_folders', {});
    assert.ok(!folders.some((f) => f.id === child.id));
  });
});

describe('mcp server-backend: Karteikarten (SM-2)', () => {
  it('deck anlegen, Karten pflegen, lernen, Statistik', async () => {
    const handler = handlerFor(fakeApi());
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
    const handler = handlerFor(fakeApi());
    const doc = await call(handler, 'create_document', { title: 'Kein Deck' });
    await assert.rejects(call(handler, 'add_cards', { deckId: doc.id, cards: [{ front: 'a', back: 'b' }] }), /not a deck/);
    await assert.rejects(call(handler, 'deck_stats', { deckId: doc.id }), /not a deck/);
  });
});

describe('mcp server-backend: Graph und Session', () => {
  it('verlinkt Dokumente über [[Wikilinks]]', async () => {
    const handler = handlerFor(fakeApi());
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

  it('reicht die Session durch und meldet die aufgelöste Identität', async () => {
    const handler = handlerFor(fakeApi());
    const before = await call(handler, 'session_info');
    assert.equal(before.authenticated, false);
    // Identität kommt aus `user` (beim Start via /api/auth/me), ohne zweiten Aufruf.
    assert.equal(before.userId, 'u1');
    const after = await call(handler, 'login');
    assert.equal(after.authenticated, true);
    const out = await call(handler, 'logout');
    assert.equal(out.loggedOut, true);
  });
});
