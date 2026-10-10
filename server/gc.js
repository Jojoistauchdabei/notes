#!/usr/bin/env node
/* Federwerk: Ausschuss und Kalt-Ablage fuer Dateien.
 *
 *   node server/gc.js [--data DIR] [--report | --delete] [--cold | --restore-cold]
 *                     [--orphan-days N] [--cold-days N] [--json] [--yes]
 *
 * GRUNDREGEL: Standard ist reine Anzeige. Es wird nichts geloescht oder
 * verschoben, was nicht ausdruecklich befohlen wurde. Grund ist nicht
 * Vorsicht um der Vorsicht willen: der Server pflegt file_refs erst ab dem
 * Zeitpunkt, an dem er laeuft. Vorher ist diese Tabelle leer, und eine leere
 * Referenztabelle sieht fuer jeden GC-Lauf exakt aus wie "alle Dateien sind
 * verwaist". Ohne Verriegelung wuerde der erste Lauf nach der Aktivierung
 * jedes Bild eines Nutzers loeschen. Siehe assertIndexPresent() unten.
 *
 * Zwei getrennte Operationen:
 *
 *   Ausschuss  Datei ohne jede Referenz seit >= --orphan-days Tagen.
 *              Wird nur mit --delete wirklich entfernt.
 *   Kalt-Ablage Datei, die seit >= --cold-days Tagen nicht mehr gelesen
 *              wurde, wandert von <hot> nach <cold>. Ein Verschieben, kein
 *              Loeschen - mit --restore-cold kommt alles unveraendert zurueck.
 *
 * Warum kein Komprimieren: die Ablage enthaelt JPEG/WebP/PNG/PDF. Das sind
 * bereits komprimierte Formate; gzip darauf liegt typischerweise bei 0-2 %
 * und kostet bei jedem Lesezugriff eine Dekomprimierung. Der Gewinn ist real
 * nicht vorhanden, die Kosten sind es auch nicht - deshalb gar nicht erst.
 *
 * Platz gewinnt man hier auf einem 7-TB-Volume mit 5,6 TB frei ohnehin
 * durch nichts als echten Ausschuss. Der Wert der Kalt-Ablage ist ein
 * anderer: sie sortiert, sodass sich kalte Daten auf QNAP-HBS-Ebenen
 * ausschliessen oder auf eine billigere Stufe legen lassen.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
function arg(name, fallback) {
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const p = argv.find((a) => a.startsWith('--' + name + '='));
  return p ? p.slice(name.length + 3) : fallback;
}

const DATA = path.resolve(arg('data', process.env.FW_DATA_DIR || '/srv/federwerk/data'));
const ORPHAN_DAYS = Number(arg('orphan-days', process.env.FW_ORPHAN_DAYS || '90'));
const COLD_DAYS = Number(arg('cold-days', process.env.FW_COLD_DAYS || '180'));
const JSON_OUT = has('--json');

const day = 86400000;
const now = Date.now();
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

/* Spiegelt extForMime() aus js/files-sync.js. Beide Seiten MUESSEN
 * dieselbe Endung liefern, sonst findet der GC die Datei nicht, die der
 * Server hingelegt hat. */
function extFromMime(mime) {
  switch (String(mime || '').toLowerCase().split(';')[0].trim()) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    case 'application/pdf': return 'pdf';
    case 'application/json': return 'json';
    default: return 'bin';
  }
}

// Sharding wie der Server: zwei Ebenen, damit kein Verzeichnis auf dem
// QNAP-Shard zum Millionen-Eintrag wird.
function filePath(base, sha256, mime) {
  return path.join(base, sha256.slice(0, 2), sha256.slice(2, 4), sha256 + '.' + extFromMime(mime));
}

function human(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}

