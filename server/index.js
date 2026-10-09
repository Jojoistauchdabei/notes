'use strict';
/* Federwerk: HTTP-Server.
 *
 * Dependency-frei auf node:http - kein Express. Passt zum Repo und heisst
 * fuenf Abhaengigkeiten weniger auf einem LXC mit 512 MB.
 *
 * Laeuft auf 127.0.0.1 und wird ueber den Cloudflare-Tunnel erreicht. Der
 * Grund ist nicht Misstrauen in die eigene Firewall, sondern: die
 * Authentifizierung laeuft bei HTTPS plus Hostname-Check, und ein
 * Reverse-Proxy vor dem Prozess ist die Stelle, an der man Header setzt,
 * Logs sammelt und spaeter TLS beendet. Der Prozess selbst muss davon
 * nichts wissen.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./db.js');
const auth = require('./auth.js');
const docsApi = require('./docs.js');
const filesApi = require('./files.js');
const shares = require('./shares.js');
const events = require('./events.js');

const PORT = Number(process.env.FW_PORT || 8080);
const HOST = process.env.FW_HOST || '127.0.0.1';
const APP_DIR = process.env.FW_APP_DIR || '/srv/federwerk/app';
const STATIC_DIR = path.join(APP_DIR, 'dist');
const SESSION_SECRET = process.env.FW_SESSION_SECRET || '';

const MAX_BODY = 12 * 1024 * 1024;
const log = (...a) => console.log('[federwerk]', ...a);

/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

function send(res, status, body, headers) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body));
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  }, headers || {}));
  res.end(buf);
}

const sendJson = (res, status, obj, headers) =>
  send(res, status, JSON.stringify(obj), Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}));

function fail(res, e) {
  const status = e && e.status ? e.status : 500;
  if (status >= 500) log('FEHLER', e && e.stack ? e.stack : String(e));
  return sendJson(res, status, { error: (e && e.message) || 'Server-Fehler' });
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > (max || MAX_BODY)) { reject(Object.assign(new Error('Payload zu gross.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const readJson = async (req) => {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw Object.assign(new Error('Ungültiges JSON.'), { status: 400 }); }
};

/* Multipart-Parser fuer Datei-Uploads.
 *
 * Kein Busboy, keine Abhaengigkeit - der Client schickt genau zwei Felder
 * (sha256 als Text, dann die Datei). Ein voller Parser waere hier Arbeit
 * ohne Nutzen, ein minimaler dafuer angreifbar, wenn man ihn nicht streng
 * begrenzt: deshalb MAX_BODY im Vorfeld, harte Grenze pro Teil, und jede
 * unerwartete Struktur ist ein Fehler statt einer Deutung.
 */
function parseMultipart(buf, boundary, limit) {
  const max = limit || MAX_BODY;
  const parts = {};
  const dash = Buffer.from('--' + boundary);
  let i = buf.indexOf(dash);
  if (i < 0) throw Object.assign(new Error('Multipart: Grenze nicht gefunden.'), { status: 400 });
  i += dash.length;
  while (i < buf.length) {
    if (buf.slice(i, i + 2).toString() === '--') break;
    if (buf.slice(i, i + 2).toString() === '\r\n') i += 2;
    const headEnd = buf.indexOf('\r\n\r\n', i, 'utf8');
    if (headEnd < 0) break;
    const head = buf.slice(i, headEnd).toString('utf8');
    const name = (/name="([^"]*)"/.exec(head) || [])[1];
    const bodyStart = headEnd + 4;
    let bodyEnd = buf.indexOf(dash, bodyStart);
    if (bodyEnd < 0) bodyEnd = buf.length;
    let end = bodyEnd;
    if (buf.slice(end - 2, end).toString() === '\r\n') end -= 2;
    const value = buf.slice(bodyStart, end);
    if (name) parts[name] = value;
    i = bodyEnd + dash.length;
    if (value.length > max) throw Object.assign(new Error('Feld zu gross.'), { status: 413 });
  }
  return parts;
}

