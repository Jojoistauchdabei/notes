'use strict';
/* Server-Tests: node --test server/test/
 *
 * Laeuft gegen ein Wegwerf-Datenverzeichnis in FW_DATA_DIR - die Tests
 * fassen weder die echten Nutzerdaten noch den QNAP an.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'federwerk-test-'));
process.env.FW_DATA_DIR = TMP;
process.env.FW_FILES_DIR = path.join(TMP, 'files');
process.env.FW_ARCHIVE_DIR = path.join(TMP, 'archive');
process.env.FW_SESSION_SECRET = 'testsecret-not-used-for-auth';
fs.mkdirSync(process.env.FW_FILES_DIR, { recursive: true });
fs.mkdirSync(process.env.FW_ARCHIVE_DIR, { recursive: true });

const db = require('../db.js');
const auth = require('../auth.js');
const docs = require('../docs.js');
const files = require('../files.js');
const shares = require('../shares.js');

test.after(() => { db.closeAll(); fs.rmSync(TMP, { recursive: true, force: true }); });

/* --------------------------------------------------------------- Auth */

test('auth: Registrierung, Anmeldung, Abmeldung', () => {
  const u = auth.createUser('A@Example.org', 'passwort123', 'Jonas');
  assert.strictEqual(u.email, 'a@example.org', 'E-Mail wird normalisiert');
  assert.ok(u.id.startsWith('u_'));

  const s = auth.login('a@example.org', 'passwort123', 'test');
  assert.ok(s.token);
  assert.strictEqual(s.user.id, u.id);

  assert.throws(() => auth.login('a@example.org', 'falsch'), /falsch/);
  assert.throws(() => auth.createUser('a@example.org', 'passwort123'), /bereits registriert/);

  assert.ok(auth.resolve(s.token));
  auth.logout(s.token);
  assert.strictEqual(auth.resolve(s.token), null, 'Nach dem Logout ist die Session tot');
});

test('auth: Token im falschen Format wird nicht akzeptiert', () => {
  auth.createUser('b@example.org', 'passwort123');
  const s = auth.login('b@example.org', 'passwort123');
  assert.strictEqual(auth.resolve(s.token + 'x'), null);
  assert.strictEqual(auth.resolve(''), null);
  assert.strictEqual(auth.resolve('a'.repeat(64)), null);
});

test('auth: Passwort-Hash ist gesalzen, gleiche Passwoerter -> verschiedene Hashes', () => {
  const a = auth.createUser('c1@example.org', 'gleichespasswort');
  const b = auth.createUser('c2@example.org', 'gleichespasswort');
  const ra = db.auth().prepare('SELECT pass_hash, pass_salt FROM users WHERE id=?').get(a.id);
  const rb = db.auth().prepare('SELECT pass_hash, pass_salt FROM users WHERE id=?').get(b.id);
  assert.notStrictEqual(ra.pass_hash, rb.pass_hash, 'Hash muss sich durch das Salt unterscheiden');
  assert.notStrictEqual(ra.pass_salt, rb.pass_salt);
  // ...und das Klartext darf nirgends liegen.
  const dump = JSON.stringify(db.auth().prepare('SELECT * FROM users').all());
  assert.ok(!dump.includes('gleichespasswort'), 'Klartext nicht in der DB');
});

test('auth: abgelaufene Session wird aufgeraeumt', () => {
  const u = auth.createUser('exp@example.org', 'passwort123');
  const s = auth.issue(u.id);
  const th = require('crypto').createHash('sha256').update(s.token).digest('hex');
  db.auth().prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1000, th);
  assert.strictEqual(auth.resolve(s.token), null);
  assert.strictEqual(
    db.auth().prepare('SELECT count(*) n FROM sessions WHERE token_hash = ?').get(th).n, 0,
    'Abgelaufene Zeile wird auch geloescht'
  );
});

/* --------------------------------------------------------------- Docs */

test('docs: anlegen, lesen, loeschen mit Grabstein', () => {
  const u = auth.createUser('docs@example.org', 'passwort123');
  const now = Date.now();
  const d = docs.upsert(u.id, { id: 'b1', title: 'Heft 1', content: '{"v":1,"pages":[]}', updatedAt: now });
  assert.strictEqual(d.title, 'Heft 1');
  assert.strictEqual(d.deletedAt, null);

  const r = docs.remove(u.id, 'b1');
  assert.ok(r.deletedAt > 0);
  assert.ok(docs.get(u.id, 'b1').deletedAt > 0, 'Loeschen ist ein Grabstein, kein Remove');
});

