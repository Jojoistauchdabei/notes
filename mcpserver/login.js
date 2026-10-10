#!/usr/bin/env node
'use strict';
/* Federwerk MCP-Login: holt eine Server-Session (Cookie) für die App.
 *
 *   node mcpserver/login.js --email DU@BEISPIEL.DE           # einmalig: Session
 *   node mcpserver/login.js --email … --save                # + Credentials merken
 *   node mcpserver/login.js --status                        # nur prüfen
 *   node mcpserver/login.js --logout --session <COOKIE>     # Session widerrufen
 *
 * Zwei Betriebsarten für den MCP-Server:
 *  1) Credentials (E-Mail + Passwort) – der MCP meldet sich beim Start selbst
 *     an, merkt sich das HttpOnly-Cookie `fw_session` und meldet sich bei 401
 *     automatisch erneut an. Quelle: Env FEDERWERK_EMAIL/FEDERWERK_PASSWORD
 *     oder die Credentials-Datei (siehe `credentialsPath`).
 *  2) Fertiges FEDERWERK_SESSION (Cookie-Wert) – ohne Passwort, vom Nutzer gesetzt.
 *
 * Die Credentials-Datei ist ein Nur-Lese-Secret (chmod 600, außerhalb des
 * Repos). Passwörter gehören NIE als Tool-Argument in den LLM-Kontext –
 * `login`/`logout` arbeiten deshalb nur mit dem Store.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const DEFAULT_URL = 'http://127.0.0.1:8080';
const COOKIE = 'fw_session';

// ~/.config/federwerk/mcp-credentials.json – bewusst außerhalb des Repos.
function credentialsPath() {
  const override = process.env.MCP_CREDENTIALS_FILE
    || process.argv.find((a) => a.startsWith('--credentials='));
  if (override) return String(override.startsWith('--credentials=') ? override.slice(14) : override).trim();
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir() || '.', '.config');
  return path.join(base, 'federwerk', 'mcp-credentials.json');
}

// {url, email, password} – nie Exceptions, nie Logs.
function loadCredentials() {
  const env = {
    url: String(process.env.FEDERWERK_URL || '').trim(),
    email: String(process.env.FEDERWERK_EMAIL || '').trim(),
    password: String(process.env.FEDERWERK_PASSWORD || ''),
  };
  let raw = null;
  try { raw = fs.readFileSync(credentialsPath(), 'utf8'); } catch { return env; }
  try {
    const j = JSON.parse(raw);
    return {
      url: env.url || String(j.url || '').trim(),
      email: env.email || String(j.email || '').trim(),
      password: env.password || String(j.password || ''),
    };
  } catch { return env; }
}

function saveCredentials(creds) {
  const file = credentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({
    url: creds.url || '', email: creds.email, password: creds.password,
  }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* fs ohne chmod */ }
  return file;
}

// Effektive Konfiguration: Store/Env plus das fertige Session-Cookie.
function loadConfig() {
  const c = loadCredentials();
  return {
    url: String(c.url || process.env.FEDERWERK_URL || DEFAULT_URL).trim() || DEFAULT_URL,
    email: c.email,
    password: c.password,
    session: String(process.env.FEDERWERK_SESSION || '').trim(),
  };
}

function hasCredentials(config) {
  return !!((config.email && config.password) || config.session);
}

function arg(name, fallback) {
  const ix = process.argv.indexOf('--' + name);
  if (ix >= 0 && process.argv[ix + 1] && !String(process.argv[ix + 1]).startsWith('--')) {
    return process.argv[ix + 1];
  }
  const pref = process.argv.find((a) => a.startsWith('--' + name + '='));
  if (pref) return pref.slice(name.length + 3);
  return fallback;
}