/* ------------------------------------------------------------------ */

function requireUser(req) {
  const cookies = auth.parseCookies(req.headers.cookie);
  const user = auth.resolve(cookies[auth.COOKIE]);
  if (!user) throw Object.assign(new Error('Nicht angemeldet.'), { status: 401 });
  return user;
}

/* ------------------------------------------------------------------ */

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const target = path.normalize(path.join(STATIC_DIR, rel));
  // Pfad-Ausbruch: alles, was nach Normalisierung nicht mehr unter
  // STATIC_DIR liegt, ist kein Treffer. path.join allein reicht da nicht.
  if (!target.startsWith(STATIC_DIR + path.sep) && target !== STATIC_DIR) return false;

  let st;
  try { st = fs.statSync(target); } catch { return false; }
  if (st.isDirectory()) return false;

  const ext = path.extname(target).toLowerCase();
  // Hash-Dateien (app.bundle.<hash>.js) sind unveraenderlich, die Shell nicht.
  // Falsch eingeteilt heisst hier: alte App haengt ewig im Cache.
  const immutable = /-[0-9a-f]{8,}\.[a-z0-9]+$/i.test(path.basename(target)) ||
                    /^(js|css)\//.test(rel.replace(/^\//, '')) && /[.-][0-9a-f]{8,}\./.test(path.basename(target));
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(target).pipe(res);
  return true;
}

/* ------------------------------------------------------------------ */

