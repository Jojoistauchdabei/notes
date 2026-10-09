'use strict';
// tests/build-wasm.test.js â€“ scripts/build.js: die Engine kommt ins dist/,
// egal ob lokal gebaut oder aus dem GitHub-Release geholt. Ohne Rust-Toolchain
// (Cloudflare Workers Builds, fremde CI) ist genau der zweite Weg der einzige,
// der eine vollstaendige App erzeugt (SPEC-40).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const buildJs = path.join(root, 'scripts', 'build.js');
const src = fs.readFileSync(buildJs, 'utf8');

/* Ein eigenes Arbeitsverzeichnis, damit der Test weder das echte dist/ noch das
 * tmp/ des Projekts anfasst. BUILD_ROOT/DIST_DIR sind genau dafÃ¼r vorgesehen. */
function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'federwerk-wasm-'));
  fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(buildJs, path.join(dir, 'scripts', 'build.js'));
  // build-dist.js wird nur gestartet, nicht ausgewertet â€“ ein Stub reicht. Er
  // muss aber dist/ anlegen, weil build.js danach dorthin kopiert.
  fs.writeFileSync(path.join(dir, 'scripts', 'build-dist.js'),
    'const fs = require("fs");\n' +
    'fs.mkdirSync(process.env.DIST_DIR, { recursive: true });\n' +
    'fs.writeFileSync(process.env.DIST_DIR + "/index.html", "<!doctype html>");\n' +
    'console.log("build: stub");\n');
  return dir;
}

function distDir(dir) {
  return path.join(dir, 'dist');
}

function hatWasm(dir) {
  return fs.existsSync(path.join(distDir(dir), 'office_wasm_bg.wasm'))
    && fs.existsSync(path.join(distDir(dir), 'craft_wasm_bg.wasm'));
}