function findUserDbs(dir) {
  const usersDir = path.join(dir, 'users');
  if (!fs.existsSync(usersDir)) return [];
  const out = [];
  for (const e of fs.readdirSync(usersDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const db = path.join(usersDir, e.name, 'docs.db');
    if (fs.existsSync(db)) out.push({ user: e.name, db });
  }
  return out;
}

function hasFileSchema(db) {
  const row = db.prepare(
    "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('files','file_refs','file_tiers')"
  ).get();
  return row && row.n === 3;
}

/* ---------------------------------------------------------------------
 * Die Verriegelung - aber nur dort, wo sie etwas schuetzt.
 *
 * files hat Zeilen, file_refs keine: aus dem Bestand liess sich keine
 * Verwaistheit ableiten, weil die Beziehung "welche Datei gehoert zu
 * welchem Dokument" nie aufgezeichnet wurde. Fuer ein LOESCHEN ist das
 * ein Blocker. Fuer einen Bericht nicht - es ist eine Tatsache, die man
 * kennen sollte, aber kein Grund, die Auswertung abzubrechen.
 *
 * Frueher stand hier pauschal eine Verweigerung, und die Folge war: bei
 * einem frischen Server, auf dem noch kein Dokument eine Datei referenziert,
 * wurde der komplette Nutzer uebersprungen - inklusive der Kalt-Ablage,
 * die gar nichts mit dem Referenzindex zu tun hat und trotzdem nie ablief.
 * --------------------------------------------------------------------- */
function indexState(db) {
  const f = db.prepare('SELECT count(*) AS n FROM files').get();
  const r = db.prepare('SELECT count(*) AS n FROM file_refs').get();
  const docs = db.prepare('SELECT count(*) AS n FROM docs').get();
  return { files: f.n, refs: r.n, docs: docs.n, empty: f.n > 0 && r.n === 0 };
}

function indexWarning(user, st) {
  return `${user}: ${st.files} Dateien in der Ablage, aber 0 Referenzen ` +
    `(${st.docs} Dokumente vorhanden).\n` +
    `  Das heisst nicht "alles verwaist", sondern "der Referenz-Index ist leer".\n` +
    `  Ursache ist meist: es hat noch kein Dokument eine Datei benutzt. Das ist\n` +
    `  am Anfang normal. Solange das so ist, wird NICHTS geloescht - ein\n` +
    `  leerer Index sieht fuer den GC sonst aus wie "alles verwaist".`;
}

/* Ablagepfade - MUSS identisch zu server/db.js:tierPaths() sein.
 *
 * Gleiche Reihenfolge: Umgebung vor Datenbank, kein stiller Default. Wenn
 * die beiden Module hier auseinanderlaufen, passiert das Schlimmste: der GC
 * schaut an eine Stelle, der Server schreibt an eine andere, und der GC
 * meldet daraufhin "keine verwaisten Dateien" - also exakt das Gegenteil
 * der Wahrheit, ohne Fehlermeldung. Deshalb an beiden Stellen dieselbe
 * Logik, und beide Stellen unit-getestet. */
function readTiers(db) {
  const out = {};
  for (const row of db.prepare('SELECT tier, path FROM file_tiers').all()) out[row.tier] = row.path;
  if (process.env.FW_FILES_DIR) out.hot = process.env.FW_FILES_DIR;
  if (process.env.FW_ARCHIVE_DIR) out.cold = process.env.FW_ARCHIVE_DIR;

  if (!out.hot) {
    throw new Error('Keine heisse Ablage bekannt (weder FW_FILES_DIR noch file_tiers gesetzt). ' +
      'Ohne diesen Pfad waere jede Aussage des GC wertlos - es wuerde "nichts gefunden" melden.');
  }
  if (!out.cold) out.cold = out.hot;
  return out;
}

/* Dateien ohne jede Referenz, aelter als Schwelle. */
function findOrphans(db, cutoff) {
  return db.prepare(`
    SELECT f.sha256, f.size, f.mime, f.tier, f.last_used_at, f.created_at
    FROM files f
    WHERE f.last_used_at < ?
      AND NOT EXISTS (SELECT 1 FROM file_refs r WHERE r.sha256 = f.sha256)
    ORDER BY f.last_used_at ASC
  `).all(cutoff);
}

/* Heisse Dateien ohne Lesezugriff seit Schwelle.
 *
 * Verwaiste Dateien sind bewusst NICHT dabei: die werden geloescht, nicht
 * kalt gelegt. Ein Datei-Aufenthalt im Archiv, gefolgt von der Loeschung,
 * waere nur zweimal Arbeit fuer dasselbe Byte. "Kalt" heisst hier deshalb
 * ausdruecklich: weiterhin gebraucht, aber selten gelesen.
 *
 * Wird IMMER berechnet, auch ohne --cold - der Bericht ist die Grundlage
 * fuer die Entscheidung, eine Datei ueberhaupt kalt zu legen. */
function findCold(db, cutoff) {
  return db.prepare(`
    SELECT f.sha256, f.size, f.mime, f.last_used_at
    FROM files f
    WHERE f.tier = 'hot' AND f.last_used_at < ?
      AND EXISTS (SELECT 1 FROM file_refs r WHERE r.sha256 = f.sha256)
    ORDER BY f.last_used_at ASC
  `).all(cutoff);
}

/* Dateien auf der Platte ohne DB-Eintrag. Nach einem abgebrochenen Upload
 * oder einem manuellen Kopieren moeglich. Nur melden, nie automatisch loeschen. */
function findStrays(tiers, db) {
  const known = new Set(db.prepare('SELECT sha256 FROM files').all().map((r) => r.sha256));
  const out = [];
  for (const tier of ['hot', 'cold']) {
    const base = tiers[tier];
    if (!fs.existsSync(base)) continue;
    (function walk(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        const sha = e.name.replace(/\.[a-z0-9]+$/i, '');
        if (/^[0-9a-f]{64}$/.test(sha) && !known.has(sha)) {
          out.push({ tier, path: full, size: fs.statSync(full).size });
        }
      }
    })(base);
  }
  return out;
}