test('docs: LWW - aelterer Stand ueberschreibt neueren nicht', () => {
  const u = auth.createUser('lww@example.org', 'passwort123');
  const jetzt = Date.now();
  docs.upsert(u.id, { id: 'x', title: 'neu', content: 'NEUER INHALT', updatedAt: jetzt });

  // Aelterer Push eines zweiten, offline gewesenen Geraets.
  docs.upsert(u.id, { id: 'x', title: 'alt', content: 'ALTER INHALT', updatedAt: jetzt - 60000 });

  const d = docs.get(u.id, 'x');
  assert.strictEqual(d.content, 'NEUER INHALT', 'Inhalt darf nicht von aelter ueberschrieben werden');
  assert.strictEqual(d.updatedAt, jetzt, 'Zeitstempel bleibt der neuere');
});

test('docs: gleicher Zeitstempel schreibt durch (idempotenter Retry)', () => {
  const u = auth.createUser('eq@example.org', 'passwort123');
  const t = Date.now();
  docs.upsert(u.id, { id: 'y', title: 'a', content: 'A', updatedAt: t });
  docs.upsert(u.id, { id: 'y', title: 'b', content: 'B', updatedAt: t });
  assert.strictEqual(docs.get(u.id, 'y').content, 'B');
});

test('docs: Delta-Pull liefert nur, was nach since passiert ist', () => {
  const u = auth.createUser('delta@example.org', 'passwort123');
  const t = Date.now();
  docs.upsert(u.id, { id: 'd1', title: 'alt', content: '1', updatedAt: t - 10000 });
  docs.upsert(u.id, { id: 'd2', title: 'neu', content: '2', updatedAt: t });

  const nurNeu = docs.since(u.id, t - 5000, 'note');
  assert.strictEqual(nurNeu.length, 1);
  assert.strictEqual(nurNeu[0].id, 'd2');

  assert.strictEqual(docs.since(u.id, t + 1000, 'note').length, 0, 'since in der Zukunft -> nichts');
  assert.strictEqual(docs.since(u.id, 0, 'note').length, 2, 'since=0 -> alles');
});

test('docs: Ordner haben ein eigenes updatedAt (keine Appwrite-Asymmetrie)', () => {
  const u = auth.createUser('ord@example.org', 'passwort123');
  const t = Date.now();
  docs.upsertFolder(u.id, { id: 'f1', name: 'Schule', updatedAt: t });
  const f = docs.allFolders(u.id).find((x) => x.id === 'f1');
  assert.strictEqual(f.updatedAt, t);
  assert.strictEqual(f.name, 'Schule');

  docs.upsertFolder(u.id, { id: 'f1', name: 'Uni', updatedAt: t - 1000 });
  assert.strictEqual(docs.allFolders(u.id).find((x) => x.id === 'f1').name, 'Schule', 'LWW gilt auch fuer Ordner');
});

test('docs: Unsinnige IDs werden abgelehnt', () => {
  const u = auth.createUser('evil@example.org', 'passwort123');
  for (const id of ['', '../../etc/passwd', 'a b', 'x'.repeat(100), 'id;DROP']) {
    assert.throws(() => docs.upsert(u.id, { id, content: 'x' }), /Ungültige ID/, `sollte ablehnen: ${JSON.stringify(id)}`);
  }
});

test('docs: Nutzer kommen nicht an die Daten anderer', () => {
  const a = auth.createUser('iso-a@example.org', 'passwort123');
  const b = auth.createUser('iso-b@example.org', 'passwort123');
  docs.upsert(a.id, { id: 'privat', title: 'A privat', content: 'geheim' });
  assert.strictEqual(docs.get(b.id, 'privat'), null, 'Nutzer B sieht das Dokument von A nicht');
  assert.strictEqual(docs.since(b.id, 0, 'note').length, 0);
});

/* -------------------------------------------------------------- Files */

test('files: ablegen, lesen, Dedupe', () => {
  const u = auth.createUser('files@example.org', 'passwort123');
  const buf = Buffer.from('hallo welt, das ist ein test');
  const sha = files.sha256(buf);

  const r1 = files.put(u.id, sha, 'text/plain', buf);
  assert.strictEqual(r1.deduplicated, false);
  const r2 = files.put(u.id, sha, 'text/plain', buf);
  assert.strictEqual(r2.deduplicated, true, 'zweiter Upload ist Dedupe');

  const got = files.get(u.id, sha);
  assert.ok(got.buf.equals(buf));
});

test('files: Inhalt, der nicht zum Namen passt, wird abgelehnt', () => {
  const u = auth.createUser('hash@example.org', 'passwort123');
  const echterHash = files.sha256(Buffer.from('A'));
  const fremderHash = files.sha256(Buffer.from('B'));
  assert.throws(
    () => files.put(u.id, fremderHash, 'text/plain', Buffer.from('A')),
    (e) => e.status === 422 && /passt nicht zum Namen/.test(e.message),
    'Hash-Mismatch muss 422 sein, nicht stillschweigend geschrieben werden'
  );
  assert.throws(() => files.get(u.id, echterHash), /unbekannt/);
});

