#!/usr/bin/env node
'use strict';
/* Federwerk MCP-Login: erzeugt eine Benutzer-Session (Cookie) für die App.
 *
 *   node mcpserver/login.js --email DU@BEISPIEL.DE           # einmalig: Session
 *   node mcpserver/login.js --email … --save                # + Credentials merken
 *   node mcpserver/login.js --status                        # nur prüfen
 *   node mcpserver/login.js --logout --session <SESSION>    # Session widerrufen
 *
 * Zwei Betriebsarten für den MCP-Server:
 *  1) Credentials (E-Mail + Passwort) – der MCP loggt sich beim Start selbst
 *     ein, erzeugt die Session (Cookie) und meldet sich bei 401 automatisch
 *     erneut an. Quelle: Env `APPWRITE_EMAIL`/`APPWRITE_PASSWORD` oder die
 *     Credentials-Datei (siehe `credentialsPath`).
 *  2) Fertiges `APPWRITE_SESSION` (Token) – ohne Passwort, vom Nutzer gesetzt.
 *
 * Die Credentials-Datei ist ein Nur-Lese-Secret (chmod 600, im Repo-ignore
 * bzw. außerhalb des Repos). Passwörter gehören NIE als Tool-Argument in den
 * LLM-Kontext – `login`/`logout` arbeiten deshalb nur mit dem Store.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

// ~/.config/federwerk/mcp-credentials.json – bewusst außerhalb des Repos.
function credentialsPath() {
  const override = process.env.MCP_CREDENTIALS_FILE
    || process.argv.find((a) => a.startsWith('--credentials='));
  if (override) return String(override.startsWith('--credentials=') ? override.slice(14) : override).trim();
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir() || '.', '.config');
  return path.join(base, 'federwerk', 'mcp-credentials.json');
}

// {email, password, endpoint?, projectId?} – nie Exceptions, nie Logs.
function loadCredentials() {
  const env = {
    email: String(process.env.APPWRITE_EMAIL || '').trim(),
    password: String(process.env.APPWRITE_PASSWORD || ''),
    endpoint: process.env.APPWRITE_ENDPOINT || '',
    projectId: process.env.APPWRITE_PROJECT_ID || '',
  };
  if (env.email && env.password) return env;
  let raw = null;
  try { raw = fs.readFileSync(credentialsPath(), 'utf8'); } catch { return env; }
  try {
    const j = JSON.parse(raw);
    return {
      email: env.email || String(j.email || '').trim(),
      password: env.password || String(j.password || ''),
      endpoint: env.endpoint || j.endpoint || '',
      projectId: env.projectId || j.projectId || '',
    };
  } catch { return env; }
}

function saveCredentials(creds) {
  const file = credentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({
    email: creds.email, password: creds.password,
    ...(creds.endpoint ? { endpoint: creds.endpoint } : {}),
    ...(creds.projectId ? { projectId: creds.projectId } : {}),
  }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* fs ohne chmod */ }
  return file;
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

// Appwrite liefert das Session-Token je nach Version im JSON-Feld `secret`
// oder (2.x) nur als Cookie `a_session[_<project>]` – beides akzeptieren.
function sessionTokenFrom(data, headers, projectId) {
  const secret = data && typeof data.secret === 'string' ? data.secret.trim() : '';
  if (secret) return secret;
  const raw = headers && typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : ((headers && headers.get && headers.get('set-cookie')) ? [headers.get('set-cookie')] : []);
  const cookies = Array.isArray(raw) ? raw.join(',') : String(raw || '');
  const re = new RegExp(`a_session_${projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;,]+)`);
  const m = re.exec(cookies);
  if (m) return decodeURIComponent(m[1]);
  const generic = /a_session[^=]*=([^;,]+)/.exec(cookies);
  return generic ? decodeURIComponent(generic[1]) : '';
}

