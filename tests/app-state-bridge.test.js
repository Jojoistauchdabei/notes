'use strict';
// Regressionstest: Der Cloud-Sync (js/appwrite-files.js, js/appwrite-sync.js)
// liest `window.state.books`. `state` ist in js/app.js als top-level `let`
// deklariert – das landet bei klassischen <script>s NICHT auf window.
// js/app.js muss daher eine window.state-Brücke (Getter/Setter) enthalten,
// sonst sieht der Sync 0 Bücher (Login geht, Sync lädt nichts hoch).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

function extractBridge(src) {
  const start = src.indexOf('let state =');
  assert.ok(start >= 0, 'app.js muss `let state =` enthalten');
  const endMarker = '} catch { /* ignore */ }';
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, 'app.js muss die window.state-Brücke (try/catch) enthalten');
  return src.slice(start, end + endMarker.length);
}

describe('app-state-bridge/statisch', () => {
  it('app.js spiegelt state auf window (Getter/Setter)', () => {
    assert.match(APP_SRC, /Object\.defineProperty\(window,\s*'state'/);
    assert.match(APP_SRC, /get\(\)\s*\{\s*return state;\s*\}/);
    assert.match(APP_SRC, /set\(v\)\s*\{\s*state\s*=\s*v;\s*\}/);
  });
  it('Sync-Module lesen window.state (Vertrag)', () => {
    for (const f of ['appwrite-files.js', 'appwrite-sync.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
      assert.match(src, /window\.state/, f + ' muss window.state lesen');
    }
  });
});

describe('app-state-bridge/verhalten', () => {
  it('Sync sieht Bücher, auch nach Reassignment in app.js', () => {
    const bridge = extractBridge(APP_SRC);
    const window = {};
    const sandbox = { window };
    vm.createContext(sandbox);
    vm.runInContext(bridge, sandbox);
    // Leser wie in js/appwrite-files.js (syncNow/cleanupOrphans)
    const filesReader = '(typeof window !== "undefined" && window.state && Array.isArray(window.state.books)) ? window.state.books : []';
    // Leser wie in js/appwrite-sync.js (getBooks)
    const syncReader = '(typeof window !== "undefined" && window.state && Array.isArray(window.state.books)) ? window.state.books : []';
    assert.deepEqual(vm.runInContext(`(${filesReader}).length`, sandbox), 0);
    // Buch anlegen (Mutation wie in app.js)
    vm.runInContext('state.books.push({ id: "b1" });', sandbox);
    assert.equal(vm.runInContext(`(${filesReader}).length`, sandbox), 1);
    assert.equal(vm.runInContext(`(${syncReader}).length`, sandbox), 1);
    // Reassignment wie beim Laden (app.js: `state = p`)
    vm.runInContext('state = { books: [{ id: "b2" }, { id: "b3" }], folders: [] };', sandbox);
    assert.equal(vm.runInContext(`(${filesReader}).length`, sandbox), 2);
    assert.equal(vm.runInContext(`(${syncReader}).length`, sandbox), 2);
    // Schreiben über window (Sync legt z.B. Download-Bücher an)
    vm.runInContext('window.state.books.push({ id: "b4" });', sandbox);
    assert.equal(vm.runInContext('state.books.length', sandbox), 3);
  });
});
