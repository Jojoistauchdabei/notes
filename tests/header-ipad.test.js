'use strict';
// Kopfzeile am iPad: die Leiste oben trug `backdrop-filter: blur(10px)` und
// klebte per `top: max(8px, var(--sat))` exakt an der Oberkante. Am Gerät war
// sie damit unlesbar – WebKit rendert den Blur einer stickigen Leiste
// fehlerhaft, der Blur greift auf den Inhalt der Leiste selbst über und die
// Schrift verwischt beim Scrollen.
//
// Geprüft wird, was stillschweigend zurückkommen könnte:
//   1. ein wieder eingeschalteter Blur – in styles.css ODER in einem Theme
//      (Neon-Glas blurrt .header sonst über die Signatur mit),
//   2. ein fehlender --edge-gap-Zuschlag (die Leiste würde wieder auf der
//      Kante kleben),
//   3. die Lücke zwischen Kopfzeile und Werkzeugleiste: sie bleibt nur gleich,
//      wenn beide denselben Zuschlag tragen und js/app.js ihn in
//      --toolbar-bottom mitrechnet.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const styles = read('css/styles.css');
const appJs = read('js/app.js');

const themeFiles = fs
  .readdirSync(path.join(root, 'css', 'themes'))
  .filter((f) => f.endsWith('.css'))
  .map((f) => `css/themes/${f}`);
const allCss = ['css/styles.css', ...themeFiles];

/* ".header" als eigene Klasse – nicht ".editor-header", nicht ".header-buttons". */
const mentionsHeader = /(^|[^-\w.])\.header(?![-\w])/;

/** Selektor des Blocks, in dem `index` steht (CSS-Nesting der Themes inklusive). */
function selectorAt(css, index) {
  const open = css.lastIndexOf('{', index);
  if (open < 0) return '';
  const from = Math.max(css.lastIndexOf('{', open - 1), css.lastIndexOf('}', open - 1)) + 1;
  return css.slice(from, open).trim();
}

/** Alle aktiven (nicht `none`) Blurs einer CSS-Datei mit ihrem Selektor. */
function blurs(file) {
  // Kommentare zuerst entfernen: sie erwähnen backdrop-filter und wären sonst
  // Fundstellen ohne Wirkung.
  const css = read(file).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out = [];
  const re = /(?:-\w+-)?backdrop-filter\s*:\s*([^;}]+)/g;
  let m;
  while ((m = re.exec(css))) {
    if (m[1].trim() !== 'none') out.push({ sel: selectorAt(css, m.index), value: m[1].trim() });
  }
  return out;
}

/** Textinhalt einer Regel der Form `.selektor { ... }` (Zeilenstil in styles.css). */
function rule(css, selector) {
  const m = css.match(new RegExp(`(^|\\n)${selector.replace(/[.]/g, '\\.')} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `${selector}-Regel nicht gefunden`);
  return m[2];
}

test('Kopfzeile: nirgends ein Blur (macht sie am iPad unlesbar)', () => {
  for (const file of allCss) {
    for (const b of blurs(file)) {
      assert.ok(
        !mentionsHeader.test(b.sel),
        `${file}: "${b.sel}" blurrt .header wieder (${b.value}) – am iPad verwischt die Schrift`
      );
    }
  }
});

test('Kopfzeile: deckend statt glasig, aber weiter aus den Theme-Tokens', () => {
  const header = rule(styles, '.header');
  assert.ok(
    !/backdrop-filter/.test(header),
    '.header hat wieder einen backdrop-filter – auf dem iPad unlesbar'
  );
  // Deckende Fläche ohne eigenen Farbwert: --bg als Grund, --surface als Film
  // darüber (dieselbe Technik wie beim --bg-image im Dunkelmodus).
  assert.match(header, /background-color:\s*var\(--bg\)/, 'kein deckender --bg-Grund');
  assert.match(
    header,
    /background-image:\s*linear-gradient\(var\(--surface\), var\(--surface\)\)/,
    'der --surface-Film fehlt – dann zeigt die Leiste die Theme-Fläche gar nicht'
  );
});

test('Kopfzeile: klebt nicht auf der Oberkante (--edge-gap)', () => {
  assert.match(styles, /--edge-gap:\s*6px/, '--edge-gap fehlt in :root');
  // Basis + die zwei mobilen Breakpoints, in denen .header neu gesetzt wird.
  const headerTops = styles.match(
    /top:\s*calc\(max\([^)]*\)\)\s*\+\s*var\(--edge-gap\)\)/g
  ) || [];
  assert.equal(headerTops.length, 3, `.header ohne --edge-gap in einem Breakpoint (${headerTops.length}/3)`);
  assert.ok(
    styles.includes('top: calc(var(--toolbar-top) + var(--sat) + var(--edge-gap))'),
    'die Werkzeugleiste rückt nicht mit – die Lücke zur Kopfzeile schrumpft um 6px'
  );
  // Der Zuschlag muss in --toolbar-bottom landen, sonst klebt die Pane-Bar
  // (Buchtitel-Zeile) 6px zu hoch unter der Werkzeugleiste.
  assert.match(
    appJs,
    /getComputedStyle\(root\)\.getPropertyValue\('--edge-gap'\)/,
    'js/app.js rechnet --edge-gap nicht in --toolbar-bottom ein'
  );
});
