#!/usr/bin/env node
'use strict';
/* Federwerk: Restore aus einem Backup-Ziel (lokal oder QNAP).
 *
 *   node deploy/lxc/restore.js [--source DIR] [--data DIR]
 *
 * Liest alle *.db unter --source (Default: FW_BACKUP_DIR bzw.
 * /srv/federwerk/backups, alternativ FW_BACKUP_REMOTE) und schreibt sie
 * mit derselben Relativstruktur wieder unter --data (Default:
 * FW_DATA_DIR bzw. /srv/federwerk/data).
 *
 * Restore macht NUR Schreibungen im Zielverzeichnis - er loescht nichts.
 * Vor jedem Schreibvorgang wird die Integritaet geprueft; ein fehlerhafter
 * Snapshot wird uebersprungen, nicht heimlich rueckgaengig gemacht.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const p = argv.find((a) => a.startsWith('--' + name + '='));
  return p ? p.slice(name.length + 3) : fallback;
}

const SOURCE = path.resolve(arg('source', process.env.FW_BACKUP_DIR || '/srv/federwerk/backups'));
const DATA = path.resolve(arg('data', process.env.FW_DATA_DIR || '/srv/federwerk/data'));

function log(msg) { console.log(`[restore] ${msg}`); }
function fail(msg) { console.error(`[restore] FEHLER: ${msg}`); process.exit(1); }

function findDatabases(dir, prefix) {
  prefix = prefix || '';
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...findDatabases(full, rel));
    else if (e.isFile() && e.name.endsWith('.db')) out.push({ abs: full, rel });
  }
  return out;
}

function integrityOk(p) {
  let db = null;
  try {
    db = new DatabaseSync(p, { readOnly: true });
    const row = db.prepare('PRAGMA integrity_check').get();
    const verdict = row && (row.integrity_check || row['integrity_check']);
    return verdict === 'ok';
  } catch {
    return false;
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

(async () => {
  if (!fs.existsSync(SOURCE)) fail(`Quellverzeichnis fehlt: ${SOURCE}`);
  const dbs = findDatabases(SOURCE);
  if (!dbs.length) { log(`Keine *.db unter ${SOURCE} - nichts zu restaurieren.`); return; }
  let restored = 0;
  let skipped = 0;
  for (const db of dbs) {
    if (!integrityOk(db.abs)) {
      log(`WARNUNG: Snapshot ${db.rel} ist beschaedigt - uebersprungen (Ziel bleibt unveraendert).`);
      skipped++;
      continue;
    }
    const dest = path.join(DATA, db.rel);
    const tmp = dest + '.restore-partial';
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(db.abs, tmp);
    if (!integrityOk(tmp)) {
      fs.rmSync(tmp, { force: true });
      log(`WARNUNG: Kopie von ${db.rel} ist beschaedigt - uebersprungen (Ziel bleibt unveraendert).`);
      skipped++;
      continue;
    }
    fs.renameSync(tmp, dest);
    log(`Restored: ${db.rel} -> ${dest}`);
    restored++;
  }
  log(`Restore abgeschlossen aus ${SOURCE} nach ${DATA} (${restored} wiederhergestellt, ${skipped} uebersprungen).`);
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
