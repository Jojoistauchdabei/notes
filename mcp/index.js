'use strict';

let createMcpHandler;
let PROTOCOL_VERSION = '2024-11-05';
try {
  ({ createMcpHandler, PROTOCOL_VERSION } = require('../mcpserver'));
} catch {
  try {
    ({ createMcpHandler, PROTOCOL_VERSION } = require('./mcpserver'));
  } catch {
    ({ createMcpHandler, PROTOCOL_VERSION } = require('@federwerk/mcpserver'));
  }
}

function getConfig() {
  return {
    endpoint: process.env.APPWRITE_ENDPOINT || 'https://fra.cloud.appwrite.io/v1',
    projectId: process.env.APPWRITE_PROJECT_ID || '6ab0067c00244c28560a',
    databaseId: process.env.APPWRITE_DATABASE_ID || 'federwerk',
    notesTableId: process.env.APPWRITE_NOTES_TABLE_ID || 'notes',
    foldersTableId: process.env.APPWRITE_FOLDERS_TABLE_ID || 'folders',
    bucketId: process.env.APPWRITE_BUCKET_ID || 'attachments',
    apiKey: process.env.APPWRITE_API_KEY,
    userId: process.env.APPWRITE_USER_ID,
    token: process.env.MCP_TOKEN,
  };
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const target = name.toLowerCase();
  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() === target && typeof val === 'string') return val;
  }
  return '';
}

function authValue(headers) {
  const auth = getHeader(headers, 'authorization');
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return getHeader(headers, 'x-mcp-token').trim();
}

function requireConfig(config, headers) {
  if (!config.apiKey || !config.userId) {
    throw new Error('APPWRITE_API_KEY and APPWRITE_USER_ID are required');
  }
  if (config.token && authValue(headers) !== config.token) {
    throw new Error('Unauthorized');
  }
}

function query(method, values, attribute) {
  return JSON.stringify({
    method,
    ...(values && values.length ? { values } : {}),
    ...(attribute ? { attribute } : {}),
  });
}

