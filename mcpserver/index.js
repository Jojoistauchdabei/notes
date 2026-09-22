'use strict';

const PROTOCOL_VERSION = '2024-11-05';

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id == null ? null : id, error: { code, message } };
}

function toolResult(text, structuredContent) {
  return {
    content: [{ type: 'text', text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

function createMcpHandler({ listDocuments, getDocument, listFolders, searchDocuments }) {
  const tools = [
    {
      name: 'list_documents',
      description: 'List Federwerk documents for the authenticated user.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max documents to return (1-100)' },
          folderId: { type: 'string', description: 'Filter documents by folder ID' },
        },
      },
    },
    {
      name: 'get_document',
      description: 'Get one Federwerk document by its Appwrite row ID.',
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
      description: 'Search Federwerk document titles and contents.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'Search term' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (1-100)' },
        },
        required: ['query'],
      },
    },
  ];

  async function callTool(name, args) {
    const input = args && typeof args === 'object' ? args : {};
    if (name === 'list_documents') {
      const rows = await listDocuments(input.limit, input.folderId, input);
      return toolResult(JSON.stringify(rows), rows);
    }
    if (name === 'get_document') {
      if (!input.id) throw new Error('id is required');
      const row = await getDocument(String(input.id), input);
      return toolResult(JSON.stringify(row), row);
    }
    if (name === 'list_folders') {
      const rows = await listFolders(input);
      return toolResult(JSON.stringify(rows), rows);
    }
    if (name === 'search_documents') {
      if (!input.query) throw new Error('query is required');
      const rows = await searchDocuments(String(input.query), input.limit, input);
      return toolResult(JSON.stringify(rows), rows);
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
            serverInfo: { name: 'federwerk-appwrite', version: '1.0.0' },
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

module.exports = { createMcpHandler, PROTOCOL_VERSION, runStdio };
