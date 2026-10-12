'use strict';
/* Federwerk: Liveshare-Freigaben.
 *
 * Freigabe-Code ist die Zeilen-ID (wie bisher s + 11 Zeichen), damit ein
 * geteilter Link keine zweite Zuordnung braucht.
 *
 * Der Sicherheitskern dieser Datei ist readShare() plus appendEvent(). In
 * Appwrite hat das eine Function erzwungen (functions/share-events-guard):
 * share_events waren fuer jeden angemeldeten Nutzer lesbar, aber nur ueber
 * eine Function beschreibbar, die Session und Freigabestatus selbst prueft.
 * Hier laeuft beides im selben Prozess - die Pruefung ist damit nicht mehr
 * von einem erreichbaren Nebenpfad abhaengig, sondern vom einen Weg, den der
 * Code auch wirklich nimmt.
 *
 * ---- Warum eine geteilte Datenbank ----
 * Freigaben sind die einzige Datenklasse, die nutzeruebergreifend ist: der
 * Gast sitzt in einer anderen Datenbank als der Besitzer. Ein Lookup aus der
 * Gast-DB heraus wuerde die Zeile nie finden - der erste Versuch, shares in
 * users/<id>/docs.db zu legen, ist genau daran gescheitert: der Gast sieht
 * seine eigene Einladung nicht. Sie liegen deshalb in social.db
 * (server/db.js, SOCIAL_SCHEMA), Schema-Definition nur an einer Stelle.
 *
 * Das ist die eine bewusste Ausnahme von "SQLite pro Nutzer". Die
 * Zugriffskontrolle steht nicht im Datenmodell, sondern hier: Lesen ist an
 * eine gueltige Freigabe gebunden, Aendern und Widerrufen an den Besitzer.
 */

const crypto = require('crypto');
const db = require('./db.js');

/* Die Ereignisarten des Clients - exakt diese elf, in dieser Schreibweise.
 *
 * Diese Liste ist eine Vereinbarung zwischen server/shares.js und
 * js/liveshare.js (dort KINDS). Sie war zuerst geraten und falsch: der
 * Server kannte "stroke", "text", "sync", der Client sendet aber
 * "stroke-add", "text-upsert", "sync-chunk". Neun von elf Arten wuerden mit
 * 400 "Unbekannte Ereignisart" abgewiesen - der Fehler faellt erst auf, wenn
 * zwei echte Geraete miteinander live teilen.
 *
 * Deshalb haengt an der Liste ein Test: server/test/share-kinds.test.js liest
 * die KINDS aus js/liveshare.js und vergleicht sie mit dieser. Wer eine Seite
 * aendert, ohne die andere zu beruehren, bekommt einen roten Test statt eines
 * stillen Live-Bruchs.
 */
const KINDS = new Set([
  // Anwesenheit
  'hello', 'heartbeat', 'bye', 'cursor',
  // Aenderungen am Dokument
  'stroke-add', 'stroke-del', 'text-upsert', 'text-del',
  // Abgleich grosser Schnipsel
  'sync-request', 'sync-state', 'sync-chunk',
]);
const MAX_EVENTS = 20000; // Ringpuffer: haelt die Tabelle auch ohne Aufraeum-Job klein
/* Freigabe-Codes: 11 Zeichen aus [a-z0-9], Praefix "s".
 *
 * Das Alphabet ist NICHT frei gewaehlt, sondern vom Client vorgegeben:
 * js/liveshare.js prueft jeden eingehenden Code gegen /^s[a-z0-9]{11}$/.
 * Ein Code mit Grossbuchstaben - oder mit dem '-' und '_' aus base64url -
 * wird vom eigenen Client als "shareId ungueltig" verworfen, und weil der
 * Sendeweg seinen Fehler mit .catch(() => null) schluckt, faellt das nur
 * als "nichts kommt an" auf.
 *
 * Das Modulo ist bewusst mit Ausschluss: 256 % 36 = 4, ein blinder %36
 * bevorzugt also die ersten vier Zeichen des Alphabets. 252 = 7 * 36, und
 * nur Werte 0..251 werden verwendet - damit ist jeder Buchstabe gleich
 * wahrscheinlich.
 */