function moveCold(db, tiers, rows) {
  let moved = 0, bytes = 0;
  const failures = [];
  const upd = db.prepare('UPDATE files SET tier = ? WHERE sha256 = ?');
  for (const r of rows) {
    const from = filePath(tiers.hot, r.sha256, r.mime);
    const to = filePath(tiers.cold, r.sha256, r.mime);
    try {
      if (!fs.existsSync(from)) {
        // Datei fehlt schon - Tier trotzdem korrigieren, sonst sucht der
        // Server sie endlos im heissen Pfad.
        upd.run('cold', r.sha256);
        failures.push({ sha: r.sha256, why: 'Quelle fehlt, nur DB-Eintrag korrigiert' });
        continue;
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to); // atomar, beide Pfade auf demselben QNAP-Volume
      upd.run('cold', r.sha256);
      moved++;
      bytes += r.size;
    } catch (e) {
      failures.push({ sha: r.sha256, why: e.message });
    }
  }
  return { moved, bytes, failures };
}

function restoreCold(db, tiers) {
  const rows = db.prepare("SELECT sha256, size, mime FROM files WHERE tier = 'cold'").all();
  let moved = 0;
  const failures = [];
  const upd = db.prepare('UPDATE files SET tier = ? WHERE sha256 = ?');
  for (const r of rows) {
    const from = filePath(tiers.cold, r.sha256, r.mime);
    const to = filePath(tiers.hot, r.sha256, r.mime);
    try {
      if (!fs.existsSync(from)) { failures.push({ sha: r.sha256, why: 'Quelle fehlt' }); continue; }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      upd.run('hot', r.sha256);
      moved++;
    } catch (e) { failures.push({ sha: r.sha256, why: e.message }); }
  }
  return { moved, rows, failures };
}

function deleteOrphans(db, tiers, rows) {
  let freed = 0;
  const failures = [];
  const delRef = db.prepare('DELETE FROM file_refs WHERE sha256 = ?');
  const delFile = db.prepare('DELETE FROM files WHERE sha256 = ?');
  for (const r of rows) {
    for (const tier of ['hot', 'cold']) {
      const p = filePath(tiers[tier], r.sha256, r.mime);
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { failures.push({ sha: r.sha256, why: 'unlink: ' + e.message }); }
    }
    delRef.run(r.sha256);
    delFile.run(r.sha256);
    freed += r.size;
  }
  return { freed, failures };
}

/* ------------------------------------------------------------------ */

const summary = { users: [], errors: [], blocked: [], warnings: [] };
const doDelete = has('--delete');
const doCold = has('--cold');
const doRestore = has('--restore-cold');

