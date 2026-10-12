'use strict';
/* Sicherheitstests: node --test server/test/security.test.js
 *
 * Abgedeckt sind die drei Angriffe, gegen die der Login sonst wehrlos war:
 *   - Brute-Force auf ein Konto (Fehlversuche zaehlen, Sperre, Reset)
 *   - Aufspueren existierender E-Mail-Adressen ueber die Sperrantwort
 *   - Registrierungsflut, die die Datenbank mit Wegwerf-Konten fuellt
 *
 * Ausserdem das Wachstum: abgelaufene Sessions muessen verschwinden, und der
 * Limiter darf nicht unbegrenzt wachsen.
 *
 * Wie in server.test.js: Wegwerf-Datenverzeichnis via FW_DATA_DIR, kein
 * Eingriff in echte Nutzerdaten. Fuer die Limiter-Tests wird eine injizierte
 * Uhr benutzt - sonst muesste der Test Minuten warten.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'federwerk-sec-'));
process.env.FW_DATA_DIR = TMP;
process.env.FW_FILES_DIR = path.join(TMP, 'files');
process.env.FW_ARCHIVE_DIR = path.join(TMP, 'archive');
fs.mkdirSync(process.env.FW_FILES_DIR, { recursive: true });
fs.mkdirSync(process.env.FW_ARCHIVE_DIR, { recursive: true });

// Schwellen klein, damit die Tests schnell sind. Im Betrieb sind die
// Defaults aus auth.js deutlich strenger.
process.env.FW_LOGIN_MAX_FAILS = '3';
process.env.FW_LOGIN_LOCK_MS = String(60 * 1000);

const db = require('../db.js');
const auth = require('../auth.js');
const { createLimiter } = require('../ratelimit.js');

test.after(() => { db.closeAll(); fs.rmSync(TMP, { recursive: true, force: true }); });

/* Jeder Test beginnt mit sauberen Zaehlern - sonst wuerde ein Sperrtreffer
 * aus dem vorherigen Test in den naechsten durchschlagen. */
test.beforeEach(() => auth.rateLimits.clear());

const LOCK = 60 * 1000;

/* ---------------------------------------------------------- Limiter-API */

test('ratelimit: erst nach limit Fehlversuchen gesperrt, Sperre verlaengert nicht', () => {
  let t = 1000;
  const l = createLimiter({ limit: 3, baseMs: 1000, factor: 2, maxMs: 8000, now: () => t });

  l.fail('k'); l.fail('k');
  assert.strictEqual(l.check('k').blocked, false, 'zwei Fehlversuche sperren noch nicht');
  assert.strictEqual(l.check('k').count, 2, 'check() zaehlt nicht selbst');

  const s = l.fail('k');
  assert.strictEqual(s.blocked, true, 'der dritte Fehlversuch sperrt');
  assert.strictEqual(s.retryAfterMs, 1000, 'erste Sperrzeit = baseMs');

  // Weitere Fehlversuche waehrend der Sperre duerfen sie nicht verlaengern -
  // sonst wuerde ein Skript sein eigenes Konto dauerhaft unbrauchbar machen.
  t += 500;
  const nochmal = l.fail('k');
  assert.strictEqual(nochmal.retryAfterMs, 500, 'Sperrzeit wird nicht verlaengert');
});

test('ratelimit: Sperrzeit verdoppelt sich und ist gedeckelt', () => {
  let t = 0;
  const l = createLimiter({ limit: 2, baseMs: 1000, factor: 2, maxMs: 5000, now: () => t });

  const sperren = [];
  for (let i = 0; i < 6; i++) {
    // Jede Runde: genug Fehlversuche, um die Schwelle zu erreichen. Mit
    // limit=2 sperrt erst der ZWEITE Versuch, nicht der erste.
    l.fail('k'); l.fail('k');
    sperren.push(l.check('k').retryAfterMs);
    // Sperre abwarten, damit der naechste Versuch sie wirklich neu setzt.
    t += sperren[i] + 1;
  }
  assert.deepStrictEqual(sperren, [1000, 2000, 4000, 5000, 5000, 5000],
    'exponentiell, aber nie ueber maxMs hinaus');

  const spaet = l.check('k');
  assert.strictEqual(spaet.retryAfterMs, 0, 'nach Ablauf ist wieder offen');
});

