#!/usr/bin/env node
'use strict';
/* Federwerk MCP-CLI: stdio- oder HTTP-Transport mit zwei Backends.
 *
 *  - Mit FEDERWERK_* (URL + E-Mail/Passwort oder Session-Cookie): echte
 *    Notizen über die Server-API (/api/*).
 *  - Ohne: In-Memory-Demo mit VOLLEM Toolset (alle 21 Tools), damit eine KI
 *    bzw. ein Mensch den Umgang (Notizen, Ordner, Decks, Suche, Graph) ohne
 *    Server-Zugang üben kann. Der Demo-Stand verfällt beim Beenden.
 */

const http = require('node:http');
const { createMcpHandler, runStdio } = require('./index');
const C = require('./content');

function createDemoHandler() {
  const docs = new Map(); // id -> {id,title,folderId,pages,kind,cards,deckOptions,reviewLog,updatedAt,deleted}
  const folders = new Map(); // id -> {id,name,parentId}
  const session = { authenticated: false, ownedByMcp: false, userId: '', email: '', expiresAt: null };
  const info = (extra) => ({ ...session, ...(extra || {}) });

  const seed = {
    id: 'demo-1', title: 'Willkommen bei Federwerk', folderId: null,
    pages: C.contentToPages('Dies ist eine lokale Demo-Notiz.\n\n- [ ] Aufgabe ausprobieren\n- [x] MCP-Server starten', 'markdown'),
    kind: 'notebook', cards: [], deckOptions: C.normalizeDeckOptions(null),
    reviewLog: [], updatedAt: new Date().toISOString(), deleted: false,
  };
  docs.set(seed.id, seed);
  folders.set('folder-1', { id: 'folder-1', name: 'Hauptordner', parentId: null });

  const live = () => [...docs.values()].filter((d) => !d.deleted);
  const getDoc = (id) => {
    const d = docs.get(String(id));
    if (!d || d.deleted) throw new Error('Document not found');
    return d;
  };
  const getFolder = (id) => {
    const f = folders.get(String(id));
    if (!f) throw new Error('Folder not found');
    return f;
  };
  const toDoc = (d) => {
    const md = C.pagesToMarkdown(d.pages);
    const out = {
      id: d.id, title: d.title, folderId: d.folderId, kind: d.kind,
      updatedAt: d.updatedAt, pages: d.pages.length,
      markdown: md.slice(0, C.INLINE_MARKDOWN_MAX + 500), truncated: md.length > C.INLINE_MARKDOWN_MAX + 500,
    };
    if (d.kind === 'flashcards') {
      out.cards = d.cards.slice(0, 200);
      out.cardsTruncated = d.cards.length > 200;
      out.cardsTotal = d.cards.length;
      out.deckOptions = d.deckOptions;
    }
    return out;
  };
  const fullDocs = () => live().map((d) => ({ ...toDoc(d), markdown: C.pagesToMarkdown(d.pages) }));

  return createMcpHandler({
    sessionInfo: async () => info(),
    login: async () => {
      session.authenticated = true;
      session.ownedByMcp = true;
      session.email = 'demo@federwerk.local';
      session.userId = 'demo-user';
      session.expiresAt = new Date(Date.now() + 3600e3).toISOString();
      return info();
    },
    logout: async () => {
      if (!session.authenticated) return info({ loggedOut: false, note: 'Keine Session aktiv' });
      const owned = session.ownedByMcp;
      Object.assign(session, { authenticated: false, ownedByMcp: false, userId: '', email: '', expiresAt: '' });
      return info({ loggedOut: owned });
    },
    listDocuments: async (limit = 100, folderId = null, opts = {}) => {
      const max = Math.min(Math.max(Number(limit) || 100, 1), 100);
      const target = folderId || (opts && opts.folderId);
      const kind = opts && opts.kind;
      return live()
        .filter((d) => (!target || d.folderId === target) && (!kind || d.kind === kind))
        .slice(0, max).map(toDoc);
    },
    getDocument: async (id) => toDoc(getDoc(id)),
    listFolders: async () => [...folders.values()],
    searchDocuments: async (query, limit = 100) => {
      const needle = String(query || '').trim().toLowerCase();
      if (!needle) return [];
      const max = Math.min(Math.max(Number(limit) || 100, 1), 100);
      const out = [];
      for (const d of live()) {
        const hay = [d.title, C.pagesToMarkdown(d.pages),
          ...d.cards.map((c) => `${C.stripTagsLite(c.front)} ${C.stripTagsLite(c.back)}`)].join('\n').toLowerCase();
        if (hay.includes(needle)) {
          out.push({ id: d.id, title: d.title, snippet: C.snippetFor(C.pagesToMarkdown(d.pages), [needle]), updatedAt: d.updatedAt });
        }
        if (out.length >= max) break;
      }
      return out;
    },
    advancedSearch: async (query, limit) => C.advancedSearchDocs(fullDocs(), String(query || ''), limit),
    getGraph: async (id, depth) => {
      const graph = C.buildGraph(fullDocs());
      if (id) {
        if (!graph.nodes.some((n) => n.id === id)) throw new Error('Document not found');
        return C.localGraph(graph, id, depth == null ? 1 : depth);
      }
      return graph;
    },
    createDocument: async (input = {}) => {
      C.checkTitle(input.title);
      if (input.folderId) getFolder(String(input.folderId));
      const kind = input.kind === 'flashcards' ? 'flashcards' : 'notebook';
      const d = {
        id: C.newId('n'), title: C.normTitle(input.title),
        folderId: input.folderId ? String(input.folderId) : null,
        pages: C.contentToPages(input.content || '', input.contentFormat || 'markdown'),
        kind, cards: [], deckOptions: C.normalizeDeckOptions(null), reviewLog: [],
        updatedAt: new Date().toISOString(), deleted: false,
      };
      docs.set(d.id, d);
      return toDoc(d);
    },
    updateDocument: async (id, input = {}) => {
      const d = getDoc(id);
      if (input.title !== undefined) { C.checkTitle(input.title); d.title = C.normTitle(input.title); }
      if (input.folderId !== undefined) {
        const fid = String(input.folderId || '').trim();
        if (fid) getFolder(fid);
        d.folderId = fid || null;
      }
      if (input.content !== undefined) {
        const pages = C.contentToPages(input.content || '', input.contentFormat || 'markdown');
        if (input.append) {
          const html = pages.length && pages[0].texts.length ? pages[0].texts[0].html : '<p></p>';
          if (!d.pages.length) d.pages = [C.blankPage()];
          const last = d.pages[d.pages.length - 1];
          last.texts = Array.isArray(last.texts) ? last.texts : [];
          last.texts.push({ id: C.newId('t'), x: 0.08, y: 0.05, html });
        } else {
          d.pages = pages;
        }
      }
      d.updatedAt = new Date().toISOString();
      return toDoc(d);
    },
    deleteDocument: async (id, input = {}) => {
      const d = getDoc(id);
      if (input && input.permanent) { docs.delete(d.id); return { id: d.id, deleted: true, permanent: true }; }
      d.deleted = true; d.title = '(gelöscht)';
      return { id: d.id, deleted: true, permanent: false };
    },
    duplicateDocument: async (id, input = {}) => {
      const d = getDoc(id);
      if (input && input.title !== undefined) C.checkTitle(input.title);
      const copy = {
        ...d, id: C.newId('n'),
        title: input && input.title ? C.normTitle(input.title) : `${d.title} (Kopie)`,
        pages: JSON.parse(JSON.stringify(d.pages)),
        cards: d.cards.map((c) => ({ ...C.normalizeCard(c), id: C.newId('c') })),
        updatedAt: new Date().toISOString(), deleted: false,
      };
      docs.set(copy.id, copy);
      return toDoc(copy);
    },
    moveDocument: async (id, folderId) => {
      const d = getDoc(id);
      const fid = String(folderId || '').trim();
      if (fid) getFolder(fid);
      d.folderId = fid || null;
      d.updatedAt = new Date().toISOString();
      return toDoc(d);
    },
    createFolder: async (input = {}) => {
      const name = String(input.name || '').trim().slice(0, 60);
      if (!name) throw new Error('name ist erforderlich');
      if (input.parentId) getFolder(String(input.parentId));
      const f = { id: C.newId('f'), name, parentId: input.parentId ? String(input.parentId) : null };
      folders.set(f.id, f);
      return f;
    },
    renameFolder: async (id, name) => {
      const f = getFolder(id);
      const clean = String(name || '').trim().slice(0, 60);
      if (!clean) throw new Error('name ist erforderlich');
      f.name = clean;
      return { ...f };
    },
    deleteFolder: async (id, input = {}) => {
      getFolder(id);
      const target = input && input.moveDocumentsTo ? String(input.moveDocumentsTo) : '';
      if (target) getFolder(target);
      let moved = 0;
      for (const d of live()) {
        if (d.folderId === id) { d.folderId = target || null; moved++; }
      }
      folders.delete(id);
      return { id, deleted: true, documentsMoved: moved, moveDocumentsTo: target || null };
    },
    createDeck: async (input = {}) => {
      C.checkTitle(input.title);
      if (input.folderId) getFolder(String(input.folderId));
      const cards = C.checkCards(input.cards || [], false);
      const d = {
        id: C.newId('n'), title: C.normTitle(input.title),
        folderId: input.folderId ? String(input.folderId) : null,
        pages: [C.blankPage()], kind: 'flashcards', cards,
        deckOptions: C.normalizeDeckOptions(null), reviewLog: [],
        updatedAt: new Date().toISOString(), deleted: false,
      };
      docs.set(d.id, d);
      return toDoc(d);
    },
    listCards: async (deckId, filter, limit) => {
      const d = getDoc(deckId);
      if (d.kind !== 'flashcards') throw new Error('Document is not a deck');
      const t = C.nowMs();
      const max = Math.min(Math.max(Number(limit) || 100, 1), 100);
      let list = d.cards;
      if (filter === 'due') list = list.filter((c) => C.isDue(c, t));
      else if (filter === 'new') list = list.filter((c) => !c.lastReview && !c.suspended);
      return list.slice(0, max);
    },
    addCards: async (deckId, cards) => {
      const fresh = C.checkCards(cards, true);
      const d = getDoc(deckId);
      if (d.kind !== 'flashcards') throw new Error('Document is not a deck');
      d.cards.push(...fresh);
      d.updatedAt = new Date().toISOString();
      return fresh;
    },
    updateCard: async (deckId, cardId, input = {}) => {
      const d = getDoc(deckId);
      if (d.kind !== 'flashcards') throw new Error('Document is not a deck');
      const card = d.cards.find((c) => c.id === cardId);
      if (!card) throw new Error('Card not found');
      if (input.front !== undefined) card.front = String(input.front);
      if (input.back !== undefined) card.back = String(input.back);
      if (input.suspended !== undefined) card.suspended = !!input.suspended;
      card.updatedAt = C.nowMs();
      C.normalizeCard(card);
      d.updatedAt = new Date().toISOString();
      return card;
    },
    deleteCard: async (deckId, cardId) => {
      const d = getDoc(deckId);
      if (d.kind !== 'flashcards') throw new Error('Document is not a deck');
      const ix = d.cards.findIndex((c) => c.id === cardId);
      if (ix < 0) throw new Error('Card not found');
      d.cards.splice(ix, 1);
      d.updatedAt = new Date().toISOString();
      return { deckId, cardId, deleted: true };
    },
    reviewCard: async (deckId, cardId, grade) => {
      const d = getDoc(deckId);
      if (d.kind !== 'flashcards') throw new Error('Document is not a deck');
      const card = d.cards.find((c) => c.id === cardId);
      if (!card) throw new Error('Card not found');
      if (!C.normalizeGrade(grade)) throw new Error('grade muss again|hard|good|easy sein');
      C.gradeCardInPlace(card, grade);
      d.reviewLog = C.normalizeReviewLog([...d.reviewLog, { t: C.nowMs(), g: C.normalizeGrade(grade), id: cardId }]);
      d.updatedAt = new Date().toISOString();
      return { card, preview: C.previewIntervals(card) };
    },
    deckStats: async (deckId) => {
      const d = getDoc(deckId);
      if (d.kind !== 'flashcards') throw new Error('Document is not a deck');
      return { deckId, ...C.deckStats(d.cards, d.reviewLog) };
    },
  });
}