async function handleApi(req, res, u) {
  const p = u.pathname;
  const m = req.method.toUpperCase();

  // ---- Health (ohne Auth, fuer Tunnel-/LXC-Ueberwachung) ----
  if (p === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'federwerk',
      version: process.env.FW_VERSION || 'dev',
      filesVerified: filesApi.VERIFY_READ,
      uptime: Math.round(process.uptime()),
      live: events.stats(),
    });
  }

  // ---- Auth ----
  if (p === '/api/auth/register' && m === 'POST') {
    const body = await readJson(req);
    let user;
    try {
      user = auth.createUser(body.email, body.password, body.name);
    } catch (e) {
      if (e.status === 409) {
        // Gleiche E-Mail: nicht verraten, ob das Konto existiert. Statt
        // Fehler wird angemeldet - das entspricht dem Verhalten, das der
        // Client ohnehin erwartet (Registrieren meldet Erfolg).
        const s = auth.login(body.email, body.password, req.headers['user-agent']);
        return sendJson(res, 200, { user: s.user }, { 'Set-Cookie': auth.cookieHeader(s.token, 90 * 86400) });
      }
      throw e;
    }
    const s = auth.issue(user.id, req.headers['user-agent']);
    return sendJson(res, 201, { user: s.user }, { 'Set-Cookie': auth.cookieHeader(s.token, 90 * 86400) });
  }

  if (p === '/api/auth/login' && m === 'POST') {
    const body = await readJson(req);
    const s = auth.login(body.email, body.password, req.headers['user-agent']);
    return sendJson(res, 200, { user: s.user }, { 'Set-Cookie': auth.cookieHeader(s.token, 90 * 86400) });
  }

  if (p === '/api/auth/logout' && m === 'POST') {
    const cookies = auth.parseCookies(req.headers.cookie);
    auth.logout(cookies[auth.COOKIE]);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  }

  if (p === '/api/auth/me' && m === 'GET') {
    const user = requireUser(req);
    return sendJson(res, 200, { user });
  }

  // ---- Alles ab hier braucht eine Session ----
  const user = requireUser(req);

  // ---- Dokumente ----
  if (p === '/api/docs' && m === 'GET') {
    const kind = u.searchParams.get('kind') || 'note';
    const since = u.searchParams.get('since');
    const limit = u.searchParams.get('limit');
    return sendJson(res, 200, { items: docsApi.since(user.id, since, kind, limit) });
  }
  if (p === '/api/docs' && m === 'PUT') {
    const body = await readJson(req);
    const doc = docsApi.upsert(user.id, body);
    events.notify(user.id, ['docs']);
    return sendJson(res, 200, { doc });
  }
  const docId = /^\/api\/docs\/([^/]+)$/.exec(p);
  if (docId && m === 'GET') return sendJson(res, 200, { doc: docsApi.get(user.id, docId[1]) });
  if (docId && m === 'DELETE') {
    const r = docsApi.remove(user.id, docId[1]);
    events.notify(user.id, ['docs']);
    return sendJson(res, 200, r);
  }

  // ---- Ordner ----
  if (p === '/api/folders' && m === 'GET') return sendJson(res, 200, { items: docsApi.allFolders(user.id) });
  if (p === '/api/folders' && m === 'PUT') {
    const body = await readJson(req);
    const folder = docsApi.upsertFolder(user.id, body);
    events.notify(user.id, ['folders']);
    return sendJson(res, 200, { folder });
  }
  const folderId = /^\/api\/folders\/([^/]+)$/.exec(p);
  if (folderId && m === 'DELETE') {
    const r = docsApi.removeFolder(user.id, folderId[1]);
    events.notify(user.id, ['folders']);
    return sendJson(res, 200, r);
  }

  // ---- Dateien ----
  if (p === '/api/files' && m === 'GET') return sendJson(res, 200, { items: filesApi.list(user.id) });
  if (p === '/api/files' && m === 'POST') {
    const ct = String(req.headers['content-type'] || '');
    const b = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
    if (!b) throw Object.assign(new Error('Kein multipart.'), { status: 400 });
    const parts = parseMultipart(await readBody(req), b[1] || b[2]);
    const sha = (parts.sha256 && parts.sha256.toString('utf8').trim()) || '';
    const mime = (parts.mime && parts.mime.toString('utf8').trim()) || 'application/octet-stream';
    const data = parts.file;
    if (!data) throw Object.assign(new Error('Feld "file" fehlt.'), { status: 400 });
    const r = filesApi.put(user.id, sha, mime, data);
    return sendJson(res, r.deduplicated ? 200 : 201, r);
  }
  const fileSha = /^\/api\/files\/([0-9a-f]{64})$/.exec(p);
  if (fileSha && m === 'GET') {
    const f = filesApi.get(user.id, fileSha[1]);
    return send(res, 200, f.buf, {
      'Content-Type': f.mime || 'application/octet-stream',
      'Content-Length': f.buf.length,
      'ETag': '"' + fileSha[1] + '"',
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
  }
  if (fileSha && m === 'HEAD') {
    const row = filesApi.list(user.id).find((f) => f.sha256 === fileSha[1]);
    if (!row) throw Object.assign(new Error('Datei unbekannt.'), { status: 404 });
    res.writeHead(200, { 'Content-Type': row.mime, 'Content-Length': row.size, 'ETag': '"' + row.sha256 + '"' });
    return res.end();
  }

  // ---- Freigaben (Liveshare) ----
  if (p === '/api/shares' && m === 'POST') {
    const body = await readJson(req);
    const share = shares.create(user.id, body);
    events.notify(user.id, ['shares']);
    return sendJson(res, 201, { share });
  }
  if (p === '/api/shares' && m === 'GET') return sendJson(res, 200, { items: shares.listOwned(user.id) });
  const shareCode = /^\/api\/shares\/([^/]+)$/.exec(p);
  if (shareCode && m === 'GET') return sendJson(res, 200, { share: shares.readShare(user.id, shareCode[1]) });
  if (shareCode && m === 'PATCH') {
    const share = shares.patch(user.id, shareCode[1], await readJson(req));
    events.notify(user.id, ['shares']);
    return sendJson(res, 200, { share });
  }
  if (shareCode && m === 'DELETE') return sendJson(res, 200, shares.revoke(user.id, shareCode[1]));

  const shareEvents = /^\/api\/shares\/([^/]+)\/events$/.exec(p);
  if (shareEvents && m === 'GET') {
    const after = u.searchParams.get('after') || 0;
    return sendJson(res, 200, {
      items: shares.events(user.id, shareEvents[1], after, u.searchParams.get('limit')),
      cursor: shares.cursor(user.id, shareEvents[1]),
    });
  }
  if (shareEvents && m === 'POST') {
    const r = shares.appendEvent(user.id, shareEvents[1], await readJson(req));
    // Alle anderen Nutzer mit offener Freigabe benachrichtigen. Der Sender
    // selbst bekommt bewusst kein Echo.
    events.notifyShare(r.shareId, user.id);
    return sendJson(res, 201, r);
  }

  // ---- Live-Kanal ----
  if (p === '/api/events' && m === 'GET') {
    const raw = u.searchParams.get('channels') || 'docs,folders,shares,share_events';
    const share = u.searchParams.get('share');
    // Eine Freigabe zu abonnieren ist eine Anmeldung fuer diesen Nutzer -
    // vorher pruefen, sonst koennte ein Client einfach fremde Codes
    // "beobachten" und Ereignisse erraten.
    if (share) shares.readShare(user.id, share);
    events.subscribe(res, user.id, raw.split(',').map((s) => s.trim()).filter(Boolean), share);
    return undefined;
  }

  throw Object.assign(new Error('Unbekannte Route: ' + p), { status: 404 });
}

/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  // Same-Origin ueber den Tunnel. Ohne diese Liste koennte eine fremde Seite
  // per fetch mit dem Cookie antworten lassen - CORS schuetzt nur vor dem
  // Lesen der Antwort, nicht vor dem Absenden der Anfrage.
  const origin = req.headers.origin;
  if (origin) {
    const allowed = process.env.FW_PUBLIC_URL;
    const sameHost = (() => { try { return new URL(origin).host === req.headers.host; } catch { return false; } })();
    if (!sameHost && !(allowed && origin === allowed)) {
      return sendJson(res, 403, { error: 'Herkunft nicht erlaubt.' });
    }
    res.setHeader('Access-Control-Allow-Origin', allowed && origin === allowed ? allowed : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) {
      const r = await handleApi(req, res, u);
      if (r !== undefined && !res.writableEnded) return r;
      return undefined;
    }
    if (serveStatic(req, res, u.pathname)) return undefined;
    // SPA-Fallback: alle uebrigen Pfade liefern die App-Shell.
    if (!u.pathname.includes('.') && serveStatic(req, res, '/index.html')) return undefined;
    return sendJson(res, 404, { error: 'Nicht gefunden.' });
  } catch (e) {
    if (res.writableEnded) return undefined;
    return fail(res, e);
  }
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignore */ }
});

