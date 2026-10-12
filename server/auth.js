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
const { createLimiter } = require('./ratelimit.js');

const SESSION_DAYS = Number(process.env.FW_SESSION_DAYS || 90);
const COOKIE = 'fw_session';

/* Fehlversuche zaehlen. Zwei Schluessel, weil sie zwei verschiedene Angriffe
 * stoppen:
 *   login:mail:<adresse>  verhindert das Raten GEGEN ein Konto
 *   login:ip:<adresse>    verhindert das Raten vieler Konten von einer
 *                         Adresse aus (Spray-Angriff, bei dem kein einzelnes
 *                         Konto die Schwelle erreicht)
 *
 * Wichtig fuer das Nicht-Orakel: Beide Schluessel werden im Zweifel auch dann
 * gefuehrt, wenn die Adresse der IP unbekannt ist. Die Sperre fuer
 * "E-Mail existiert nicht" sieht damit exakt so aus wie die fuer "Passwort
 * falsch" - sonst koennte man durch Warten auf die SperreAdressen aufspueren.
 * Ohne IP fehlt einfach der zweite Schluessel, nicht der erste.
 */
const loginLimiter = createLimiter({
  limit: Number(process.env.FW_LOGIN_MAX_FAILS || 5),
  baseMs: Number(process.env.FW_LOGIN_LOCK_MS || 60 * 1000),
  maxMs: Number(process.env.FW_LOGIN_MAX_LOCK_MS || 15 * 60 * 1000),
  maxEntries: Number(process.env.FW_RATELIMIT_MAX_ENTRIES || 10000),
});

/* Registrierung ist offen, sonst waere Erstnutzung unmoeglich - aber ein Skript
 * darf davon nicht beliebig viele Konten anlegen, sonst wird die Datenbank mit
 * Wegwerf-Konten und Wegwerf-Sessions gefuellt.
 *
 * Anders als beim Login wird hier NACH einem Erfolg NICHT zurueckgesetzt: der
 * Missbrauch besteht ja gerade aus vielen ERFOLGREICHEN Registrierungen. Also
 * zaehlt jeder Versuch, gleich ob er geklappt hat oder nicht.
 *
 * Ohne bekannte IP (Aufrufe aus dem Prozess heraus, Tests) wird gar nicht erst
 * gezaehlt - ein gemeinsamer globaler Schluessel wuerde jeden internen Aufruf
 * in einen Sperrtreffer laufen lassen.
 */
const registerLimiter = createLimiter({
  limit: Number(process.env.FW_REGISTER_MAX || 5),
  baseMs: Number(process.env.FW_REGISTER_LOCK_MS || 10 * 60 * 1000),
  maxMs: Number(process.env.FW_REGISTER_MAX_LOCK_MS || 60 * 60 * 1000),
  maxEntries: Number(process.env.FW_RATELIMIT_MAX_ENTRIES || 10000),
});

const normMail = (v) => String(v || '').trim().toLowerCase();

function loginKeys(email, clientIp) {
  const keys = ['login:mail:' + normMail(email)];
  const ip = normIp(clientIp);
  if (ip) keys.push('login:ip:' + ip);
  return keys;
}

/* Der Aufrufer (server/index.js) reicht die Remote-Adresse der Anfrage
 * weiter. Hier wird sie nur normalisiert: IPv4-mapped IPv6 und Port
 * abschneiden, sonst haette dieselbe Adresse je nach Weg mehrere
 * Schluessel und die Sperre waere umgehbar. */
function normIp(clientIp) {
  const ip = String(clientIp || '').trim()
    .replace(/^\[|\]$/g, '')
    .replace(/^::ffff:/, '')
    .replace(/:\d+$/, '');
  return /^[0-9a-f:.]{1,45}$/i.test(ip) ? ip : '';
}

function lockedError(retryAfterMs) {
  const min = Math.max(1, Math.ceil(retryAfterMs / 60000));
  const e = httpError(429, `Zu viele Fehlversuche - gesperrt. Bitte in ${min} Minute(n) erneut versuchen.`);
  e.retryAfterMs = retryAfterMs;
  return e;
}

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

