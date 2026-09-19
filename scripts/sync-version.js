// scripts/sync-version.js – hält package.json, manifest.webmanifest,
// src-tauri/tauri.conf.json und src-tauri/Cargo.toml auf derselben Version.
// Nutzung: VERSION=1.7.3 npm run sync-version  (oder ohne Env: nimmt package.json)
// Die CI (tauri.yml) macht dasselbe pro Release-Tag automatisch.
const fs = require('fs');

const version = (process.env.VERSION || JSON.parse(fs.readFileSync('package.json', 'utf8')).version).replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Ungültige Version '${version}' (erwartet MAJOR.MINOR.PATCH).`);
  process.exit(1);
}

function writeJSON(path, mutate) {
  // Formatierung erhalten: nur die version-Zeile ersetzen statt neu zu serialisieren.
  const raw = fs.readFileSync(path, 'utf8');
  const j = JSON.parse(raw);
  mutate(j);
  if (!/"version"\s*:\s*"[^"]*"/.test(raw)) {
    console.error(`${path}: keine version-Zeile gefunden.`);
    process.exit(1);
  }
  fs.writeFileSync(path, raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${j.version}$2`));
}

writeJSON('package.json', (j) => { j.version = version; });
writeJSON('manifest.webmanifest', (j) => { j.version = version; });
writeJSON('src-tauri/tauri.conf.json', (j) => { j.version = version; });

let cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');
if (!/^version = ".*"$/m.test(cargo)) {
  console.error('src-tauri/Cargo.toml: keine version-Zeile gefunden.');
  process.exit(1);
}
const next = cargo.replace(/^version = ".*"$/m, `version = "${version}"`);
fs.writeFileSync('src-tauri/Cargo.toml', next);
console.log(`Version auf ${version} synchronisiert.`);
