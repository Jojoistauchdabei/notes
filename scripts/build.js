// scripts/build.js - Wrapper um scripts/build-dist.js.
//
// Warum ein Wrapper statt eines Eingriffs in build-dist.js: der Markdown-Editor
// (SPEC-39) ist gerade in Arbeit und aendert build-dist.js. Diese Datei bleibt
// davon unberuehrt, sodass beide Baustellen sich nicht in die Quere kommen.
//
// Aufgabe hier: office-wasm/dist/ nach dist/ kopieren, wenn es vorhanden ist.
// Das WASM enthaelt die DOCX/XLSX/PPTX-Bridge (WordCraft/GridCraft/DeckCraft).
//
// Fehlt das WASM, bricht der Build NICHT ab: Lokal und in Checkout-Umgebungen
// ohne Rust-Toolchain soll der App-Build weitergehen. In den Release-Workflows
// werden die build-Skripte vorher ausgefuehrt, und dort schlaegt der Build bei
// fehlendem WASM fehl (REQUIRE_OFFICE_WASM=1) - sonst waere ein Release
// stillschweigend ohne Engine.
//
// Zusaetzlich zum Kopieren gibt es einen Download aus dem GitHub-Release. Grund:
// Builds, die kein Rust haben (Cloudflare Workers Builds, fremde CI), konnten
// vorher zwar dist/ erzeugen, aber ohne Engine - und deployten damit eine App,
// deren Import-/Export-Knoepfe ins Leere zeigen, ohne dass der Build rot wurde.
// Die Engine liegt jetzt als Release-Asset vor und wird im Zweifel geholt.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = process.env.BUILD_ROOT || path.join(__dirname, '..');
const dist = process.env.DIST_DIR || path.join(root, 'dist');

console.log('build: scripts/build-dist.js ...');
execFileSync(process.execPath, [path.join(__dirname, 'build-dist.js')], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

const required = process.env.REQUIRE_OFFICE_WASM === '1';

/* -- Engine aus dem GitHub-Release -------------------------------------- */

/* Das Repo kommt aus dem Remote, nicht aus einer Umgebungsvariable: so stimmt
 * der Pfad auch bei einem Tag-Build, wo GITHUB_REPOSITORY nicht gesetzt ist. */
function repoSlug() {
  if (process.env.FEDERWERK_REPO) return process.env.FEDERWERK_REPO;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    if (m) return m[1];
  } catch (e) { /* ohne git-remote gibt es eben keinen Download */ }
  return null;
}

/* Bei einem Tag-Build gehoert zum Tag; sonst das juengste Release, weil
 * Auto-Release bei jedem Push auf main eines erzeugt. */
async function releaseTag(slug) {
  if (process.env.FEDERWERK_WASM_RELEASE) return process.env.FEDERWERK_WASM_RELEASE;
  const ref = process.env.GITHUB_REF || '';
  const ausRef = ref.match(/^refs\/tags\/(.+)$/);
  // FETCH_BASE nur fuer die Tests: damit laesst sich der ganze Pfad gegen einen
  // lokalen Server fahren, ohne GitHub zu brauchen.
  const basis = process.env.FETCH_BASE || 'https://api.github.com';
  const url = ausRef
    ? basis + '/repos/' + slug + '/releases/tags/' + ausRef[1]
    : basis + '/repos/' + slug + '/releases/latest';
  const json = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'federwerk-build',
      ...(process.env.GITHUB_TOKEN ? { authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {}),
    },
  });
  if (!json.ok) return null;
  const body = await json.json();
  return body && body.tag_name ? body.tag_name : null;
}

/* Download nach tmpName; .part daneben, damit ein abgebrochener Lauf kein
 * halbes File in tmp/ hinterlaesst. */