test('ratelimit: ok() setzt zurueck, check() veraendert nichts', () => {
  const l = createLimiter({ limit: 3, baseMs: 1000, now: () => 0 });
  l.fail('k'); l.fail('k');
  l.ok('k');
  assert.strictEqual(l.check('k').count, 0, 'nach Erfolg ist der Zaehler weg');
  l.fail('k'); l.fail('k');
  assert.strictEqual(l.check('k').blocked, false, 'zwei neue Fehlversuche sperren nicht');
});

test('ratelimit: Speicher ist begrenzt - tausende Schluessel bleiben in der Map', () => {
  let t = 0;
  const MAX = 50;
  const l = createLimiter({ limit: 5, baseMs: 1000, maxMs: 1000, maxEntries: MAX, idleMs: 1000, now: () => t });
  for (let i = 0; i < 5000; i++) l.fail(`angreifer-${i}@example.org`);
  assert.ok(l.size() <= MAX, `Map darf nicht wachsen: ${l.size()} > ${MAX}`);

  // ...und abgelaufene Eintraege werden auch ohne Druck ausgeräumt.
  t += 100000;
  l.sweep();
  assert.strictEqual(l.size(), 0, 'nach Ablauf raeumt der Sweep restlos auf');
});

/* ---------------------------------------------------------------- Login */

test('login: Sperre nach 3 Fehlversuchen, danach 429 mit Sperrhinweis', () => {
  auth.createUser('sperre@example.org', 'passwort123');

  for (let i = 0; i < 3; i++) {
    assert.throws(() => auth.login('sperre@example.org', 'falsch', 'test', '10.0.0.1'),
      (e) => e.status === 401, `Versuch ${i + 1} ist noch ein normaler Fehlversuch`);
  }
  assert.throws(
    () => auth.login('sperre@example.org', 'passwort123', 'test', '10.0.0.1'),
    (e) => e.status === 429 && /gesperrt/i.test(e.message),
    'der naechste Versuch wird gesperrt, auch MIT dem richtigen Passwort'
  );
});

test('login: die Sperre greift vor dem Hash - ein gesperrter Versuch ist billig', () => {
  auth.createUser('teuer@example.org', 'passwort123');
  const key = 'login:mail:teuer@example.org';
  for (let i = 0; i < 3; i++) {
    assert.throws(() => auth.login('teuer@example.org', 'falsch', 't', '10.0.0.2'), (e) => e.status === 401);
  }
  assert.ok(auth.rateLimits.login.check(key).blocked);

  // Ein gesperrter Aufruf darf den Zaehler NICHT weiter hochzaehlen - sonst
  // waere die Sperrzeit unbegrenzt verlaengerbar.
  const vorher = auth.rateLimits.login.peek(key).count;
  assert.throws(() => auth.login('teuer@example.org', 'falsch', 't', '10.0.0.2'));
  assert.strictEqual(auth.rateLimits.login.peek(key).count, vorher, 'kein Zaehlen im gesperrten Zustand');
});

test('login: IP-Schluessel sperrt Spray-Angriffe ueber viele Konten', () => {
  auth.createUser('ziel-a@example.org', 'passwort123');
  auth.createUser('ziel-b@example.org', 'passwort123');

  // Drei Versuche auf zwei Konten von derselben IP: kein einzelnes Konto
  // erreicht die Schwelle, die IP schon.
  const ip = '10.0.0.3';
  assert.throws(() => auth.login('ziel-a@example.org', 'falsch', 't', ip));
  assert.throws(() => auth.login('ziel-b@example.org', 'falsch', 't', ip));
  assert.throws(() => auth.login('gibt-es-nicht@example.org', 'falsch', 't', ip));
  assert.throws(
    () => auth.login('ziel-a@example.org', 'passwort123', 't', ip),
    (e) => e.status === 429,
    'die IP ist gesperrt, auch wenn das Passwort richtig waere'
  );
});

