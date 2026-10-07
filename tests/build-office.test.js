// tests/build-office.test.js – Build-Robustheit des Office-Bundles: CRLF-Checkouts
// (Windows), fehlendes esbuild (Fallback) und korrektes Umhaengen der Referenzen.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const buildScript = path.join(root, 'scripts/build-office.js');
let tmp = null;

function write(file, content) {
  const p = path.join(tmp.src, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// Mini-Fixture mit allen sechs Skripten, die scripts/build-office.js erwartet.
function makeFixture(eol) {
  fs.rmSync(tmp.src, { recursive: true, force: true });
  fs.mkdirSync(tmp.src, { recursive: true });
  write('office/index.html', [
    '<!DOCTYPE html>',
    '<html lang="de">',
    '<head>',
    '<link rel="stylesheet" href="office.css">',
    '</head>',
    '<body>',
    '<p id="unlockForm"></p>',
    '<script src="js/crypto.js"></script>',
    '<script src="js/kv.js"></script>',
    '<script src="js/storage-adapter.js"></script>',
    '<script src="js/docstore.js"></script>',
    '<script src="js/editor-adapter.js"></script>',
    '<script src="js/app.js"></script>',
    '</body>',
    '</html>',
    '',
  ].join(eol));
  write('office/office.css', '.a { color: red; }\n');
  const scripts = ['crypto', 'kv', 'storage-adapter', 'docstore', 'editor-adapter', 'app'];
  for (const name of scripts) {
    write(`office/js/${name}.js`, `// ${name}\nfunction f_${name.replace(/-/g, '_')}() { return ${scripts.indexOf(name) + 1}; }\n`);
  }
}

// Standard: ohne npx auf dem PATH. Das ist der Fallback-Pfad des Builds und
// kostet Millisekunden statt ~4 s pro Fall (npx laedt esbuild sonst neu).
// Nur der Test "mit esbuild" schaltet ihn ausdruecklich wieder zu.
function build(options) {
  const opts = options || {};
  const res = spawnSync(process.execPath, [buildScript], {
    cwd: tmp.src,
    encoding: 'utf8',
    env: {
      ...process.env,
      BUILD_ROOT: tmp.src,
      DIST_DIR: tmp.out,
      PATH: opts.npx ? process.env.PATH : '',
    },
  });
  if (res.status !== 0) throw new Error((res.stderr || res.stdout || '').trim());
  return { out: res.stdout || '', err: res.stderr || '' };
}

function listDist() {
  const out = [];
  (function walk(dir, base) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, base);
      else out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  })(tmp.out, tmp.out);
  return out.sort();
}

before(() => {
  tmp = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'office-build-test-')) };
  tmp.src = path.join(tmp.root, 'src');
  tmp.out = path.join(tmp.root, 'out');
  fs.mkdirSync(tmp.src, { recursive: true });
});

after(() => { if (tmp) fs.rmSync(tmp.root, { recursive: true, force: true }); });

