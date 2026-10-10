'use strict';
/* Federwerk: Datei-Ablage (Bilder, PDFs, abgelegte Dokumentinhalte).
 *
 * Content-adressiert: Der Name ist der SHA-256 des Inhalts. Daraus folgt
 * Dedupe kostenlos (gleicher Inhalt = gleicher Name = ein Upload) und der
 * Wegfall einer ganzen Fehlerklasse: Es gibt keine zwei Namen fuer dieselben
 * Bytes und keine zwei Dateien mit demselben Namen.
 *
 * ---- Warum beim Lesen geprueft wird ----
 *
 * Der QNAP-Share haengt mit cache=strict (SMB/CIFS). Der Kernel darf
 * Schreibvorgaenge als erledigt melden, obwohl sie noch im Puffer liegen -
 * bei NAS-Ausfall fehlen dann genau die juengsten Dateien, und zwar
 * typischerweise als abgeschnittene Dateien. Ein still beschadigtes Bild
 * ist schlimmer als ein fehlendes: es wird geliefert, angezeigt und
 * irgendwann als Benutzerschaden gemeldet.
 *
 * Weil der Name der Hash ist, faellt eine Beschaedigung sofort auf: der
 * Inhalt passt nicht mehr zum Namen. Deshalb wird beim Lesen der Hash
 * gebildet und verglichen, und bei Abweichung wird 500 statt der kaputten
 * Bytes geliefert. Kosten: rund 1-2 ms je Bild, gegenueber dem Netzrundlauf.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db.js');

const VERIFY_READ = process.env.FW_VERIFY_READ !== '0';
const HEX64 = /^[0-9a-f]{64}$/;

/* Spiegelt extForMime() aus js/files-sync.js. Beide Seiten MUESSEN
 * dieselbe Endung liefern - sonst findet der Server eine Datei nicht, die
 * der Client unter einem anderen Namen abgelegt hat. */
function extForMime(mime) {
  switch (String(mime || '').toLowerCase().split(';')[0].trim()) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    case 'application/pdf': return 'pdf';
    case 'application/json': return 'json';
    case 'text/plain': return 'txt';
    default: return 'bin';
  }
}