test('login: kein Orakel - unbekannte und bekannte E-Mail verhalten sich gleich', () => {
  auth.createUser('real@example.org', 'passwort123');

  const beobachten = (adresse, ip) => {
    auth.rateLimits.clear();
    const antworten = [];
    for (let i = 0; i < 3; i++) {
      try { auth.login(adresse, 'falsch', 't', ip); antworten.push({ ok: true }); }
      catch (e) { antworten.push({ status: e.status, message: e.message }); }
    }
    try { auth.login(adresse, 'falsch', 't', ip); antworten.push({ ok: true }); }
    catch (e) { antworten.push({ status: e.status, message: e.message }); }
    return antworten;
  };

  const bekannt = beobachten('real@example.org', '10.0.0.4');
  const unbekannt = beobachten('erfindet@example.org', '10.0.0.5');

  assert.deepStrictEqual(unbekannt, bekannt,
    'unbekannte E-Mail: exakt derselbe Verlauf von Status und Meldung');
  assert.ok(!JSON.stringify(bekannt).includes('existiert'),
    'die Meldung darf nichts ueber die Existenz der Adresse verraten');
});

test('login: IP und Port werden normalisiert, IPv4-mapped IPv6 ist dieselbe Adresse', () => {
  auth.createUser('norm@example.org', 'passwort123');
  const k1 = 'login:ip:203.0.113.9';
  for (let i = 0; i < 3; i++) assert.throws(() => auth.login('norm@example.org', 'falsch', 't', '203.0.113.9'));

  assert.ok(auth.rateLimits.login.check(k1).blocked, 'gesperrt ueber die reine IP');
  assert.throws(
    () => auth.login('norm@example.org', 'passwort123', 't', '::ffff:203.0.113.9:54321'),
    (e) => e.status === 429,
    'IPv4-mapped IPv6 mit Port umgeht die Sperre nicht'
  );
});

test('login: ein erfolgreicher Login setzt den Zaehler zurueck', () => {
  auth.createUser('reset@example.org', 'passwort123');
  const key = 'login:mail:reset@example.org';

  assert.throws(() => auth.login('reset@example.org', 'falsch', 't', '10.0.0.6'), (e) => e.status === 401);
  assert.throws(() => auth.login('reset@example.org', 'falsch', 't', '10.0.0.6'), (e) => e.status === 401);
  assert.strictEqual(auth.rateLimits.login.peek(key).count, 2);

  const s = auth.login('reset@example.org', 'passwort123', 't', '10.0.0.6');
  assert.ok(s.token, 'der richtige Login gelingt');
  assert.strictEqual(auth.rateLimits.login.peek(key).count, 0, 'Zaehler ist zurueckgesetzt');

  // Und die Schonfrist gilt auch fuer die IP.
  assert.strictEqual(auth.rateLimits.login.check('login:ip:10.0.0.6').count, 0);
});

/* -------------------------------------------------------- Registrierung */

test('register: Registrierung wird pro IP begrenzt', () => {
  const ip = '10.1.1.1';
  // Der Default erlaubt 5 Versuche; der Test macht daraus 5 Konten und den
  // sechsten Versuch.
  for (let i = 0; i < 5; i++) {
    const u = auth.createUser(`flut-${i}@example.org`, 'passwort123', 'Flut', ip);
    assert.ok(u.id, `Registrierung ${i + 1} muss erst einmal klappen`);
  }
  assert.throws(
    () => auth.createUser('flut-6@example.org', 'passwort123', 'Flut', ip),
    (e) => e.status === 429 && /gesperrt/i.test(e.message),
    'der sechste Versuch von derselben IP wird gesperrt'
  );

  // Eine andere IP ist unbeeinflusst - Sperren sind pro Schluessel.
  assert.doesNotThrow(() => auth.createUser('flut-andere-ip@example.org', 'passwort123', 'X', '10.1.1.2'));
});

