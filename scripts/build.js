// scripts/build.js – Wrapper um scripts/build-dist.js und scripts/build-crafts.js.
//
// Zwei Schritte, und die Reihenfolge ist keine Geschmacksfrage:
//   1. build-dist.js baut dist/ (Bundles, gehashte Assets) und schreibt
//      dist/_headers mit den globalen Regeln – darunter
//      `X-Frame-Options: DENY` fuer /*.
//   2. build-crafts.js holt die Craft-Engines (WASM-Builds der storytold-Apps)
//      nach dist/crafts/<id>/ und HAENGT an _headers die Ausnahmen an:
//      gleich-origin erlaubt, weil craft.html die App im iframe rahmt.
// Umgekehrt wuerde build-dist die Ausnahmen wieder ueberschreiben.
//
// Fehlt build-crafts.js oder scheitert es (kein Netz, kein python3), laeuft der
// Build trotzdem durch: lokal soll eine App ohne Engine baubar bleiben. In den
// Release-Workflows setzen die Aufrufer CRAFTS_STRICT=1, dann bricht der Build
// ab – ein Release ohne Engines waere stillschweigend kaputt.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = process.env.BUILD_ROOT || path.join(__dirname, '..');
const streng = process.env.CRAFTS_STRICT === '1';

function lauf(skript) {
  execFileSync(process.execPath, [path.join(__dirname, skript)], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
}

console.log('build: scripts/build-dist.js ...');
lauf('build-dist.js');

if (process.env.CRAFTS_SKIP === '1') {
  console.warn('build: CRAFTS_SKIP=1 – dist/ entsteht ohne Craft-Engines.');
} else if (!fs.existsSync(path.join(__dirname, 'build-crafts.js'))) {
  if (streng) {
    console.error('build: scripts/build-crafts.js fehlt, CRAFTS_STRICT=1 verlangt aber Engines.');
    process.exit(1);
  }
  console.warn('build: scripts/build-crafts.js fehlt – dist/ entsteht ohne Craft-Engines.');
} else {
  console.log('build: scripts/build-crafts.js ...');
  try {
    lauf('build-crafts.js');
  } catch (e) {
    if (streng) throw e;
    console.warn('build: Craft-Engines konnten nicht geholt werden (' + ((e && e.message) || e) + ').');
    console.warn('build: die App laeuft, zeigt fuer Craft-Dokumente aber "Engine nicht eingebaut".');
  }
}

console.log('build: fertig.');
