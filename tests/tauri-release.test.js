// tests/tauri-release.test.js – prüft das Tauri-Releasegerüst:
// Versionssync, Updater-Konfiguration, Datei-Referenzen, Workflow-Trigger.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

describe('Tauri-Releasegerüst', () => {
  it('Versionen sind synchron (package.json, Manifest, tauri.conf.json, Cargo.toml)', () => {
    const pkg = JSON.parse(read('package.json'));
    const manifest = JSON.parse(read('manifest.webmanifest'));
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
    const cargo = read('src-tauri/Cargo.toml');
    const m = cargo.match(/^version = "([^"]+)"/m);
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json-Version');
    assert.equal(manifest.version, pkg.version, 'manifest.webmanifest');
    assert.equal(conf.version, pkg.version, 'tauri.conf.json');
    assert.ok(m, 'Cargo.toml enthält version');
    assert.equal(m[1], pkg.version, 'Cargo.toml');
  });

  it('Updater zeigt auf GitHub-Releases + Public Key ist gesetzt', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
    const updater = conf.plugins && conf.plugins.updater;
    assert.ok(updater && updater.active, 'updater.active');
    assert.ok(
      (updater.endpoints || []).some((u) => u.includes('releases/latest/download/latest.json')),
      'Updater-Endpoint latest.json'
    );
    assert.ok(updater.pubkey && updater.pubkey.length > 50, 'Updater-Public-Key gesetzt');
  });

  it('Bundle-Icons existieren, Identifier ist gesetzt', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
    assert.match(conf.identifier || '', /\./, 'identifier');
    for (const icon of conf.bundle.icon || []) {
      assert.ok(fs.existsSync(path.join(root, 'src-tauri', icon)), `Icon fehlt: ${icon}`);
    }
    assert.ok(fs.existsSync(path.join(root, 'src-tauri/src/lib.rs')), 'src/lib.rs');
    assert.ok(fs.existsSync(path.join(root, 'src-tauri/src/main.rs')), 'src/main.rs');
    assert.ok(fs.existsSync(path.join(root, 'src-tauri/capabilities/default.json')), 'capabilities');
  });

  it('js/updater.js ist eingebunden (index.html + sw.js offline)', () => {
    assert.ok(fs.existsSync(path.join(root, 'js/updater.js')), 'js/updater.js');
    assert.ok(read('index.html').includes('js/updater.js'), 'index.html referenziert updater.js');
    assert.ok(read('sw.js').includes('js/updater.js'), 'sw.js cacht updater.js');
  });

  it('tauri.yml: Release-Trigger + alle Paketformate (deb/AppImage/rpm/Windows/APK)', () => {
    const wf = read('.github/workflows/tauri.yml');
    assert.ok(wf.includes('published'), 'läuft bei published Releases');
    assert.ok(!/^  push:/m.test(wf), 'kein Push-Trigger (kein Release pro Commit)');
    assert.ok(wf.includes('workflow_call'), 'wiederverwendbar für auto-release.yml');
    assert.ok(wf.includes('inputs.tag'), 'Tag-Auflösung nutzt inputs.tag (Call-Pfad)');
    for (const needle of ['deb', 'AppImage', 'rpm', 'windows', 'apk', 'latest.json', 'TAURI_SIGNING_PRIVATE_KEY']) {
      assert.ok(wf.toLowerCase().includes(needle.toLowerCase()), `Workflow enthält ${needle}`);
    }
  });

  it('dist/ ist Build-Artefakt: ignoriert, nicht eingecheckt, Web-ZIP im Release', () => {
    const ignore = read('.gitignore');
    assert.ok(/^dist\/$/m.test(ignore), '.gitignore ignoriert dist/');
    const release = read('.github/workflows/release.yml');
    assert.ok(release.includes('npm run build'), 'release.yml baut dist/ frisch');
    assert.ok(release.includes('-web.zip'), 'release.yml hängt Web-ZIP ans Release');
    assert.ok(release.includes('gh release upload'), 'release.yml lädt ZIP hoch');
    const auto = read('.github/workflows/auto-release.yml');
    assert.ok(auto.includes('-web.zip'), 'auto-release.yml lädt Web-ZIP hoch');
    assert.ok(auto.includes('uses: ./.github/workflows/tauri.yml'), 'auto-release.yml ruft Tauri-Workflow auf');
  });

  it('auto-release.yml: jeder Main-Push legt ein Release an (Auto-Patch-Bump, Opt-out)', () => {
    const auto = read('.github/workflows/auto-release.yml');
    assert.ok(/^  push:/m.test(auto), 'Push-Trigger vorhanden');
    assert.ok(!auto.includes('[release]'), 'kein [release]-Marker mehr nötig');
    assert.ok(auto.includes('[skip release]'), 'Opt-out per [skip release]');
    assert.ok(auto.includes('hochzählen') || auto.includes('v[2]++') || auto.includes('v[2]++;'), 'Auto-Patch-Bump bei belegtem Tag');
  });
});
