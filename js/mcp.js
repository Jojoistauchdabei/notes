/* Federwerk MCP-Bridge: Login + Prompt über Notizen (curl-fähig).
 *
 * Idee (User-Wunsch: "mcp nur via prompt mit login und alles via curl"):
 * - Minimal-API statt vollem MCP-SDK: POST /mcp/login {user, pass} -> {token},
 *   danach Authorization: Bearer <token> für POST /mcp/prompt {prompt},
 *   POST /mcp/search {query}, POST /mcp/read {bookId}, GET /mcp/tools.
 * - Dieselbe Logik läuft an drei Stellen (eine Quelle):
 *   1) Browser (dieses Modul, window.FederwerkMCP) – sucht im lokalen State,
 *   2) Cloudflare Worker (worker.js) – prüft Bearer gegen env MCP_TOKEN,
 *   3) lokaler Node-Server (mcp-server.js) – gleiche Endpunkte via curl.
 * - Reine Helfer (verifyLogin, verifyToken, searchBooks, answerPrompt) sind
 *   DOM-frei und in Node testbar. Browser-Glue speichert die lokale
 *   MCP-Konfiguration ({user, pass, token}) in localStorage – das ist
 *   Komfortschutz für ein Single-User-Gerät, kein Ersatz für Server-Secrets
 *   (Worker: MCP_TOKEN als Secret, siehe MCP_CURL.md).
 */
