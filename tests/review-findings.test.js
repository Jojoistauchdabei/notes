'use strict';
// Review-Befund 4 (Konflikt-Registry): die Sync-Registry ist ohne DOM testbar.
// Die frueheren Befunde 1-3 betrafen den MCP-Worker (specs/41) - der ist mit
// dem Umstieg auf den eigenen Server entfallen, die zugehoerigen
// Quelltext-Assertions damit auch.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const S = require('../js/sync.js');

function read(p) {
  return fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
}

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
