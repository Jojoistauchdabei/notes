// scripts/build-dist.js – baut ein frisches dist/ plattformübergreifend
// (Linux/macOS/Windows) für Web-Release und Tauri beforeBuildCommand.
//
// CDN-Optimierung (Cloudflare Workers Static Assets):
// - altes_Papier.png (2,5 MB) bleibt Quell-Asset, kommt NICHT ins dist/.
//   Stattdessen WebP + JPEG-Fallback, beide inhalts-gehasht (cachebar mit immutable).
// - Die 26 Seiten-Skripte aus index.html werden in EIN Bundle gelegt und
//   minifiziert: 27 Requests -> 1, ~37 % weniger Bytes (über gzip ~37 %).
// - css/styles.css wird minifiziert und gehasht.
// - dist/index.html lädt genau ein Bundle (defer) + ein gehashtes Stylesheet.
// - dist/sw.js precacht nur noch die App-Shell statt aller Einzeldateien.
// - dist/_headers: immutable für gehashte Assets, must-revalidate für HTML/SW.
//
// Minifiziert wird mit esbuild (npx, wie wrangler@4 im Release-Workflow).
// Ohne Netz/ohne esbuild baut der Schritt ohne Minifizierung weiter – die
// Bundle-/Hash-/Caching-Optimierungen greifen unabhängig davon immer.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');

const root = process.env.BUILD_ROOT || process.cwd();
const dist = process.env.DIST_DIR || path.join(root, 'dist');
const esbuildBin = 'esbuild@0.25.10';

/* Optionales Verzeichnis? Dann ist sein Fehlen kein Fehler – sonst bricht der
 * Build, sobald jemand in einem Checkout oder Test-Fixture ohne z.B. docs/
 * baut (das hat tests/build-dist.test.js mit einem Minimal-Fixture erwischt).
 * Pflichtdateien wie index.html bleiben hart: fehlen sie, muss der Build
 * abbrechen, statt still ein halbes dist/ zu erzeugen. */
function copy(relativePath, options = undefined) {
  const src = path.join(root, relativePath);
  let missing = false;
  try { missing = !fs.existsSync(src); }
  catch { missing = true; }
  if (missing) {
    let isDir = false;
    try { isDir = fs.statSync(src).isDirectory(); } catch { /* existiert nicht */ }
    if (isDir || options) {
      if (isDir) return;
      // Datei mit Optionen bzw. unbekannt: nur stillschweigend ueberspringen,
      // wenn es ein Verzeichnis sein sollte.
      if (options) return;
    }
  }
  fs.cpSync(src, path.join(dist, relativePath), options);
}

function hash10(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
}

// Minifiziert über esbuild (npx). Läuft auf Linux/macOS/Windows; jeder Fehler
// (kein Netz, kein npx.cmd, gesperrte Temp-Datei) darf den Release-BUILD nie
// abbrechen – dann wird unminifiziert weitergebaut (Bundle/Hash/Caching aktiv).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'federwerk-build-'));
process.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

function minify(kind, source, label) {
  const tmpIn = path.join(tmpDir, `${label}.in.${kind}`);
  const tmpOut = path.join(tmpDir, `${label}.out.${kind}`);
  const cleanup = (f) => { try { fs.rmSync(f, { force: true }); } catch { /* Windows: Datei gesperrt */ } };
  try {
    fs.writeFileSync(tmpIn, source);
    // Eine Shell-Zeile (kein Argument-Array): findet unter Windows npx.cmd
    // und unter POSIX npx; Pfade mit Leerzeichen/Backslashes bleiben sicher.
    const q = (p) => '"' + String(p).split(path.sep).join('/').replace(/"/g, '\\"') + '"';
    const cmd = ['npx', '--yes', esbuildBin, '--minify', '--target=es2020', '--outfile=' + q(tmpOut), q(tmpIn)].join(' ');
    execFileSync(cmd, { stdio: ['ignore', 'ignore', 'pipe'], shell: true, windowsHide: true });
    const out = fs.readFileSync(tmpOut);
    if (kind === 'js') execFileSync(process.execPath, ['--check', tmpOut], { stdio: 'ignore' });
    return out.length < Buffer.byteLength(source) ? out : Buffer.from(source);
  } catch (e) {
    const why = String((e && (e.stderr || e.message)) || e).split('\n')[0].trim().slice(0, 160);
    console.warn(`build: Minifizierung für ${label} übersprungen (${why || 'esbuild nicht verfügbar'}).`);
    return Buffer.from(source);
  } finally {
    cleanup(tmpIn);
    cleanup(tmpOut);
  }
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'css'), { recursive: true });
fs.mkdirSync(path.join(dist, 'js'), { recursive: true });
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });

