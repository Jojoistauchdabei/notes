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

  it('Linux-Bundle nutzt gültigen appimage-Key', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
    const linux = (conf.bundle && conf.bundle.linux) || {};
    assert.ok(linux.appimage && typeof linux.appimage === 'object', 'linux.appimage gesetzt');
    assert.equal('appImage' in linux, false, 'kein ungültiger linux.appImage-Key');
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
    assert.ok(wf.includes('tauri-action@v0'), 'existierende tauri-action-Version (v0)');
    assert.ok(!wf.includes('tauri-action@v2'), 'keine nichtexistente tauri-action@v2');
    for (const needle of ['deb', 'AppImage', 'rpm', 'windows', 'apk', 'latest.json', 'TAURI_SIGNING_PRIVATE_KEY', 'minisign']) {
      assert.ok(wf.toLowerCase().includes(needle.toLowerCase()), `Workflow enthält ${needle}`);
    }
  });

  it('dist/ ist Build-Artefakt: ignoriert, nicht eingecheckt, Web-ZIP im Release', () => {
    const ignore = read('.gitignore');
    assert.ok(/^dist\/$/m.test(ignore), '.gitignore ignoriert dist/');
    const release = read('.github/workflows/release.yml');
    assert.ok(release.includes('npm run release-web'), 'release.yml baut + stempelt dist/ frisch');
    assert.ok(release.includes('-web.zip'), 'release.yml hängt Web-ZIP ans Release');
    assert.ok(release.includes('gh release upload'), 'release.yml lädt ZIP hoch');
    const auto = read('.github/workflows/auto-release.yml');
    assert.ok(auto.includes('npm run release-web'), 'auto-release.yml baut + stempelt dist/ frisch');
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

  it('Versions-Injektion: release-web stempelt dist/ (Anzeige, Manifest, SW-Cache)', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.scripts['release-web'].includes('inject-version'), 'release-web nutzt inject-version.js');
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
    assert.equal(conf.build.beforeBuildCommand, 'npm run release-web', 'Tauri baut mit Stempelung');
    const { execFileSync } = require('node:child_process');
    const os = require('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-inject-'));
    const d = path.join(tmp, 'dist');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'index.html'), '<span class="version-tag">v0.0.0 · BUILD x</span>');
    fs.writeFileSync(path.join(d, 'manifest.webmanifest'), '{"version": "0.0.0"}');
    fs.writeFileSync(path.join(d, 'sw.js'), "const CACHE = 'federwerk-v0.0.0';");
    execFileSync('node', [path.join(root, 'scripts/inject-version.js')], {
      env: { ...process.env, VERSION: '9.9.9', DIST_DIR: d },
    });
    assert.ok(fs.readFileSync(path.join(d, 'index.html'), 'utf8').includes('>v9.9.9 · BUILD x<'), 'version-tag gestempelt');
    assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'manifest.webmanifest'), 'utf8')).version, '9.9.9', 'manifest gestempelt');
    assert.ok(fs.readFileSync(path.join(d, 'sw.js'), 'utf8').includes("'federwerk-v9.9.9'"), 'sw-cache gestempelt');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('Build-Skript ist plattformübergreifend (kein rm/cp/mkdir/find-Shell-Mix)', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.scripts.build, 'node scripts/build-dist.js', 'build nutzt node-basiertes Skript');
  });

  it('tauri.yml: Windows-sicher + Android ohne Fremd-Action', () => {
    const wf = read('.github/workflows/tauri.yml');
    assert.ok(wf.includes('shell: bash'), 'Bash-Shell gegen PowerShell-Quoting');
    assert.ok(wf.includes('npm run sync-version'), 'Versionssync über Skript');
    assert.ok(!wf.includes('setup-android'), 'kein setup-android (vorinstalliertes SDK)');
    assert.ok(wf.includes('ANDROID_SDK_ROOT'), 'nutzt vorinstalliertes Android-SDK');
    assert.ok(wf.includes('npm run release-web'), 'Frontend mit Versionsstempel');
  });

  it('Größe/Speed: Release-Profil gestrippt, Split-APKs, Rust-Cache', () => {
    const cargo = read('src-tauri/Cargo.toml');
    assert.ok(/\[profile\.release\]/m.test(cargo), 'Release-Profil vorhanden');
    assert.ok(/^\s*strip\s*=\s*true/m.test(cargo), 'Symbole gestrippt (kleinere Binaries)');
    assert.ok(/^\s*panic\s*=\s*"abort"/m.test(cargo), 'panic=abort (kleiner)');
    const wf = read('.github/workflows/tauri.yml');
    assert.ok(wf.includes('--split-per-abi'), 'pro-ABI-APKs statt Universal-Fett-APK');
    assert.ok(wf.includes('Swatinem/rust-cache'), 'Rust-Cache für schnelle CI-Builds');
    assert.ok(!wf.includes('rustup toolchain install'), 'kein manueller Toolchain-Reinstall');
  });

  it('Mobil schlank: Updater/Prozess nur auf Desktop, eigene Capabilities', () => {
    const lib = read('src-tauri/src/lib.rs');
    assert.ok(lib.includes('#[cfg(desktop)]'), 'Desktop-Gating in lib.rs');
    assert.ok(/cfg\(desktop\)\]\s*\n?\s*\.plugin\(tauri_plugin_updater/.test(lib), 'Updater nur Desktop');
    assert.ok(/cfg\(desktop\)\]\s*\n?\s*\.plugin\(tauri_plugin_process/.test(lib), 'Prozess nur Desktop');
    assert.ok(fs.existsSync(path.join(root, 'src-tauri/capabilities/mobile.json')), 'mobile.json');
    const mobile = JSON.parse(read('src-tauri/capabilities/mobile.json'));
    const perms = (mobile.permissions || []).join(' ');
    assert.ok(!perms.includes('updater:'), 'keine Updater-Rechte mobil');
    assert.ok(!perms.includes('process:'), 'keine Prozess-Rechte mobil');
    const def = JSON.parse(read('src-tauri/capabilities/default.json'));
    assert.ok((def.platforms || []).includes('linux'), 'default.json auf Desktop begrenzt');
  });

  it('Android trägt Federwerk-Logo (kein Tauri-Standard im APK)', () => {
    // Regressionstest: `android init` erzeugt ein frisches gen-Projekt mit
    // Tauri-Standard-Icons – die CI muss danach `tauri icon` laufen lassen,
    // sonst zeigt das APK das Tauri-Logo statt unseres Logos.
    const wf = read('.github/workflows/tauri.yml');
    assert.ok(wf.includes('android init'), 'Android-Init vorhanden');
    const initPos = wf.indexOf('android init');
    const iconPos = wf.indexOf('tauri-apps/cli icon');
    assert.ok(iconPos > initPos, '`tauri icon` läuft nach `android init` (gen-Icons überschreiben)');
    assert.ok(wf.includes('src-tauri/icons/icon.png'), 'Icon-Quelle ist unser Federwerk-Icon');
    // Adaptive-Icon-Hintergrund: Ecken des Foregrounds sind transparent –
    // Marken-Dunkelbraun statt Weiß (sonst weiße Ecken ums dunkle Icon).
    const bg = read('src-tauri/icons/android/values/ic_launcher_background.xml');
    assert.ok(bg.includes('#2a1a0e'), 'Launcher-Hintergrund ist Marken-Dunkelbraun');
    assert.ok(!bg.includes('#fff'), 'kein Weiß-Hintergrund');
  });
});