test('register: auch Fehlversuche zaehlen - kein scrypt auf Abfall', () => {
  const ip = '10.1.1.3';
  // Die Grenze liegt bei 5 Versuchen pro IP, und JEDER Versuch zaehlt -
  // auch einer, der mit einem Fehler abgelehnt wird.
  //  1: Anlage (ok)      2+3: Dubletten (409)     4+5: ungueltig (400)
  // Der 6. Versuch ist gesperrt. Dass die Fehlschlaege mitzaehlen, sieht man
  // daran, dass ein vollstaendig gueltiges Konto abgelehnt wird: wuerden 400
  // und 409 nicht zaehlen, waeren sie ein kostenloser scrypt-Hebel.
  auth.createUser('doppelt@example.org', 'passwort123', 'X', ip);
  for (let i = 0; i < 2; i++) {
    assert.throws(() => auth.createUser('doppelt@example.org', 'passwort123', 'X', ip), /bereits registriert/);
  }
  for (let i = 0; i < 2; i++) {
    assert.throws(() => auth.createUser(`neu-${i}@example.org`, 'kurz', 'X', ip), /mindestens 8/);
  }
  assert.throws(
    () => auth.createUser('soll-nicht-mehr-gehen@example.org', 'passwort123', 'X', ip),
    (e) => e.status === 429,
    'nach 5 Versuchen von dieser IP ist die naechste Registrierung gesperrt'
  );
  assert.strictEqual(
    db.auth().prepare('SELECT count(*) n FROM users WHERE email=?').get('soll-nicht-mehr-gehen@example.org').n,
    0, 'und es wurde tatsaechlich kein Konto angelegt'
  );
});

test('register: ohne bekannte IP wird nicht gezaehlt (Aufrufe aus dem Prozess)', () => {
  for (let i = 0; i < 12; i++) {
    assert.doesNotThrow(() => auth.createUser(`intern-${i}@example.org`, 'passwort123'),
      'server.test.js registriert viele Nutzer ohne IP - das darf nicht sperren');
  }
});

/* -------------------------------------------------------------- Sessions */

test('sessions: purgeSessions raeumt ab, gueltige bleiben unberuehrt', () => {
  const u = auth.createUser('purge@example.org', 'passwort123');
  const alt = auth.issue(u.id, 'test');
  const neu = auth.issue(u.id, 'test');

  const th = (t) => crypto.createHash('sha256').update(t).digest('hex');
  db.auth().prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
    .run(Date.now() - 1000, th(alt.token));

  const entfernt = auth.purgeSessions();
  assert.strictEqual(entfernt, 1, 'genau die abgelaufene Zeile');
  assert.strictEqual(db.auth().prepare('SELECT count(*) n FROM sessions WHERE token_hash=?').get(th(alt.token)).n, 0);
  assert.ok(auth.resolve(neu.token), 'die gueltige Session lebt noch');
});

test('sessions: eine neue Session raeumt die alten mit auf', () => {
  const u = auth.createUser('mitraeum@example.org', 'passwort123');
  const a = auth.issue(u.id);
  const b = auth.issue(u.id);
  const c = auth.issue(u.id);

  const th = (t) => crypto.createHash('sha256').update(t).digest('hex');
  // Zwei Sitzungen kuenfig machen - resolve() wuerde sie nie wieder anschauen.
  db.auth().prepare('UPDATE sessions SET expires_at = ? WHERE token_hash IN (?,?)')
    .run(Date.now() - 1000, th(a.token), th(b.token));

  const d = auth.issue(u.id, 'test'); // issue() raeumt mit
  for (const t of [a.token, b.token]) {
    assert.strictEqual(auth.resolve(t), null, 'abgelaufene Session ist ungueltig');
    assert.strictEqual(db.auth().prepare('SELECT count(*) n FROM sessions WHERE token_hash=?').get(th(t)).n, 0,
      'und auch aus der Tabelle verschwunden');
  }
  assert.ok(auth.resolve(d.token), 'die neue Session gilt');
});

test('sessions: das Wachstum ist begrenzt, nicht nur die Sichtbarkeit', () => {
  const u = auth.createUser('wachstum@example.org', 'passwort123');
  for (let i = 0; i < 25; i++) auth.issue(u.id, 'test');
  const vorher = db.auth().prepare('SELECT count(*) n FROM sessions').get().n;

  // Alle Sitzungen kuenstlich altern lassen.
  db.auth().prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1000);
  auth.purgeSessions();

  assert.strictEqual(db.auth().prepare('SELECT count(*) n FROM sessions').get().n, 0,
    'die Tabelle ist leer, nicht nur unbrauchbar');
  assert.ok(vorher >= 25);
});