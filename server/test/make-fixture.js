// Test-Fixture fuer server/gc.js: eine Nutzer-DB mit realistisch
// verteilten Zeitstempeln und echten Dateien daneben.
//
//   node make-fixture.js <docs.db> <hot-dir> <cold-dir>

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const dbPath = process.argv[2];
const HOT = process.argv[3];
const COLD = process.argv[4];

const db = new DatabaseSync(dbPath);
db.exec(fs.readFileSync('/tmp/schema.sql', 'utf8'));

// schema.sql setzt die Produktionspfade (/srv/federwerk/files, ...). Die
// Fixture zeigt auf Testverzeichnisse, sonst sucht der GC die Dateien an
// einer ganz anderen Stelle und meldet sie als fehlend.
db.prepare('UPDATE file_tiers SET path = ? WHERE tier = ?').run(HOT, 'hot');
db.prepare('UPDATE file_tiers SET path = ? WHERE tier = ?').run(COLD, 'cold');

const DAY = 86400000;
const now = Date.now();
const sha = (n) => String(n).repeat(64).slice(0, 64);
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf', 'image/webp': 'webp' };

const put = (s, size, mime, tier, ageDays) => db.prepare(
  'INSERT INTO files VALUES (?,?,?,?,?,?)'
).run(s, size, mime, tier, now - ageDays * DAY, now - ageDays * DAY);
const ref = (s, doc) => db.prepare('INSERT OR IGNORE INTO file_refs VALUES (?,?)').run(s, doc);

function write(base, s, mime) {
  const dir = path.join(base, s.slice(0, 2), s.slice(2, 4));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${s}.${EXT[mime] || 'bin'}`), Buffer.alloc(1024));
}

// a: frisch, referenziert -> bleibt unangetastet
put(sha('a'), 2 * 1024 * 1024, 'image/jpeg', 'hot', 3); ref(sha('a'), 'doc-1'); write(HOT, sha('a'), 'image/jpeg');
// b: alt, referenziert -> Kalt-Kandidat, darf NICHT geloescht werden
put(sha('b'), 5 * 1024 * 1024, 'application/pdf', 'hot', 400); ref(sha('b'), 'doc-2'); write(HOT, sha('b'), 'application/pdf');
// c: ohne Referenz, 200 Tage -> verwaist UND kalt
put(sha('c'), 800 * 1024, 'image/png', 'hot', 200); write(HOT, sha('c'), 'image/png');
// d: ohne Referenz, erst 10 Tage -> zu jung
put(sha('d'), 300 * 1024, 'image/jpeg', 'hot', 10); write(HOT, sha('d'), 'image/jpeg');
// e: bereits im Kalt-Tier, referenziert
put(sha('e'), 1 * 1024 * 1024, 'image/webp', 'cold', 500); ref(sha('e'), 'doc-3'); write(COLD, sha('e'), 'image/webp');
// f: auf der Platte, aber ohne DB-Eintrag (abgebrochener Upload)
const strayDir = path.join(HOT, 'ff', 'ff');
fs.mkdirSync(strayDir, { recursive: true });
fs.writeFileSync(path.join(strayDir, `${sha('f')}.bin`), Buffer.alloc(4096));
// 9: in der DB, aber Datei fehlt auf der Platte
put(sha('9'), 123, 'image/gif', 'hot', 500); ref(sha('9'), 'doc-4');

db.close();
console.log('Fixture angelegt');