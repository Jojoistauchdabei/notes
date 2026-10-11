// scripts/build-crafts.js - holt die Web-Builds der Upstream-Craft-Apps nach
// dist/crafts/<id>/.
//
// Federwerk baut seine Office-Oberflaeche nicht mehr selbst: die Dokumente
// werden in den WASM-Web-Builds der Apps aus github.com/storytold bearbeitet
// (WordCraft/GridCraft/DeckCraft = Word/Excel/PowerPoint, dazu die Adobe-/
// Autodesk-/Avid-Clones). Welche Apps es gibt und wie sie gebaut werden, steht
// in js/craft-catalog.js; welche Version ausgeliefert wird, in crafts.lock.json.
// Diese Datei fuehrt beides zusammen und legt das Ergebnis unter dist/crafts/<id>/
// ab, wo js/craft-host.js es in einen gleich-origin iframe laedt.
//
// Quellen in dieser Reihenfolge (die erste, die greift, gewinnt):
//   (a) CRAFTS_SRC_DIR/<id>/   - vorgebaute Ablage. Tests und der CI-Cache
//       legen die fertigen Web-Builds dort ab; dann wird nichts geholt.
//   (b) Release-Asset *-web-*.zip des gepinnten Tags - der Standardweg. Die
//       Upstream-Releases tragen die fertigen Web-Builds bereits als ZIP; damit
//       braucht der Build weder Rust noch trunk. GITHUB_TOKEN hebt das
//       API-Rate-Limit; FETCH_BASE biegt die API fuer die Tests um.
//   (c) Release-Asset crafts-<id>.zip des eigenen Federwerk-Releases - nur mit
//       CRAFTS_FROM_RELEASE=1, fuer Umgebungen ohne Netz zu GitHub.
//   (d) Upstream selbst bauen - nur mit CRAFTS_BUILD=1, wenn kein Asset da ist.
//       Das ist der Notfallweg (Rust/trunk bzw. `cargo xtask web`).
//
// Grundsatz: ein fehlender Craft ist kein Grund, den ganzen Lauf abzubrechen -
// die uebrigen Apps sollen trotzdem ins dist. Erst CRAFTS_STRICT=1 macht aus
// einem fehlenden Craft einen Fehler (exit 1); das setzen die Release-Workflows.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const catalog = require('../js/craft-catalog.js');

const root = process.env.BUILD_ROOT || path.join(__dirname, '..');
const dist = process.env.DIST_DIR || path.join(root, 'dist');
const craftsDist = path.join(dist, 'crafts');
const tmp = path.join(root, 'tmp', 'crafts');

// Cloudflare Workers Static Assets: max. 25 MiB je Datei. Ist eine Datei
// groesser, scheitert der ganze Deploy - deshalb fliegt der einzelne Craft
// raus, statt alle anderen mitzureissen.
const limit = 25 * 1024 * 1024;

const strict = process.env.CRAFTS_STRICT === '1';
const fromRelease = process.env.CRAFTS_FROM_RELEASE === '1';
const bauen = process.env.CRAFTS_BUILD === '1';
const reuse = process.env.CRAFTS_REUSE === '1';
const apiBase = process.env.FETCH_BASE || 'https://api.github.com';
// Nur fuer die Tests umbiegbar, damit der Upstream-Bau ohne Netz pruefbar ist.
const codeloadBase = process.env.CRAFTS_CODELOAD_BASE || 'https://codeload.github.com';

/* Dateien, die NICHT mitkopiert werden.
 *
 * Ein Upstream-Service-Worker wuerde die Federwerk-App uebernehmen: er
 * registriert sich (Standard-Scope "/") fuer den ganzen Origin, faengt also
 * auch Federwerk-Seiten ab und liefert sie aus seinem eigenen Cache - die App
 * waere nicht mehr unter unserer Kontrolle und ein Deploy koennte einen alten
 * Stand ausliefern. Manifest-Dateien haben denselben Effekt auf den App-Scope
 * (Installierbarkeit/PWA gehoert zu Federwerk, nicht zum eingebetteten Editor).
 * Alles andere bleibt: index.html, *_bg.wasm, *.js, worker.js (Web-Worker der
 * App), audio-worklet.js, snippets/, fonts/.
 */
const AUSGESCHLOSSEN = new Set(['sw.js', 'service-worker.js', 'manifest.webmanifest', 'manifest.json']);

// Schriftdateien, die bei zu grossen Upstream-Builds entfallen duerfen: die
// Upstream-App laeuft laut eigener Doku auch ohne (LightCraft ist im ZIP ~101 MB,
// einzelne Fonts sprengen dann das 25-MiB-Limit je Datei).
const FONT_EXT = new Set(['ttf', 'otf', 'woff', 'woff2', 'ttc']);

function mib(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

function liesLock() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'crafts.lock.json'), 'utf8'));
    return (j && j.crafts) || {};
  } catch (e) {
    console.warn('build-crafts: crafts.lock.json nicht lesbar (' + e.message + ') - kein Pin.');
    return {};
  }
}

