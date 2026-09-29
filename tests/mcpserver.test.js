'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandler, PROTOCOL_VERSION } = require('../mcpserver');

describe('mcpserver', () => {
  const handler = createMcpHandler({
    listDocuments: async () => [{ $id: 'doc-1', title: 'Test' }],
    getDocument: async id => ({ $id: id, title: 'Test' }),
    listFolders: async () => [{ $id: 'folder-1', name: 'Notizen' }],
    searchDocuments: async query => [{ $id: 'doc-1', title: query }],
  });

  it('initialisiert mit MCP-Fähigkeiten', async () => {
    const response = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    assert.equal(response.result.protocolVersion, PROTOCOL_VERSION);
    assert.ok(response.result.capabilities.tools);
  });

  it('listet alle 21 Tools (lesen, schreiben, Ordner, Karten, Suche, Graph)', async () => {
    const list = await handler({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(list.result.tools.map(tool => tool.name), [
      'list_documents', 'get_document', 'list_folders', 'search_documents',
      'advanced_search', 'get_graph',
      'create_document', 'update_document', 'delete_document',
      'duplicate_document', 'move_document',
      'create_folder', 'rename_folder', 'delete_folder',
      'create_deck', 'list_cards', 'add_cards', 'update_card', 'delete_card',
      'review_card', 'deck_stats',
    ]);
  });

  it('ruft Lese-Tools auf', async () => {
    const call = await handler({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'get_document', arguments: { id: 'doc-1' } },
    });
    assert.equal(call.result.structuredContent.$id, 'doc-1');
  });

  it('meldet fehlende Pflichtparameter als JSON-RPC-Fehler', async () => {
    const response = await handler({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'get_document', arguments: {} },
    });
    assert.equal(response.error.code, -32000);
    assert.match(response.error.message, /id is required/);
  });

  it('meldet nicht implementierte Schreib-Tools verständlich', async () => {
    const response = await handler({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'create_document', arguments: { title: 'Neu' } },
    });
    assert.equal(response.error.code, -32000);
    assert.match(response.error.message, /Backend ohne createDocument/);
  });

  it('meldet unbekannte Methoden als JSON-RPC-Fehler', async () => {
    const response = await handler({ jsonrpc: '2.0', id: 6, method: 'unknown' });
    assert.equal(response.error.code, -32601);
  });
});