(function () {
  'use strict';

  const LS_KEY = 'federwerkMcpV1';
  const DEFAULT_LIMIT = 3;

  const TOOLS = [
    { name: 'mcp.login', method: 'POST', path: '/mcp/login', body: '{user, pass}', auth: false },
    { name: 'mcp.prompt', method: 'POST', path: '/mcp/prompt', body: '{prompt, limit?}', auth: true },
    { name: 'mcp.search', method: 'POST', path: '/mcp/search', body: '{query, limit?}', auth: true },
    { name: 'mcp.read', method: 'POST', path: '/mcp/read', body: '{bookId}', auth: true },
    { name: 'mcp.tools', method: 'GET', path: '/mcp/tools', auth: false },
    { name: 'mcp.health', method: 'GET', path: '/mcp/health', auth: false },
  ];

  /* ---------- rein (testbar) ---------- */

  function norm(s) {
    return String(s ?? '').toLowerCase();
  }
  function stripTags(h) {
    return String(h ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function tokensOf(q) {
    return norm(q).split(/[^a-z0-9äöüß#]+/i).map((t) => t.trim()).filter((t) => t.length >= 2);
  }
  // Durchsuchbarer Text eines Buchs (Titel + Texte + Karten, ohne Bild-Bytes).
  function bookText(book) {
    const parts = [];
    try {
      if (book && book.title) parts.push(String(book.title));
      if (book && Array.isArray(book.pages)) {
        for (const p of book.pages) {
          if (!p) continue;
          if (Array.isArray(p.texts)) for (const t of p.texts) if (t && t.html) parts.push(stripTags(t.html));
        }
      }
      if (book && Array.isArray(book.cards)) {
        for (const c of book.cards) {
          if (!c) continue;
          if (c.front) parts.push(stripTags(c.front));
          if (c.back) parts.push(stripTags(c.back));
        }
      }
    } catch { /* ignore */ }
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
  // Relevanzsuche über Bücher (Titel x3, Text-/Karten-Treffer, OR über Tokens).
  function searchBooks(books, query, limit) {
    const toks = tokensOf(query);
    if (!toks.length || !Array.isArray(books)) return [];
    const out = [];
    for (const b of books) {
      if (!b || !b.id) continue;
      const title = norm(b.title || '');
      const text = norm(bookText(b));
      let score = 0;
      for (const t of toks) {
        if (title.includes(t)) score += 3;
        if (text.includes(t)) score += 2;
      }
      if (score > 0) {
        out.push({
          id: b.id,
          title: b.title || 'Unbenannt',
          score,
          pages: Array.isArray(b.pages) ? b.pages.length : 0,
          snippet: snippetFor(bookText(b), toks),
        });
      }
    }
    out.sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title), 'de'));
    const n = Math.max(1, Math.min(20, Number(limit) || DEFAULT_LIMIT));
    return out.slice(0, n);
  }
  // Prompt -> Antwort aus lokalen Treffern (kein LLM, kein Netz: zitiert Fundstellen).
  function answerPrompt(books, prompt, limit) {
    const hits = searchBooks(books, prompt, limit);
    if (!hits.length) {
      return {
        answer: 'Keine Treffer in deinen Notizen für: „' + String(prompt ?? '').slice(0, 200) + '“.',
        hits: [],
      };
    }
    const lines = hits.map((h, i) => (i + 1) + '. „' + h.title + '“ (' + h.pages + ' S., Score ' + h.score + '): ' + h.snippet);
    return {
      answer: 'Top-' + hits.length + ' Treffer zu „' + String(prompt ?? '').slice(0, 200) + '“:\n' + lines.join('\n'),
      hits,
    };
  }
  // Server-/Test-Login: exakter Vergleich gegen Konfiguration (Worker: Secrets).
  function verifyLogin(user, pass, cfg) {
    try {
      const c = cfg || {};
      if (!c.user || !c.pass) return false;
      return String(user || '') === String(c.user) && String(pass || '') === String(c.pass);
    } catch { return false; }
  }
  function verifyToken(token, cfg) {
    try {
      const c = cfg || {};
      const t = String(token || '').trim();
      if (!t || !c.token) return false;
      return t === String(c.token);
    } catch { return false; }
  }
  function bearerOf(headers) {
    try {
      const h = headers || {};
      const raw = h.authorization || h.Authorization || '';
      const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
      return m ? m[1].trim() : '';
    } catch { return ''; }
  }
  function randomToken(bytes) {
    const n = Math.max(16, Math.min(64, Number(bytes) || 32));
    try {
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        const a = new Uint8Array(n);
        crypto.getRandomValues(a);
        return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
      }
      if (typeof require === 'function') return require('crypto').randomBytes(n).toString('hex');
    } catch { /* Fallback unten */ }
    let s = '';
    while (s.length < n * 2) s += Math.random().toString(16).slice(2);
    return s.slice(0, n * 2);
  }

  const Mcp = {
    TOOLS, LS_KEY,
    norm, stripTags, tokensOf, bookText, snippetFor,
    searchBooks, answerPrompt,
    verifyLogin, verifyToken, bearerOf, randomToken,
  };

  /* ---------- Browser-Glue (lokale Config + Dialog) ---------- */

  function ls() {
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch { /* ignore */ }
    return null;
  }
  function loadCfg() {
    try {
      const s = ls();
      if (!s) return { user: '', pass: '', token: '' };
      const raw = s.getItem(LS_KEY);
      if (!raw) return { user: '', pass: '', token: '' };
      const p = JSON.parse(raw);
      // Passwort wird bewusst nicht persistiert (nur User + Token).
      return { user: String(p.user || ''), pass: '', token: String(p.token || '') };
    } catch { return { user: '', pass: '', token: '' }; }
  }
  function saveCfg(cfg) {
    try {
      const s = ls();
      if (s) s.setItem(LS_KEY, JSON.stringify({ user: cfg.user || '', token: cfg.token || '' }));
    } catch { /* ignore */ }
  }
  function getBooks() {
    try {
      if (typeof window !== 'undefined' && window.state && Array.isArray(window.state.books)) return window.state.books;
    } catch { /* ignore */ }
    return [];
  }
  function el(id) {
    try { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
    catch { return null; }
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function ensureSetup() {
    const cfg = loadCfg();
    if (!cfg.token) {
      cfg.token = randomToken(32);
      saveCfg(cfg);
    }
    return cfg;
  }
  // Lokaler Login (Appwrite-Session gilt alternativ als eingeloggt).
  function localLogin(user, pass) {
    try {
      const F = (typeof window !== 'undefined' && window.FederwerkFiles) ? window.FederwerkFiles : null;
      if (F && typeof F.loadSession === 'function') {
        const sess = F.loadSession();
        if (sess && (sess.secret || sess.userId)) return { ok: true, via: 'appwrite', token: ensureSetup().token };
      }
    } catch { /* weiter mit lokal */ }
    const cfg = ensureSetup();
    if (!cfg.user || !cfg.pass) {
      return { ok: false, error: 'Kein lokaler MCP-Zugang eingerichtet – unten User/Passwort setzen.' };
    }
    if (verifyLogin(user, pass, cfg)) return { ok: true, via: 'local', token: cfg.token };
    return { ok: false, error: 'Login falsch.' };
  }
  function localPrompt(prompt, token, limit) {
    const cfg = loadCfg();
    if (!verifyToken(token || (cfg && cfg.token), cfg)) {
      // Bequemlichkeit: ohne gesetzten Zugang antwortet die lokale Suche direkt.
      if (!cfg.user && !cfg.pass) return { answer: answerPrompt(getBooks(), prompt, limit).answer, hits: answerPrompt(getBooks(), prompt, limit).hits, auth: false };
      return { error: 'Ungültiger Token – bitte einloggen.', auth: false };
    }
    const r = answerPrompt(getBooks(), prompt, limit);
    return { answer: r.answer, hits: r.hits, auth: true };
  }

  function openDialog() {
    const ov = el('mcpOverlay');
    if (!ov) return;
    ov.style.display = 'flex';
    const cfg = loadCfg();
    const u = el('mcpUser'), p = el('mcpPass'), t = el('mcpToken');
    if (u && !u.value) u.value = cfg.user || '';
    if (p && !p.value) p.value = cfg.pass || '';
    if (t) t.textContent = cfg.token ? ('Token: ' + cfg.token.slice(0, 12) + '… (' + cfg.token.length + ' Zeichen)') : 'Noch kein Token – Einrichten klicken.';
  }
  function closeDialog() {
    const ov = el('mcpOverlay');
    if (ov) ov.style.display = 'none';
  }
  function setupAccess() {
    const u = el('mcpUser'), p = el('mcpPass');
    const msg = el('mcpMsg');
    const cfg = loadCfg();
    cfg.user = u ? String(u.value || '').trim() : cfg.user;
    cfg.pass = p ? String(p.value || '') : cfg.pass;
    if (!cfg.user || !cfg.pass) {
      if (msg) msg.textContent = 'Bitte User + Passwort setzen.';
      return null;
    }
    cfg.token = randomToken(32);
    saveCfg(cfg);
    if (msg) msg.textContent = 'Zugang eingerichtet – Token neu vergeben.';
    const t = el('mcpToken');
    if (t) t.textContent = 'Token: ' + cfg.token.slice(0, 12) + '… (' + cfg.token.length + ' Zeichen)';
    return cfg;
  }
  function doLogin() {
    const u = el('mcpUser'), p = el('mcpPass');
    const msg = el('mcpMsg');
    const r = localLogin(u ? u.value : '', p ? p.value : '');
    if (msg) msg.textContent = r.ok ? ('Login ok (' + r.via + '). Token freigeschaltet.') : ('Login fehlgeschlagen: ' + (r.error || ''));
    const out = el('mcpOut');
    if (out && r.ok) out.textContent = 'Bearer-Token (für curl):\n' + r.token;
    return r;
  }
  function doPrompt() {
    const q = el('mcpPrompt');
    const out = el('mcpOut');
    const msg = el('mcpMsg');
    const prompt = q ? String(q.value || '') : '';
    if (!prompt.trim()) {
      if (msg) msg.textContent = 'Bitte einen Prompt eingeben.';
      return null;
    }
    const cfg = loadCfg();
    const r = localPrompt(prompt, cfg.token, 5);
    if (r.error) {
      if (msg) msg.textContent = r.error;
      if (out) out.textContent = '';
      return r;
    }
    if (msg) msg.textContent = r.auth ? 'Prompt beantwortet (lokale Treffer, eingeloggt).' : 'Prompt beantwortet (ohne Zugang, lokal).';
    if (out) {
      out.textContent = r.answer + '\n\n--- curl ---\n' +
        'curl -s -X POST http://localhost:8787/mcp/prompt \\\n' +
        '  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \\\n' +
        '  -d \'{"prompt":' + JSON.stringify(prompt.slice(0, 120)) + '}\'';
    }
    return r;
  }

  if (typeof window !== 'undefined') {
    window.FederwerkMCP = Object.assign({}, Mcp, {
      loadCfg, saveCfg, localLogin, localPrompt,
      openDialog, closeDialog, setupAccess, doLogin, doPrompt,
    });
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = Mcp;
})();
