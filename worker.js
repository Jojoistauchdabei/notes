/* Federwerk MCP-Worker (Cloudflare): Prompt + Login, alles via curl.
 *
 * Routen (öffentlich): GET /mcp/health, GET /mcp/tools, POST /mcp/login
 * Routen (Bearer): POST /mcp/prompt, POST /mcp/search, POST /mcp/read
 * Alles andere -> Static Assets (dist/, siehe wrangler.toml).
 *
 * Secrets (wrangler secret put): MCP_USER, MCP_PASS, MCP_TOKEN.
 * Optional für echte Notizsuche in der Cloud: APPWRITE_ENDPOINT,
 * APPWRITE_PROJECT_ID, APPWRITE_DATABASE_ID, APPWRITE_API_KEY
 * (Tabellen `notes`: $id/title/content/updatedAt). Ohne Appwrite antwortet
 * die API mit 503 + Hinweis auf den lokalen Server (mcp-server.js).
 *
 * SICHERHEIT (Mehrnutzer): MCP_TOKEN allein scopet NICHT pro Nutzer – wer ihn
 * besitzt, liest per APPWRITE_API_KEY alle Notizen. Für Einzelnutzer-
 * Deployments ist das ok. Sobald mehrere Personen dieselbe Worker-Instanz /
 * denselben Appwrite-Datenbestand nutzen, UNBEDINGT zusätzlich MCP_USER_ID
 * (oder APPWRITE_USER_ID) setzen: Suche/Lesen werden dann auf diese
 * Appwrite-userId gefiltert (Query + Nachfilter + Einzel-Check, fremde Rows
 * -> 404). Ohne dieses Scoping ist der Worker nur für Einzelnutzer sicher.
 *
 * Lokal testen: npx wrangler dev --test-scheduled? Nein: `wrangler dev`
 * und curl gegen http://localhost:8787/mcp/health.
 */