// 1) Unveränderte Dateien (Papier-PNG bewusst ausgelassen: 2,5 MB)
// agent.html = /agent (KI-Agent-Seite), MCP_AI.md = /mcp (Anleitung fuer KI-Modelle)
// present.html = Empfängerseite des Präsentationsmodus (SPEC-38), wird unten
// wie index.html gebündelt – fehlt sie (alte Checkout/Fixture), kein Fehler.
for (const file of ['index.html', 'agent.html', 'manifest.webmanifest', 'sw.js', 'llms.txt', 'FEDERWERK_FORMAT.md', 'MCP_AI.md', 'federwerk.schema.json']) {
  copy(file);
}
if (fs.existsSync(path.join(root, 'present.html'))) copy('present.html');
for (const dir of ['icons', 'screenshots', 'docs']) {
  // docs/ ist optional (Nutzer-Doku) – ein fehlender Ordner darf den Build
  // nicht abbrechen.
  if (!fs.existsSync(path.join(root, dir))) {
    console.warn(`build: Verzeichnis ${dir}/ fehlt – wird übersprungen.`);
    continue;
  }
  copy(dir, { recursive: true });
}

// 2) Papier-Textur gehasht ablegen und im CSS umschreiben
const paperFiles = {};
for (const ext of ['webp', 'jpg']) {
  const bytes = fs.readFileSync(path.join(root, `altes_Papier.${ext}`));
  const name = `papier.${hash10(bytes)}.${ext}`;
  fs.writeFileSync(path.join(dist, 'assets', name), bytes);
  paperFiles[ext] = `assets/${name}`;
}

