'use strict';
/* Doku-Routen des Workers: GET /agent (HTML) und GET /mcp (text/markdown).
 *
 * /mcp war früher ein Alias der Tool-Liste der Legacy-API – die Doku-Route hat
 * ihn jetzt belegt (API weiter unter /mcp/tools, /mcp/login, …). Ohne
 * Regressionstest käme das still zurück. */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

async function loadWorker() {
  // worker.js ist ein ES-Modul; der Test lädt es deshalb per data-URL-Import.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  return mod.default;
}

const FILES = {
  '/agent.html': { type: 'text/html', body: '<!DOCTYPE html><title>KI-Agent &amp; MCP</title>' },
  '/MCP_AI.md': { type: 'text/markdown', body: '# Federwerk MCP\n\n24 Tools\n' },
  '/index.html': { type: 'text/html', body: '<!DOCTYPE html><title>App</title>' },
};

function makeEnv() {
  return {
    MCP_TOKEN: 'test-token',
    ASSETS: {
      async fetch(req) {
        let p = new URL(req.url).pathname;
        if (p === '/') p = '/index.html';
        const f = FILES[p];
        if (!f) return new Response('Not found', { status: 404 });
        return new Response(f.body, { status: 200, headers: { 'Content-Type': f.type } });
      },
    },
  };
}

describe('worker/doku-routen', () => {
  it('/agent liefert die KI-Agent-Seite als HTML', async () => {
    const worker = await loadWorker();
    for (const p of ['/agent', '/agent/']) {
      const res = await worker.fetch(new Request('https://t.test' + p), makeEnv(), {});
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get('content-type') || '', /text\/html/);
      assert.match(await res.text(), /KI-Agent/);
    }
  });

  it('/mcp liefert die Anleitung als text/markdown', async () => {
    const worker = await loadWorker();
    const res = await worker.fetch(new Request('https://t.test/mcp'), makeEnv(), {});
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/markdown/);
    assert.match(await res.text(), /Federwerk MCP/);
  });

  it('/mcp beantwortet HEAD ohne Body', async () => {
    const worker = await loadWorker();
    const res = await worker.fetch(new Request('https://t.test/mcp', { method: 'HEAD' }), makeEnv(), {});
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
  });

  it('die Legacy-API bleibt unter /mcp/… erreichbar', async () => {
    const worker = await loadWorker();
    const tools = await worker.fetch(new Request('https://t.test/mcp/tools'), makeEnv(), {});
    assert.equal(tools.status, 200);
    assert.match(await tools.text(), /mcp\.login/);
    const health = await worker.fetch(new Request('https://t.test/mcp/health'), makeEnv(), {});
    assert.equal(health.status, 200);
    // Schreibende Route ohne Bearer bleibt geschützt.
    const search = await worker.fetch(new Request('https://t.test/mcp/search', { method: 'POST' }), makeEnv(), {});
    assert.equal(search.status, 401);
  });

  it('/ liefert weiterhin die App', async () => {
    const worker = await loadWorker();
    const res = await worker.fetch(new Request('https://t.test/'), makeEnv(), {});
    assert.equal(res.status, 200);
    assert.match(await res.text(), /App/);
  });
});

describe('doku-dateien', () => {
  const fs = require('node:fs');
  const path = require('node:path');
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