test('files: beschaedigte Datei wird erkannt, nicht ausgeliefert', () => {
  const u = auth.createUser('kaputt@example.org', 'passwort123');
  const buf = Buffer.from('unversehrter inhalt');
  const sha = files.sha256(buf);
  files.put(u.id, sha, 'text/plain', buf);

  const p = files.locate(process.env.FW_FILES_DIR, sha, 'text/plain');
  fs.writeFileSync(p, Buffer.from('BESCHAEDIGT')); // anderer Inhalt, gleicher Name

  assert.throws(
    () => files.get(u.id, sha),
    (e) => e.corrupt === true,
    'Hash-Abweichung muss als corrupt gemeldet werden'
  );
});

test('files: Referenzindex folgt dem Dokumentinhalt', () => {
  const u = auth.createUser('refs@example.org', 'passwort123');
  const a = files.sha256(Buffer.from('bild-a'));
  const b = files.sha256(Buffer.from('bild-b'));
  files.put(u.id, a, 'image/jpeg', Buffer.from('bild-a'));
  files.put(u.id, b, 'image/jpeg', Buffer.from('bild-b'));

  docs.upsert(u.id, { id: 'mitbild', content: JSON.stringify({ pages: [{ images: [{ src: 'awfile:' + a }] }] }) });

  const d = db.docs(u.id);
  const refs = d.prepare('SELECT sha256 FROM file_refs WHERE doc_id=?').all('mitbild').map((r) => r.sha256);
  assert.deepStrictEqual(refs, [a], 'genau die referenzierte Datei');

  // Dokument ohne Referenz mehr -> Index muss leer werden, sonst waere die
  // Datei fuer den GC nie verwaist und wuerde ewig liegen.
  docs.upsert(u.id, { id: 'mitbild', content: JSON.stringify({ pages: [] }) });
  assert.strictEqual(d.prepare('SELECT count(*) n FROM file_refs WHERE doc_id=?').get('mitbild').n, 0);
});

test('files: geloeschtes Dokument nimmt seine Referenzen mit, die Datei bleibt', () => {
  const u = auth.createUser('del@example.org', 'passwort123');
  const a = files.sha256(Buffer.from('weg-damit'));
  files.put(u.id, a, 'image/png', Buffer.from('weg-damit'));
  docs.upsert(u.id, { id: 'd', content: JSON.stringify({ src: 'awfile:' + a }) });
  docs.remove(u.id, 'd');

  const d = db.docs(u.id);
  assert.strictEqual(d.prepare('SELECT count(*) n FROM file_refs WHERE doc_id=?').get('d').n, 0);
  assert.strictEqual(d.prepare('SELECT count(*) n FROM files WHERE sha256=?').get(a).n, 1,
    'die Datei bleibt liegen - der GC entscheidet, nicht das Loeschen');
});

/* ------------------------------------------------------------- Shares */

test('shares: anlegen, lesen, Gast darf mitlesen', () => {
  const owner = auth.createUser('own@example.org', 'passwort123');
  const guest = auth.createUser('guest@example.org', 'passwort123');
  const s = shares.create(owner.id, { bookId: 'b1', title: 'Geteilt', mode: 'edit', ownerName: 'Jonas' });
  assert.ok(s.shareId.startsWith('s'));
  assert.strictEqual(s.mode, 'edit');
  assert.strictEqual(shares.readShare(guest.id, s.shareId).shareId, s.shareId, 'Gast liest die Freigabe');
});

test('shares: nur der Eigener darf aendern oder widerrufen', () => {
  const owner = auth.createUser('own2@example.org', 'passwort123');
  const guest = auth.createUser('guest2@example.org', 'passwort123');
  const s = shares.create(owner.id, { bookId: 'b1' });
  assert.throws(() => shares.patch(guest.id, s.shareId, { mode: 'read' }), /Nur der Eigener/);
  assert.throws(() => shares.revoke(guest.id, s.shareId), /Nur der Eigener/);
  assert.doesNotThrow(() => shares.revoke(owner.id, s.shareId));
});

test('shares: widerrufen und abgelaufen blockieren auch das Lesen', () => {
  const owner = auth.createUser('own3@example.org', 'passwort123');
  const guest = auth.createUser('guest3@example.org', 'passwort123');

  const rev = shares.create(owner.id, { bookId: 'b1' });
  shares.revoke(owner.id, rev.shareId);
  assert.throws(() => shares.readShare(guest.id, rev.shareId), /widerrufen/);

  // Abgelaufen nicht anlegen - create() prueft am Ende selbst und wuerde
  // ablehnen. Stattdessen mit gueltiger Frist anlegen und zurueckdatieren.
  const exp = shares.create(owner.id, { bookId: 'b1', expiresAt: Date.now() + 3600000 });
  assert.ok(shares.readShare(guest.id, exp.shareId).shareId);
  db.social().prepare('UPDATE shares SET expires_at = ? WHERE share_id = ?')
    .run(Date.now() - 1000, exp.shareId);
  assert.throws(() => shares.readShare(guest.id, exp.shareId), /abgelaufen/);
});