// 3) CSS: Quell-URLs auf gehashte Bilder, dann minifizieren + hashen
const cssSource = fs
  .readFileSync(path.join(root, 'css/styles.css'), 'utf8')
  .replace(/url\(['"]\.\.\/altes_Papier\.(webp|jpg)['"]\)/g, (_, ext) => `url('../${paperFiles[ext]}')`);
const cssMin = minify('css', cssSource, 'styles');
const cssName = `styles.${hash10(cssMin)}.css`;
fs.writeFileSync(path.join(dist, 'css', cssName), cssMin);

// 4+6) HTML-Seiten: Skripte in Reihenfolge laden -> je ein Bundle, dann ein
//      Stylesheet und genau ein Bundle mit defer pro Seite verlinken.
//      Zeilenumbruch-agnostisch: Windows-Checkouts (core.autocrlf) liefern CRLF,
//      darum wird nie auf einen exakten \n-Block gepatcht.
//      `required=false` -> fehlende Seite (oder Seite ohne Skripte) wird
//      übersprungen, statt den Build abzubrechen.
function bundlePage(htmlRel, prefix, required) {
  const p = path.join(dist, htmlRel);
  if (!fs.existsSync(p)) {
    if (required) {
      console.error(`build: ${htmlRel} fehlt im dist.`);
      process.exit(1);
    }
    return null;
  }
  let h = fs.readFileSync(p, 'utf8');
  const scriptSrcs = [...h.matchAll(/<script\s+src="(js\/[^"]+\.js)"><\/script>/g)].map((m) => m[1]);
  if (!scriptSrcs.length) {
    if (required) {
      console.error(`build: Keine <script src="js/..."> in ${htmlRel} gefunden.`);
      process.exit(1);
    }
    return null;
  }
  const bundleSource = scriptSrcs
    .map((rel) => {
      const f = path.join(root, rel);
      if (!fs.existsSync(f)) {
        console.error(`build: Skript fehlt: ${rel}`);
        process.exit(1);
      }
      return fs.readFileSync(f, 'utf8');
    })
    .join('\n;\n');
  const bundle = minify('js', bundleSource, prefix);
  const bundleName = `${prefix}.${hash10(bundle)}.js`;
  fs.writeFileSync(path.join(dist, 'js', bundleName), bundle);

  const eol = h.includes('\r\n') ? '\r\n' : '\n';
  h = h.replace(/<link\b[^>]*href="css\/styles\.css"[^>]*>/, `<link rel="stylesheet" href="css/${cssName}">`);
  const scriptTag = /[ \t]*<script src="js\/[^"]+\.js"><\/script>[ \t]*\r?\n?/g;
  const found = (h.match(scriptTag) || []).length;
  if (found !== scriptSrcs.length) {
    console.error(`build: Skript-Block in ${htmlRel} unvollständig (${found}/${scriptSrcs.length} gefunden).`);
    process.exit(1);
  }
  h = h.replace(scriptTag, '');
  const bundleTag = `  <script src="js/${bundleName}" defer></script>`;
  h = /<\/body>/i.test(h)
    ? h.replace(/[ \t]*<\/body>/i, `${bundleTag}${eol}</body>`)
    : `${h.replace(/\s*$/, '')}${eol}${bundleTag}${eol}`;
  // Auf das <link>-Tag pruefen, nicht auf den blossen Substring: present.html
  // erwaehnt "css/styles.css" in einem Kommentar ("damit Schirm und Notizbuch
  // gleich aussehen"), und der Substring-Check hat den Build daran
  // abgebrochen – die Seite blieb unausgepackt und im Release waere sie
  // komplett funktionsunfaehig gewesen (Skripte und CSS existieren dort
  // nicht einzeln, nur als Bundle).
  if (/<link\b[^>]*href="css\/styles\.css"/.test(h)) {
    console.error(`build: CSS-Referenz in ${htmlRel} nicht gefunden.`);
    process.exit(1);
  }
  fs.writeFileSync(p, h);
  return { bundleName, count: scriptSrcs.length };
}

const appPage = bundlePage('index.html', 'app.bundle', true);
// Empfängerseite der Präsentation (SPEC-38). Eigenes, schlankes Bundle: sie
// braucht weder app.js noch die Cloud-Sync-Skripte – nur Renderer, Bleistift,
// Laser und die Präsentationslogik.
const presentPage = bundlePage('present.html', 'present.bundle', false);

// 5) Eigenständig geladene Dateien behalten ihre Namen
//    gnpdf-worker.js: new Worker('js/gnpdf-worker.js', { type: 'module' })
//    mcp.js / storage-usage.js: nicht in index.html referenziert, gehören aber
//    weiterhin zum ausgelieferten dist/ (z. B. für externe Aufrufer/Tests).
//    themes.js: lädt synchron im <head> und hängt die Theme-Stylesheets erst
//    zur Laufzeit an den Dokumentanfang. Es darf deshalb nicht im Bundle
//    landen (das wäre defer am Seitenende = sichtbarer Theme-Wechsel) und
//    muss eigenständig kopiert werden.
for (const rel of ['js/gnpdf-worker.js', 'js/mcp.js', 'js/storage-usage.js', 'js/themes.js']) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) continue;
  fs.writeFileSync(path.join(dist, rel), minify('js', fs.readFileSync(p, 'utf8'), path.basename(rel, '.js')));
}