function start() {
  return new Promise((resolve) => server.listen(PORT, HOST, () => {
    // Die Pfade aus der Umgebung lesen, nicht ueber db.tierPaths() - das
    // wuerde fuer den Namen '__probe__' ein echtes Verzeichnis und eine
    // leere Datenbank anlegen. Genau das ist passiert: nach jedem Start lag
    // /srv/federwerk/data/users/__probe__/docs.db, und der GC zaehlte den
    // mit als Nutzer.
    const hot = process.env.FW_FILES_DIR || '(nicht gesetzt)';
    const cold = process.env.FW_ARCHIVE_DIR || hot;
    log(`lauscht auf http://${HOST}:${PORT}`);
    log(`Ablage  hot=${hot}`);
    log(`Ablage cold=${cold}`);
    if (!process.env.FW_FILES_DIR) log('WARNUNG: FW_FILES_DIR nicht gesetzt - Datei-Uploads schlagen fehl.');
    log(`Hash-Pruefung beim Lesen: ${filesApi.VERIFY_READ ? 'an' : 'aus'}`);
    if (!SESSION_SECRET) log('WARNUNG: FW_SESSION_SECRET nicht gesetzt (in /etc/federwerk/env)');
    resolve(server);
  }));
}

if (require.main === module) {
  start();
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log(`${sig} - fahre herunter`);
      events.shutdown();
      db.closeAll();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

module.exports = { server, start, handleApi, serveStatic, parseMultipart };