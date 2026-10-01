// Theme-System: die 15 Design-Themen + das Standard-Design "Papier".
//
// Geprueft wird das, was spaeter stillschweigend kaputtgehen koennte:
// fehlende Theme-Datei, ein Adapter, der das Standard-Design anfasst,
// papier.css ohne Synchronisation zu styles.css, themes.js im falschen
// Script-Block oder nicht offline verfuegbar.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const themesDir = path.join(root, 'css', 'themes');
const sharedPath = path.join(themesDir, '_shared.css');
const paperPath = path.join(themesDir, 'papier.css');
const themesJs = read('js/themes.js');
const indexHtml = read('index.html');
const swJs = read('sw.js');
const buildDist = read('scripts/build-dist.js');

/* Die Theme-Liste aus themes.js ziehen – sie ist die fuehrende Quelle,
 * nicht die Liste der Dateien: eine Design-Vorlage ohne Datei waere ein
 * Fehler, eine Datei ohne Eintrag waere totes Gewicht. */
function themeList() {
  const start = themesJs.indexOf('var LIST = [');
  assert.ok(start > 0, 'themes.js: var LIST nicht gefunden');
  const open = themesJs.indexOf('[', start);
  const close = themesJs.indexOf('\n  ];', open);
  assert.ok(close > open, 'themes.js: LIST nicht geschlossen');
  return [...themesJs.slice(open, close).matchAll(/\{ id: '([^']+)', name: '([^']+)', file: (null|'[^']+')/g)].map(
    (m) => ({ id: m[1], name: m[2], file: m[3].replace(/'/g, '') })
  );
}

test('themes.js: die 16 Themen liegen in css/themes/', () => {
  const list = themeList();
  assert.strictEqual(list.length, 16, 'erwartet: 15 Designs + Standard "Papier"');
  assert.strictEqual(list[0].id, 'papier', 'Standard-Thema steht vorn');

  for (const t of list) {
    assert.ok(t.file, `${t.id}: kein Dateiname in der LIST`);
    const p = path.join(themesDir, `${t.file}.css`);
    assert.ok(fs.existsSync(p), `${t.id}: ${t.file}.css fehlt in css/themes/`);
  }

  // Und umgekehrt: keine Datei ohne LIST-Eintrag (sonst waere sie toter Code).
  const known = new Set(list.map((t) => `${t.file}.css`));
  known.add('_shared.css');
  const onDisk = fs.readdirSync(themesDir).filter((f) => f.endsWith('.css'));
  const orphans = onDisk.filter((f) => !known.has(f));
  assert.deepStrictEqual(orphans, [], `Dateien ohne LIST-Eintrag: ${orphans.join(', ')}`);
});

test('jede Theme-Datei liefert hell und dunkel', () => {
  for (const t of themeList()) {
    if (t.id === 'papier') continue; // erzeugt von scripts/sync-paper-theme.js
    const css = fs.readFileSync(path.join(themesDir, `${t.file}.css`), 'utf8');
    assert.ok(
      css.includes(`:root[data-theme="${t.id}"] {`),
      `${t.id}: fehlender Light-Block :root[data-theme="${t.id}"]`
    );
    assert.ok(
      css.includes(`:root[data-theme="${t.id}"][data-scheme="dark"] {`),
      `${t.id}: fehlender Dark-Block [data-scheme="dark"]`
    );
  }
});

test('jede Theme-Datei setzt die Schriften in BEIDEN Schemata', () => {
  // Bei dunkel-first-Themen (Terminal, Neon-Glas, Blueprint, Werkbank) steht
  // die helle Variante als Ueberschreibung im Entwurf – dort fehlen die
  // Font-Tokens. Ohne sie faellt var(--font-body) in Hell auf den
  // Initialwert zurueck und die Seite erscheint in Times.
  for (const t of themeList()) {
    if (t.id === 'papier') continue; // nutzt die Web-Fonts aus styles.css
    const css = fs.readFileSync(path.join(themesDir, `${t.file}.css`), 'utf8');
    const blocks = [
      ['hell', css.slice(css.indexOf(`:root[data-theme="${t.id}"] {`), css.indexOf(`:root[data-theme="${t.id}"][data-scheme="dark"] {`))],
      ['dunkel', css.slice(css.indexOf(`:root[data-theme="${t.id}"][data-scheme="dark"] {`))]
    ];
    for (const [name, block] of blocks) {
      for (const token of ['--font-body', '--font-display']) {
        assert.ok(block.includes(token), `${t.id} (${name}): ${token} fehlt`);
      }
    }
  }
});

test('Theme-Dateien brauchen keine Media Query – Helligkeit kommt aus data-scheme', () => {
  // themes.js setzt data-scheme immer explizit (auch "auto" wird aufgeloest),
  // ein @media(prefers-color-scheme) in einer Theme-Datei waere toter Code
  // und wuerde die Datei nur aufblaehen.
  for (const t of themeList()) {
    const css = fs.readFileSync(path.join(themesDir, `${t.file}.css`), 'utf8');
    assert.ok(
      !/prefers-color-scheme/.test(css),
      `${t.id}: prefers-color-scheme gehoert nach themes.js, nicht ins Theme-CSS`
    );
  }
});

test('_shared.css fasst das Standard-Design "Papier" nicht an', () => {
  const shared = fs.readFileSync(sharedPath, 'utf8');
  const rootRules = [...shared.matchAll(/:root\[data-theme\][^\s{]*\s*\{/g)].map((m) => m[0].trim());
  assert.ok(rootRules.length > 0, 'Adapter hat keine :root[data-theme]-Regeln');
  for (const sel of rootRules) {
    assert.ok(
      sel.startsWith(':root[data-theme]:not([data-theme="papier"])'),
      `Adapter-Regel "${sel}" gilt auch fuer "papier" – der Standard-Look waere veraendert`
    );
  }
});

test('_shared.css leitet die Tokens ab, die styles.css erwartet', () => {
  const shared = fs.readFileSync(sharedPath, 'utf8');
  // Diese Namen benutzt styles.css, ohne sie selbst zu setzen. Fehlt einer,
  // bekommen Buttons/Felder beim Theme-Wechsel einen leeren Wert und fallen
  // auf den Initialwert zurueck.
  for (const token of [
    '--accent-dark',
    '--accent-muted',
    '--border-light',
    '--surface-strong',
    '--field-bg',
    '--button-bg',
    '--button-text',
    '--mini-button-hover-bg',
    '--paper-texture'
  ]) {
    assert.ok(shared.includes(`${token}:`), `_shared.css: ${token} wird nicht gesetzt`);
  }
  // --bg-image muss eine gueltige Bildebene sein: die Papier-Varianten
  // bauen Komma-Listen, und ein "none" wuerde die ganze Deklaration
  // verwerfen (Liste darf kein "none" enthalten).
  const bgImage = shared.match(/--bg-image:\s*([^;]+);/);
  assert.ok(bgImage, '_shared.css: --bg-image nicht gesetzt');
  assert.ok(
    !/^\s*none\s*$/.test(bgImage[1]),
    '_shared.css: --bg-image darf nicht "none" sein (Papier-Komma-Listen)'
  );
  const texture = shared.match(/--paper-texture:\s*([^;]+);/);
  assert.ok(texture && !/^\s*none\s*$/.test(texture[1]), '--paper-texture darf nicht "none" sein');
});

test('papier.css ist mit styles.css synchron', () => {
  // Sonst driftet die Papier-Palette stillschweigend auseinander: styles.css
  // aendert, papier.css nicht, und Hell/Dunkel zeigt plötzlich andere Farben.
  const { execFileSync } = require('node:child_process');
  try {
    execFileSync(process.execPath, [path.join(root, 'scripts', 'sync-paper-theme.js'), '--check'], {
      cwd: root,
      stdio: 'pipe'
    });
  } catch (e) {
    assert.fail(
      `css/themes/papier.css ist veraltet. Bitte \`npm run sync-paper-theme\` laufen lassen.\n${
        (e.stderr || '').toString().trim()
      }`
    );
  }
});

test('papier.css zeigt auf eine existierende Papier-Textur', () => {
  // Die Pfade stammen aus styles.css (eine Ebene ueber css/). In
  // css/themes/ muss es zwei Ebenen sein – sonst liefern sie stillschweigend
  // ein 404 und das Standard-Design verliert seine Textur.
  const paper = fs.readFileSync(paperPath, 'utf8');
  const urls = [...paper.matchAll(/url\(['"](\.\.\/[^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 2, `papier.css: keine Bildpfade gefunden (gefunden: ${urls.length})`);
  for (const u of urls) {
    assert.ok(
      u.startsWith('../../'),
      `papier.css: "${u}" ist zu flach – ab css/themes/ braucht es ../../`
    );
    const p = path.join(themesDir, u);
    assert.ok(fs.existsSync(p), `papier.css: "${u}" existiert nicht (${path.relative(root, p)})`);
  }
  // Und der Build muss sie auf die gehashten Dateien umschreiben, sonst zeigt
  // der Release auf altes_Papier.*, das es in dist/ gar nicht gibt.
  const rewrite = buildDist.match(/.*altes_Papier\\\.\(webp\|jpg\).*/g) || [];
  const themeRewrite = rewrite.find((l) => l.includes('\\.\\.\\/\\.\\.\\/'));
  assert.ok(themeRewrite, 'build-dist.js: keine Umschreibung fuer die Theme-Pfade (../../altes_Papier)');
  assert.ok(
    themeRewrite.includes("`url('../../${paperFiles[ext]}')`"),
    'build-dist.js: Ziel der Theme-Umschreibung ist nicht ../../assets/'
  );
  assert.ok(
    buildDist.includes("path.join(dist, 'css', 'themes')"),
    'build-dist.js: css/themes/ wird nicht ins dist kopiert'
  );
});

test('index.html laedt themes.js im head – und nicht ins Bundle', () => {
  const tag = indexHtml.match(/<script src="js\/themes\.js"[^>]*><\/script>/);
  assert.ok(tag, 'index.html: themes.js nicht geladen');
  // build-dist buendelt nur Skript-Tags OHNE weitere Attribute. Ohne
  // data-boot landet themes.js im defer-Bundle am Seitenende und die Seite
  // blitzte im Standard-Design auf.
  assert.ok(/data-boot/.test(tag[0]), 'themes.js-Tag braucht ein data-boot-Attribut (Bundle-Sperre)');
  const head = indexHtml.slice(0, indexHtml.indexOf('</head>'));
  assert.ok(head.includes(tag[0]), 'themes.js muss vor </head> stehen (kein FOUC)');
});

test('themes.js ist offline verfuegbar und wandert mit ins dist', () => {
  // themes.js ist nicht im Bundle -> muss im sw.js-Precache stehen,
  // sonst gibt es beim Offline-Start gar kein Theme-System.
  const assets = swJs.match(/const ASSETS = \[([\s\S]*?)\];/);
  assert.ok(assets, 'sw.js: ASSETS nicht gefunden');
  assert.ok(assets[1].includes("'js/themes.js'"), 'sw.js: js/themes.js nicht im Precache');
  assert.ok(buildDist.includes("'js/themes.js'"), 'build-dist.js: js/themes.js wird nicht kopiert');
  assert.ok(buildDist.includes("'css', 'themes'"), 'build-dist.js: css/themes/ wird nicht kopiert');
});

test('present.html folgt dem Theme des Notizbuchs', () => {
  // SPEC-38 verlangt, dass Schirm und Notizbuch gleich aussehen; present.html
  // zieht .stage/.text-box bewusst aus css/styles.css. Ohne themes.js bliebe
  // der Schirm im Standard-Design stehen, waehrend das Notizbuch z. B. im
  // Blueprint laeuft.
  const present = read('present.html');
  const tag = present.match(/<script src="js\/themes\.js"[^>]*><\/script>/);
  assert.ok(tag, 'present.html: themes.js nicht geladen');
  assert.ok(/data-boot/.test(tag[0]), 'present.html: themes.js-Tag braucht data-boot (Bundle-Sperre)');
  // Muss nach dem Stylesheet stehen, sonst greifen die Theme-Regeln nicht.
  assert.ok(
    present.indexOf(tag[0]) > present.indexOf('css/styles.css'),
    'present.html: themes.js steht vor dem Stylesheet'
  );
  // themes.js wird eigenständig kopiert – bleibt also auch dann da, wenn
  // present.html sein Skript-Bundle bekommt.
  assert.ok(buildDist.includes("'js/themes.js'"), 'build-dist.js: js/themes.js wird nicht kopiert');
  assert.ok(swJs.includes("'present.html'"), 'sw.js: present.html nicht im Precache (Schirm offline kaputt)');
  // Kein Auswahl-Knopf auf dem Schirm: themes.js haengt ihn nur an
  // .header-buttons, und die gibt es in present.html nicht.
  assert.ok(!/header-buttons/.test(present), 'present.html: Schirm sollte keine eigene Kopfzeile haben');
});

test('themes.js laedt Papier ohne Adapter und Designs mit', () => {
  // Sonst waere beim Standard-Design der Adapter geladen – und damit der
  // Papier-Look nicht mehr der von styles.css.
  assert.ok(/noAdapter: true/.test(themesJs), 'themes.js: "papier" ist nicht als noAdapter markiert');
  assert.ok(/t\.noAdapter\) dropLink\('fw-theme-shared'\)/.test(themesJs), 'themes.js: Papier laedt den Adapter doch');
});

test('Die Design-Dateien in tmp/designs bleiben mit den App-Themes gleich', () => {
  // Nur pruefbar, solange die Entwurfsseiten da sind (tmp/ ist gitignoriert,
  // der Test darf deshalb nicht fehlschlagen, wenn sie fehlen).
  const designsDir = path.join(root, 'tmp', 'designs');
  if (!fs.existsSync(designsDir)) return;
  const designFiles = fs.readdirSync(designsDir).filter((f) => /^\d\d-.*\.html$/.test(f));
  if (!designFiles.length) return;
  const appIds = new Set(themeList().map((t) => t.file));
  for (const f of designFiles) {
    const id = f.replace(/\.html$/, '');
    assert.ok(appIds.has(id), `${f}: Entwurfsseite ohne zugehoeriges App-Theme css/themes/${id}.css`);
  }
});