// Zwei Ebenen Sharding: bei mehreren 100k Dateien waeren sonst Verzeichnisse
// mit sechsstelliger Eintragszahl auf SMB der naechste Engpass.
function locate(base, sha256, mime) {
  return path.join(base, sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}.${extForMime(mime)}`);
}

/* Bewusst hashBytes() und nicht sha256(): die Funktionen weiter unten haben
 * einen Parameter namens "sha256", der den Namen hier im Modulbereich
 * ueberschattet haette. Dann ruft sha256(buf) den String auf und wirft
 * "sha256 is not a function" - mitten in der Beschaedigungspruefung. */
function hashBytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function validHash(sha) {
  return HEX64.test(String(sha || ''));
}

function findOnDisk(userId, sha256, mime) {
  const tiers = db.tierPaths(userId);
  for (const tier of ['hot', 'cold']) {
    const p = locate(tiers[tier], sha256, mime);
    if (fs.existsSync(p)) return { tier, path: p };
  }
  return null;
}

function knownMime(userId, sha256) {
  const row = db.docs(userId).prepare('SELECT mime FROM files WHERE sha256 = ?').get(sha256);
  return row ? row.mime : '';
}

/* Datei ablegen. Existiert sie schon (Dedupe), wird der Inhalt verworfen und
 * nur der Lesezeitpunkt angefasst. */
function put(userId, sha256, mime, buf) {
  if (!validHash(sha256)) { const e = new Error('Ungültiger Hash.'); e.status = 400; throw e; }
  if (!Buffer.isBuffer(buf) || !buf.length) { const e = new Error('Leere Datei.'); e.status = 400; throw e; }

  const actual = hashBytes(buf);
  if (actual !== sha256) {
    // Der Client behauptet einen anderen Inhalt als er schickt. Das ist
    // kein Rechenfehler, sondern ein Bug im Client - und genau die Sorte
    // Datenverlust, die man stillschweigend durchwinken sollte.
    const e = new Error(`Inhalt passt nicht zum Namen: ${actual} != ${sha256}`);
    e.status = 422;
    throw e;
  }

  const d = db.docs(userId);
  const existing = findOnDisk(userId, sha256, mime);
  const now = Date.now();

  if (existing) {
    d.prepare('UPDATE files SET last_used_at = ? WHERE sha256 = ?').run(now, sha256);
    return { sha256, deduplicated: true, tier: existing.tier, size: buf.length };
  }

  const m = mime || 'application/octet-stream';
  const tiers = db.tierPaths(userId);
  const dest = locate(tiers.hot, sha256, m);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.partial';
  try {
    fs.writeFileSync(tmp, buf);
    // Erst vollstaendig schreiben, dann umbenennen. Auf SMB macht erst der
    // rename die Datei fuer andere sichtbar - ein Leser sieht nie eine
    // halbe Datei.
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }

  d.prepare('INSERT INTO files (sha256, size, mime, tier, created_at, last_used_at) VALUES (?,?,?,?,?,?) ' +
            'ON CONFLICT(sha256) DO UPDATE SET last_used_at = excluded.last_used_at')
    .run(sha256, buf.length, m, 'hot', now, now);
  return { sha256, deduplicated: false, tier: 'hot', size: buf.length };
}

function get(userId, sha256) {
  const d = db.docs(userId);
  const row = d.prepare('SELECT sha256, size, mime, tier FROM files WHERE sha256 = ?').get(sha256);
  if (!row) { const e = new Error('Datei unbekannt.'); e.status = 404; throw e; }

  const found = findOnDisk(userId, sha256, row.mime);
  if (!found) {
    // DB weiss von der Datei, Platte nicht. Bei cache=strict und NAS-Ausfall
    // der wahrscheinlichste Fall. Als Verlust melden, nicht als 404.
    const e = new Error(`Datei fehlt auf der Ablage (${row.tier}): ${sha256}`);
    e.status = 410;
    throw e;
  }

  const buf = fs.readFileSync(found.path);
  if (VERIFY_READ) {
    const actual = hashBytes(buf);
    if (actual !== sha256) {
      const e = new Error(`Datei beschaedigt: Inhalt ${actual} passt nicht zum Namen ${sha256} (${found.tier}).`);
      e.status = 500;
      e.corrupt = true;
      throw e;
    }
  }

  d.prepare('UPDATE files SET last_used_at = ?, tier = ? WHERE sha256 = ?').run(Date.now(), found.tier, sha256);
  return { buf, mime: row.mime, size: buf.length, tier: found.tier };
}

/* Referenzen eines Dokuments setzen. Der Aufrufer uebergibt die vollstaendige
 * Menge der Hashes, die das Dokument benutzt - nicht ein Delta. Das haelt
 * die Logik hier trivial und damit zuverlaessig: es gibt keinen Pfad, auf
 * dem eine alte Referenz beim Aktualisieren vergessen werden kann. */
function setRefs(userId, docId, hashes) {
  const d = db.docs(userId);
  const uniq = [...new Set((hashes || []).filter(validHash))];
  d.prepare('DELETE FROM file_refs WHERE doc_id = ?').run(docId);
  const ins = d.prepare('INSERT OR IGNORE INTO file_refs (sha256, doc_id) VALUES (?,?)');
  const now = Date.now();
  const touch = d.prepare('UPDATE files SET last_used_at = ? WHERE sha256 = ?');
  for (const h of uniq) {
    ins.run(h, docId);
    touch.run(now, h);
  }
  return uniq.length;
}

/* Hashes aus einem Dokumentinhalt herausziehen. Die Referenzen stehen im
 * JSON als "awfile:<hash>" (Push) oder "blob:<id>" (lokal) - letztere sind
 * ohne Server nicht auflösbar und werden hier bewusst ignoriert. */
function hashesFromContent(contentJson) {
  const found = new Set();
  const text = typeof contentJson === 'string' ? contentJson : JSON.stringify(contentJson || '');
  for (const m of text.matchAll(/awfile:([0-9a-f]{64})/g)) found.add(m[1]);
  for (const m of text.matchAll(/"([0-9a-f]{64})\.(?:jpg|png|webp|gif|pdf|json|txt|bin)"/g)) found.add(m[1]);
  return [...found];
}

function list(userId) {
  return db.docs(userId).prepare(
    'SELECT sha256, size, mime, tier, created_at, last_used_at FROM files ORDER BY last_used_at DESC'
  ).all();
}

module.exports = { put, get, setRefs, hashesFromContent, list, locate, sha256: hashBytes, extForMime, VERIFY_READ };