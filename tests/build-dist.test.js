// tests/build-dist.test.js – Build-Robustheit: CRLF-Checkouts (Windows),
// fehlendes esbuild (Fallback) und korrektes Umhängen der Asset-Referenzen.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const buildScript = path.join(root, 'scripts/build-dist.js');
let tmp = null;

function write(file, content) {
  const p = path.join(tmp.src, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// Mini-Fixture: alles, was scripts/build-dist.js erwartet.
function makeFixture(eol) {
  const scripts = ['js/pencil.js', 'js/editor.js', 'js/app.js'];
  const html = [
    '<!DOCTYPE html>',
    '<html lang="de">',
    '<head>',
    '<link rel="manifest" href="manifest.webmanifest">',
    '<link href="css/styles.css" rel="stylesheet">',
    '</head>',
    '<body>',
    '<div class="container"><span class="version-tag">v1.2.3 · BUILD x</span></div>',
    '<script src="js/pencil.js"></script>',
    '<script src="js/editor.js"></script>',
    '<script src="js/app.js"></script>',
    '</body>',
    '</html>',
    '',
  ].join(eol);
  write('index.html', html);
  write('manifest.webmanifest', '{"name":"f","version":"1.2.3"}');
  write('sw.js', "const CACHE = 'federwerk-v1.2.3';\nconst ASSETS = ['.', 'index.html'];\n");
  write('llms.txt', 'x');
  write('FEDERWERK_FORMAT.md', 'x');
  write('federwerk.schema.json', '{}');
  write('altes_Papier.webp', Buffer.from([0x52, 0x49, 0x46, 0x46]));
  write('altes_Papier.jpg', Buffer.from([0xff, 0xd8, 0xff]));
  write('css/styles.css', ':root{--bg-image:url(\'../altes_Papier.jpg\')}' + eol + 'body{background-image:var(--bg-image)}');
  for (const s of scripts) write(s, '/* ' + s + ' */' + eol + 'window.X_' + path.basename(s, '.js') + ' = 1;');
  write('js/gnpdf-worker.js', 'self.onmessage = () => {};');
  write('icons/logo.svg', '<svg></svg>');
  write('icons/icon-192.png', Buffer.from([0x89, 0x50]));
  write('icons/icon-512.png', Buffer.from([0x89, 0x50]));
  write('screenshots/preview-wide.png', Buffer.from([0x89, 0x50]));
  write('screenshots/preview-narrow.png', Buffer.from([0x89, 0x50]));
}

function runBuild() {
  // PATH ohne npx -> esbuild-Fallback, Build muss trotzdem durchlaufen
  const emptyBin = path.join(tmp.root, 'nobin');
  fs.mkdirSync(emptyBin, { recursive: true });
  execFileSync(process.execPath, [buildScript], {
    env: {
      ...process.env,
      BUILD_ROOT: tmp.src,
      DIST_DIR: path.join(tmp.root, 'dist'),
      PATH: emptyBin,
    },
    stdio: 'pipe',
  });
  return path.join(tmp.root, 'dist');
}

function assertBuilt(dist, eol) {
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, 'genau ein Script-Tag');
  assert.match(scripts[0], /^js\/app\.bundle\.[0-9a-f]{10}\.js$/, 'Bundle mit Hash');
  assert.ok(html.includes('defer'), 'Bundle mit defer');
  assert.ok(!html.includes('js/pencil.js'), 'keine Einzel-Skripte mehr');
  assert.ok(!html.includes('css/styles.css'), 'CSS umgehängt');
  assert.match(html, new RegExp('href="css/styles\\.[0-9a-f]{10}\\.css"'), 'gehashtes Stylesheet');
  if (eol === '\r\n') assert.ok(html.includes('\r\n'), 'CRLF-Zeilenenden bleiben erhalten');

  const bundle = fs.readFileSync(path.join(dist, scripts[0]), 'utf8');
  for (const f of ['X_pencil', 'X_editor', 'X_app']) {
    assert.ok(bundle.includes(f), f + ' im Bundle');
  }

  const css = fs.readdirSync(path.join(dist, 'css'));
  const cssFile = path.join(dist, 'css', css.find((f) => f.endsWith('.css')));
  const cssText = fs.readFileSync(cssFile, 'utf8');
  assert.ok(!cssText.includes('altes_Papier.jpg'), 'ungehashte Bild-URL entfernt');
  assert.match(cssText, /url\('\.\.\/assets\/papier\.[0-9a-f]{10}\.jpg'\)/, 'gehashte Bild-URL im CSS');

  const assets = fs.readdirSync(path.join(dist, 'assets'));
  const webp = assets.find((f) => /^papier\.[0-9a-f]{10}\.webp$/.test(f));
  const jpg = assets.find((f) => /^papier\.[0-9a-f]{10}\.jpg$/.test(f));
  assert.ok(webp, 'WebP-Asset gehasht');
  assert.ok(jpg, 'JPG-Fallback gehasht');
  assert.ok(cssText.includes(jpg), 'CSS zeigt auf das gehashte JPG');

  const sw = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8');
  assert.ok(sw.includes(scripts[0]), 'SW precacht das Bundle');
  assert.ok(!sw.includes("'index.html', 'css/styles.css'"), 'SW nutzt gehashtes CSS');
  assert.ok(!sw.includes('screenshots/'), 'SW ohne Screenshots');
  assert.ok(!fs.existsSync(path.join(dist, 'altes_Papier.png')), 'kein 2,5-MB-PNG im dist');

  const headers = fs.readFileSync(path.join(dist, '_headers'), 'utf8');
  assert.ok(headers.includes('/' + scripts[0]), 'immutable für Bundle');
  assert.ok(headers.includes('X-Content-Type-Options: nosniff'), 'Security-Header');
  assert.ok(headers.includes('X-Frame-Options: DENY'), 'X-Frame-Options');
  assert.ok(/index\.html\n {2}Cache-Control: public, max-age=0, must-revalidate/.test(headers), 'HTML revalidiert');
}

describe('scripts/build-dist.js', () => {
  before(() => {
    tmp = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'fw-build-test-')), src: null };
    tmp.src = path.join(tmp.root, 'src');
    fs.mkdirSync(tmp.src, { recursive: true });
  });
  after(() => { if (tmp) fs.rmSync(tmp.root, { recursive: true, force: true }); });

  it('baut mit LF-Zeilenenden (Linux/macOS)', () => {
    makeFixture('\n');
    assertBuilt(runBuild(), '\n');
  });

  it('baut mit CRLF-Zeilenenden (Windows-Checkout) – Regression', () => {
    makeFixture('\r\n');
    assertBuilt(runBuild(), '\r\n');
  });
});