async function appwriteRequest(config, path, queries = [], method = 'GET', bodyData = null) {
  const url = new URL(config.endpoint.replace(/\/$/, '') + path);
  queries.forEach((value, index) => url.searchParams.set(`queries[${index}]`, value));
  const headers = {
    'X-Appwrite-Project': config.projectId,
    'X-Appwrite-Key': config.apiKey,
    'X-Appwrite-Response-Format': '2.0.0',
    'Content-Type': 'application/json',
  };
  const options = { method, headers };
  if (bodyData !== null && bodyData !== undefined) {
    options.body = typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData);
  }
  const response = await fetch(url, options);
  const bodyText = await response.text();
  let data;
  try {
    data = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    data = { message: bodyText };
  }
  if (!response.ok) {
    const err = new Error(`Appwrite ${response.status}: ${(data && data.message) || 'request failed'}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function fetchTableRows(config, tableId, queries = []) {
  const primaryPath = `/tablesdb/${encodeURIComponent(config.databaseId)}/tables/${encodeURIComponent(tableId)}/rows`;
  try {
    return await appwriteRequest(config, primaryPath, queries);
  } catch (err) {
    if (err.status === 404) {
      const fallbackPath = `/databases/${encodeURIComponent(config.databaseId)}/tables/${encodeURIComponent(tableId)}/rows`;
      try {
        return await appwriteRequest(config, fallbackPath, queries);
      } catch (err2) {
        if (err2.status === 404) {
          const docPath = `/databases/${encodeURIComponent(config.databaseId)}/collections/${encodeURIComponent(tableId)}/documents`;
          return await appwriteRequest(config, docPath, queries);
        }
        throw err2;
      }
    }
    throw err;
  }
}

async function fetchTableRow(config, tableId, rowId) {
  const primaryPath = `/tablesdb/${encodeURIComponent(config.databaseId)}/tables/${encodeURIComponent(tableId)}/rows/${encodeURIComponent(rowId)}`;
  try {
    return await appwriteRequest(config, primaryPath);
  } catch (err) {
    if (err.status === 404) {
      const fallbackPath = `/databases/${encodeURIComponent(config.databaseId)}/tables/${encodeURIComponent(tableId)}/rows/${encodeURIComponent(rowId)}`;
      try {
        return await appwriteRequest(config, fallbackPath);
      } catch (err2) {
        if (err2.status === 404) {
          const docPath = `/databases/${encodeURIComponent(config.databaseId)}/collections/${encodeURIComponent(tableId)}/documents/${encodeURIComponent(rowId)}`;
          return await appwriteRequest(config, docPath);
        }
        throw err2;
      }
    }
    throw err;
  }
}

async function resolveNoteContent(config, row) {
  if (!row) return row;
  if (!row.content && row.contentFileId) {
    try {
      const bucketId = config.bucketId || 'attachments';
      const fileUrl = `${config.endpoint.replace(/\/$/, '')}/storage/buckets/${encodeURIComponent(bucketId)}/files/${encodeURIComponent(row.contentFileId)}/download`;
      const res = await fetch(fileUrl, {
        headers: {
          'X-Appwrite-Project': config.projectId,
          'X-Appwrite-Key': config.apiKey,
        },
      });
      if (res.ok) {
        row.content = await res.text();
      }
    } catch {
      // Content download failure leaves metadata intact
    }
  }
  return row;
}

function isLiveRow(row) {
  if (!row) return false;
  if (row.deletedAt) return false;
  if (row.deleted === true || row.deleted === 1) return false;
  if (row.title === '(gelöscht)') return false;
  return true;
}

async function rows(config, tableId, additionalQueries = []) {
  const result = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const queries = [
      query('limit', [100]),
      query('equal', [config.userId], 'userId'),
      ...additionalQueries,
    ];
    if (cursor) queries.push(query('cursorAfter', [cursor]));
    const data = await fetchTableRows(config, tableId, queries);
    const pageRows = Array.isArray(data && (data.rows || data.documents))
      ? (data.rows || data.documents)
      : [];
    result.push(...pageRows);
    if (pageRows.length < 100) break;
    cursor = pageRows[pageRows.length - 1].$id || pageRows[pageRows.length - 1].id;
  }
  return result;
}

function createAppwriteHandler(config) {
  return createMcpHandler({
    listDocuments: async (limit = 100, folderId = null, opts = {}) => {
      const max = Math.min(Math.max(Number(limit) || 100, 1), 100);
      const targetFolder = folderId || (opts && opts.folderId);
      const extra = [query('orderAsc', [], 'updatedAt')];
      if (targetFolder) {
        extra.push(query('equal', [targetFolder], 'folderId'));
      }
      const all = await rows(config, config.notesTableId, extra);
      return all.filter(isLiveRow).slice(0, max);
    },
    getDocument: async (id) => {
      const row = await fetchTableRow(config, config.notesTableId, id);
      if (!row || row.userId !== config.userId) {
        throw new Error('Document not found');
      }
      if (!isLiveRow(row)) {
        throw new Error('Document has been deleted');
      }
      return await resolveNoteContent(config, row);
    },
    listFolders: async () => {
      const all = await rows(config, config.foldersTableId, [query('orderAsc', [], '$updatedAt')]);
      return all.filter(isLiveRow);
    },
    searchDocuments: async (text, limit = 100) => {
      const needle = String(text || '').trim().toLowerCase();
      if (!needle) return [];
      const max = Math.min(Math.max(Number(limit) || 100, 1), 100);
      const all = await rows(config, config.notesTableId);
      return all
        .filter(row => isLiveRow(row) && (
          String(row.title || '').toLowerCase().includes(needle) ||
          String(row.content || '').toLowerCase().includes(needle)
        ))
        .slice(0, max);
    },
  });
}

function parseBody(req) {
  if (!req) return null;
  if (req.bodyJson && typeof req.bodyJson === 'object') return req.bodyJson;
  if (req.body && typeof req.body === 'object') return req.body;
  const raw = typeof req.bodyText === 'string' ? req.bodyText : (typeof req.body === 'string' ? req.body : null);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return req;
}

async function main(context = {}, resArg) {
  let req, res, log, error;
  if (resArg !== undefined || (context && context.headers && !context.req)) {
    req = context;
    res = resArg;
    log = console.log;
    error = console.error;
  } else {
    req = context.req;
    res = context.res;
    log = context.log || console.log;
    error = context.error || console.error;
  }

  const safeRes = {
    json: (data, status = 200, headers = {}) => {
      if (res && typeof res.json === 'function') {
        return res.json(data, status, { 'Access-Control-Allow-Origin': '*', ...headers });
      }
      return { status, body: data, headers };
    },
    empty: () => {
      if (res && typeof res.empty === 'function') return res.empty();
      if (res && typeof res.text === 'function') return res.text('', 204);
      return { status: 204 };
    },
    text: (str, status = 200, headers = {}) => {
      if (res && typeof res.text === 'function') {
        return res.text(str, status, { 'Access-Control-Allow-Origin': '*', ...headers });
      }
      return { status, body: str, headers };
    },
  };

  const method = (req && req.method ? String(req.method) : 'POST').toUpperCase();
  if (method === 'OPTIONS') {
    return safeRes.text('', 204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-MCP-Token, X-Appwrite-Project',
    });
  }

  if (method === 'GET') {
    return safeRes.json({
      status: 'ok',
      service: 'federwerk-mcp',
      description: 'Federwerk Model Context Protocol (MCP) server running on Appwrite Functions',
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  const config = getConfig();

  try {
    requireConfig(config, req && req.headers);
    const handler = createAppwriteHandler(config);
    const result = await handler(parseBody(req));
    if (result === null || result === undefined) return safeRes.empty();
    return safeRes.json(result);
  } catch (err) {
    if (typeof error === 'function') error(err.message || String(err));
    const isAuth = err.message === 'Unauthorized';
    const status = isAuth ? 401 : 500;
    return safeRes.json({
      jsonrpc: '2.0',
      id: null,
      error: { code: isAuth ? -32001 : -32000, message: err.message },
    }, status);
  }
}

main.main = main;
main.getConfig = getConfig;
main.createAppwriteHandler = createAppwriteHandler;
main.requireConfig = requireConfig;
main.parseBody = parseBody;
main.authValue = authValue;

module.exports = main;
