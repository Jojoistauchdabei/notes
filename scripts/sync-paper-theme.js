#!/usr/bin/env node
// scripts/sync-paper-theme.js – erzeugt css/themes/papier.css aus css/styles.css
//
// Warum es das gibt: das Standard-Design ("Papier") ist genauso ein Theme
// wie die 15 Design-Varianten – nur eben mit dem Papier-Look, den die App
// schon immer hat. Damit auch IT die Hell/Dunkel-Schaltung des
// Theme-Systems befolgt (und nicht nur das System-Prefers-Color-Schema aus
// styles.css), braucht es fuer dieses Theme eine eigene Theme-Datei.
//
// Die Papier-Palette steht in css/styles.css und soll dort bleiben: doppelt
// festzuhalten hiesse, sie an zwei Orten pflegen zu muessen. Dieses Skript
// liest die Token aus styles.css und schreibt sie als Theme-Datei.
// styles.css bleibt die Quelle, papier.css nur das Spiegelbild.
//
// Aufruf:  node scripts/sync-paper-theme.js          (schreibt)
//          node scripts/sync-paper-theme.js --check  (prueft nur, Exit 1
//                                                    wenn veraltet)
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const stylesPath = path.join(root, 'css', 'styles.css');
const outPath = path.join(root, 'css', 'themes', 'papier.css');

/** Innen Inhalt des Blocks, dessen Selektor mit prefix beginnt. */
function block(css, prefix) {
  const i = css.indexOf(prefix);
  if (i < 0) throw new Error(`Block "${prefix}" nicht in styles.css gefunden`);
  const open = css.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}' && --depth === 0) return css.slice(open + 1, j);
  }
  throw new Error(`Block "${prefix}" nicht geschlossen`);
}

const styles = fs.readFileSync(stylesPath, 'utf8');

// :root kommt zweimal vor: erst die hellen Werte, dann (in der
// prefers-color-scheme-Query) die dunklen. Der erste Treffer ist der helle;
// die dunklen holen wir gezielt aus der Media Query und entpacken dort noch
// die innere :root-Huelle.
const light = block(styles, ':root {');
const darkMedia = block(styles, '@media (prefers-color-scheme: dark) {');
const dark = block(darkMedia, ':root {');

/** Nur Deklarationen: Kommentare raus, entschaerfen, einruecken. */
function declarations(raw) {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    // Die Textur-Pfade stammen aus styles.css (eine Ebene ueber css/).
    // In css/themes/ muss es zwei Ebenen sein.
    .map((l) => l.replace(/url\('\.\.\/altes_Papier\./g, "url('../../altes_Papier."))
    .map((l) => '  ' + l)
    .join('\n');
}

const file = `/* Federwerk-Theme "Papier" – das Standard-Design der App.
 *
 * ERZEUGT von scripts/sync-paper-theme.js aus css/styles.css.
 * Bitte nicht von Hand aendern: die Papier-Palette gehoert in styles.css,
 * dieses Skript spiegelt sie nur. Nach jeder Aenderung an den :root-Tokens
 * in styles.css laufen lassen:
 *
 *   npm run sync-paper-theme
 *
 * Warum es diese Datei ueberhaupt gibt: nur mit ihr befolgt das
 * Standard-Design die Hell/Dunkel-Schaltung des Theme-Systems. Ohne sie
 * wuerde styles.css allein das System-Prefers-Color-Schema bestimmen.
 *
 * Weitere Tokens stehen hier bewusst NICHT: fuer "papier" liefert
 * styles.css Farben, Rahmen, Radien und die Papier-Textura bereits
 * vollstaendig und hart verdrahtet. css/themes/_shared.css ist zudem auf
 * Nicht-Papier-Themen eingeschraenkt – diese Datei kann das Standard-Design
 * gar nicht veraendern, sie haelt nur dessen Palette fuer data-scheme
 * bereit.
 */
:root[data-theme="papier"] {
${declarations(light)}
}

:root[data-theme="papier"][data-scheme="dark"] {
${declarations(dark)}
}
`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  if (current !== file) {
    console.error('css/themes/papier.css ist veraltet – bitte `npm run sync-paper-theme` laufen lassen.');
    process.exit(1);
  }
  console.log('css/themes/papier.css ist aktuell.');
} else {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, file, 'utf8');
  console.log(`css/themes/papier.css geschrieben (${file.length} Bytes) – Quelle: css/styles.css`);
}