function createUser(email, password, name, clientIp) {
  const ip = normIp(clientIp);
  // VOR dem Hash. Ein Registrierungsversuch ist ein scrypt so teuer wie ein
  // Loginversuch; wer die Sperre erst danach prueft, hat gegen genau das
  // Werkzeug geschuetzt, das man ihm nehmen wollte.
  const regKey = ip ? 'register:ip:' + ip : '';
  if (regKey) {
    const s = registerLimiter.check(regKey);
    if (s.blocked) throw lockedError(s.retryAfterMs);
  }
  // Zaehlen passiert unabhaengig vom Ergebnis - deshalb das try/finally.
  // Sonst koennte man durch Absenden ungueltiger Registrierungen (400/409)
  // unbegrenzt scrypt auf den Server treiben.
  try {
    const a = db.auth();
    const { email: e, password: p } = validateCredentials(email, password);
    const exists = a.prepare('SELECT id FROM users WHERE email = ?').get(e);
    if (exists) throw httpError(409, 'Diese E-Mail-Adresse ist bereits registriert.');
    const { hash, salt } = hashPassword(p);
    const id = 'u_' + crypto.randomBytes(12).toString('hex');
    a.prepare('INSERT INTO users (id, email, name, pass_hash, pass_salt, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, e, String(name || '').slice(0, 128), hash, salt, Date.now());
    return getUser(id);
  } finally {
    if (regKey) registerLimiter.fail(regKey);
  }
}

function getUser(id) {
  const row = db.auth().prepare('SELECT id, email, name, created_at FROM users WHERE id = ?').get(id);
  return row ? { id: row.id, email: row.email, name: row.name } : null;
}

function login(email, password, userAgent, clientIp) {
  const keys = loginKeys(email, clientIp);
  // Die Sperrpruefung kommt VOR dem scrypt - und zwar vor der Datenbankabfrage,
  // nicht danach. Ein Angreifer, der 10.000mal "bob@example.org, falsch"
  // schickt, darf davon keinen einzigen Hash kosten, sonst ist die Sperre nur
  // eine Verzoegerung fuer ihn und eine Last fuer uns.
  for (const key of keys) {
    const s = loginLimiter.check(key);
    if (s.blocked) throw lockedError(s.retryAfterMs);
  }

  const a = db.auth();
  const row = a.prepare('SELECT * FROM users WHERE email = ?').get(normMail(email));
  // Auch bei unbekannter Adresse einen Hash rechnen, damit die Antwortzeit
  // nicht verrät, ob eine E-Mail existiert.
  const salt = row ? row.pass_salt : 'dummy-salt-for-constant-time';
  const ok = verifyPassword(String(password || ''), row ? row.pass_hash : hashPassword('x', salt).hash, salt);
  if (!row || !ok) {
    // Beide Faelle - unbekannte Adresse und falsches Passwort - zaehlen auf
    // denselben Schluessel. Genau das ist der Grund, warum es hier KEINEN
    // Sonderfall "unbekannte E-Mail" gibt: die Sperre waere sonst selbst das
    // Orakel, das die Antwortzeit bisher verdeckt hat.
    for (const key of keys) loginLimiter.fail(key);
    throw httpError(401, 'E-Mail oder Passwort falsch.');
  }
  // Erfolg zaehlt nicht als Fehlschlag und setzt den Zaehler zurueck: wer
  // das richtige Passwort hat, darf nicht unter einer alten Sperre leiden.
  for (const key of keys) loginLimiter.ok(key);
  return issue(row.id, userAgent);
}

function issue(userId, userAgent) {
  // Abgelaufene Sessions hier mitraeumen, nicht nur beim Aufloesen: resolve()
  // trifft genau die Zeile, die der Cookie gerade traegt. Alle anderen
  // abgelaufenen Zeilen wuerden bis zum 90-Tage-Ablauf liegen bleiben, weil
  // niemand sie je ansieht. Beim Anlegen einer Session ist die DB ohnehin
  // offen - das Aufraeumen kostet also fast nichts.
  purgeSessions();
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.auth().prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)')
    .run(tokenHash(token), userId, now, now + SESSION_DAYS * 86400000, String(userAgent || '').slice(0, 200));
  return { token, user: getUser(userId) };
}

/* Loescht alle abgelaufenen Sessions und gibt die Anzahl zurueck.
 *
 * Bewusst eigenstaendig und exportiert, damit server/index.js sie entweder
 * direkt beim Start oder in einem Intervall aufrufen kann (z.B. stuendlich
 * per setInterval). Hier wird sie NICHT eingebunden - das gehoert in den
 * Server, der die Lebensdauer des Prozesses kennt.
 */
function purgeSessions() {
  const r = db.auth().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  return r.changes;
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
  purgeSessions,
  /* Nur fuer Tests und Diagnose: die Limiter selbst und ein Zuruecksetzen.
   * Echte Nutzer sehen davon nichts. */
  rateLimits: {
    login: loginLimiter,
    register: registerLimiter,
    clear: () => { loginLimiter.clear(); registerLimiter.clear(); },
  },
};