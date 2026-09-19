// scripts/inject-version.js – stempelt die Release-Version in ein frisch
// gebautes dist/ (nach `npm run build`, vor ZIP/Deploy/Tauri-Build):
// - dist/index.html: sichtbarer version-tag (statt hartcodiert veraltet)
// - dist/manifest.webmanifest: version-Feld
// - dist/sw.js: CACHE-Name (sonst liefert die PWA ewig alte Dateien,
//   und der Update-Banner würde dauerhaft „neu verfügbar" melden)
// Nutzung: VERSION=1.7.5 npm run release-web  (ohne Env: package.json-Version)
const fs = require('fs');
const path = require('path');

const dist = process.env.DIST_DIR || path.join(__dirname, '..', 'dist');
const pkgFile = process.env.PACKAGE_JSON || 'package.json';
const version = (process.env.VERSION || JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version).replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Ungültige Version '${version}' (erwartet MAJOR.MINOR.PATCH).`);
  process.exit(1);
}
if (!fs.existsSync(dist)) {
  console.error('dist/ fehlt – zuerst `npm run build` ausführen.');
  process.exit(1);
}

function patch(file, regex, replacement, label) {
  const p = path.join(dist, file);
  const raw = fs.readFileSync(p, 'utf8');
  if (!regex.test(raw)) {
    console.error(`${file}: Muster für ${label} nicht gefunden.`);
    process.exit(1);
  }
  fs.writeFileSync(p, raw.replace(regex, replacement));
  console.log(`${file}: ${label} → ${version}`);
}

// <span class="version-tag" …>v1.7.2 · BUILD …</span> → v1.7.5 (BUILD-Datum behalten)
patch(
  'index.html',
  /(<span class="version-tag"[^>]*>v)\d+\.\d+\.\d+/,
  `$1${version}`,
  'version-tag'
);

// "version": "1.7.2" → "version": "1.7.5"
patch(
  'manifest.webmanifest',
  /("version"\s*:\s*")[^"]*(")/,
  `$1${version}$2`,
  'manifest-version'
);

// const CACHE = 'federwerk-v1.7.0' → 'federwerk-v1.7.5'
patch(
  'sw.js',
  /(const CACHE\s*=\s*'federwerk-v)[\d.]+(')/,
  `$1${version}$2`,
  'sw-cache'
);

console.log(`dist/ auf v${version} gestempelt.`);