for (const { user, db: dbPath } of findUserDbs(DATA)) {
  const db = new DatabaseSync(dbPath);
  try {
    if (!hasFileSchema(db)) { log(`  ${user}: kein Datei-Schema (uebersprungen)`); continue; }

    let tiers;
    try { tiers = readTiers(db); } catch (e) { summary.errors.push({ user, error: e.message }); continue; }

    const st = indexState(db);
    if (st.empty) summary.warnings.push(indexWarning(user, st));
    // Loeschen nur, wenn die Beziehung dokumentiert ist. Kalt-Ablage und der
    // Bericht laufen immer - sie machen keine Aussage ueber Verwaistheit.
    const mayDelete = !st.empty;

    const orphans = findOrphans(db, now - ORPHAN_DAYS * day);
    // Kalt-Kandidaten werden auch im reinen Bericht gezahlt, damit man sieht,
    // was --cold tun wuerde, bevor man es tut.
    const cold = findCold(db, now - COLD_DAYS * day);
    const strays = findStrays(tiers, db);

    const entry = {
      user,
      tierPaths: tiers,
      orphanCount: orphans.length,
      orphanBytes: orphans.reduce((s, r) => s + r.size, 0),
      coldCandidateCount: cold.length,
      coldCandidateBytes: cold.reduce((s, r) => s + r.size, 0),
      strayCount: strays.length,
      strayBytes: strays.reduce((s, r) => s + r.size, 0),
    };

    if (doRestore) {
      const res = restoreCold(db, tiers);
      entry.restored = res.moved;
      entry.failures = res.failures;
    } else if (doDelete && orphans.length && !mayDelete) {
      // Genau hier ist die Verriegelung wirksam: es waere loeschbar, aber
      // die Grundlage fehlt.
      summary.blocked.push({ user, reason: indexWarning(user, st) });
      entry.deleteBlocked = orphans.length;
    } else if (doDelete && orphans.length) {
      const res = deleteOrphans(db, tiers, orphans);
      entry.deleted = orphans.length;
      entry.freed = res.freed;
      entry.failures = res.failures;
    } else if (doCold && cold.length) {
      const res = moveCold(db, tiers, cold);
      entry.coldMoved = res.moved;
      entry.coldBytes = res.bytes;
      entry.failures = res.failures;
    }

    summary.users.push(entry);

    log(`\n-- ${user}`);
    log(`   verwaist seit >${ORPHAN_DAYS}d : ${entry.orphanCount} Dateien, ${human(entry.orphanBytes)}`);
    log(`   kalt-Kandidaten (>${COLD_DAYS}d)  : ${entry.coldCandidateCount} Dateien, ${human(entry.coldCandidateBytes)}`);
    log(`   ohne DB-Eintrag                 : ${entry.strayCount} Dateien, ${human(entry.strayBytes)}`);
    if (entry.coldMoved) log(`   -> ${entry.coldMoved} in Kalt-Ablage verschoben (${human(entry.coldBytes)})`);
    if (entry.deleted) log(`   -> ${entry.deleted} geloescht, ${human(entry.freed)} frei`);
    if (entry.restored) log(`   -> ${entry.restored} zurueck in die heisse Ablage`);
    if (entry.deleteBlocked) log(`   -> LOESCHEN blockiert (${entry.deleteBlocked} Datei(en), aber Index leer)`);
    if (entry.failures && entry.failures.length) {
      for (const f of entry.failures.slice(0, 5)) log(`   !! ${f.sha.slice(0, 12)}: ${f.why}`);
    }
  } catch (e) {
    summary.errors.push({ user, error: e.message });
    log(`\n-- ${user}: FEHLER ${e.message}`);
  } finally {
    db.close();
  }
}

if (summary.warnings.length) {
  log('\n=== Hinweis zum Referenzindex ===');
  for (const w of summary.warnings) log(w);
}
if (summary.blocked.length) {
  log('\n=== LOESCHEN VERWEIGERT ===');
  for (const b of summary.blocked) log(b.reason);
}
if (summary.errors.length) {
  log('\n=== Fehler ===');
  for (const e of summary.errors) log(`${e.user}: ${e.error}`);
}

if (JSON_OUT) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const u = summary.users;
  log(`\n=== Summe: ${u.length} Nutzer, ` +
      `${u.reduce((s, x) => s + x.orphanCount, 0)} verwaist (${human(u.reduce((s, x) => s + x.orphanBytes, 0))}), ` +
      `${u.reduce((s, x) => s + x.coldCandidateCount, 0)} kalt-Kandidaten ===`);
  if (!doDelete && !doCold && !doRestore) {
    log('Nur Bericht. Mit --delete wirklich loeschen, mit --cold kalt legen.');
  }
}