function prompt(text, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl.stdoutMuted = true;
      const orig = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (s) => {
        if (rl.stdoutMuted && s !== '\n' && s !== '\r\n' && s !== '\r') rl.output.write('*');
        else orig(s);
      };
    }
    rl.question(text, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

/* Set-Cookie robust auslesen: fetch darf mehrere Cookies in EINEM Header
 * liefern (Komma-getrennt), und Expires enthält selbst ein Komma. Deshalb
 * nicht stumpf am ersten Komma trennen, sondern den fw_session-Eintrag
 * suchen; sein Wert endet am ersten ';'. */
function setCookieValues(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie() || [];
  if (typeof headers.get === 'function') { const v = headers.get('set-cookie'); return v ? [v] : []; }
  if (typeof headers.raw === 'function') {
    const r = headers.raw()['set-cookie'];
    return Array.isArray(r) ? r : (r ? [r] : []);
  }
  const v = headers['set-cookie'] || headers['Set-Cookie'];
  if (Array.isArray(v)) return v;
  return v ? [v] : [];
}

function sessionCookieFrom(headers) {
  const lines = setCookieValues(headers);
  for (const line of lines) {
    const parts = String(line).split(/,\s*(?=[A-Za-z0-9_.-]+\s*=)/);
    for (const part of parts) {
      for (const seg of part.split(';')) {
        const i = seg.indexOf('=');
        if (i < 0) continue;
        if (seg.slice(0, i).trim() === COOKIE) return seg.slice(i + 1).trim();
      }
    }
  }
  return '';
}

async function httpJson(url, method, pathName, opts) {
  const o = opts || {};
  const headers = {};
  if (o.cookie) headers.Cookie = COOKIE + '=' + o.cookie;
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(String(url).replace(/\/+$/, '') + pathName, {
    method,
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  return { res, data };
}

// Login: gibt {cookie, user}. Das Cookie ist der fw_session-Wert.
async function createSession(opts) {
  const o = opts || {};
  const url = String(o.url || DEFAULT_URL);
  const email = String(o.email || '').trim();
  const password = String(o.password || '');
  if (!email || !password) throw new Error('E-Mail und Passwort erforderlich');
  const { res, data } = await httpJson(url, 'POST', '/api/auth/login', { body: { email, password } });
  if (!res.ok) throw new Error((data && data.error) || ('Login fehlgeschlagen (' + res.status + ')'));
  const cookie = sessionCookieFrom(res.headers);
  if (!cookie) throw new Error('Server lieferte kein Session-Cookie (fw_session)');
  return { cookie, user: (data && data.user) || null };
}

// GET /api/auth/me – 401 bedeutet schlicht "nicht angemeldet".
async function sessionInfo(opts) {
  const o = opts || {};
  const url = String(o.url || DEFAULT_URL);
  const cookie = String(o.cookie || '');
  if (!cookie) return { authenticated: false, ownedByMcp: false, userId: '', email: '', expiresAt: null, user: null };
  const { res, data } = await httpJson(url, 'GET', '/api/auth/me', { cookie });
  if (res.status === 401) return { authenticated: false, ownedByMcp: false, userId: '', email: '', expiresAt: null, user: null };
  if (!res.ok) throw new Error((data && data.error) || ('Federwerk ' + res.status));
  const user = (data && data.user) || null;
  return {
    authenticated: !!user, ownedByMcp: false,
    userId: user ? user.id : '', email: user ? user.email : '',
    expiresAt: null, user,
  };
}

// Session gezielt widerrufen (nur die übergebene – nie pauschal alle).
async function deleteSession(opts) {
  const o = opts || {};
  const url = String(o.url || DEFAULT_URL);
  const cookie = String(o.cookie || '');
  if (!cookie) throw new Error('Session-Cookie fehlt');
  const { res, data } = await httpJson(url, 'POST', '/api/auth/logout', { cookie });
  if (!res.ok) throw new Error((data && data.error) || ('Logout fehlgeschlagen (' + res.status + ')'));
  return true;
}

/* REST-Transport für das MCP-Backend. Hält das Session-Cookie und meldet
 * sich bei 401 einmal neu an – aber nur mit eigener Session (nicht bei
 * FEDERWERK_SESSION, damit ein fremder Cookie nicht stillschweigend ersetzt
 * wird). */
function createApi(config) {
  const cfg = config || {};
  const base = String(cfg.url || DEFAULT_URL).replace(/\/+$/, '');
  let cookie = String(cfg.session || '');
  let owned = false;
  let user = null;

  async function ensureCookie(force) {
    if (cookie && !force) return cookie;
    const store = loadCredentials();
    const email = cfg.email || store.email;
    const password = cfg.password || store.password;
    if (!email || !password) {
      if (cookie) return cookie;
      throw new Error('Keine Anmeldedaten: FEDERWERK_EMAIL/FEDERWERK_PASSWORD setzen oder `node mcpserver/login.js --email … --save` ausführen');
    }
    const s = await createSession({ url: base, email, password });
    cookie = s.cookie;
    owned = true;
    user = s.user || null;
    return cookie;
  }

  async function request(method, pathName, body, retried) {
    await ensureCookie();
    const send = () => httpJson(base, method, pathName, { cookie, body });
    let { res, data } = await send();
    if (res.status === 401 && owned && !retried) {
      // Eigene Session abgelaufen: einmal neu anmelden und wiederholen.
      await ensureCookie(true);
      ({ res, data } = await send());
    }
    if (!res.ok) {
      const e = new Error((data && data.error) || ('Federwerk ' + res.status));
      e.status = res.status;
      throw e;
    }
    return data;
  }

  return {
    sessionInfo: async () => {
      await ensureCookie();
      const info = await sessionInfo({ url: base, cookie });
      info.ownedByMcp = owned;
      if (info.user) user = info.user;
      return info;
    },
    login: async () => {
      await ensureCookie(true);
      const info = await sessionInfo({ url: base, cookie });
      return Object.assign({}, info, { ownedByMcp: owned });
    },
    logout: async () => {
      if (!cookie) return { authenticated: false, ownedByMcp: false, userId: '', email: '', expiresAt: null, loggedOut: false, note: 'Keine Session aktiv' };
      if (!owned) {
        return {
          authenticated: true, ownedByMcp: false,
          userId: user ? user.id : '', email: user ? user.email : '', expiresAt: null,
          loggedOut: false,
          note: 'Session gehört nicht dem MCP (z. B. per FEDERWERK_SESSION gesetzt) – nicht gelöscht, damit die App angemeldet bleibt.',
        };
      }
      try { await request('POST', '/api/auth/logout', undefined, true); } catch { /* war schon weg */ }
      cookie = '';
      owned = false;
      user = null;
      return { authenticated: false, ownedByMcp: false, userId: '', email: '', expiresAt: null, loggedOut: true };
    },
    listDocs: async (since, limit) => {
      const n = Math.min(Math.max(Number(limit) || 1000, 1), 1000);
      const data = await request('GET', '/api/docs?since=' + (Number(since) || 0) + '&limit=' + n);
      return (data && data.items) || [];
    },
    getDoc: async (id) => {
      const data = await request('GET', '/api/docs/' + encodeURIComponent(id));
      return (data && data.doc) || null;
    },
    putDoc: async (doc) => {
      const data = await request('PUT', '/api/docs', doc);
      return (data && data.doc) || null;
    },
    deleteDoc: async (id) => request('DELETE', '/api/docs/' + encodeURIComponent(id)),
    listFolders: async () => {
      const data = await request('GET', '/api/folders');
      return (data && data.items) || [];
    },
    putFolder: async (folder) => {
      const data = await request('PUT', '/api/folders', folder);
      return (data && data.folder) || null;
    },
    deleteFolder: async (id) => request('DELETE', '/api/folders/' + encodeURIComponent(id)),
  };
}

async function main() {
  const store = loadCredentials();
  const url = arg('url', process.env.FEDERWERK_URL || store.url || DEFAULT_URL);

  if (process.argv.includes('--logout')) {
    const cookie = arg('session', process.env.FEDERWERK_SESSION || '');
    if (!cookie) throw new Error('--session oder FEDERWERK_SESSION fehlt');
    await deleteSession({ url, cookie });
    console.log('Session gelöscht.');
    return;
  }

  if (process.argv.includes('--status')) {
    console.log('Credentials-Datei:', credentialsPath(),
      fs.existsSync(credentialsPath()) ? '(vorhanden)' : '(nicht vorhanden)');
    console.log('Server-URL:', url);
    console.log('E-Mail aus Env/Store:', store.email || '(keine)');
    console.log('Passwort hinterlegt:', store.password ? 'ja' : 'nein');
    console.log('FEDERWERK_SESSION gesetzt:', process.env.FEDERWERK_SESSION ? 'ja' : 'nein');
    // --status prüft die Session: fertiges Cookie oder frisch angemeldet.
    let cookie = arg('session', process.env.FEDERWERK_SESSION || '');
    if (!cookie && store.email && store.password) {
      cookie = (await createSession({ url, email: store.email, password: store.password })).cookie;
    }
    if (cookie) {
      const info = await sessionInfo({ url, cookie });
      console.log('Angemeldet:', info.authenticated ? ('ja (' + (info.email || info.userId) + ')') : 'nein');
    }
    return;
  }

  const email = arg('email', store.email || '');
  if (!email) throw new Error('--email oder FEDERWERK_EMAIL fehlt');
  let password = arg('password', store.password || '');
  if (!password) password = await prompt('Federwerk-Passwort: ', true);
  if (!password) throw new Error('Passwort fehlt');

  const session = await createSession({ url, email, password });

  if (process.argv.includes('--save')) {
    const file = saveCredentials({ url, email, password });
    console.log('Credentials gespeichert:', file, '(chmod 600)');
  }
  password = '';

  console.log('Eingeloggt als:', (session.user && (session.user.email || session.user.name)) || email);
  console.log('User-ID:', (session.user && session.user.id) || '');
  console.log('');
  console.log('Ohne Env starten: `node mcpserver/cli.js` (MCP meldet sich mit diesen');
  console.log('Daten selbst an und erneuert die Session bei Ablauf).');
  console.log('Session-Cookie manuell nutzen:');
  console.log('FEDERWERK_SESSION=' + session.cookie);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fehler:', err.message);
    process.exit(1);
  });
}

module.exports = {
  main, createSession, sessionInfo, deleteSession, sessionCookieFrom,
  credentialsPath, loadCredentials, saveCredentials, loadConfig, hasCredentials, createApi,
  DEFAULT_URL,
};