// 5b) Theme-Stylesheets mitnehmen (js/themes.js lädt sie zur Laufzeit nach).
//     Ungehasht und unminifiziert: sie sind additiv gegenüber styles.css
//     (_shared.css + <thema>.css) und werden nach dem Start nur geladen,
//     wenn ein Design-Thema gewählt wurde – der Standard lädt gar nichts.
//     Ausnahme papier.css: es referenziert dasselbe Papierbild wie
//     styles.css und muss daher genauso auf die gehashten Dateien zeigen.
{
  const src = path.join(root, 'css', 'themes');
  if (fs.existsSync(src)) {
    const dst = path.join(dist, 'css', 'themes');
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src).filter((f) => f.endsWith('.css'))) {
      let body = fs.readFileSync(path.join(src, name), 'utf8');
      body = body.replace(/url\(['"]\.\.\/\.\.\/altes_Papier\.(webp|jpg)['"]\)/g, (_, ext) => `url('../../${paperFiles[ext]}')`);
      fs.writeFileSync(path.join(dst, name), body);
    }
  } else {
    console.warn('build: css/themes/ fehlt – Design-Themen fehlen im dist.');
  }
}

// 6) Eigenständig geladene Dateien behalten ihre Namen (siehe 5)

// 7) sw.js: nur App-Shell precachen, kein Screenshot-/Doku-Ballast
{
  const p = path.join(dist, 'sw.js');
  let s = fs.readFileSync(p, 'utf8');
  const shell = [
    './',
    'index.html',
    'agent.html',
    `css/${cssName}`,
    `js/${appPage.bundleName}`,
    'js/gnpdf-worker.js',
    'manifest.webmanifest',
    paperFiles.webp,
    paperFiles.jpg,
    'icons/logo.svg',
    'icons/icon-192.png',
    'icons/icon-512.png',
  ];
  // Die Empfängerseite gehört zur Shell: eine Präsentation muss auch ohne Netz
  // starten können, sonst ist ausgerechnet beim Zeigen alles weg.
  if (presentPage) {
    shell.splice(3, 0, 'present.html');
    shell.splice(5, 0, `js/${presentPage.bundleName}`);
  }
  const arr = `const ASSETS = ${JSON.stringify(shell).replace(/","/g, '", "')};`;
  if (!/const ASSETS = \[[^\]]*\];/.test(s)) {
    console.error('build: ASSETS-Liste in sw.js nicht gefunden.');
    process.exit(1);
  }
  s = s.replace(/const ASSETS = \[[^\]]*\];/, arr);
  fs.writeFileSync(p, s);
}

// 8) _headers: lange Cache-TTL für gehashte/unveränderte Dateien
{
  const immutable = [
    `/js/${appPage.bundleName}`,
    `/css/${cssName}`,
    `/${paperFiles.webp}`,
    `/${paperFiles.jpg}`,
    '/icons/*',
  ];
  const revalidate = [
    '/index.html',
    '/agent.html',
    '/MCP_AI.md',
    '/sw.js',
    '/manifest.webmanifest',
  ];
  if (presentPage) {
    immutable.push(`/js/${presentPage.bundleName}`);
    revalidate.push('/present.html');
  }
  const headers = [
    ...immutable.map((route) => `${route}\n  Cache-Control: public, max-age=31536000, immutable`),
    '/screenshots/*\n  Cache-Control: public, max-age=604800',
    '/docs/*\n  Cache-Control: public, max-age=0, must-revalidate',
    ...revalidate.map((route) => `${route}\n  Cache-Control: public, max-age=0, must-revalidate`),
    '/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()\n  Content-Security-Policy: frame-ancestors \'none\'',
  ].join('\n\n') + '\n';
  fs.writeFileSync(path.join(dist, '_headers'), headers);
}

function listFiles(dir, base = dist, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

let total = 0;
for (const file of listFiles(dist, dist).sort()) {
  const size = fs.statSync(path.join(dist, file)).size;
  total += size;
  console.log(`dist/${file} (${(size / 1024).toFixed(1)}K)`);
}
console.log(`dist gesamt: ${(total / 1024).toFixed(0)}K`);
