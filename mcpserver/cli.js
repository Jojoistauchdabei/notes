#!/usr/bin/env node
'use strict';

const http = require('node:http');
const { createMcpHandler, runStdio } = require('./index');

function createFallbackHandler() {
  const mockNotes = [
    { $id: 'demo-1', title: 'Willkommen bei Federwerk', content: 'Dies ist eine lokale Demo-Notiz.', updatedAt: new Date().toISOString() },
  ];
  const mockFolders = [
    { $id: 'folder-1', name: 'Hauptordner', parentId: null },
  ];

  return createMcpHandler({
    listDocuments: async (limit = 100) => mockNotes.slice(0, limit),
    getDocument: async (id) => {
      const note = mockNotes.find(n => n.$id === id);
      if (!note) throw new Error('Document not found');
      return note;
    },
    listFolders: async () => mockFolders,
    searchDocuments: async (query, limit = 100) => {
      const q = String(query).toLowerCase();
      return mockNotes.filter(n => n.title.toLowerCase().includes(q) || (n.content && n.content.toLowerCase().includes(q))).slice(0, limit);
    },
  });
}

function getHandler() {
  try {
    const { createAppwriteHandler, getConfig } = require('../mcp');
    const config = getConfig();
    if (config.apiKey && config.userId) {
      return createAppwriteHandler(config);
    }
  } catch {
    // Fall back to demo handler if mcp module cannot connect
  }
  return createFallbackHandler();
}

async function main() {
  const args = process.argv.slice(2);
  const isHttp = args.includes('--http');
  const handler = getHandler();

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

module.exports = { main, getHandler };
