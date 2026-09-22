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

  it('listet und ruft Tools auf', async () => {
    const list = await handler({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(list.result.tools.map(tool => tool.name), [
      'list_documents', 'get_document', 'list_folders', 'search_documents',
    ]);
    const call = await handler({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'get_document', arguments: { id: 'doc-1' } },
    });
    assert.equal(call.result.structuredContent.$id, 'doc-1');
  });

  it('meldet unbekannte Methoden als JSON-RPC-Fehler', async () => {
    const response = await handler({ jsonrpc: '2.0', id: 4, method: 'unknown' });
    assert.equal(response.error.code, -32601);
  });
});
