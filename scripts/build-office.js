// scripts/build-office.js – baut office/dist/ fuer das eigene Worker-Deployment.
//
// Gegenstueck zu scripts/build-dist.js (Federwerk), aber ohne geteilten Code:
// die beiden Bundles sind unabhaengig, werden aber nach derselben Regel
// gebaut, damit beide Deployments gleich cachebar sind.
//
// - Skripte aus office/js/ werden konkateniert, minifiziert (esbuild via npx)
//   und gehasht -> genau EIN Bundle statt sechs Requests.
// - office.css wird minifiziert und gehasht.
// - _headers: immutable fuer Hash-Dateien, must-revalidate fuer HTML.
//   Die CSP erlaubt das Einbetten des WASM-Editors per frame-src und laesst
//   die App selbst einbettbar (frame-ancestors 'self') – anders als der
//   Federwerk-Worker, der X-Frame-Options: DENY setzt.
// - Ohne Netz/ohne esbuild geht es unminifiziert weiter; das ist kein Fehler.
//
// Aufrufbar mit BUILD_ROOT/DIST_DIR, damit tests/build-office.test.js mit
// einem Minimal-Fixture bauen kann (gleiches Muster wie build-dist.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');

const root = process.env.BUILD_ROOT || path.join(__dirname, '..');
const dist = process.env.DIST_DIR || path.join(root, 'office', 'dist');
const esbuildBin = 'esbuild@0.25.10';

// Reihenfolge ist bedeutsam: Abhaengigkeiten zuerst, app.js als Einstieg
// zuletzt. Jedes Skript haengt sich an window bzw. module.exports.
const SCRIPTS = [
  'js/crypto.js',
  'js/kv.js',
  'js/storage-adapter.js',
  'js/docstore.js',
  'js/editor-adapter.js',
  'js/app.js',
];

function hash10(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-build-'));
process.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

function minify(kind, source, label) {
  const tmpIn = path.join(tmpDir, `${label}.in.${kind}`);
  const tmpOut = path.join(tmpDir, `${label}.out.${kind}`);
  const cleanup = (f) => { try { fs.rmSync(f, { force: true }); } catch { /* Windows: Datei gesperrt */ } };
  try {
    fs.writeFileSync(tmpIn, source);
    const q = (p) => '"' + String(p).split(path.sep).join('/').replace(/"/g, '\\"') + '"';
    const cmd = ['npx', '--yes', esbuildBin, '--minify', '--target=es2020', '--outfile=' + q(tmpOut), q(tmpIn)].join(' ');
    execFileSync(cmd, { stdio: ['ignore', 'ignore', 'pipe'], shell: true, windowsHide: true });
    const out = fs.readFileSync(tmpOut);
    if (kind === 'js') execFileSync(process.execPath, ['--check', tmpOut], { stdio: 'ignore' });
    return out.length < Buffer.byteLength(source) ? out : Buffer.from(source);
  } catch (e) {
    const why = String((e && (e.stderr || e.message)) || e).split('\n')[0].trim().slice(0, 160);
    console.warn(`build-office: Minifizierung für ${label} übersprungen (${why || 'esbuild nicht verfügbar'}).`);
    return Buffer.from(source);
  } finally {
    cleanup(tmpIn);
    cleanup(tmpOut);
  }
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'js'), { recursive: true });

// 1) Skripte: Pflichtdateien. Fehlt eine, ist das ein echter Fehler – ein
//    halbes dist/ waere still funktionsunfaehig (siehe build-dist.js).
const sources = [];
for (const rel of SCRIPTS) {
  const file = path.join(root, 'office', rel);
  if (!fs.existsSync(file)) {
    console.error(`build-office: Skript fehlt: office/${rel}`);
    process.exit(1);
  }
  sources.push(fs.readFileSync(file, 'utf8'));
}
const bundle = minify('js', sources.join('\n;\n'), 'office.bundle');
const bundleName = `office.bundle.${hash10(bundle)}.js`;
fs.writeFileSync(path.join(dist, 'js', bundleName), bundle);

// 2) CSS
const cssSource = fs.readFileSync(path.join(root, 'office', 'office.css'), 'utf8');
const cssMin = minify('css', cssSource, 'office');
const cssName = `office.${hash10(cssMin)}.css`;
fs.writeFileSync(path.join(dist, cssName), cssMin);

// 3) index.html: Bundle + Stylesheet einhaengen, Einzel-Skripte entfernen.
const htmlPath = path.join(root, 'office', 'index.html');
if (!fs.existsSync(htmlPath)) {
  console.error('build-office: office/index.html fehlt.');
  process.exit(1);
}
let html = fs.readFileSync(htmlPath, 'utf8');
const eol = html.includes('\r\n') ? '\r\n' : '\n';

// Zeilenumbruch-agnostisch (core.autocrlf): Blöcke ueber Whitespace loeschen.
const scriptTag = /[ \t]*<script src="js\/[^"]+\.js"><\/script>[ \t]*\r?\n?/g;
const found = (html.match(scriptTag) || []).length;
if (found !== SCRIPTS.length) {
  console.error(`build-office: Skript-Block unvollständig (${found}/${SCRIPTS.length} gefunden).`);
  process.exit(1);
}
html = html.replace(scriptTag, '');
html = html.replace(/<link\b[^>]*href="office\.css"[^>]*>/, `<link rel="stylesheet" href="${cssName}">`);
if (/<link\b[^>]*href="office\.css"/.test(html)) {
  console.error('build-office: CSS-Referenz nicht gefunden.');
  process.exit(1);
}
const tags = `  <script src="js/${bundleName}" defer></script>`;
html = /<\/body>/i.test(html)
  ? html.replace(/[ \t]*<\/body>/i, `${tags}${eol}</body>`)
  : `${html.replace(/\s*$/, '')}${eol}${tags}${eol}`;

// 4) _headers: Cache-Vertrag + Sicherheitsheader.
//    frame-src muss den WASM-Editor erlauben (runtime konfigurierbar, deshalb
//    bewusst 'self' + https:), ohne default-src zu weit aufzumachen.
const headers = [
  `/js/${bundleName}\n  Cache-Control: public, max-age=31536000, immutable`,
  `/${cssName}\n  Cache-Control: public, max-age=31536000, immutable`,
  '/index.html\n  Cache-Control: public, max-age=0, must-revalidate',
  "/*\n"
  + '  X-Content-Type-Options: nosniff\n'
  + '  Referrer-Policy: strict-origin-when-cross-origin\n'
  + '  Permissions-Policy: camera=(), microphone=(), geolocation=()\n'
  + "  Content-Security-Policy: default-src 'self'; "
  + "script-src 'self'; "
  + "style-src 'self'; "
  + "img-src 'self' data: blob:; "
  + "connect-src 'self'; "
  + "frame-src 'self' https:; "
  + "object-src 'none'; base-uri 'none'; form-action 'none'; "
  + "frame-ancestors 'self'",
].join('\n\n') + '\n';
fs.writeFileSync(path.join(dist, '_headers'), headers);

fs.writeFileSync(path.join(dist, 'index.html'), html);

// 5) Bestand auflisten (gleiche Ausgabe wie build-dist.js)
function listFiles(dir, base = dist, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

let total = 0;
for (const file of listFiles(dist).sort()) {
  const size = fs.statSync(path.join(dist, file)).size;
  total += size;
  console.log(`office/dist/${file} (${(size / 1024).toFixed(1)}K)`);
}
console.log(`office/dist gesamt: ${(total / 1024).toFixed(0)}K`);
