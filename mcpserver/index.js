'use strict';
/* Federwerk MCP-Serverkern (JSON-RPC 2.0, ohne Dependencies).
 *
 * Stateless Protokoll-Engine: Alle Fachoperationen kommen als injizierte
 * Handler herein, damit derselbe Kern an drei Stellen läuft:
 *  1) Server-API-Backend (mcpserver/backend.js gegen /api/*),
 *  2) lokaler stdio/HTTP-Server (mcpserver/cli.js, Demo- oder Server-Backend),
 *  3) Node-Tests (Mocks).
 *
 * Tools (21):
 *  Lesen: list_documents, get_document, list_folders, search_documents,
 *         advanced_search, get_graph
 *  Notizen (wie ein Mensch): create_document, update_document, delete_document,
 *         duplicate_document, move_document
 *  Ordner: create_folder, rename_folder, delete_folder
 *  Karteikarten (SM-2, js/flashcards.js-kompatibel): create_deck, list_cards,
 *         add_cards, update_card, delete_card, review_card, deck_stats
 */

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_VERSION = '1.1.0';

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id == null ? null : id, error: { code, message } };
}

function toolResult(text, structuredContent) {
  return {
    content: [{ type: 'text', text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

const LIMIT = { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (1-100)' };

function createMcpHandler(deps) {
  const d = deps || {};
  // Lesende Handler sind Pflicht, schreibende optional: fehlt einer, meldet
  // das Tool einen verständlichen Fehler statt "Unknown tool".
  const need = (name) => {
    const fn = d[name];
    if (typeof fn !== 'function') throw new Error(`Tool nicht verfügbar (Backend ohne ${name})`);
    return fn;
  };

  const tools = [
    {
      name: 'session_info',
      description: 'Show the current Federwerk login: signed in as (email, userId), whether the session belongs to this MCP (ownedByMcp) and when it expires. Never returns passwords.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'login',
      description: 'Sign in with the configured Federwerk credentials (E-Mail/Passwort from env or the credential store) and create a session. Use after a session error or to switch users.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'logout',
      description: 'Sign out: ends the session this MCP created. Refuses to delete sessions it does not own (e.g. a browser session passed in as FEDERWERK_SESSION) so the app stays logged in.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_documents',
      description: 'List Federwerk documents for the authenticated user. Optional kind filter (notebook|flashcards).',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { ...LIMIT, description: 'Max documents to return (1-100)' },
          folderId: { type: 'string', description: 'Filter documents by folder ID' },
          kind: { type: 'string', enum: ['notebook', 'flashcards'], description: 'Filter by document type' },
        },
      },
    },
    {
      name: 'get_document',
      description: 'Get one Federwerk document by its document ID (with markdown content; decks include cards).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1, description: 'Document ID' } },
        required: ['id'],
      },
    },
    {
      name: 'list_folders',
      description: 'List the complete Federwerk folder tree for the authenticated user.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'search_documents',
      description: 'Search Federwerk document titles and contents (substring; for query language use advanced_search).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'Search term' },
          limit: LIMIT,
        },
        required: ['query'],
      },
    },
    {
      name: 'advanced_search',
      description: 'Query-language search (SPEC-07 light): OR (uppercase), -negation, "phrases", file:/path:/tag:/task:/task-todo:/task-done:. Scores title 10 > tag 5 > task 3 > text 1.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1 }, limit: LIMIT },
        required: ['query'],
      },
    },
    {
      name: 'get_graph',
      description: 'Wikilink graph ([[...]]) over all documents. With id: local subgraph up to depth (max 3).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Document ID for local subgraph' },
          depth: { type: 'integer', minimum: 0, maximum: 3, description: 'Neighborhood depth (default 1)' },
        },
      },
    },
    {
      name: 'create_document',
      description: 'Create a note like a human in the editor. content is markdown by default (contentFormat: markdown|html|text).',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 200, description: 'Note title' },
          content: { type: 'string', description: 'Note body (markdown default)' },
          contentFormat: { type: 'string', enum: ['markdown', 'html', 'text'], description: 'Body format (default markdown)' },
          folderId: { type: 'string', description: 'Folder ID (omit = unsorted)' },
          kind: { type: 'string', enum: ['notebook', 'flashcards'], description: 'Document type (default notebook)' },
        },
        required: ['title'],
      },
    },
    {
      name: 'update_document',
      description: 'Update title/body/folder of a note. append=true appends the body as new textbox instead of replacing.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', maxLength: 200 },
          content: { type: 'string' },
          contentFormat: { type: 'string', enum: ['markdown', 'html', 'text'] },
          folderId: { type: 'string', description: 'New folder ID (empty string = unsorted)' },
          append: { type: 'boolean', description: 'Append body instead of replacing' },
        },
        required: ['id'],
      },
    },
    {
      name: 'delete_document',
      description: 'Delete a note (default: tombstone like the app sync; permanent=true deletes the row).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          permanent: { type: 'boolean', description: 'Hard-delete the row (default false)' },
        },
        required: ['id'],
      },
    },
    {
      name: 'duplicate_document',
      description: 'Duplicate a note (with pages and, for decks, cards) under a new title.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', maxLength: 200, description: 'Title of the copy' },
        },
        required: ['id'],
      },
    },
    {
      name: 'move_document',
      description: 'Move a note into another folder (empty folderId = unsorted).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          folderId: { type: 'string', description: 'Target folder ID (empty = unsorted)' },
        },
        required: ['id'],
      },
    },
    {
      name: 'create_folder',
      description: 'Create a folder (optionally nested via parentId).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 60 },
          parentId: { type: 'string', description: 'Parent folder ID' },
        },
        required: ['name'],
      },
    },
    {
      name: 'rename_folder',
      description: 'Rename a folder.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1, maxLength: 60 },
        },
        required: ['id', 'name'],
      },
    },
    {
      name: 'delete_folder',
      description: 'Delete a folder. Contained documents move to moveDocumentsTo (default unsorted).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          moveDocumentsTo: { type: 'string', description: 'Target folder for contained docs (empty = unsorted)' },
        },
        required: ['id'],
      },
    },
    {
      name: 'create_deck',
      description: 'Create a flashcard deck (SM-2) like via "Neues Deck", optionally with first cards [{front, back}].',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 200 },
          folderId: { type: 'string' },
          cards: {
            type: 'array', maxItems: 100,
            items: {
              type: 'object',
              properties: { front: { type: 'string' }, back: { type: 'string' } },
              required: ['front', 'back'],
            },
          },
        },
        required: ['title'],
      },
    },
    {
      name: 'list_cards',
      description: 'List cards of a deck (filter: all|due|new).',
      inputSchema: {
        type: 'object',
        properties: {
          deckId: { type: 'string', minLength: 1 },
          filter: { type: 'string', enum: ['all', 'due', 'new'], description: 'Default all' },
          limit: LIMIT,
        },
        required: ['deckId'],
      },
    },
    {
      name: 'add_cards',
      description: 'Add flashcards to a deck (max 100 per call).',
      inputSchema: {
        type: 'object',
        properties: {
          deckId: { type: 'string', minLength: 1 },
          cards: {
            type: 'array', minItems: 1, maxItems: 100,
            items: {
              type: 'object',
              properties: { front: { type: 'string' }, back: { type: 'string' } },
              required: ['front', 'back'],
            },
          },
        },
        required: ['deckId', 'cards'],
      },
    },
    {
      name: 'update_card',
      description: 'Edit front/back of a card or (un)suspend it.',
      inputSchema: {
        type: 'object',
        properties: {
          deckId: { type: 'string', minLength: 1 },
          cardId: { type: 'string', minLength: 1 },
          front: { type: 'string' },
          back: { type: 'string' },
          suspended: { type: 'boolean' },
        },
        required: ['deckId', 'cardId'],
      },
    },
    {
      name: 'delete_card',
      description: 'Delete a card from a deck.',
      inputSchema: {
        type: 'object',
        properties: {
          deckId: { type: 'string', minLength: 1 },
          cardId: { type: 'string', minLength: 1 },
        },
        required: ['deckId', 'cardId'],
      },
    },
    {
      name: 'review_card',
      description: 'Grade a card SM-2 style (again|hard|good|easy) like tapping the buttons in the app.',
      inputSchema: {
        type: 'object',
        properties: {
          deckId: { type: 'string', minLength: 1 },
          cardId: { type: 'string', minLength: 1 },
          grade: { type: 'string', enum: ['again', 'hard', 'good', 'easy'], description: 'again=Nochmal, hard=Hart, good=Gut, easy=Leicht' },
        },
        required: ['deckId', 'cardId', 'grade'],
      },
    },
    {
      name: 'deck_stats',
      description: 'Deck statistics: totals, due/new/learned, accuracy, leeches, 7-day forecast, streak.',
      inputSchema: {
        type: 'object',
        properties: { deckId: { type: 'string', minLength: 1 } },
        required: ['deckId'],
      },
    },
  ];

  async function callTool(name, args) {
    const input = args && typeof args === 'object' ? args : {};
    const call = async (dep, ...a) => need(dep)(...a);
    if (name === 'session_info') {
      const rows = await call('sessionInfo');
      return toolResult(JSON.stringify(rows), rows);
    }
    if (name === 'login') {
      const rows = await call('login');
      return toolResult(JSON.stringify(rows), rows);
    }
    if (name === 'logout') {
      const rows = await call('logout');
      return toolResult(JSON.stringify(rows), rows);
    }
    if (name === 'list_documents') {
      const rows = await call('listDocuments', input.limit, input.folderId, input);
      return toolResult(JSON.stringify(rows), rows);
    }
    if (name === 'get_document') {
      if (!input.id) throw new Error('id is required');
      const row = await call('getDocument', String(input.id), input);
      return toolResult(JSON.stringify(row), row);
    }
    if (name === 'list_folders') {
      const rows = await call('listFolders', input);
      return toolResult(JSON.stringify(rows), rows);
    }
    if (name === 'search_documents') {
      if (!input.query) throw new Error('query is required');
      const rows = await call('searchDocuments', String(input.query), input.limit, input);
      return toolResult(JSON.stringify(rows), rows);
    }
    if (name === 'advanced_search') {
      if (!input.query) throw new Error('query is required');
      const rows = await call('advancedSearch', String(input.query), input.limit, input);
      return toolResult(JSON.stringify(rows), rows);
    }
    if (name === 'get_graph') {
      const rows = await call('getGraph', input.id ? String(input.id) : null, input.depth, input);
      return toolResult(JSON.stringify(rows), rows);
    }
    if (name === 'create_document') {
      if (!input.title) throw new Error('title is required');
      const row = await call('createDocument', input);
      return toolResult(JSON.stringify(row), row);
    }
    if (name === 'update_document') {
      if (!input.id) throw new Error('id is required');
      const row = await call('updateDocument', String(input.id), input);
      return toolResult(JSON.stringify(row), row);
    }
    if (name === 'delete_document') {
      if (!input.id) throw new Error('id is required');
      const row = await call('deleteDocument', String(input.id), input);
      return toolResult(JSON.stringify(row), row);
    }
    if (name === 'duplicate_document') {
      if (!input.id) throw new Error('id is required');
      const row = await call('duplicateDocument', String(input.id), input);
      return toolResult(JSON.stringify(row), row);
    }
    if (name === 'move_document') {
      if (!input.id) throw new Error('id is required');
      const row = await call('moveDocument', String(input.id), input.folderId, input);
      return toolResult(JSON.stringify(row), row);
    }
    if (name === 'create_folder') {
      if (!input.name) throw new Error('name is required');
      const row = await call('createFolder', input);
      return toolResult(JSON.stringify(row), row);
    }
    if (name === 'rename_folder') {
      if (!input.id) throw new Error('id is required');
      if (!input.name) throw new Error('name is required');
      const row = await call('renameFolder', String(input.id), String(input.name), input);
      return toolResult(JSON.stringify(row), row);
    }
    if (name === 'delete_folder') {
      if (!input.id) throw new Error('id is required');
      const row = await call('deleteFolder', String(input.id), input);
      return toolResult(JSON.stringify(row), row);
    }
    if (name === 'create_deck') {
      if (!input.title) throw new Error('title is required');
      const row = await call('createDeck', input);
      return toolResult(JSON.stringify(row), row);
    }
    if (name === 'list_cards') {
      if (!input.deckId) throw new Error('deckId is required');
      const rows = await call('listCards', String(input.deckId), input.filter, input.limit, input);
      return toolResult(JSON.stringify(rows), rows);
    }
    if (name === 'add_cards') {
      if (!input.deckId) throw new Error('deckId is required');
      if (!input.cards) throw new Error('cards is required');
      const rows = await call('addCards', String(input.deckId), input.cards, input);
      return toolResult(JSON.stringify(rows), rows);
    }
    if (name === 'update_card') {
      if (!input.deckId) throw new Error('deckId is required');
      if (!input.cardId) throw new Error('cardId is required');
      const row = await call('updateCard', String(input.deckId), String(input.cardId), input);
      return toolResult(JSON.stringify(row), row);
    }
    if (name === 'delete_card') {
      if (!input.deckId) throw new Error('deckId is required');
      if (!input.cardId) throw new Error('cardId is required');
      const row = await call('deleteCard', String(input.deckId), String(input.cardId), input);
      return toolResult(JSON.stringify(row), row);
    }
    if (name === 'review_card') {
      if (!input.deckId) throw new Error('deckId is required');
      if (!input.cardId) throw new Error('cardId is required');
      if (!input.grade) throw new Error('grade is required');
      const row = await call('reviewCard', String(input.deckId), String(input.cardId), String(input.grade), input);
      return toolResult(JSON.stringify(row), row);
    }
    if (name === 'deck_stats') {
      if (!input.deckId) throw new Error('deckId is required');
      const row = await call('deckStats', String(input.deckId), input);
      return toolResult(JSON.stringify(row), row);
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  return async function handle(request) {
    const id = request && request.id;
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return jsonRpcError(id, -32600, 'Invalid JSON-RPC request');
    }
    try {
      if (request.method === 'initialize') {
        const clientVersion = request.params && request.params.protocolVersion;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: clientVersion || PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'federwerk-mcp', version: SERVER_VERSION },
          },
        };
      }
      if (request.method === 'notifications/initialized' || request.method === 'ping') {
        return request.id === undefined ? null : { jsonrpc: '2.0', id, result: {} };
      }
      if (request.method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: { tools } };
      }
      if (request.method === 'tools/call') {
        const params = request.params || {};
        return { jsonrpc: '2.0', id, result: await callTool(params.name, params.arguments) };
      }
      return jsonRpcError(id, -32601, `Method not found: ${request.method}`);
    } catch (error) {
      return jsonRpcError(id, -32000, error && error.message ? error.message : 'MCP request failed');
    }
  };
}

function runStdio(handler) {
  const readline = require('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const req = JSON.parse(trimmed);
      const res = await handler(req);
      if (res !== null && res !== undefined) {
        process.stdout.write(JSON.stringify(res) + '\n');
      }
    } catch (err) {
      process.stdout.write(JSON.stringify(jsonRpcError(null, -32700, 'Parse error: ' + (err && err.message))) + '\n');
    }
  });

  process.stderr.write('Federwerk MCP Server running on stdio\n');
}

module.exports = { createMcpHandler, PROTOCOL_VERSION, SERVER_VERSION, runStdio };
