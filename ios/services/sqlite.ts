/** SQLite (expo-sqlite): lokaler Store für Notizen + Offline-Sync-Queue. */

import * as SQLite from 'expo-sqlite';

type DbLike = {
  runAsync?: (sql: string, params?: any[]) => Promise<void>;
  runSync?: (sql: string, params?: any[]) => void;
  getAllAsync?: (sql: string, params?: any[]) => Promise<any[]>;
  getAllSync?: (sql: string, params?: any[]) => any[];
  execAsync?: (sql: string) => Promise<void>;
  execSync?: (sql: string) => void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  starred INTEGER NOT NULL DEFAULT 0,
  image_data TEXT,
  synced INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS learn_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL,
  note_id TEXT,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

let db: DbLike | null = null;

function exec(db: DbLike, sql: string): void {
  (db.execAsync ?? db.execSync ?? (() => undefined))(sql);
}

export async function init(): Promise<void> {
  if (!db) {
    db = SQLite.openDatabaseSync('federwerk.db') as unknown as DbLike;
  }
  exec(db!, SCHEMA);
}

function db_(): DbLike {
  if (!db) throw new Error('SQLite nicht initialisiert – init() aufrufen.');
  return db;
}

/** SQL ausführen (Schreibzugriff). */
export async function run(sql: string, params: any[] = []): Promise<void> {
  const d = db_();
  const fn = d.runAsync ?? d.runSync ?? (() => undefined);
  await fn(sql, params);
}

/** Alle Zeilen lesen (Lesezugriff). */
export async function query<T = any[]>(sql: string, params: any[] = []): Promise<T[]> {
  const d = db_();
  const fn = d.getAllAsync ?? d.getAllSync ?? (() => []);
  const rows = await fn(sql, params);
  return (Array.isArray(rows) ? rows : []) as T[];
}
