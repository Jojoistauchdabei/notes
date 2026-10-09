#!/usr/bin/env node
/* Federwerk: SQLite-Snapshots pro Nutzer.
 *
 *   node deploy/lxc/backup.js [--data DIR] [--out DIR] [--keep DAYS] [--remote DIR]
 *
 * Nimmt von JEDER Datenbank unter <data> einen konsistenten Snapshot mit
 * node:sqlite#backup() - das ist die Online-Backup-API und darf waehrend
 * laufender Schreibzugriffe verwendet werden (VACUUM INTO waere hier nicht
 * noetig und wuerde die Quelle exklusiv sperren).
 *
 * Anschliessend wird jeder Snapshot auf <remote> (QNAP-Share) gespiegelt und
 * die Aufbewahrung durchgesetzt. Ohne --remote bzw. ohne gemountetes Ziel
 * bleibt der Lauf ein reiner Lokalsnapshot - gedacht als Sicherheitsnetz,
 * falls die NAS gerade nicht erreichbar ist.
 *
 * Aufbewahrung: Loescht Snapshots, die aelter als --keep Tage sind, in BEIDEN
 * Zielen. Der lokale Snapshot bleibt auch dann erhalten, wenn die NAS
 * ausfaellt - sonst haette man bei stoerender NAS am Ende nichts.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync, backup } = require('node:sqlite');

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const p = argv.find((a) => a.startsWith('--' + name + '='));
  return p ? p.slice(name.length + 3) : fallback;
}

const DATA = path.resolve(arg('data', process.env.FW_DATA_DIR || '/srv/federwerk/data'));
const OUT = path.resolve(arg('out', process.env.FW_BACKUP_DIR || '/srv/federwerk/backups'));
const REMOTE = arg('remote', process.env.FW_BACKUP_REMOTE || '');
const KEEP_DAYS = Number(arg('keep', process.env.FW_BACKUP_KEEP_DAYS || '14'));

function log(msg) { console.log(`[backup] ${msg}`); }

function fail(msg) { console.error(`[backup] FEHLER: ${msg}`); process.exit(1); }

/* Alle Datenbanken einsammeln: <data>/auth.db plus <data>/users/<userId>/docs.db.
 * Die Nutzer-ID bleibt als Verzeichnisstruktur erhalten, damit ein Restore
 * klar ist ("welche DB gehoerte wem?").
 *
 * Hinweis: hier KEIN Glob-Muster in einen Blockkommentar schreiben. Der
 * Stern-Slash-Verbund darin beendet den Kommentar vorzeitig, und alles
 * Folgende wird als Code geparst (SyntaxError). */
function findDatabases(dir, prefix = '') {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...findDatabases(full, rel));
    else if (e.isFile() && e.name.endsWith('.db')) out.push({ abs: full, rel });
  }
  return out;
}

async function snapshotOne(srcPath, rel) {
  const destDir = path.join(OUT, path.dirname(rel));
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(rel));
  const tmp = dest + '.partial';
  fs.rmSync(tmp, { force: true });

  // srcPath ist der absolute Pfad der Quelle (nicht das Objekt aus
  // findDatabases) - der Aufrufer loest .abs bereits auf.
  const src = new DatabaseSync(srcPath, { readOnly: true });
  try {
    await backup(src, tmp);
  } finally {
    src.close();
  }

  // Snapshot pruefen, BEVOR er als gut gilt. Eine kaputte Sicherung, die
  // erst beim Restore auffaellt, ist keine Sicherung.
  const check = new DatabaseSync(tmp, { readOnly: true });
  try {
    const row = check.prepare('PRAGMA integrity_check').get();
    const verdict = row && (row.integrity_check || row['integrity_check']);
    if (verdict !== 'ok') fail(`Integritaet von ${rel} schlecht: ${verdict}`);
  } finally {
    check.close();
  }

  fs.renameSync(tmp, dest); // atomar auf dem selben Dateisystem
  const size = fs.statSync(dest).size;
  log(`Snapshot ${rel} -> ${dest} (${Math.round(size / 1024)} KB)`);
  return { rel, dest, size };
}

function copyTo(dest, remote, rel) {
  const target = path.join(remote, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { force: true });
  fs.copyFileSync(dest, target);
}

function prune(root, keepDays) {
  if (!fs.existsSync(root)) return;
  const cutoff = Date.now() - keepDays * 86400000;
  let n = 0;
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.db') && fs.statSync(full).mtimeMs < cutoff) {
        fs.rmSync(full, { force: true });
        n++;
      }
    }
  })(root);
  if (n) log(`Aufraeumen: ${n} Snapshot(s) aelter als ${keepDays} Tage aus ${root}`);
}

(async () => {
  if (!fs.existsSync(DATA)) fail(`Datenverzeichnis fehlt: ${DATA}`);

  const dbs = findDatabases(DATA);
  if (!dbs.length) {
    log('Keine *.db unter ' + DATA + ' - nichts zu tun (App laeuft noch nicht?).');
    return;
  }

  let remoteOk = false;
  if (REMOTE) {
    // Ohne gemountetes Ziel wuerde das cp in das Mount-Root schreiben und
    // beim naechsten Mount verdeckt verschwinden. Deshalb hart prüfen.
    if (fs.existsSync(path.join(REMOTE, '.')) && fs.statfsSync) {
      try {
        const probe = path.join(REMOTE, `.backup-probe-${process.pid}`);
        fs.writeFileSync(probe, 'ok');
        fs.rmSync(probe, { force: true });
        remoteOk = true;
      } catch (e) {
        log(`WARNUNG: ${REMOTE} nicht beschreibbar (${e.message}) - nur lokaler Snapshot.`);
      }
    } else {
      log(`WARNUNG: ${REMOTE} existiert nicht (QNAP nicht gemountet?) - nur lokaler Snapshot.`);
    }
  }

  const results = [];
  for (const db of dbs) results.push(await snapshotOne(db.abs, db.rel));

  const total = results.reduce((s, r) => s + r.size, 0);
  log(`${results.length} Datenbank(en), ${Math.round(total / 1024)} KB gesamt.`);
  if (remoteOk) {
    for (const r of results) copyTo(r.dest, REMOTE, r.rel);
    log(`Gespiegelt nach ${REMOTE}`);
  }

  prune(OUT, KEEP_DAYS);
  if (remoteOk) prune(REMOTE, KEEP_DAYS);
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));