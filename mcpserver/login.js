#!/usr/bin/env node
'use strict';
/* Federwerk MCP-Login: erzeugt eine Benutzer-Session für den key-losen Betrieb.
 *
 *   node mcpserver/login.js --email DU@BEISPIEL.DE [--password ...]
 *   node mcpserver/login.js --logout --session <APPWRITE_SESSION>
 *
 * Gibt APPWRITE_SESSION (Secret) + User-ID aus – beides in die MCP-Env
 * übernehmen (APPWRITE_USER_ID ist optional, wird aus der Session abgeleitet).
 * Das Secret ist ein Zugang wie ein Passwort: in Env-Datei (nie committen),
 * bei Verlust/Bedarf in der Console (Auth → Users → Sessions) entziehen oder
 * per --logout löschen. Ohne --password wird interaktiv gefragt (erscheint
 * weder in Shell-History noch `ps`).
 */

const readline = require('node:readline');

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

async function main() {
  const endpoint = arg('endpoint', process.env.APPWRITE_ENDPOINT || 'https://fra.cloud.appwrite.io/v1');
  const projectId = arg('project', process.env.APPWRITE_PROJECT_ID || '6ab0067c00244c28560a');

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

  const email = arg('email', process.env.APPWRITE_EMAIL || '');
  if (!email) throw new Error('--email oder APPWRITE_EMAIL fehlt');
  let password = arg('password', process.env.APPWRITE_PASSWORD || '');
  if (!password) password = await prompt('Appwrite-Passwort: ', true);
  if (!password) throw new Error('Passwort fehlt');

  const { data, headers } = await api(endpoint, projectId, '/account/sessions/email', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  password = '';
  const token = sessionTokenFrom(data, headers, projectId);
  if (!token) throw new Error('Login fehlgeschlagen (E-Mail/Passwort prüfen)');

  const me = await api(endpoint, projectId, '/account', {
    headers: { 'X-Appwrite-Session': token },
  });

  console.log('Eingeloggt als:', (me.data && (me.data.email || me.data.name)) || email);
  console.log('User-ID:', me.data.$id);
  console.log('');
  console.log('In die MCP-Umgebung übernehmen (Session läuft ggf. ab – dann erneut einloggen):');
  console.log(`APPWRITE_SESSION=${token}`);
  console.log(`APPWRITE_USER_ID=${me.data.$id}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fehler:', err.message);
    process.exit(1);
  });
}

module.exports = { main, sessionTokenFrom };