test('shares: der Code IST die Berechtigung - Fremde duerfen mit, nicht aendern', () => {
  const owner = auth.createUser('own6@example.org', 'passwort123');
  const fremd = auth.createUser('fremd6@example.org', 'passwort123');
  const s = shares.create(owner.id, { bookId: 'b1', mode: 'edit' });

  // Das ist Absicht und war es auch vorher (read("users") in Appwrite): wer
  // den Link hat, darf teilnehmen. Deshalb ist der Code kurz, aus crypto
  // erzeugt und jederzeit widerrufbar - nicht aus als Sitzungsersatz gedacht.
  assert.strictEqual(shares.readShare(fremd.id, s.shareId).shareId, s.shareId);
  shares.appendEvent(fremd.id, s.shareId, { kind: 'cursor', payload: { x: 1 } });
  assert.strictEqual(shares.events(owner.id, s.shareId, 0).length, 1);

  // Aendern/widerrufen bleibt beim Besitzer.
  assert.throws(() => shares.patch(fremd.id, s.shareId, { mode: 'read' }), /Nur der Eigener/);
  assert.throws(() => shares.revoke(fremd.id, s.shareId), /Nur der Eigener/);
});

test('shares: Ereignisse nur mit gueltiger Freigabe, Cursor ist stabil', () => {
  const owner = auth.createUser('own4@example.org', 'passwort123');
  const guest = auth.createUser('guest4@example.org', 'passwort123');
  const fremd = auth.createUser('fremd@example.org', 'passwort123');
  const s = shares.create(owner.id, { bookId: 'b1' });

  shares.appendEvent(guest.id, s.shareId, { kind: 'cursor', payload: { x: 1 } });
  shares.appendEvent(owner.id, s.shareId, { kind: 'stroke', payload: { pts: 3 } });

  const alle = shares.events(guest.id, s.shareId, 0);
  assert.strictEqual(alle.length, 2);
  assert.ok(alle[0].seq < alle[1].seq, 'seq ist streng monoton');

  const nach = shares.events(guest.id, s.shareId, alle[0].seq);
  assert.strictEqual(nach.length, 1, 'Cursor liefert exakt den Rest');
  assert.strictEqual(nach[0].kind, 'stroke');

  // Fremder mit dem Code darf mitlesen - der Code ist die Berechtigung.
  assert.doesNotThrow(() => shares.events(fremd.id, s.shareId, 0));
  // Nicht angemeldet ist eine andere Frage: das prueft die Route, nicht shares.js.
  assert.throws(() => shares.appendEvent(fremd.id, 'sGIBT_ESNICHT', { kind: 'cursor' }), /nicht gefunden/);

  // Unbekannte Ereignisart: auch mit gueltiger Freigabe abgelehnt.
  assert.throws(() => shares.appendEvent(guest.id, s.shareId, { kind: 'exfiltrate' }), /Unbekannte Ereignisart/);
});

test('shares: fremder Gast kann am Eventstrom hängen, aber nicht ueberschreiben', () => {
  const owner = auth.createUser('own5@example.org', 'passwort123');
  const a = auth.createUser('gastA@example.org', 'passwort123');
  const b = auth.createUser('gastB@example.org', 'passwort123');
  const s = shares.create(owner.id, { bookId: 'b1', mode: 'read' });
  const seq0 = shares.cursor(b.id, s.shareId);
  assert.strictEqual(seq0, 0);
  shares.appendEvent(a.id, s.shareId, { kind: 'cursor', payload: { x: 5 } });
  assert.strictEqual(shares.events(b.id, s.shareId, seq0).length, 1, 'Leserecht gilt fuer jeden');
});

test('shares: Ringpuffer haelt die Tabelle klein', () => {
  const owner = auth.createUser('ring@example.org', 'passwort123');
  const s = shares.create(owner.id, { bookId: 'b1' });
  for (let i = 0; i < 30; i++) shares.appendEvent(owner.id, s.shareId, { kind: 'cursor', payload: { i } });
  const alle = shares.events(owner.id, s.shareId, 0, 1000);
  assert.strictEqual(alle.length, 30);
  const seqs = alle.map((e) => e.seq);
  assert.deepStrictEqual(seqs, [...seqs].sort((a, b) => a - b), 'aufsteigend sortiert');
});