/* Welche Crafts gebaut werden: CRAFTS=wordcraft,gridcraft oder alle aus dem
 * Katalog. Unbekannte IDs werden gemeldet, aber nicht als Fehler gewertet. */
function auswahl() {
  const roh = process.env.CRAFTS;
  if (!roh) return catalog.ids().map((id) => catalog.byId(id));
  const out = [];
  for (const id of roh.split(',').map((s) => s.trim()).filter(Boolean)) {
    const c = catalog.byId(id);
    if (!c) {
      console.warn('build-crafts: unbekannte Craft-ID "' + id + '" wird ignoriert.');
      continue;
    }
    out.push(c);
  }
  return out;
}

/* Das eigene Federwerk-Repo - fuer das Release-Asset crafts-<id>.zip. */
function repoSlug() {
  if (process.env.FEDERWERK_REPO) return process.env.FEDERWERK_REPO;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    if (m) return m[1];
  } catch (e) { /* ohne git-remote gibt es eben kein Release-Asset */ }
  return null;
}

function gitHubHeaders(accept) {
  return {
    accept: accept || 'application/vnd.github+json',
    'user-agent': 'federwerk-build-crafts',
    ...(process.env.GITHUB_TOKEN ? { authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {}),
  };
}

async function api(pfad, accept) {
  const res = await fetch(apiBase + pfad, { headers: gitHubHeaders(accept), redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/* ---- entpacken ---------------------------------------------------------- */

/* ZIP entpacken. python3 ist im Repo bereits Voraussetzung (die Release-
 * Workflows bauen das Web-ZIP damit), also nehmen wir `python3 -m zipfile -e`.
 * Fehlt python3, faellt der Aufruf auf die minimale eigene Entpackung zurueck -
 * so bleibt der Pfad auch in kargen Umgebungen lauffaehig. */
function entpackeZip(zipDatei, ziel) {
  fs.mkdirSync(ziel, { recursive: true });
  try {
    execFileSync('python3', ['-m', 'zipfile', '-e', zipDatei, ziel], { stdio: 'inherit' });
    return;
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
    extractZip(fs.readFileSync(zipDatei), ziel);
  }
}

/* Nur der Fall, den GitHub fuer ein Release-Asset erzeugt: DEFLATE oder
 * gespeichert, Groessen im zentralen Verzeichnis. Rueckfall, falls python3 fehlt. */
function extractZip(buf, dest) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('kein ZIP-Endverzeichnis gefunden');
  const anzahl = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < anzahl; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const methode = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    const rel = name.split('/').filter((p) => p && p !== '.' && p !== '..').join('/');
    if (!rel) continue;
    if (name.endsWith('/')) { fs.mkdirSync(path.join(dest, rel), { recursive: true }); continue; }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    const ziel = path.join(dest, rel);
    fs.mkdirSync(path.dirname(ziel), { recursive: true });
    if (methode === 0) fs.writeFileSync(ziel, data);
    else if (methode === 8) fs.writeFileSync(ziel, zlib.inflateRawSync(data));
    else throw new Error('unbekannte ZIP-Kompression ' + methode + ' fuer ' + name);
  }
}

/* tar.gz entpacken (nur der Notfallweg CRAFTS_BUILD=1). Node bringt kein tar
 * mit und eine zusaetzliche Abhaengigkeit soll es nicht geben, deshalb hier
 * genau die Header-Faelle, die GitHub-codeload-Archive erzeugen: Dateien,
 * Verzeichnisse, Symlinks (uebersprungen - fuer den Build ohne Belang),
 * GNU-Langname ('L') und pax-Header ('x'/'g', uebersprungen). Pfade werden
 * entschaerft: kein "..", keine absoluten Pfade. */
function extractTarGz(gz, dest) {
  const buf = zlib.gunzipSync(gz);
  const readStr = (o, n) => buf.toString('utf8', o, o + n).replace(/\0.*$/, '');
  let off = 0;
  let langName = null;
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break; // zwei Nullbloecke = Archivende
    const name = langName || readStr(off, 100);
    langName = null;
    const size = parseInt(readStr(off + 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(buf[off + 156] || 0);
    const prefix = readStr(off + 345, 155);
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    off = dataStart + Math.ceil(size / 512) * 512;
    const voll = (prefix ? prefix + '/' : '') + name;
    const rel = voll.split('/').filter((p) => p && p !== '.' && p !== '..').join('/');
    if (!rel) continue;
    const ziel = path.join(dest, rel);
    if (type === '5') { fs.mkdirSync(ziel, { recursive: true }); continue; }
    if (type === 'L') { langName = buf.toString('utf8', dataStart, dataEnd).replace(/\0.*$/, ''); continue; }
    if (type === 'x' || type === 'g' || type === '2') continue; // pax/Symlink
    fs.mkdirSync(path.dirname(ziel), { recursive: true });
    fs.writeFileSync(ziel, buf.subarray(dataStart, dataEnd));
  }
}