const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const CODE_REJECT_AT = 252; // 7 * 36
const MAX_PAYLOAD = 256 * 1024;

function shareCode() {
  const bytes = crypto.randomBytes(32);
  let out = '';
  for (let i = 0; i < bytes.length && out.length < 11; i++) {
    if (bytes[i] >= CODE_REJECT_AT) continue;
    out += CODE_ALPHABET[bytes[i] % 36];
  }
  // 32 Zufallsbytes reichen fuer 11 Zeichen praktisch immer; die Schleife
  // kann theoretisch zu kurz bleiben, dann wird schlicht neu gewuerfelt.
  return out.length === 11 ? 's' + out : 's' + crypto.randomBytes(9).toString('hex').slice(0, 11);
}

// Der Client-Pfad. server/test/share-code.test.js haelt beides zusammen.
const CODE_RE = /^s[a-z0-9]{11}$/;

const ensure = () => db.social();

function bad(msg) { const e = new Error(msg); e.status = 400; return e; }
function forbidden(msg) { const e = new Error(msg || 'Kein Zugriff.'); e.status = 403; return e; }

function rowToShare(r) {
  if (!r) return null;
  return {
    shareId: r.share_id,
    bookId: r.book_id,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    title: r.title,
    mode: r.mode,
    pageId: r.page_id,
    expiresAt: r.expires_at,
    revoked: !!r.revoked,
    snapshot: r.snapshot,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* Freigabe lesen. Erlaubt fuer jeden angemeldeten Nutzer, sofern sie nicht
 * abgelaufen oder widerrufen ist - so war es auch vorher (read("users")). */
function readShare(userId, shareId) {
  const s = ensure().prepare('SELECT * FROM shares WHERE share_id = ?').get(String(shareId || ''));
  if (!s) { const e = new Error('Freigabe nicht gefunden.'); e.status = 404; throw e; }
  const share = rowToShare(s);
  if (share.revoked) throw forbidden('Diese Freigabe wurde widerrufen.');
  if (share.expiresAt && share.expiresAt <= Date.now()) throw forbidden('Diese Freigabe ist abgelaufen.');
  return share;
}

function ownShare(userId, shareId) {
  const s = readShare(userId, shareId);
  if (s.ownerId !== userId) throw forbidden('Nur der Eigener darf die Freigabe aendern.');
  return s;
}

function create(userId, input) {
  const d = ensure();
  const bookId = String((input && input.bookId) || '');
  if (!bookId || bookId.length > 64) throw bad('bookId fehlt.');
  const mode = (input && input.mode) === 'edit' ? 'edit' : 'read';
  const now = Date.now();
  const shareId = shareCode();
  let snapshot = String((input && input.snapshot) || '');
  if (Buffer.byteLength(snapshot, 'utf8') > 512 * 1024) snapshot = '';

  d.prepare(
    `INSERT INTO shares (share_id, book_id, owner_id, owner_name, title, mode, page_id, expires_at, revoked, snapshot, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,0,?,?,?)`
  ).run(
    shareId, bookId, userId,
    String((input && input.ownerName) || '').slice(0, 64),
    String((input && input.title) || '').slice(0, 160),
    mode,
    input && input.pageId ? String(input.pageId).slice(0, 64) : null,
    input && input.expiresAt ? Number(input.expiresAt) : null,
    snapshot, now, now
  );
  return readShare(userId, shareId);
}

function patch(userId, shareId, input) {
  const cur = ownShare(userId, shareId);
  const d = ensure();
  const now = Date.now();
  const mode = input && input.mode ? (input.mode === 'edit' ? 'edit' : 'read') : cur.mode;
  const revoked = input && input.revoked !== undefined ? (input.revoked ? 1 : 0) : (cur.revoked ? 1 : 0);
  d.prepare('UPDATE shares SET mode = ?, revoked = ?, expires_at = ?, updated_at = ? WHERE share_id = ?')
    .run(mode, revoked,
         input && input.expiresAt !== undefined ? Number(input.expiresAt) || null : cur.expiresAt,
         now, cur.shareId);
  return readShare(userId, cur.shareId);
}

function revoke(userId, shareId) {
  const cur = ownShare(userId, shareId);
  ensure().prepare('UPDATE shares SET revoked = 1, updated_at = ? WHERE share_id = ?')
    .run(Date.now(), cur.shareId);
  return { shareId: cur.shareId, revoked: true };
}

function listOwned(userId) {
  return ensure().prepare('SELECT * FROM shares WHERE owner_id = ? ORDER BY created_at DESC')
    .all(userId).map(rowToShare);
}

/* Event anhaengen. Die Reihenfolge ist die Absicherung:
 *   1. Nutzer angemeldet (Aufrufer hat das schon geprueft)
 *   2. Freigabe existiert, ist nicht widerrufen, nicht abgelaufen
 *   3. Art der Operation bekannt
 *   4. Groesse im Rahmen
 * Erst danach wird geschrieben. Ein Gast ohne gueltige Freigabe erreicht
 * den INSERT nicht.
 */
function appendEvent(userId, shareId, input) {
  const share = readShare(userId, shareId);
  const kind = String((input && input.kind) || '');
  if (!KINDS.has(kind)) throw bad(`Unbekannte Ereignisart: ${kind}`);
  const payload = typeof (input && input.payload) === 'string'
    ? input.payload
    : JSON.stringify((input && input.payload) || {});
  if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD) throw bad('Ereignis zu gross.');

  const d = ensure();
  const now = Date.now();
  d.prepare(
    'INSERT INTO share_events (share_id, user_id, user_name, user_color, kind, payload, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(share.shareId, userId,
        String((input && input.userName) || '').slice(0, 64),
        String((input && input.userColor) || '').slice(0, 16),
        kind, payload, now);

  // Ringpuffer nachziehen. Ohne das waechst die Tabelle unbegrenzt; die
  // Freigabe-Option expires_at begrenzt nur die Sichtbarkeit, nicht den Speicher.
  const r = d.prepare('SELECT max(seq) AS m FROM share_events WHERE share_id = ?').get(share.shareId);
  if (r && r.m > MAX_EVENTS) {
    d.prepare('DELETE FROM share_events WHERE share_id = ? AND seq <= ?').run(share.shareId, r.m - MAX_EVENTS);
  }
  return { shareId: share.shareId, kind, createdAt: now };
}

/* Events seit einem Cursor. Der Cursor ist die seq, nicht die Zeit - bei
 * gleicher Millisekunde waere eine Zeitgrenze nicht eindeutig, und genau
 * daran haengt, ob ein Strich beim Gast ankommt oder fehlt. */
function events(userId, shareId, afterSeq, limit) {
  const share = readShare(userId, shareId);
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const rows = ensure().prepare(
    'SELECT seq, share_id, user_id, user_name, user_color, kind, payload, created_at FROM share_events WHERE share_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
  ).all(share.shareId, Number(afterSeq) || 0, lim);
  return rows.map((r) => ({
    seq: r.seq,
    shareId: r.share_id,
    userId: r.user_id,
    userName: r.user_name,
    userColor: r.user_color,
    kind: r.kind,
    payload: r.payload,
    createdAt: r.created_at,
  }));
}

const cursor = (userId, shareId) => {
  const r = ensure().prepare('SELECT max(seq) AS m FROM share_events WHERE share_id = ?').get(String(shareId));
  return r && r.m ? r.m : 0;
};

module.exports = {
  ensure, create, readShare, ownShare, patch, revoke, appendEvent,
  events, cursor, listOwned, rowToShare, KINDS,
};