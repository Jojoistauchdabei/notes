'use strict';
/* Doku-Routen des eigenen Servers: GET /agent (HTML) und GET /mcp
 * (text/markdown).
 *
 * Beide Adressen sind aelter als dieser Server. Sie bleiben gueltig, weil
 * Lesezeichen, Links und die Anleitungen selbst darauf zeigen.
 * Ohne Regressionstest faellt das still in den SPA-Fallback zurueck - dann
 * liefert /mcp die App statt der Anleitung. */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

let appDir = null;
let serveStatic = null;

before(() => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-doc-'));
  const dist = path.join(appDir, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'agent.html'), '<!DOCTYPE html><title>KI-Agent &amp; MCP</title>');
  fs.writeFileSync(path.join(dist, 'MCP_AI.md'), '# Federwerk MCP\n\n24 Tools\n');
  fs.writeFileSync(path.join(dist, 'index.html'), '<!DOCTYPE html><title>App</title>');
  // FW_APP_DIR wird beim Laden von server/index.js gelesen - deshalb erst hier
  // setzen und dann requiren.
  process.env.FW_APP_DIR = appDir;
  ({ serveStatic } = require('../server/index.js'));
});

after(() => {
  if (appDir) fs.rmSync(appDir, { recursive: true, force: true });
});

/* Kleiner Antwort-Faenger: serveStatic schreibt in einen Stream, den es fuer
 * einen http.ServerResponse haelt. Mehr als writeHead/pipe/end braucht es
 * nicht - und so laeuft der Test ohne echten Socket. */
function get(pathname) {
  const chunks = [];
  const res = new PassThrough();
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers || {}; };
  res.on('data', (c) => chunks.push(c));
  const hit = serveStatic(null, res, pathname);
  if (!hit) return Promise.resolve({ status: 404, headers: {}, body: '' });
  return new Promise((resolve) => res.on('end', () => resolve({
    status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'),
  })));
}

describe('server/doku-routen', () => {
  it('/agent liefert die KI-Agent-Seite als HTML', async () => {
    for (const p of ['/agent', '/agent/']) {
      const res = await get(p);
      assert.equal(res.status, 200, p);
      assert.match(res.headers['Content-Type'], /text\/html/, p);
      assert.match(res.body, /KI-Agent/, p);
    }
  });

  it('/mcp liefert die Anleitung als text/markdown', async () => {
    const res = await get('/mcp');
    assert.equal(res.status, 200);
    assert.match(res.headers['Content-Type'], /text\/markdown/);
    assert.match(res.body, /Federwerk MCP/);
  });

  it('/ liefert weiterhin die App', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.match(res.body, /App/);
  });

  it('unbekannte Pfade ohne Endung sind kein Treffer (SPA-Fallback im Aufrufer)', () => {
    assert.equal(serveStatic(null, new PassThrough(), '/gibtsnicht'), false);
  });

  it('setzt die Header, die frueher die CDN-Konfiguration gesetzt hat', async () => {
    const res = await get('/agent');
    assert.equal(res.headers['X-Frame-Options'], 'DENY');
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(res.headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
  });
});

describe('doku-dateien', () => {
  const root = path.join(__dirname, '..');

  it('agent.html verlinkt die KI-Anleitung und zurück in die App', () => {
    const html = fs.readFileSync(path.join(root, 'agent.html'), 'utf8');
    // Relative Links, damit die Seite auch aus Tauri/file:// funktioniert;
    // die kanonische Online-Adresse /mcp wird per JS eingesetzt.
    assert.match(html, /href="MCP_AI\.md"/, 'Link auf die KI-Anleitung');
    assert.match(html, /location\.origin/, 'Online-Adresse aus location.origin');
    assert.match(html, /id="originMcp"/, 'Anzeige der kanonischen /mcp-Adresse');
    assert.match(html, /href="\.\/"/, 'Link zurück zur App');
    assert.match(html, /login\.js/, 'Einrichtungsbefehl genannt');
  });

  it('MCP_AI.md beschreibt Installation, Anmeldung und alle Tools', () => {
    const md = fs.readFileSync(path.join(root, 'MCP_AI.md'), 'utf8');
    assert.match(md, /login\.js/);
    assert.match(md, /mcpServers/);
    for (const tool of ['session_info', 'login', 'logout', 'create_document', 'create_deck',
      'review_card', 'deck_stats', 'advanced_search', 'get_graph', 'delete_folder']) {
      assert.ok(md.includes('`' + tool + '`'), 'Tool ' + tool + ' dokumentiert');
    }
    assert.match(md, /Passwort/, 'Passwort-Hinweis');
  });

  it('die App verlinkt auf die Agent-Seite', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(html, /href="agent\.html"/);
  });
});
