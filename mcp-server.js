#!/usr/bin/env node
/* Federwerk lokaler MCP-Server (curl-fähig, ohne Dependencies).
 *
 *   node mcp-server.js --port 8787 --user jonas --pass geheim --token abc123 \
 *     --file grimoire-export.json
 *
 * Endpunkte (identisch zum Cloudflare-Worker worker.js):
 *   GET  /mcp/health                 (offen)
 *   GET  /mcp/tools                  (offen)
 *   POST /mcp/login   {user, pass}   -> {token} | 401
 *   POST /mcp/search  {query, limit?} (Bearer) -> {hits}
 *   POST /mcp/read    {bookId}        (Bearer) -> {id, title, text}
 *   POST /mcp/prompt  {prompt, limit?} (Bearer) -> {answer, hits}
 *
 * Notizquelle: Export-JSON (Gesamt-Export {books} oder Einzelbuch {pages}).
 * Ohne --file antwortet die Suche mit leerer Trefferliste statt Fehler.
 * Token: --token oder automatisch generiert (wird beim Start ausgegeben).
 * Über curl: siehe MCP_CURL.md.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

let Mcp = null;
try {
  Mcp = require('./js/mcp.js');
} catch (e) {
  console.error('js/mcp.js fehlt:', e.message);
  process.exit(1);
}

function arg(name, fallback) {
  const ix = process.argv.indexOf('--' + name);
  if (ix >= 0 && process.argv[ix + 1] && !process.argv[ix + 1].startsWith('--')) return process.argv[ix + 1];
  const pref = process.argv.find((a) => a.startsWith('--' + name + '='));
  if (pref) return pref.slice(name.length + 3);
  return fallback;
}

const PORT = Number(arg('port', process.env.MCP_PORT || '8787')) || 8787;
const HOST = String(arg('host', process.env.MCP_HOST || '127.0.0.1'));
const USER = String(arg('user', process.env.MCP_USER || 'federwerk') || '');
const PASS = String(arg('pass', process.env.MCP_PASS || '') || '');
const FILE = arg('file', process.env.MCP_FILE || '');
let TOKEN = String(arg('token', process.env.MCP_TOKEN || '') || '');
if (!TOKEN) TOKEN = Mcp.randomToken(32);

function loadBooks() {
  if (!FILE) return [];
  try {
    const p = path.isAbsolute(FILE) ? FILE : path.join(process.cwd(), FILE);
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    if (Array.isArray(j.books)) return j.books;
    if (Array.isArray(j.pages)) return [{ id: j.id || 'book', title: j.title || 'Import', pages: j.pages, cards: j.cards || [] }];
    if (j && j.id && Array.isArray(j.pages)) return [j];
    return [];
  } catch (e) {
    console.error('WARN: --file nicht lesbar (' + e.message + '), leere Bibliothek.');
    return [];
  }
}

const CORS_ORIGIN = String(process.env.MCP_ALLOW_ORIGIN || '').trim();
function corsHeaders() {
  if (!CORS_ORIGIN || CORS_ORIGIN === '*') return {};
  return {
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
  };
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body),
  }, corsHeaders()));
  res.end(body);
}
function timingSafeEqual(a, b) {
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_TRIES = 8;
const loginAttempts = new Map();
function clientKey(req) { return String(req.socket && req.socket.remoteAddress || 'local').slice(0, 64); }
function tooManyLogins(key) {
  const now = Date.now();
  const rec = loginAttempts.get(key);
  if (!rec || now - rec.since > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, since: now });
    return false;
  }
  if (loginAttempts.size > 5000) loginAttempts.clear();
  rec.count++;
  return rec.count > LOGIN_MAX_TRIES;
}
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (maxBytes || 1024 * 1024)) {
        reject(new Error('Payload zu groß'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Ungültiges JSON')); }
    });
    req.on('error', reject);
  });
}
function bearerOf(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1].trim() : '';
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    const m = req.method.toUpperCase();
    if (m === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    if (p === '/mcp/health' && m === 'GET') {
      return send(res, 200, { ok: true, service: 'federwerk-mcp', time: new Date().toISOString(), books: loadBooks().length, hasFile: !!FILE });
    }
    if ((p === '/mcp/tools' || p === '/mcp') && m === 'GET') {
      return send(res, 200, { tools: Mcp.TOOLS });
    }
    if (p === '/mcp/login' && m === 'POST') {
      const key = clientKey(req);
      if (tooManyLogins(key)) return send(res, 429, { error: 'Zu viele Login-Versuche – bitte später erneut probieren.' });
      const body = await readBody(req).catch(() => null);
      if (!body) return send(res, 400, { error: 'Ungültiges JSON' });
      if (!PASS) return send(res, 503, { error: 'Kein Passwort konfiguriert (--pass …)' });
      const okUser = timingSafeEqual(body.user, USER);
      const okPass = timingSafeEqual(body.pass, PASS);
      if (okUser && okPass) {
        loginAttempts.delete(key);
        return send(res, 200, { token: TOKEN });
      }
      return send(res, 401, { error: 'Login falsch' });
    }
    // Ab hier: Bearer-Pflicht.
    if (!timingSafeEqual(bearerOf(req), TOKEN)) {
      return send(res, 401, { error: 'Ungültiger oder fehlender Bearer-Token (POST /mcp/login)' });
    }
    const books = loadBooks();
    if (p === '/mcp/search' && m === 'POST') {
      const body = await readBody(req).catch(() => null);
      if (!body) return send(res, 400, { error: 'Ungültiges JSON' });
      return send(res, 200, { hits: Mcp.searchBooks(books, body.query || '', body.limit) });
    }
    if (p === '/mcp/read' && m === 'POST') {
      const body = await readBody(req).catch(() => null);
      if (!body || !body.bookId) return send(res, 400, { error: 'bookId fehlt' });
      const b = books.find((x) => x && x.id === String(body.bookId));
      if (!b) return send(res, 404, { error: 'Buch nicht gefunden' });
      return send(res, 200, { id: b.id, title: b.title || '', pages: Array.isArray(b.pages) ? b.pages.length : 0, text: Mcp.bookText(b).slice(0, 8000) });
    }
    if (p === '/mcp/prompt' && m === 'POST') {
      const body = await readBody(req).catch(() => null);
      if (!body || !String(body.prompt || '').trim()) return send(res, 400, { error: 'prompt fehlt' });
      const r = Mcp.answerPrompt(books, body.prompt, body.limit);
      return send(res, 200, r);
    }
    return send(res, 404, { error: 'Unbekannte MCP-Route', tools: Mcp.TOOLS });
  } catch (e) {
    return send(res, 500, { error: 'Server-Fehler' });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('Federwerk MCP-Server läuft auf http://' + HOST + ':' + PORT);
    if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
      console.log('  WARNUNG: an ' + HOST + ' gebunden – damit im Netzwerk erreichbar.');
    }
    console.log('  User:  ' + (USER || '(–)'));
    console.log('  Token: ' + TOKEN);
    console.log('  Datei: ' + (FILE || '(keine – leere Bibliothek)'));
    console.log('Doku: MCP_CURL.md');
  });
}

module.exports = server;
