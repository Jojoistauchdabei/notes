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
const { execFileSync } = require('child_process');

const root = process.env.BUILD_ROOT || process.cwd();
const dist = process.env.DIST_DIR || path.join(root, 'dist');
const esbuildBin = 'esbuild@0.25.10';

function copy(relativePath, options = undefined) {
  fs.cpSync(path.join(root, relativePath), path.join(dist, relativePath), options);
}

function hash10(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
}

// Minifiziert über esbuild; bei Fehler (kein Netz, kein Binary) Original zurück.
function minify(kind, source, label) {
  const tmpIn = path.join(dist, `.min-${label}.in.${kind}`);
  const tmpOut = path.join(dist, `.min-${label}.out.${kind}`);
  fs.writeFileSync(tmpIn, source);
  try {
    const args = [
      '--minify',
      '--target=es2020',
      `--outfile=${tmpOut}`,
      tmpIn,
    ];
    execFileSync('npx', ['--yes', esbuildBin, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    const out = fs.readFileSync(tmpOut);
    if (kind === 'js') execFileSync(process.execPath, ['--check', tmpOut], { stdio: 'ignore' });
    return out.length < Buffer.byteLength(source) ? out : Buffer.from(source);
  } catch {
    console.warn(`build: Minifizierung für ${label} übersprungen (esbuild nicht verfügbar).`);
    return Buffer.from(source);
  } finally {
    fs.rmSync(tmpIn, { force: true });
    fs.rmSync(tmpOut, { force: true });
  }
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'css'), { recursive: true });
fs.mkdirSync(path.join(dist, 'js'), { recursive: true });
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });

// 1) Unveränderte Dateien (Papier-PNG bewusst ausgelassen: 2,5 MB)
for (const file of ['index.html', 'manifest.webmanifest', 'sw.js', 'llms.txt', 'FEDERWERK_FORMAT.md', 'federwerk.schema.json']) {
  copy(file);
}
for (const dir of ['icons', 'screenshots']) {
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

// 4) Skripte aus index.html in Reihenfolge laden -> ein Bundle
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scriptSrcs = [...html.matchAll(/<script\s+src="(js\/[^"]+\.js)"><\/script>/g)].map((m) => m[1]);
if (!scriptSrcs.length) {
  console.error('build: Keine <script src="js/..."> in index.html gefunden.');
  process.exit(1);
}
const bundleSource = scriptSrcs
  .map((rel) => {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) {
      console.error(`build: Skript fehlt: ${rel}`);
      process.exit(1);
    }
    return fs.readFileSync(p, 'utf8');
  })
  .join('\n;\n');
const bundle = minify('js', bundleSource, 'bundle');
const bundleName = `app.bundle.${hash10(bundle)}.js`;
fs.writeFileSync(path.join(dist, 'js', bundleName), bundle);

// 5) Eigenständig geladene Dateien behalten ihre Namen
//    gnpdf-worker.js: new Worker('js/gnpdf-worker.js', { type: 'module' })
//    mcp.js / storage-usage.js: nicht in index.html referenziert, gehören aber
//    weiterhin zum ausgelieferten dist/ (z. B. für externe Aufrufer/Tests).
for (const rel of ['js/gnpdf-worker.js', 'js/mcp.js', 'js/storage-usage.js']) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) continue;
  fs.writeFileSync(path.join(dist, rel), minify('js', fs.readFileSync(p, 'utf8'), path.basename(rel, '.js')));
}

// 6) index.html: ein Stylesheet, ein Bundle mit defer
{
  const p = path.join(dist, 'index.html');
  let h = fs.readFileSync(p, 'utf8');
  h = h.replace(/<link href="css\/styles\.css" rel="stylesheet">|<link rel="stylesheet" href="css\/styles\.css">/, `<link rel="stylesheet" href="css/${cssName}">`);
  const oldBlock = scriptSrcs.map((s) => `<script src="${s}"></script>`).join('\n');
  const oldBlockIndented = scriptSrcs.map((s) => `  <script src="${s}"></script>`).join('\n');
  const newBlock = `  <script src="js/${bundleName}" defer></script>`;
  if (h.includes(oldBlock)) h = h.replace(oldBlock, newBlock);
  else if (h.includes(oldBlockIndented)) h = h.replace(oldBlockIndented, newBlock);
  else {
    console.error('build: Skript-Block in index.html nicht gefunden.');
    process.exit(1);
  }
  if (h.includes('css/styles.css')) {
    console.error('build: CSS-Referenz in index.html nicht gefunden.');
    process.exit(1);
  }
  fs.writeFileSync(p, h);
}

// 7) sw.js: nur App-Shell precachen, kein Screenshot-/Doku-Ballast
{
  const p = path.join(dist, 'sw.js');
  let s = fs.readFileSync(p, 'utf8');
  const shell = [
    './',
    'index.html',
    `css/${cssName}`,
    `js/${bundleName}`,
    'js/gnpdf-worker.js',
    'manifest.webmanifest',
    paperFiles.webp,
    paperFiles.jpg,
    'icons/logo.svg',
    'icons/icon-192.png',
    'icons/icon-512.png',
  ];
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
    `/js/${bundleName}`,
    `/css/${cssName}`,
    `/${paperFiles.webp}`,
    `/${paperFiles.jpg}`,
    '/icons/*',
  ];
  const headers = [
    ...immutable.map((route) => `${route}\n  Cache-Control: public, max-age=31536000, immutable`),
    '/screenshots/*\n  Cache-Control: public, max-age=604800',
    '/index.html\n  Cache-Control: public, max-age=0, must-revalidate',
    '/sw.js\n  Cache-Control: public, max-age=0, must-revalidate',
    '/manifest.webmanifest\n  Cache-Control: public, max-age=0, must-revalidate',
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