describe('build-office', () => {
  it('erzeugt Bundle, CSS und _headers', () => {
    makeFixture('\n');
    build();
    const files = listDist();
    assert.equal(files.filter((f) => f.startsWith('js/') && f.endsWith('.js')).length, 1,
      'genau ein JS-Bundle statt sechs Requests');
    assert.equal(files.filter((f) => f.endsWith('.css')).length, 1);
    assert.ok(files.includes('index.html'));
    assert.ok(files.includes('_headers'));
  });

  it('haengt genau ein Bundle + gehashtes CSS ein, Einzel-Skripte raus', () => {
    makeFixture('\n');
    build();
    const html = fs.readFileSync(path.join(tmp.out, 'index.html'), 'utf8');
    assert.equal((html.match(/<script/g) || []).length, 1);
    assert.match(html, /<script src="js\/office\.bundle\.[0-9a-f]{10}\.js" defer><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="office\.[0-9a-f]{10}\.css">/);
    assert.ok(!/js\/crypto\.js/.test(html), 'Einzel-Skript-Referenz muss verschwunden sein');
    assert.ok(!/office\.css/.test(html), 'alte CSS-Referenz muss ersetzt sein');
  });

  it('CRLF-Checkout (core.autocrlf) baut genauso', () => {
    makeFixture('\r\n');
    const html = fs.readFileSync((build(), path.join(tmp.out, 'index.html')), 'utf8');
    assert.equal((html.match(/<script/g) || []).length, 1);
    assert.match(html, /<script src="js\/office\.bundle\.[0-9a-f]{10}\.js" defer><\/script>/);
  });

  it('Bundle enthaelt alle sechs Module in Abhaengigkeitsreihenfolge', () => {
    makeFixture('\n');
    build();
    const file = listDist().find((f) => f.endsWith('.js'));
    const src = fs.readFileSync(path.join(tmp.out, file), 'utf8');
    const pos = ['crypto', 'storage-adapter', 'app'].map((n) => src.indexOf('f_' + n.replace(/-/g, '_')));
    assert.ok(pos.every((p) => p >= 0), 'jedes Modul muss im Bundle stehen');
    assert.ok(pos[0] < pos[1] && pos[1] < pos[2], 'Reihenfolge: Abhaengigkeiten zuerst');
  });

  it('_headers: immutable fuer Hash-Dateien, CSP erlaubt den Editor-Frame', () => {
    makeFixture('\n');
    build();
    const headers = fs.readFileSync(path.join(tmp.out, '_headers'), 'utf8');
    assert.match(headers, /\/js\/office\.bundle\.[0-9a-f]{10}\.js\n {2}Cache-Control: public, max-age=31536000, immutable/);
    assert.match(headers, /\/index\.html\n {2}Cache-Control: public, max-age=0, must-revalidate/);
    assert.match(headers, /frame-src 'self' https:/, 'Editor muss einbettbar sein');
    assert.match(headers, /object-src 'none'/);
    assert.ok(!/X-Frame-Options: DENY/.test(headers), 'DENY wuerde das Einbetten der App verhindern');
  });

  it('ohne esbuild baut es unminifiziert weiter', () => {
    makeFixture('\n');
    const res = build();
    assert.ok(listDist().includes('index.html'), 'Build darf an fehlendem esbuild nicht scheitern');
    const file = listDist().find((f) => f.endsWith('.js'));
    const src = fs.readFileSync(path.join(tmp.out, file), 'utf8');
    assert.ok(src.includes('function f_crypto'), 'ungekuerzter Quelltext muss erhalten bleiben');
    assert.match(res.err, /Minifizierung/, 'der Fallback wird gemeldet (stderr)');
  });

  it('mit esbuild wird das Bundle minifiziert und bleibt gueltiges JS', () => {
    makeFixture('\n');
    build({ npx: true });
    const file = listDist().find((f) => f.endsWith('.js'));
    const raw = fs.readFileSync(path.join(tmp.out, file), 'utf8');
    const source = ['crypto', 'kv', 'storage-adapter', 'docstore', 'editor-adapter', 'app']
      .map((n) => fs.statSync(path.join(tmp.src, 'office/js', n + '.js')).size)
      .reduce((a, b) => a + b, 0);
    assert.ok(raw.length <= source, 'Bundle ist hoechstens so gross wie die Quellen');
    assert.doesNotThrow(() => new (require('node:vm').Script)(raw, { filename: 'bundle.js' }));
  });

  it('fehlendes Skript bricht den Build ab statt halb zu liefern', () => {
    makeFixture('\n');
    fs.rmSync(path.join(tmp.src, 'office/js/docstore.js'));
    assert.throws(() => build(), /Skript fehlt: office\/js\/docstore\.js/);
  });

  it('fehlende index.html bricht den Build ab', () => {
    makeFixture('\n');
    fs.rmSync(path.join(tmp.src, 'office/index.html'));
    assert.throws(() => build(), /index\.html fehlt/);
  });

  it('unvollstaendiger Skript-Block bricht den Build ab', () => {
    makeFixture('\n');
    const p = path.join(tmp.src, 'office/index.html');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('<script src="js/kv.js"></script>\n', ''));
    assert.throws(() => build(), /Skript-Block unvollständig/);
  });

  it('alte dist/ wird vorher geleert', () => {
    makeFixture('\n');
    fs.mkdirSync(path.join(tmp.out, 'js'), { recursive: true });
    fs.writeFileSync(path.join(tmp.out, 'js/alt.js'), '// von einem frueheren Build');
    build();
    assert.ok(!fs.existsSync(path.join(tmp.out, 'js/alt.js')));
  });
});
