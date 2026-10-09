'use strict';
/* Federwerk: SQLite-Zugriff.
 *
 * Zwei Datenbanken, aus zwei Gruenden bewusst getrennt:
 *
 *   auth.db            users + sessions. Wird bei JEDEM Login gelesen. Laege
 *                     die Zuordnung Nutzer->Datenbank hier drin, muesste
 *                     man beim Login erst ueber alle Nutzer-DBs gehen, um
 *                     das Passwort zu finden. Also: eine flache Tabelle, ein
 *                     Index, fertig.
 *
 *   users/<id>/docs.db Everything, was dem Nutzer gehoert: Dokumente,
 *                     Ordner, Anteile, Datei-Ablage, Freigaben.
 *
 * Damit ist "SQLite pro Nutzer" woertlich umgesetzt und die Isolierung
 * faellt nebenbei ab: ein Nutzer kann strukturell nicht in die Daten eines
 * anderen lesen, weil sein SQL-Handle nur auf sein eigenes File zeigt.
 *
 * SQLite bleibt absichtlich auf der LOKALEN Platte. Die Dateien der Nutzer
 * liegen auf dem QNAP (SMB/CIFS), eine SQLite-Datei gehoert dort nicht hin:
 * CIFS ohne POSIX-Semantik (nounix) und ohne Byte-Range-Locks traegt das
 * Locking- und Journal-Verhalten, auf das sich SQLite verlaesst, nicht.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.FW_DATA_DIR || '/srv/federwerk/data';

const DOCS_SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  folder_id  TEXT,
  content    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS idx_docs_updated  ON docs (updated_at);
CREATE INDEX IF NOT EXISTS idx_docs_folder   ON docs (folder_id);

CREATE TABLE IF NOT EXISTS folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  parent_id  TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS idx_folders_updated ON folders (updated_at);
`;

const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  pass_hash  TEXT NOT NULL,
  pass_salt  TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
`;

/* Freigaben sind die eine Datenklasse, die per Definition NUTZERUEBERGREIFEND
 * ist: der Gast liegt in einer anderen Datenbank als der Besitzer. Ein
 * Lookup aus der Gast-DB heraus wuerde die Zeile nie finden - der erste
 * Versuch, shares in users/<id>/docs.db zu legen, ist genau daran gescheitert
 * (der Gast sieht seine eigene Einladung nicht).
 *
 * Also eine eigene, geteilte Datenbank. Die Zugriffskontrolle steht nicht
 * im Datenmodell, sondern in shares.js: Lesen ist an eine gueltige Freigabe
 * gebunden, Schreiben an den Besitzer. */
const SOCIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS shares (
  share_id   TEXT PRIMARY KEY,
  book_id    TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  owner_name TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  mode       TEXT NOT NULL CHECK (mode IN ('read','edit')),
  page_id    TEXT,
  expires_at INTEGER,
  revoked    INTEGER NOT NULL DEFAULT 0,
  snapshot   TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares (owner_id);

CREATE TABLE IF NOT EXISTS share_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  user_name  TEXT NOT NULL DEFAULT '',
  user_color TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_share_events_share ON share_events (share_id, seq);
`;

// Datei-Schema aus schema.sql: die Schnittstelle zu server/gc.js. Bewusst
// nicht hier inline, damit GC und Server garantiert dieselbe Definition
// benutzen - zwei Kopien driften.
function fileSchema() {
  const p = path.join(__dirname, 'schema.sql');
  return fs.readFileSync(p, 'utf8');
}

let authDb = null;
function auth() {
  if (authDb) return authDb;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  authDb = new DatabaseSync(path.join(DATA_DIR, 'auth.db'));
  authDb.exec(AUTH_SCHEMA);
  authDb.exec('PRAGMA journal_mode = WAL');
  authDb.exec('PRAGMA foreign_keys = ON');
  return authDb;
}

let socialDb = null;
/* Geteilte Datenbank der Freigaben. Kein Nutzerbezug - wer eine Zeile lesen
 * darf, entscheidet shares.js anhand von owner_id und Freigabestatus. */
function social() {
  if (socialDb) return socialDb;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  socialDb = new DatabaseSync(path.join(DATA_DIR, 'social.db'));
  socialDb.exec(SOCIAL_SCHEMA);
  socialDb.exec('PRAGMA journal_mode = WAL');
  return socialDb;
}

const userDbs = new Map();

/* Dokument-DB eines Nutzers, bei Bedarf angelegt.
 *
 * WAL ist hier die richtige Wahl: der Schreibzugriff eines Nutzers blockiert
 * nicht die Lesezugriffe aller anderen, und ein Absturz waehrend eines
 * Schreibvorgangs verliert nicht den ganzen Snapshot.
 */
function docs(userId) {
  if (userDbs.has(userId)) return userDbs.get(userId);
  const dir = path.join(DATA_DIR, 'users', userId);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'docs.db'));
  db.exec(DOCS_SCHEMA);
  db.exec(fileSchema());
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  userDbs.set(userId, db);
  return db;
}

/* Wo die Dateien liegen.
 *
 * Reihenfolge: Umgebung, dann Datenbank, dann Abbruch.
 *
 * Die Umgebung hat Vorrang, weil sie die Deployment-Konfiguration ist
 * (/etc/federwerk/env, gesetzt von systemd). Ein Eintrag in file_tiers ist
 * eine Ausnahme fuer einzelne Nutzer, kein Standard - und darf eine
 * kaputte Konfiguration nicht verdecken.
 *
 * Der Abbruch ist Absicht. "Kein Pfad bekannt" darf nicht auf einen
 * Default zurueckfallen, der vielleicht nicht existiert: dann schreibt
 * der Server Dateien dorthin und glaubt, es sei alles gut. Lieber beim
 * Start laut scheitern.
 */
function tierPaths(userId) {
  const out = {};
  try {
    for (const row of docs(userId).prepare('SELECT tier, path FROM file_tiers').all()) {
      out[row.tier] = row.path;
    }
  } catch { /* vor Schema-Anlage */ }

  if (process.env.FW_FILES_DIR) out.hot = process.env.FW_FILES_DIR;
  if (process.env.FW_ARCHIVE_DIR) out.cold = process.env.FW_ARCHIVE_DIR;

  if (!out.hot) {
    const e = new Error('Keine heisse Ablage konfiguriert (FW_FILES_DIR). Dateien koennten nicht abgelegt werden.');
    e.status = 500;
    throw e;
  }
  if (!out.cold) out.cold = out.hot; // kein Archiv: kalte Dateien bleiben im selben Ordner, nur tier=2
  return out;
}

function closeAll() {
  for (const db of userDbs.values()) { try { db.close(); } catch { /* ignore */ } }
  userDbs.clear();
  for (const d of [authDb, socialDb]) {
    if (d) { try { d.close(); } catch { /* ignore */ } }
  }
  authDb = null;
  socialDb = null;
}

module.exports = { DATA_DIR, auth, social, docs, tierPaths, fileSchema, closeAll };