'use strict';
/* Federwerk: Konten und Sessions.
 *
 * Bewusste Abweichungen von dem, was Appwrite gemacht hat:
 *
 * - EIN HttpOnly-Cookie statt Session-Secret im localStorage PLUS Cookie.
 *   Appwrite brauchte beides, weil der Tauri-WebView den Third-Party-Cookie
 *   verliert; auf eigenem Origin mit eigenem Protokoll gibt es dieses
 *   Problem nicht mehr. Ein Cookie im localStorage ist zudem fuer jeden
 *   XSS-Pfad lesbar - der HttpOnly-Cookie nicht.
 * - Sessions sind serverseitig widerrufbar (DELETE /api/auth/logout
 *   beendet genau die eine Session, die das Cookie traegt).
 * - Passwoerter mit scrypt. Bewusst keine bcrypt-Abhaengigkeit, damit das
 *   Zero-Dependency-Versprechen des Repos nicht gebrochen wird.
 */

const crypto = require('crypto');
const db = require('./db.js');

const SESSION_DAYS = Number(process.env.FW_SESSION_DAYS || 90);
const COOKIE = 'fw_session';

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(password, s, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { hash: h, salt: s };
}

function verifyPassword(password, hash, salt) {
  const { hash: h } = hashPassword(password, salt);
  // timingSafeEqual braucht gleich lange Puffer - erst vergleichen, dann auswerten.
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function validateCredentials(email, password) {
  const e = String(email || '').trim().toLowerCase();
  const p = String(password || '');
  if (!e || !p) throw httpError(400, 'E-Mail und Passwort erforderlich.');
  // Gleiche Obergrenze wie im Client (js/appwrite-files.js:validateRegister),
  // damit die Validierung nicht von der Seite des Clients abhaengt.
  if (p.length < 8) throw httpError(400, 'Passwort muss mindestens 8 Zeichen haben.');
  if (p.length > 512) throw httpError(400, 'Passwort ist zu lang.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw httpError(400, 'Ungültige E-Mail-Adresse.');
  return { email: e, password: p };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function createUser(email, password, name) {
  const a = db.auth();
  const { email: e, password: p } = validateCredentials(email, password);
  const exists = a.prepare('SELECT id FROM users WHERE email = ?').get(e);
  if (exists) throw httpError(409, 'Diese E-Mail-Adresse ist bereits registriert.');
  const { hash, salt } = hashPassword(p);
  const id = 'u_' + crypto.randomBytes(12).toString('hex');
  a.prepare('INSERT INTO users (id, email, name, pass_hash, pass_salt, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, e, String(name || '').slice(0, 128), hash, salt, Date.now());
  return getUser(id);
}

function getUser(id) {
  const row = db.auth().prepare('SELECT id, email, name, created_at FROM users WHERE id = ?').get(id);
  return row ? { id: row.id, email: row.email, name: row.name } : null;
}

function login(email, password, userAgent) {
  const a = db.auth();
  const row = a.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  // Auch bei unbekannter Adresse einen Hash rechnen, damit die Antwortzeit
  // nicht verrät, ob eine E-Mail existiert.
  const salt = row ? row.pass_salt : 'dummy-salt-for-constant-time';
  const ok = verifyPassword(String(password || ''), row ? row.pass_hash : hashPassword('x', salt).hash, salt);
  if (!row || !ok) throw httpError(401, 'E-Mail oder Passwort falsch.');
  return issue(row.id, userAgent);
}

function issue(userId, userAgent) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.auth().prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)')
    .run(tokenHash(token), userId, now, now + SESSION_DAYS * 86400000, String(userAgent || '').slice(0, 200));
  return { token, user: getUser(userId) };
}

/* Cookie -> Nutzer. Beendet abgelaufene Sessions und raeumt sie gleich mit. */
function resolve(token) {
  if (!token) return null;
  const a = db.auth();
  const now = Date.now();
  const row = a.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash(token));
  if (!row) return null;
  if (row.expires_at <= now) {
    a.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  return getUser(row.user_id);
}

function logout(token) {
  if (!token) return false;
  const r = db.auth().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
  return r.changes > 0;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(token, maxAgeSeconds) {
  const bits = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  // Secure nur, wenn die Anfrage wirklich ueber TLS kam. Sonst waere die
  // App lokal (oder hinter einem Tunnel ohne Forwarded-Proto) unbenutzbar.
  if (process.env.FW_FORCE_SECURE === '1' || process.env.FW_PUBLIC_URL) bits.push('Secure');
  return bits.join('; ');
}

const clearCookie = () => cookieHeader('', 0);

module.exports = {
  COOKIE, createUser, getUser, login, logout, resolve,
  issue, parseCookies, cookieHeader, clearCookie, httpError, validateCredentials,
};