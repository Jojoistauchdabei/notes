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

/* Eine WASM-Engine nach dist/ kopieren. office -> office_wasm (DOCX/XLSX/PPTX),
 * craft -> craft_wasm (PSD/SVG/IDML). Getrennt, weil die Engines selten
 * gleichzeitig gebraucht werden: so bleibt jede Datei klein und wird nur
 * geladen, wenn sie gebraucht wird.
 *
 * `requiredOnly` erlaubt einen Modifier wie REQUIRE_CRAFT_WASM=1, damit ein
 * Release auch gezielt auf das Fehlen einer bestimmten Engine reagieren kann. */
function copyWasm(kind, requiredOnly) {
  const base = kind === 'craft' ? 'craft_wasm' : 'office_wasm';
  const srcDir = (kind === 'craft' ? process.env.CRAFT_WASM_DIR : process.env.OFFICE_WASM_DIR)
    || path.join(root, kind + '-wasm', 'dist');
  const files = [base + '.js', base + '_bg.wasm'];

  if (!fs.existsSync(srcDir)) {
    if (requiredOnly || required) {
      console.error('build: ' + srcDir + ' fehlt - die ' + kind + '-Engine wird nicht ausgeliefert.');
      console.error('build: erwartet Build-Schritt: ' + kind + '-wasm/build.sh');
      process.exit(1);
    }
    console.warn('build: ' + kind + '-Engine fehlt (' + srcDir + '), wird nicht ausgeliefert.');
    return;
  }
  for (const name of files) {
    const from = path.join(srcDir, name);
    if (!fs.existsSync(from)) {
      if (requiredOnly || required) {
        console.error('build: ' + name + ' fehlt in ' + srcDir + '.');
        process.exit(1);
      }
      console.warn('build: ' + name + ' fehlt in ' + srcDir + ', wird uebersprungen.');
      return;
    }
  }
  for (const name of files) {
    const from = path.join(srcDir, name);
    fs.copyFileSync(from, path.join(dist, name));
    const kb = Math.round(fs.statSync(from).size / 1024);
    console.log('dist/' + name + ' (' + kb + 'K)');
  }
  // Der MIME-Typ fuer .wasm ist Pflicht: sonst faellt der Browser auf
  // instantiate() mit ArrayBuffer zurueck (deutlich langsameres Starten).
  const headers = path.join(srcDir, base + '.headers');
  if (fs.existsSync(headers)) {
    const target = path.join(dist, '_headers');
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const add = fs.readFileSync(headers, 'utf8').trim();
    if (!existing.includes('/' + base + '_bg.wasm')) {
      fs.writeFileSync(target, existing.replace(/\s*$/, '\n\n') + add + '\n', 'utf8');
      console.log('dist/_headers: ' + base + '-MIME ergaenzt');
    }
  }
}

copyWasm('office', false);
copyWasm('craft', process.env.REQUIRE_CRAFT_WASM === '1');
console.log('build: fertig.');