describe('build.js: Release-Assets und MIME', () => {
  it('haengt die vier Engine-Dateien in beide Release-Workflows', () => {
    for (const wf of ['auto-release.yml', 'release.yml']) {
      const y = fs.readFileSync(path.join(root, '.github', 'workflows', wf), 'utf8');
      for (const f of ['office_wasm.js', 'office_wasm_bg.wasm', 'craft_wasm.js', 'craft_wasm_bg.wasm']) {
        assert.ok(y.includes(f), wf + ' laesst ' + f + ' als Release-Asset aus');
      }
      assert.match(y, /gh release upload[\s\S]{0,400}wasm/, wf + ' laesst die Engine wirklich hochladen');
    }
  });

  it('bricht das Release ab, wenn eine Engine im dist fehlt', () => {
    for (const wf of ['auto-release.yml', 'release.yml']) {
      const y = fs.readFileSync(path.join(root, '.github', 'workflows', wf), 'utf8');
      assert.match(y, /::error::dist\/\$f fehlt/, wf + ' prueft die Engine vor dem Upload');
    }
  });

  it('traegt den MIME-Eintrag auch ohne build.sh ein', () => {
    // Genau der Fall, der Cloudflare erwischt hat: kein office-wasm/dist/, also
    // keine office_wasm.headers - ohne den Fallback kaeme die WASM als
    // application/octet-stream heraus.
    assert.match(src, /fs\.existsSync\(headers\)[\s\S]{0,80}\?/, 'build.sh-Datei wird bevorzugt');
    assert.match(src, /Content-Type: application\/wasm/, 'Fallback traegt application/wasm');
    assert.match(src, /Content-Type: text\/javascript/, 'Fallback traegt die Glue auch');
  });

  it('prueft die WASM-Magic, weil der Worker 200 mit HTML liefert', () => {
    // not_found_handling = single-page-application: eine fehlende Datei kommt als
    // App-Shell mit HTTP 200 zurueck. Ohne Magic-Pruefung landet HTML im dist/.
    assert.match(src, /istWasm/, 'die Magic-Pruefung wird benutzt');
    assert.match(src, /0x00, 0x61, 0x73, 0x6d/, '00 61 73 6d ist die gesuchte Signatur');
    assert.match(src, /name\.endsWith\('\.wasm'\)/, 'nur fuer _bg.wasm gilt die WASM-Magic');
  });

  it('nutzt GITHUB_REF fuer Tag-Builds und sonst das juengste Release', () => {
    // Der Quelltext enthaelt die Regex als /^refs\/tags\/(.+)$/ â€“ escaped gesucht.
    assert.match(src, /refs\\\/tags\\\//, 'Tag-Builds nehmen ihren Tag');
    assert.match(src, /\/releases\/latest/, 'sonst das juengste Release');
  });

  it('laesst den Download abschaltbar, ohne die Engines zu verlieren', () => {
    assert.match(src, /FEDERWERK_NO_WASM_DOWNLOAD/, 'Abschalter vorhanden');
    assert.match(src, /FEDERWERK_WASM_RELEASE/, 'Release fest pinnbar');
  });

  it('baut lokal vor, bevor es herunterlaedt', () => {
    // Das Release-Asset muss die Engine *dieses* Commits sein. Wer selbst bauen
    // kann, nutzt das; der Download ist nur der Notfallweg.
    const reihenfolge = src.indexOf('holeEngine(kind, base)');
    const kopieren = src.indexOf('fs.copyFileSync(from, path.join(dist, name))');
    assert.ok(reihenfolge > 0 && kopieren > 0);
    assert.ok(reihenfolge < kopieren, 'die Quelle wird vor dem Kopieren entschieden');
  });
});

describe('build.js: Engine landet im dist', () => {

  /* Der Download-Pfad braucht Netz und ein Release mit Engine-Assets. Beides ist
   * in fremden Umgebungen nicht garantiert, deshalb wird die Quelle simuliert:
   * ein lokaler HTTP-Server liefert die vier Dateien, inklusive eines Faells mit
   * kaputter Magic. So prueft der Test den echten Code ohne GitHub. */
  /* WICHTIG: Der Server laeuft in einem eigenen Prozess. Waere er im Test-
   Prozess, wuerde execFileSync (synchron!) dessen Event-Loop blockieren,
   waehrend build.js auf genau diesen Server wartet - ein Deadlock. */
function fakeRelease(tot, kaputteMagic) {
  const script = `
    const http = require('node:http');
    const path = require('node:path');
    const kaputt = ${kaputteMagic === true ? 'true' : 'false'};
    const server = http.createServer((req, res) => {
      // Die Release-Angabe kommt zuerst, danach die Dateien aus dem Tag.
      if (req.url.includes('/releases/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ tag_name: ${JSON.stringify(tot)} }));
        return;
      }
      const name = path.basename(req.url);
      const wasm = name.endsWith('.wasm');
      const body = wasm
        ? (kaputt ? Buffer.from('<!doctype html>') : Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 2, 3, 4]))
        : Buffer.from('// glue ' + name);
      res.writeHead(200, { 'content-type': wasm ? 'application/wasm' : 'text/javascript' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write(String(server.address().port));
    });
  `;
  const tmpOrdner = fs.mkdtempSync(path.join(os.tmpdir(), 'federwerk-fake-'));
  const datei = path.join(tmpOrdner, 'server.js');
  fs.writeFileSync(datei, script);
  const kindFn = spawn(process.execPath, [datei], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return new Promise((resolve, reject) => {
    let port = '';
    const timer = setTimeout(() => reject(new Error('Server kam nicht hoch')), 8000);
    kindFn.stdout.on('data', (d) => {
      port += d.toString();
      if (port) { clearTimeout(timer); resolve({ kindFn, ordner: tmpOrdner, port: parseInt(port, 10), url: 'http://127.0.0.1:' + port }); }
    });
    kindFn.on('error', reject);
  });
}

function stopFake(fake) {
  if (!fake) return;
  try { fake.kindFn.kill(); } catch (e) { /* schon weg */ }
  fs.rmSync(fake.ordner, { recursive: true, force: true });
}

  /* releaseTag() fragt die GitHub-API; der Server beantwortet beides ueber
   * /latest, und der Pfad wird per FETCH_BASE umgebogen. */
  it('holt beide Engines aus dem Release, wenn kein Rust da ist', async () => {
    const fake = await fakeRelease('v9.9.9');
    const d = makeRoot();
    try {
      execFileSync(process.execPath, [path.join(d, 'scripts', 'build.js')], {
        cwd: d,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          BUILD_ROOT: d,
          DIST_DIR: distDir(d),
          FEDERWERK_REPO: 'test/irgendwas',
          FETCH_BASE: fake.url,
        },
      });
      assert.ok(hatWasm(d), 'beide _bg.wasm liegen im dist');
      const wasm = fs.readFileSync(path.join(distDir(d), 'office_wasm_bg.wasm')).subarray(0, 4);
      assert.deepEqual(Array.from(wasm), [0x00, 0x61, 0x73, 0x6d], 'echtes WebAssembly, kein HTML');
      const headers = fs.readFileSync(path.join(distDir(d), '_headers'), 'utf8');
      assert.match(headers, /\/office_wasm_bg\.wasm\s*\r?\n\s*Content-Type: application\/wasm/);
      assert.match(headers, /\/craft_wasm_bg\.wasm\s*\r?\n\s*Content-Type: application\/wasm/);
    } finally {
      stopFake(fake);
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('verwirft eine heruntergeladene Datei ohne WASM-Magic', async () => {
    // Der Worker liefert bei fehlender Datei HTTP 200 mit der App-Shell. Ohne
    // diese Pruefung landete HTML als "Engine" im dist.
    const fake = await fakeRelease('v9.9.9', true);
    const d = makeRoot();
    try {
      /* console.warn landet in stderr. execFileSync gibt stderr nur im Fehlerfall
       zurueck - deshalb spawnSync, das stdout und stderr getrennt liefert. */
      const r = spawnSync(process.execPath, [path.join(d, 'scripts', 'build.js')], {
        cwd: d,
        encoding: 'utf8',
        env: {
          ...process.env,
          BUILD_ROOT: d,
          DIST_DIR: distDir(d),
          FEDERWERK_REPO: 'test/irgendwas',
          FETCH_BASE: fake.url,
        },
      });
      const aus = (r.stdout || '') + (r.stderr || '');
      assert.match(aus, /kein WebAssembly/, 'die kaputte Datei wird gemeldet');
      assert.ok(!fs.existsSync(path.join(distDir(d), 'office_wasm_bg.wasm')),
        'und nicht ins dist gelegt');
    } finally {
      stopFake(fake);
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('bricht streng ab, wenn die Engine fehlt und der Download nichts bringt', () => {
    const d2 = makeRoot();
    let schlugFehl = false;
    try {
      execFileSync(process.execPath, [path.join(d2, 'scripts', 'build.js')], {
        cwd: d2,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          BUILD_ROOT: d2,
          DIST_DIR: path.join(d2, 'dist'),
          REQUIRE_OFFICE_WASM: '1',
          REQUIRE_CRAFT_WASM: '1',
          // Nicht erreichbar: so bleibt der Test ohne Netz.
          FEDERWERK_REPO: 'federwerk-does-not-exist/nirgends',
          GITHUB_REPOSITORY: '',
          GITHUB_REF: 'refs/tags/v0.0.0-does-not-exist',
        },
      });
    } catch (e) {
      schlugFehl = e.status === 1;
    } finally {
      fs.rmSync(d2, { recursive: true, force: true });
    }
    assert.ok(schlugFehl, 'REQUIRE_*_WASM=1 macht den Build rot statt still Engine-los zu deployen');
  });

  it('r\u00e4umt die .part-Dateien wieder weg', () => {
    // Kein halbes File darf in tmp/ liegenbleiben und beim naechsten Build als
    //Quelle durchgehen.
    const p = path.join(root, 'tmp', 'office_wasm_bg.wasm.part');
    assert.ok(!fs.existsSync(p), 'keine .part-Datei im Projekt-tmp nach einem Build');
  });
});