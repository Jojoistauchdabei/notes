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
// wird office-wasm/build.sh vorher ausgefuehrt, und dort schlaegt der Build bei
// fehlendem WASM fehl (REQUIRE_OFFICE_WASM=1) - sonst waere ein Release
// stillschweigend ohne Engine.

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

const wasmSrc = process.env.OFFICE_WASM_DIR || path.join(root, 'office-wasm', 'dist');
const required = process.env.REQUIRE_OFFICE_WASM === '1';

function copyWasm() {
  if (!fs.existsSync(wasmSrc)) {
    const msg = 'build: office-wasm/dist fehlt - die DOCX/XLSX/PPTX-Engine wird nicht ausgeliefert.';
    if (required) {
      console.error('build: ' + msg);
      console.error('build: erwartet Build-Schritt: office-wasm/build.sh (siehe .github/workflows/release.yml)');
      process.exit(1);
    }
    console.warn('build: ' + msg + ' Weiter ohne sie (lokal/CI ohne Rust).');
    return;
  }
  const wanted = ['office_wasm.js', 'office_wasm_bg.wasm'];
  for (const name of wanted) {
    const from = path.join(wasmSrc, name);
    if (!fs.existsSync(from)) {
      console.error('build: ' + name + ' fehlt in office-wasm/dist.');
      process.exit(1);
    }
    fs.copyFileSync(from, path.join(dist, name));
    const kb = Math.round(fs.statSync(from).size / 1024);
    console.log('dist/' + name + ' (' + kb + 'K)');
  }
  // Der MIME-Typ fuer .wasm ist Pflicht: sonst faellt der Browser auf
  // instantiate() mit ArrayBuffer zurueck (deutlich langsameres Starten).
  const headers = path.join(wasmSrc, 'office_wasm.headers');
  if (fs.existsSync(headers)) {
    const target = path.join(dist, '_headers');
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const add = fs.readFileSync(headers, 'utf8').trim();
    if (!existing.includes('/office_wasm_bg.wasm')) {
      fs.writeFileSync(target, existing.replace(/\s*$/, '\n\n') + add + '\n', 'utf8');
      console.log('dist/_headers: WASM-MIME ergaenzt');
    }
  }
}

copyWasm();
console.log('build: fertig.');