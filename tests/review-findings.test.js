'use strict';
// Review-Befund 2 (MCP-Worker) + 4 (Konflikt-Registry): worker.js ist ein
// ES-Modul (Cloudflare) und wird hier wie in tests/sanitize.test.js per
// Quelltext-Assertion geprüft; die Sync-Registry ist ohne DOM testbar.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const S = require('../js/appwrite-sync.js');

function read(p) {
  return fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
}

describe('review/worker-scope', () => {
  const w = read('worker.js');
  it('Scope-Env ist dokumentiert (Single-User-Warnung)', () => {
    assert.ok(w.includes('MCP_USER_ID'), 'MCP_USER_ID erwähnt');
    assert.ok(/nur f.r Einzelnutzer/i.test(w), 'Einzelnutzer-Warnung im Header');
  });
  it('fetchNotes filtert serverseitig per userId-Query', () => {
    assert.ok(w.includes("method: 'equal', attribute: 'userId'"), 'equal-Query auf userId');
    assert.ok(w.includes('mcpUserScope(env)'), 'Scope wird an Abfragen übergeben');
  });
  it('fetchNote verrät keine fremden Rows (404 statt Inhalt/502)', () => {
    assert.ok(w.includes("status: 404"), '404-Marker vorhanden');
    assert.ok(w.includes("error: 'Notiz nicht gefunden'"), '404-Antwort ohne Leak');
  });
  it('/mcp/health signalisiert Scoping', () => {
    assert.ok(w.includes('scoped:'), 'health enthält scoped-Flag');
  });
  it('alte Sicherheits-Assertions bleiben erfüllt', () => {
    assert.ok(w.includes('timingSafeEqual(bearerOf(request)'), 'timing-sicher');
    assert.ok(w.includes('MCP_ALLOW_ORIGIN'), 'CORS opt-in');
  });
});

describe('review/konflikt-registry', () => {
  it('Titel-Erkennung', () => {
    assert.ok(S.isConflictTitle('Buch (Konflikt 20.09.2026)'));
    assert.ok(!S.isConflictTitle('Buch (Kopie)'));
    assert.ok(!S.isConflictTitle(null));
    assert.match(S.makeConflictTitle('Buch', 1700000000000), /\(Konflikt /);
  });
  it('Registry ist ohne DOM gutmütig (leere Liste)', () => {
    assert.deepEqual(S.loadConflicts(), []);
    assert.deepEqual(S.listLiveConflictCopies([]), []);
    assert.deepEqual(S.listLiveConflictCopies(null), []);
  });
  it('record gibt Einträge zurück (persistiert, wo localStorage existiert)', () => {
    const cur = S.recordConflictCopies([{ id: 'k1', title: 'A (Konflikt x)', sourceId: 'b1' }]);
    assert.ok(cur.some(e => e.id === 'k1'));
    // Dedupe: kein Doppel-Eintrag
    const cur2 = S.recordConflictCopies([{ id: 'k1', title: 'A (Konflikt x)' }]);
    assert.equal(cur2.filter(e => e.id === 'k1').length, 1);
    S.resolveConflictCopy('k1');
    S.clearConflictCopies();
  });
  it('listLiveConflictCopies findet Kopien per Titel-Fallback', () => {
    const books = [
      { id: 'a', title: 'Normal' },
      { id: 'k9', title: 'Normal (Konflikt 01.01.2026)' },
    ];
    const live = S.listLiveConflictCopies(books);
    assert.deepEqual(live.map(b => b.id), ['k9']);
  });
  it('UI-Verdrahtung existiert (Banner + Filter + Dismiss)', () => {
    const app = read('js/app.js');
    assert.ok(app.includes('renderConflictBanner()'), 'Banner-Render');
    assert.ok(app.includes('conflictsOnly'), 'Konflikt-Filter');
    assert.ok(app.includes('dismissConflictBanner'), 'Erledigt-Button');
    assert.ok(app.includes('liveConflictCopies()'), 'Registry-Anbindung');
    const html = read('index.html');
    assert.ok(html.includes('id="conflictBanner"'), 'Banner-Element');
    const css = read('css/styles.css');
    assert.ok(css.includes('.conflict-banner'), 'Banner-Styles');
  });
});