async function lade(url, tmpName) {
  const p = path.join(root, 'tmp', tmpName);
  const res = await fetch(url, {
    headers: { 'user-agent': 'federwerk-build' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(p, buf);
  return p;
}

/* Eine WebAssembly-Datei beginnt mit 00 61 73 6D. Das wird geprueft, weil der
 * Worker bei fehlender Datei mit not_found_handling die App-Shell liefert: die
 * ist HTML, 200, und damit kein Fehler - nur kaputtes WASM im Download. */
function istWasm(datei) {
  try {
    const fd = fs.openSync(datei, 'r');
    const buf = Buffer.alloc(4);
    const n = fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return n === 4 && buf.equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  } catch (e) { return false; }
}

async function holeEngine(kind, base) {
  const slug = repoSlug();
  if (!slug) return null;
  let tag = null;
  try { tag = await releaseTag(slug); } catch (e) { tag = null; }
  if (!tag) return null;

  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const geholt = [];
  for (const name of [base + '.js', base + '_bg.wasm']) {
    // FETCH_BASE ist nur fuer die Tests gedacht und zeigt im Normalfall auf
  // objects.githubusercontent.com, wo die Weiterleitung des Browsers landet.
  const downloadBasis = process.env.FETCH_BASE
    ? process.env.FETCH_BASE
    : 'https://github.com/' + slug + '/releases/download';
  const url = downloadBasis + '/' + tag + '/' + name;
    let datei;
    try {
      datei = await lade(url, name + '.part');
    } catch (e) {
      console.warn('build: Download fehlgeschlagen (' + name + ' aus ' + tag + '): ' + e.message);
      for (const f of geholt) fs.rmSync(f, { force: true });
      return null;
    }
    if (name.endsWith('.wasm') && !istWasm(datei)) {
      fs.rmSync(datei, { force: true });
      console.warn('build: ' + url + ' lieferte kein WebAssembly (Magic falsch) - vermutlich die App-Shell.');
      for (const f of geholt) fs.rmSync(f, { force: true });
      return null;
    }
    geholt.push(datei);
  }
  return { tag, dateien: geholt };
}

/* Eine WASM-Engine nach dist/ kopieren. office -> office_wasm (DOCX/XLSX/PPTX),
 * craft -> craft_wasm (PSD/SVG/IDML). Getrennt, weil die Engines selten
 * gleichzeitig gebraucht werden: so bleibt jede Datei klein und wird nur
 * geladen, wenn sie gebraucht wird.
 *
 * `requiredOnly` erlaubt einen Modifier wie REQUIRE_CRAFT_WASM=1, damit ein
 * Release auch gezielt auf das Fehlen einer bestimmten Engine reagieren kann.
 *
 * Reihenfolge: lokal gebaute Engine schlaegt Download. Ein Release baut immer
 * selbst, damit das Release-Asset exakt die Engine dieses Commits traegt. */
async function copyWasm(kind, requiredOnly) {
  const base = kind === 'craft' ? 'craft_wasm' : 'office_wasm';
  const srcDir = (kind === 'craft' ? process.env.CRAFT_WASM_DIR : process.env.OFFICE_WASM_DIR)
    || path.join(root, kind + '-wasm', 'dist');
  const files = [base + '.js', base + '_bg.wasm'];
  const streng = requiredOnly || required;

  let heruntergeladen = null;

  if (!fs.existsSync(srcDir) || files.some((name) => !fs.existsSync(path.join(srcDir, name)))) {
    if (fs.existsSync(srcDir)) {
      if (streng) {
        console.error('build: ' + srcDir + ' ist unvollstaendig.');
        process.exit(1);
      }
      console.warn('build: ' + srcDir + ' ist unvollstaendig.');
    }
    if (process.env.FEDERWERK_NO_WASM_DOWNLOAD !== '1') {
      heruntergeladen = await holeEngine(kind, base);
    }
    if (!heruntergeladen) {
      if (streng) {
        console.error('build: ' + kind + '-Engine fehlt und liess sich nicht aus dem Release holen.');
        console.error('build: erwartet Build-Schritt: ' + kind + '-wasm/build.sh');
        process.exit(1);
      }
      console.warn('build: ' + kind + '-Engine fehlt (' + srcDir + '), wird nicht ausgeliefert.');
      return;
    }
  }

  for (const name of files) {
    const from = heruntergeladen
      ? path.join(root, 'tmp', name + '.part')
      : path.join(srcDir, name);
    fs.copyFileSync(from, path.join(dist, name));
    const kb = Math.round(fs.statSync(from).size / 1024);
    console.log('dist/' + name + ' (' + kb + 'K)' + (heruntergeladen ? ' aus Release ' + heruntergeladen.tag : ''));
  }
  for (const name of files) {
    fs.rmSync(path.join(root, 'tmp', name + '.part'), { force: true });
  }
  // Der MIME-Typ fuer .wasm ist Pflicht: sonst faellt der Browser auf
  // instantiate() mit ArrayBuffer zurueck (deutlich langsameres Starten).
  // build.sh legt dafuer <base>.headers neben die Engine. Beim Download gibt es
  // kein build.sh, deshalb steht derselbe Inhalt hier - sonst deployte ein
  // Build ohne Rust die WASM mit application/octet-stream.
  const headers = path.join(srcDir, base + '.headers');
  const add = fs.existsSync(headers)
    ? fs.readFileSync(headers, 'utf8').trim()
    : [
      '/' + base + '_bg.wasm',
      '  Content-Type: application/wasm',
      '/' + base + '.js',
      '  Content-Type: text/javascript',
    ].join('\n');
  const target = path.join(dist, '_headers');
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (!existing.includes('/' + base + '_bg.wasm')) {
    fs.writeFileSync(target, existing.replace(/\s*$/, '\n\n') + add + '\n', 'utf8');
    console.log('dist/_headers: ' + base + '-MIME ergaenzt');
  }
}

(async function main() {
  await copyWasm('office', false);
  await copyWasm('craft', process.env.REQUIRE_CRAFT_WASM === '1');
  console.log('build: fertig.');
})().catch((e) => {
  console.error('build: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});