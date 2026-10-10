'use strict';
/* Federwerk MCP-Backend gegen die eigene Server-API (statt Appwrite).
 *
 * Der Handler kennt nur das `api`-Objekt (Transport, siehe mcpserver/login.js)
 * und die Inhalts-Envelopes aus content.js. Dadurch bleibt die Fachlogik
 * (Notizen wie ein Mensch, SM-2-Decks) unabhängig davon, ob sie gegen den
 * echten Server oder eine In-Memory-Fake-API in Tests läuft.
 *
 * `api`-Aufrufe: sessionInfo, login, logout, listDocs, getDoc, putDoc,
 * deleteDoc, listFolders, putFolder, deleteFolder.
 */

const { createMcpHandler } = require('./index');
const C = require('./content');

// Der Server liefert Zeitstempel in Millisekunden und markiert Löschungen als
// Tombstone (deletedAt gesetzt, server/docs.js). Tombstones bleiben im Pull,
// damit Clients die Löschung mitbekommen – für MCP blenden wir sie aus.
function isLiveDoc(doc) { return !!doc && !doc.deletedAt; }
function isLiveFolder(folder) { return !!folder && !folder.deletedAt; }

function createServerHandler(deps) {
  const d = deps || {};
  const api = d.api || {};
  const who = d.user || null;

  // Eine Pull-Seite genügt für Suche/Graph: server/docs.js deckelt bei 1000.
  async function pullDocs() {
    return (await api.listDocs(0, 1000)) || [];
  }

  async function allDocs() {
    return (await pullDocs())
      .filter(isLiveDoc)
      .map((doc) => C.docFromServerDoc(doc, { markdownMax: Infinity }));
  }

  async function ensureFolder(folderId) {
    if (!folderId) return null;
    const fid = String(folderId).trim();
    if (!fid) return null;
    const all = ((await api.listFolders()) || []).filter(isLiveFolder);
    if (!all.some((f) => f.id === fid)) throw new Error('Folder not found');
    return fid;
  }

  // Dokument laden und in eine Arbeitskopie entpacken; Writes bauen daraus
  // wieder die volle Zeile (der Server-PUT ersetzt sie komplett).
  async function loadParts(id) {
    const doc = await api.getDoc(String(id));
    if (!doc) throw new Error('Document not found');
    if (doc.deletedAt) throw new Error('Document has been deleted');
    const dec = C.decodeContent(doc.content || '');
    return {
      doc,
      parts: {
        id: doc.id,
        title: doc.title || '',
        folderId: doc.folderId || null,
        pages: dec.pages,
        kind: dec.kind,
        cards: dec.cards.map((c) => C.normalizeCard(c)),
        deckOptions: C.normalizeDeckOptions(dec.deckOptions),
        reviewLog: C.normalizeReviewLog(dec.reviewLog),
        createdAt: doc.createdAt || null,
      },
    };
  }

  async function saveParts(id, parts) {
    const data = C.serverDataFromDocParts(Object.assign({}, parts, { id }));
    C.checkContentBytes(data.content);
    return api.putDoc(data);
  }

  async function freshDoc(id) {
    const doc = await api.getDoc(String(id));
    if (!doc) throw new Error('Document not found');
    return C.docFromServerDoc(doc, { cardsLimit: 200 });
  }

  return createMcpHandler({
    sessionInfo: async () => {
      const info = (await api.sessionInfo()) || {};
      // Die beim Start einmal aufgelöste Identität erspart einen zweiten
      // /api/auth/me-Rundlauf; die Session selbst bleibt Sache des Clients.
      if (!who) return info;
      return Object.assign({}, info, {
        userId: info.userId || who.id || '',
        email: info.email || who.email || '',
      });
    },
    login: async () => (await api.login()) || {},
    logout: async () => (await api.logout()) || {},
    listDocuments: async (limit = 100, folderId = null, opts = {}) => {
      const max = Math.min(Math.max(Number(limit) || 100, 1), 100);
      const target = folderId || (opts && opts.folderId);
      const kind = opts && opts.kind;
      let live = (await pullDocs()).filter(isLiveDoc);
      if (target) live = live.filter((doc) => (doc.folderId || null) === target);
      if (kind === 'notebook' || kind === 'flashcards') {
        live = live.filter((doc) => C.decodeContent(doc.content || '').kind === kind);
      }
      live.sort((a, b) => (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0));
      return live.slice(0, max).map((doc) => C.docFromServerDoc(doc));
    },
    getDocument: async (id) => freshDoc(id),
    listFolders: async () => {
      const all = ((await api.listFolders()) || []).filter(isLiveFolder);
      all.sort((a, b) => (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0));
      return all.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId || null }));
    },
    searchDocuments: async (text, limit = 100) => {
      const needle = String(text || '').trim().toLowerCase();
      if (!needle) return [];
      const max = Math.min(Math.max(Number(limit) || 100, 1), 100);
      const out = [];
      for (const doc of (await pullDocs()).filter(isLiveDoc)) {
        const dec = C.decodeContent(doc.content || '');
        const md = C.pagesToMarkdown(dec.pages);
        const hay = [
          String(doc.title || ''),
          md,
          ...dec.cards.map((c) => `${C.stripTagsLite(c.front)} ${C.stripTagsLite(c.back)}`),
        ].join('\n').toLowerCase();
        if (hay.includes(needle)) {
          out.push({
            id: doc.id,
            title: doc.title || 'Unbenannt',
            snippet: C.snippetFor(md.replace(/\s+/g, ' ') || String(doc.title || ''), [needle]),
            updatedAt: C.nowIso(Number(doc.updatedAt)),
          });
        }
        if (out.length >= max) break;
      }
      return out;
    },
    advancedSearch: async (text, limit = 100) => {
      const q = String(text || '').trim();
      if (!q) return [];
      return C.advancedSearchDocs(await allDocs(), q, limit);
    },
    getGraph: async (id, depth) => {
      const graph = C.buildGraph(await allDocs());
      if (id) {
        if (!graph.nodes.some((n) => n.id === id)) throw new Error('Document not found');
        return C.localGraph(graph, id, depth == null ? 1 : depth);
      }
      return graph;
    },
    createDocument: async (input = {}) => {
      C.checkTitle(input.title);
      await ensureFolder(input.folderId);
      const kind = input.kind === 'flashcards' ? 'flashcards' : 'notebook';
      const id = C.docIdFor(C.newId('n'), 'b');
      await saveParts(id, {
        title: C.normTitle(input.title),
        folderId: input.folderId ? String(input.folderId) : null,
        pages: C.contentToPages(input.content || '', input.contentFormat || 'markdown'),
        kind,
        cards: [],
        deckOptions: C.normalizeDeckOptions(null),
        reviewLog: [],
      });
      return freshDoc(id);
    },
    updateDocument: async (id, input = {}) => {
      const { parts } = await loadParts(id);
      if (input.title !== undefined) {
        C.checkTitle(input.title);
        parts.title = C.normTitle(input.title);
      }
      if (input.folderId !== undefined) {
        const fid = String(input.folderId || '').trim();
        await ensureFolder(fid || null);
        parts.folderId = fid || null;
      }
      if (input.content !== undefined) {
        const pages = C.contentToPages(input.content || '', input.contentFormat || 'markdown');
        if (input.append) {
          const html = pages.length && pages[0].texts.length ? pages[0].texts[0].html : '';
          if (!parts.pages.length) parts.pages = [C.blankPage()];
          const last = parts.pages[parts.pages.length - 1];
          last.texts = Array.isArray(last.texts) ? last.texts : [];
          last.texts.push({ id: C.newId('t'), x: 0.08, y: 0.05, html: html || '<p></p>' });
        } else {
          parts.pages = pages;
        }
      }
      await saveParts(id, parts);
      return freshDoc(id);
    },
    deleteDocument: async (id) => {
      await loadParts(id); // Existenz-Check (fremd/gelöscht -> Fehler)
      // Der Server kennt nur Tombstones (server/docs.js remove); endgültig
      // räumt der GC auf. Ein `permanent`-Argument gibt es hier deshalb nicht.
      await api.deleteDoc(String(id));
      return { id, deleted: true, permanent: false };
    },
    duplicateDocument: async (id, input = {}) => {
      const { parts } = await loadParts(id);
      if (input && input.title !== undefined) C.checkTitle(input.title);
      const copyId = C.docIdFor(C.newId('n'), 'b');
      const fresh = Object.assign({}, parts, {
        id: copyId,
        title: input && input.title ? C.normTitle(input.title) : `${parts.title} (Kopie)`,
        createdAt: null,
        // Karten-IDs neu vergeben (sonst kollidieren Review-Zuordnungen).
        cards: parts.cards.map((c) => Object.assign({}, C.normalizeCard(c), { id: C.newId('c') })),
      });
      await saveParts(copyId, fresh);
      return freshDoc(copyId);
    },
    moveDocument: async (id, folderId) => {
      const { parts } = await loadParts(id);
      const fid = String(folderId || '').trim();
      await ensureFolder(fid || null);
      parts.folderId = fid || null;
      await saveParts(id, parts);
      return freshDoc(id);
    },
    createFolder: async (input = {}) => {
      const name = String(input.name || '').trim().slice(0, 60);
      if (!name) throw new Error('name ist erforderlich');
      if (input.parentId) await ensureFolder(String(input.parentId));
      const id = C.docIdFor(C.newId('f'), 'f');
      const saved = await api.putFolder({
        id, name, parentId: input.parentId ? String(input.parentId) : null,
        updatedAt: C.nowMs(), deletedAt: null,
      });
      return { id: saved.id, name: saved.name, parentId: saved.parentId || null };
    },
    renameFolder: async (id, name) => {
      const clean = String(name || '').trim().slice(0, 60);
      if (!clean) throw new Error('name ist erforderlich');
      const all = ((await api.listFolders()) || []).filter(isLiveFolder);
      const hit = all.find((f) => f.id === id);
      if (!hit) throw new Error('Folder not found');
      const saved = await api.putFolder({
        id, name: clean, parentId: hit.parentId || null,
        updatedAt: C.nowMs(), deletedAt: null,
      });
      return { id, name: saved.name, parentId: saved.parentId || null };
    },
    deleteFolder: async (id, input = {}) => {
      const all = ((await api.listFolders()) || []).filter(isLiveFolder);
      if (!all.some((f) => f.id === id)) throw new Error('Folder not found');
      const target = input && input.moveDocumentsTo ? String(input.moveDocumentsTo) : '';
      if (target && !all.some((f) => f.id === target)) throw new Error('Folder not found');
      let moved = 0;
      for (const doc of (await pullDocs()).filter(isLiveDoc)) {
        if ((doc.folderId || null) !== id) continue;
        // Nur die Ordnerzuordnung ändern, Inhalt unangetastet übernehmen.
        await api.putDoc({
          id: doc.id, title: doc.title, folderId: target || null, content: doc.content,
          createdAt: doc.createdAt, updatedAt: C.nowMs(), deletedAt: null,
        });
        moved++;
      }
      await api.deleteFolder(id);
      return { id, deleted: true, documentsMoved: moved, moveDocumentsTo: target || null };
    },

    createDeck: async (input = {}) => {
      C.checkTitle(input.title);
      await ensureFolder(input.folderId);
      const cards = C.checkCards(input.cards || [], false);
      const id = C.docIdFor(C.newId('n'), 'b');
      await saveParts(id, {
        title: C.normTitle(input.title),
        folderId: input.folderId ? String(input.folderId) : null,
        pages: [C.blankPage()],
        kind: 'flashcards',
        cards,
        deckOptions: C.normalizeDeckOptions(null),
        reviewLog: [],
      });
      return freshDoc(id);
    },
    listCards: async (deckId, filter, limit) => {
      const { parts } = await loadParts(deckId);
      if (parts.kind !== 'flashcards') throw new Error('Document is not a deck');
      const t = C.nowMs();
      const max = Math.min(Math.max(Number(limit) || 100, 1), 100);
      let list = parts.cards;
      if (filter === 'due') list = list.filter((c) => C.isDue(c, t));
      else if (filter === 'new') list = list.filter((c) => !c.lastReview && !c.suspended);
      return list.slice(0, max);
    },
    addCards: async (deckId, cards) => {
      const fresh = C.checkCards(cards, true);
      const { parts } = await loadParts(deckId);
      if (parts.kind !== 'flashcards') throw new Error('Document is not a deck');
      parts.cards.push(...fresh);
      await saveParts(deckId, parts);
      return fresh;
    },
    updateCard: async (deckId, cardId, input = {}) => {
      const { parts } = await loadParts(deckId);
      if (parts.kind !== 'flashcards') throw new Error('Document is not a deck');
      const card = parts.cards.find((c) => c.id === cardId);
      if (!card) throw new Error('Card not found');
      if (input.front !== undefined) card.front = String(input.front);
      if (input.back !== undefined) card.back = String(input.back);
      if (input.suspended !== undefined) card.suspended = !!input.suspended;
      card.updatedAt = C.nowMs();
      C.normalizeCard(card);
      await saveParts(deckId, parts);
      return card;
    },
    deleteCard: async (deckId, cardId) => {
      const { parts } = await loadParts(deckId);
      if (parts.kind !== 'flashcards') throw new Error('Document is not a deck');
      const ix = parts.cards.findIndex((c) => c.id === cardId);
      if (ix < 0) throw new Error('Card not found');
      parts.cards.splice(ix, 1);
      await saveParts(deckId, parts);
      return { deckId, cardId, deleted: true };
    },
    reviewCard: async (deckId, cardId, grade) => {
      const { parts } = await loadParts(deckId);
      if (parts.kind !== 'flashcards') throw new Error('Document is not a deck');
      const card = parts.cards.find((c) => c.id === cardId);
      if (!card) throw new Error('Card not found');
      if (!C.normalizeGrade(grade)) throw new Error('grade muss again|hard|good|easy sein');
      C.gradeCardInPlace(card, grade);
      parts.reviewLog = C.normalizeReviewLog([...parts.reviewLog, { t: C.nowMs(), g: C.normalizeGrade(grade), id: cardId }]);
      await saveParts(deckId, parts);
      return { card, preview: C.previewIntervals(card) };
    },
    deckStats: async (deckId) => {
      const { parts } = await loadParts(deckId);
      if (parts.kind !== 'flashcards') throw new Error('Document is not a deck');
      return { deckId, ...C.deckStats(parts.cards, parts.reviewLog) };
    },
  });
}

module.exports = { createServerHandler };