async function getHandler() {
  const B = require('./backend');
  const L = require('./login');
  const config = L.loadConfig();
  if (!L.hasCredentials(config)) {
    process.stderr.write('Federwerk MCP: keine Anmeldedaten – Demo-Backend (flüchtig).\n'
      + '  Für die echten Notizen: node mcpserver/login.js --email <adresse> --save\n');
    return createDemoHandler();
  }
  // Meldet sich mit den hinterlegten Daten selbst an; wirft bei falschen
  // Credentials (kein stiller Demo-Fallback, sonst schreibt man blind ins Nichts).
  const api = L.createApi(config);
  const info = await api.sessionInfo();
  process.stderr.write(
    'Federwerk MCP: Server-Backend als ' + (info.email || info.userId || '(unbekannt)')
    + ' (' + config.url + ').\n',
  );
  return B.createServerHandler({ api, user: info.user || null });
}

async function main() {
  const args = process.argv.slice(2);
  const isHttp = args.includes('--http');
  const handler = await getHandler();

  if (isHttp) {
    const portIndex = args.indexOf('--http') + 1;
    const port = Number(args[portIndex]) || Number(process.env.PORT) || 3000;
    const server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body);
            const result = await handler(parsed);
            if (result === null) {
              res.writeHead(204);
              res.end();
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            }
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } }));
          }
        });
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'federwerk-mcpserver', status: 'running' }));
    });

    server.listen(port, () => {
      console.error(`Federwerk MCP Server running on HTTP http://localhost:${port}`);
    });
  } else {
    runStdio(handler);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, getHandler, createDemoHandler };