// Kleine, abhängigkeitsfreie Duplikate aus js/mcp.js (Worker-Bundle ohne Build).
function norm(s) { return String(s ?? '').toLowerCase(); }
function stripTags(h) { return String(h ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
function tokensOf(q) {
  return norm(q).split(/[^a-z0-9äöüß#]+/i).map((t) => t.trim()).filter((t) => t.length >= 2);
}
function rowText(r) {
  const parts = [];
  if (r && r.title) parts.push(String(r.title));
  const c = r && r.content != null ? String(r.content) : '';
  if (c) {
    try {
      const p = JSON.parse(c);
      if (p && Array.isArray(p.pages)) {
        for (const pg of p.pages) {
          if (pg && Array.isArray(pg.texts)) for (const t of pg.texts) if (t && t.html) parts.push(stripTags(t.html));
        }
      } else {
        parts.push(stripTags(c).slice(0, 4000));
      }
    } catch {
      parts.push(stripTags(c).slice(0, 4000));
    }
  }
  return parts.join('\n');
}
function snippetFor(text, tokens, maxLen) {
  maxLen = maxLen || 160;
  const low = norm(text);
  let ix = -1;
  for (const t of tokens) {
    const i = low.indexOf(t);
    if (i >= 0 && (ix < 0 || i < ix)) ix = i;
  }
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLen) return flat;
  if (ix < 0) return flat.slice(0, maxLen) + ' …';
  const from = Math.max(0, ix - 60);
  return (from > 0 ? '… ' : '') + flat.slice(from, from + maxLen) + ' …';
}
function searchRows(rows, query, limit) {
  const toks = tokensOf(query);
  if (!toks.length) return [];
  const out = [];
  for (const r of rows || []) {
    const title = norm(r.title || '');
    const text = norm(rowText(r));
    let score = 0;
    for (const t of toks) {
      if (title.includes(t)) score += 3;
      if (text.includes(t)) score += 2;
    }
    if (score > 0) {
      out.push({ id: r.$id || r.id, title: r.title || 'Unbenannt', score, snippet: snippetFor(rowText(r), toks) });
    }
  }
  out.sort((a, b) => b.score - a.score);
  const n = Math.max(1, Math.min(20, Number(limit) || 3));
  return out.slice(0, n);
}

const TOOLS = [
  { name: 'mcp.login', method: 'POST', path: '/mcp/login', body: '{user, pass}', auth: false },
  { name: 'mcp.prompt', method: 'POST', path: '/mcp/prompt', body: '{prompt, limit?}', auth: true },
  { name: 'mcp.search', method: 'POST', path: '/mcp/search', body: '{query, limit?}', auth: true },
  { name: 'mcp.read', method: 'POST', path: '/mcp/read', body: '{bookId}', auth: true },
  { name: 'mcp.tools', method: 'GET', path: '/mcp/tools', auth: false },
  { name: 'mcp.health', method: 'GET', path: '/mcp/health', auth: false },
];

const CORS_ORIGIN = '*';
function corsHeaders(env) {
  // CORS standardmaessig aus: MCP wird per curl/Server-to-Server genutzt.
  // Opt-in ueber Secret/Var MCP_ALLOW_ORIGIN (exakter Origin, kein Wildcard).
  const allow = env && env.MCP_ALLOW_ORIGIN ? String(env.MCP_ALLOW_ORIGIN).trim() : '';
  const h = {};
  if (allow && allow !== CORS_ORIGIN) {
    h['Access-Control-Allow-Origin'] = allow;
    h['Vary'] = 'Origin';
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}
function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, corsHeaders(env)),
  });
}
function timingSafeEqual(a, b) {
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_TRIES = 8;
const loginAttempts = new Map();
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
function clearLogins(key) { loginAttempts.delete(key); }
function bearerOf(req) {
  try {
    const h = req.headers.get('authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    return m ? m[1].trim() : '';
  } catch { return ''; }
}
async function readJson(req, maxBytes) {
  const limit = maxBytes || 64 * 1024;
  const len = Number(req.headers.get('content-length') || 0);
  if (len > limit) throw new Error('Payload zu groß');
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > limit) throw new Error('Payload zu groß');
  if (!raw) return {};
  return JSON.parse(raw);
}
function appwriteCfg(env) {
  const e = env || {};
  if (e.APPWRITE_ENDPOINT && e.APPWRITE_PROJECT_ID && e.APPWRITE_DATABASE_ID && e.APPWRITE_API_KEY) {
    return {
      endpoint: String(e.APPWRITE_ENDPOINT).replace(/\/$/, ''),
      projectId: e.APPWRITE_PROJECT_ID,
      databaseId: e.APPWRITE_DATABASE_ID,
      apiKey: e.APPWRITE_API_KEY,
    };
  }
  return null;
}
async function fetchNotes(cfg, limit, userId) {
  const n = Math.max(1, Math.min(100, Number(limit) || 50));
  const q = [
    JSON.stringify({ method: 'limit', values: [n] }),
    JSON.stringify({ method: 'orderDesc', attribute: 'updatedAt' }),
  ];
  // Nutzer-Scope (Mehrnutzer-Deployments): nur eigene Rows vom Server holen.
  // Ohne Scope (Einzelnutzer-Deployment) bleibt das Verhalten wie bisher.
  if (userId) q.push(JSON.stringify({ method: 'equal', attribute: 'userId', values: [userId] }));
  const qs = q.map((p, i) => 'queries[' + i + ']=' + encodeURIComponent(p)).join('&');
  const url = cfg.endpoint + '/tablesdb/' + cfg.databaseId + '/tables/notes/rows?' + qs;
  const r = await fetch(url, {
    headers: {
      'X-Appwrite-Project': cfg.projectId,
      'X-Appwrite-Key': cfg.apiKey,
      'X-Appwrite-Response-Format': '2.0.0',
    },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j && j.message) || ('Appwrite HTTP ' + r.status));
  const rows = (j && (j.rows || j.documents)) || [];
  // Nachfilter (Defense in Depth, falls die Query je ignoriert wird).
  return userId ? rows.filter((row) => row && row.userId === userId) : rows;
}
function notFound(msg) {
  return Object.assign(new Error(msg || 'Notiz nicht gefunden'), { status: 404 });
}
async function fetchNote(cfg, id, userId) {
  const url = cfg.endpoint + '/tablesdb/' + cfg.databaseId + '/tables/notes/rows/' + encodeURIComponent(id);
  const r = await fetch(url, {
    headers: {
      'X-Appwrite-Project': cfg.projectId,
      'X-Appwrite-Key': cfg.apiKey,
      'X-Appwrite-Response-Format': '2.0.0',
    },
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 404) throw notFound();
  if (!r.ok) throw new Error((j && j.message) || ('Appwrite HTTP ' + r.status));
  // Einzel-Check: fremde Row -> 404 (kein Unterschied zu „nicht vorhanden").
  if (userId && j && j.userId && j.userId !== userId) throw notFound();
  if (userId && j && !j.userId) throw notFound();
  return j;
}
// Optionales Nutzer-Scope: MCP_USER_ID (oder APPWRITE_USER_ID, wie die
// Appwrite Function in mcp/). Leer = Einzelnutzer-Deployment (alle Rows).
function mcpUserScope(env) {
  const v = (env && (env.MCP_USER_ID || env.APPWRITE_USER_ID)) || '';
  return String(v).trim();
}

async function handleMcp(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  if (path === '/mcp/health' && method === 'GET') {
    const aw = appwriteCfg(env);
    return json({ ok: true, service: 'federwerk-mcp', time: new Date().toISOString(), notesSource: aw ? 'appwrite' : 'none', scoped: !!mcpUserScope(env) }, 200, env);
  }
  if (path === '/mcp/tools' && method === 'GET') {
    return json({ tools: TOOLS }, 200, env);
  }
  if (path === '/mcp/login' && method === 'POST') {
    const ip = (request.headers.get('cf-connecting-ip') || 'local').slice(0, 64);
    if (tooManyLogins(ip)) {
      return json({ error: 'Zu viele Login-Versuche – bitte später erneut probieren.' }, 429, env);
    }
    const body = await readJson(request).catch(() => null);
    if (!body) return json({ error: 'Ungültiges JSON' }, 400, env);
    const user = String(body.user || ''), pass = String(body.pass || '');
    if (!env.MCP_USER || !env.MCP_PASS || !env.MCP_TOKEN) {
      return json({ error: 'MCP-Login am Server nicht konfiguriert (Secrets MCP_USER/MCP_PASS/MCP_TOKEN fehlen)' }, 503, env);
    }
    const okUser = timingSafeEqual(user, String(env.MCP_USER));
    const okPass = timingSafeEqual(pass, String(env.MCP_PASS));
    if (okUser && okPass) {
      clearLogins(ip);
      return json({ token: String(env.MCP_TOKEN) }, 200, env);
    }
    return json({ error: 'Login falsch' }, 401, env);
  }

  // Ab hier: Bearer-Pflicht.
  if (!env.MCP_TOKEN) return json({ error: 'MCP_TOKEN fehlt (Server nicht konfiguriert)' }, 503, env);
  if (!timingSafeEqual(bearerOf(request), String(env.MCP_TOKEN))) {
    return json({ error: 'Ungültiger oder fehlender Bearer-Token' }, 401, env);
  }
  const aw = appwriteCfg(env);
  if (!aw) {
    return json({ error: 'Keine Notizquelle konfiguriert – lokalen Server nutzen: node mcp-server.js --file grimoire-export.json (siehe MCP_CURL.md)' }, 503, env);
  }

  if (path === '/mcp/search' && method === 'POST') {
    const body = await readJson(request).catch(() => null);
    if (!body) return json({ error: 'Ungültiges JSON' }, 400, env);
    const rows = await fetchNotes(aw, 100, mcpUserScope(env)).catch(() => null);
    if (!rows) return json({ error: 'Appwrite-Abfrage fehlgeschlagen' }, 502, env);
    return json({ hits: searchRows(rows, body.query || '', body.limit) }, 200, env);
  }
  if (path === '/mcp/read' && method === 'POST') {
    const body = await readJson(request).catch(() => null);
    if (!body || !body.bookId) return json({ error: 'bookId fehlt' }, 400, env);
    try {
      const row = await fetchNote(aw, String(body.bookId), mcpUserScope(env));
      return json({ id: row.$id, title: row.title || '', updatedAt: row.updatedAt || null, text: rowText(row).slice(0, 8000) }, 200, env);
    } catch (e) {
      if (e && e.status === 404) return json({ error: 'Notiz nicht gefunden' }, 404, env);
      return json({ error: 'Lesen fehlgeschlagen' }, 502, env);
    }
  }
  if (path === '/mcp/prompt' && method === 'POST') {
    const body = await readJson(request).catch(() => null);
    if (!body || !String(body.prompt || '').trim()) return json({ error: 'prompt fehlt' }, 400, env);
    const rows = await fetchNotes(aw, 100, mcpUserScope(env)).catch(() => null);
    if (!rows) return json({ error: 'Appwrite-Abfrage fehlgeschlagen' }, 502, env);
    const hits = searchRows(rows, body.prompt, body.limit);
    const answer = hits.length
      ? 'Top-' + hits.length + ' Treffer zu „' + String(body.prompt).slice(0, 200) + '“:\n' +
        hits.map((h, i) => (i + 1) + '. „' + h.title + '“: ' + h.snippet).join('\n')
      : 'Keine Treffer in den Cloud-Notizen für: „' + String(body.prompt).slice(0, 200) + '“.';
    return json({ answer, hits }, 200, env);
  }
  return json({ error: 'Unbekannte MCP-Route', tools: TOOLS }, 404, env);
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
        return handleMcp(request, env);
      }
      if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
        return env.ASSETS.fetch(request);
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return json({ error: 'Worker-Fehler: ' + (e && e.message) }, 500, env);
    }
  },
};