async function api(endpoint, projectId, path, opts = {}) {
  const res = await fetch(`${endpoint.replace(/\/$/, '')}${path}`, {
    ...opts,
    headers: {
      'X-Appwrite-Project': projectId,
      'X-Appwrite-Response-Format': '2.0.0',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const body = await res.text().catch(() => '');
  let data = null;
  try { data = body ? JSON.parse(body) : null; } catch { data = { message: body }; }
  if (!res.ok) {
    throw new Error(`Appwrite ${res.status}: ${(data && data.message) || 'request failed'}`);
  }
  return { data, headers: res.headers };
}

// Session erzeugen: gibt {token, userId, sessionId, expire} – ohne Passwort.
async function createSession(opts) {
  const o = opts || {};
  const endpoint = o.endpoint || 'https://fra.cloud.appwrite.io/v1';
  const projectId = o.projectId || '6ab0067c00244c28560a';
  const email = String(o.email || '').trim();
  const password = String(o.password || '');
  if (!email || !password) throw new Error('E-Mail und Passwort erforderlich');
  const { data, headers } = await api(endpoint, projectId, '/account/sessions/email', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  const token = sessionTokenFrom(data, headers, projectId);
  if (!token) throw new Error('Login fehlgeschlagen (E-Mail/Passwort prüfen)');
  const me = await api(endpoint, projectId, '/account', {
    headers: { 'X-Appwrite-Session': token },
  });
  return {
    token,
    userId: (me.data && me.data.$id) || '',
    email: (me.data && (me.data.email || me.data.name)) || email,
    sessionId: (data && data.$id) || '',
    expire: (data && data.expire) || null,
  };
}

// Session gezielt widerrufen (nur die übergebene ID – nie pauschal alle,
// damit die Browser-Sessions der App unangetastet bleiben).
async function deleteSession(opts) {
  const o = opts || {};
  const endpoint = o.endpoint || 'https://fra.cloud.appwrite.io/v1';
  const projectId = o.projectId || '6ab0067c00244c28560a';
  const token = String(o.token || '');
  const sessionId = String(o.sessionId || '');
  if (!token) throw new Error('Session-Token fehlt');
  const target = sessionId
    ? `/account/sessions/${encodeURIComponent(sessionId)}`
    : '/account/sessions/current';
  await api(endpoint, projectId, target, {
    method: 'DELETE',
    headers: { 'X-Appwrite-Session': token },
  });
  return true;
}

async function main() {
  const endpoint = arg('endpoint', process.env.APPWRITE_ENDPOINT || 'https://fra.cloud.appwrite.io/v1');
  const projectId = arg('project', process.env.APPWRITE_PROJECT_ID || '6ab0067c00244c28560a');
  const store = loadCredentials();

  if (process.argv.includes('--logout')) {
    const session = arg('session', process.env.APPWRITE_SESSION || '');
    if (!session) throw new Error('--session oder APPWRITE_SESSION fehlt');
    await api(endpoint, projectId, '/account/sessions/current', {
      method: 'DELETE',
      headers: { 'X-Appwrite-Session': session },
    });
    console.log('Session gelöscht.');
    return;
  }

  if (process.argv.includes('--status')) {
    console.log('Credentials-Datei:', credentialsPath(),
      require('node:fs').existsSync(credentialsPath()) ? '(vorhanden)' : '(nicht vorhanden)');
    console.log('E-Mail aus Env/Store:', store.email || '(keine)');
    console.log('Passwort hinterlegt:', store.password ? 'ja' : 'nein');
    console.log('APPWRITE_SESSION gesetzt:', process.env.APPWRITE_SESSION ? 'ja' : 'nein');
    return;
  }

  const email = arg('email', store.email || '');
  if (!email) throw new Error('--email oder APPWRITE_EMAIL fehlt');
  let password = arg('password', store.password || '');
  if (!password) password = await prompt('Appwrite-Passwort: ', true);
  if (!password) throw new Error('Passwort fehlt');

  const session = await createSession({ endpoint, projectId, email, password });
  password = '';

  if (process.argv.includes('--save')) {
    const file = saveCredentials({ email: session.email || email, password: process.env.APPWRITE_PASSWORD || '' });
    console.log('Credentials gespeichert:', file, '(chmod 600)');
  }

  console.log('Eingeloggt als:', session.email);
  console.log('User-ID:', session.userId);
  console.log('Session läuft ab:', session.expire || 'unbekannt');
  console.log('');
  console.log('Ohne Env/Session-Token starten: `node mcpserver/cli.js` (MCP meldet sich');
  console.log('mit diesen Daten selbst an und erneuert die Session bei Ablauf).');
  console.log('Session-Token manuell nutzen:');
  console.log(`APPWRITE_SESSION=${session.token}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fehler:', err.message);
    process.exit(1);
  });
}

module.exports = {
  main, sessionTokenFrom, createSession, deleteSession,
  credentialsPath, loadCredentials, saveCredentials,
};
