// tests/office-ui.test.js – statische Pruefungen an index.html und office.css.
// Kein DOM noetig: die Fehler, die hier gemeint sind, fallen beim Lesen der
// Quelldateien auf, nicht erst im Browser.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, 'office', rel), 'utf8');
const html = read('index.html');
const css = read('office.css');

describe('office/index.html', () => {
  it('jede id kommt genau einmal vor', () => {
    // Ein doppeltes id="status" hatte zwei Statuszeilen: getElementById traf
    // immer nur die erste, die zweite blieb stumm.
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const doppelt = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual(doppelt, [], 'mehrfach vergebene id: ' + doppelt.join(', '));
    assert.ok(ids.length > 8, 'die UI braucht mehr Anker als das hier: ' + ids.length);
  });

  it('jede per id referenzierte Element-Id existiert im HTML', () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const imCode = fs.readFileSync(path.join(root, 'office/js/app.js'), 'utf8');
    const verwendet = new Set([...imCode.matchAll(/el\('([^']+)'\)/g)].map((m) => m[1]));
    const fehlen = [...verwendet].filter((id) => !ids.has(id));
    assert.deepEqual(fehlen, [], 'app.js greift auf nicht vorhandene Elemente zu: ' + fehlen.join(', '));
  });

  it('alle referenzierten Skripte existieren als Datei', () => {
    const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.ok(srcs.length >= 6, 'erwartet crypto/kv/storage/docstore/editor/app, gefunden: ' + srcs.length);
    for (const src of srcs) {
      assert.ok(fs.existsSync(path.join(root, 'office', src)), 'fehlt: ' + src);
    }
  });

  it('Skripte stehen in Abhaengigkeitsreihenfolge', () => {
    const srcs = [...html.matchAll(/<script src="js\/([^"/]+)\.js"><\/script>/g)].map((m) => m[1]);
    assert.deepEqual(srcs, ['crypto', 'kv', 'storage-adapter', 'docstore', 'editor-adapter', 'app']);
  });

  it('der Editor-Frame traegt title und allow', () => {
    const frame = html.match(/<iframe[^>]*id="editorFrame"[^>]*>/);
    assert.ok(frame, 'iframe#editorFrame fehlt');
    assert.match(frame[0], /title="[^"]+"/, 'iframe ohne title ist fuer Screenreader unbrauchbar');
    assert.match(frame[0], /allow="clipboard-write"/, 'Zwischenablage wird fuer Kopieren im Editor gebraucht');
  });

  it('keine externen Ressourcen fest im HTML verdrahtet', () => {
    // Der ONLYOFFICE-Editor wird zur Laufzeit konfiguriert; eine im HTML
    // eingetragene Adresse wuerde still einen fremden Origin zum Fixed-Plot
    // machen. Das placeholder-Attribut ist ausdruecklich erlaubt.
    const ohnePlaceholder = html.replace(/\splaceholder="[^"]*"/g, '');
    assert.ok(!/<(?:script|link|iframe)[^>]+(?:src|href)="https?:/i.test(ohnePlaceholder),
      'externe Ressource fest verdrahtet');
    assert.ok(!/EDITOR_BASE\s*=\s*['"]https?:/.test(ohnePlaceholder),
      'Editor-Basis-URL nicht hart im HTML setzen');
  });
});

describe('office/office.css', () => {
  it('hidden schlägt eigene display-Regeln', () => {
    // Regression: .gate{display:grid} und .conflict{display:flex} haben das
    // hidden-Attribut ausgehebelt -- Tresor und Konfliktbalken blieben
    // sichtbar. !important noetig, weil eine author-Regel sonst gegen das
    // Attribut gewinnt. Die Position ist egal: !important schlaegt immer,
    // unabhaengig von der Reihenfolge (deshalb wird hier nichts geprueft).
    assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
    const eigeneDisplays = [...css.matchAll(/\.[a-z#][^{]*\{[^}]*?display:\s*(?!none)/gi)];
    assert.ok(eigeneDisplays.length >= 2,
      'ohne eigene display-Regeln waere der Guard gegenstandslos -- Test prueft nichts');
  });

  it('#editorPane wächst mit, sonst bleibt der Editor ein 150px-Streifen', () => {
    const pane = css.match(/\.editor\s*>\s*#editorPane\s*\{([^}]*)\}/);
    assert.ok(pane, '.editor > #editorPane-Regel fehlt');
    assert.match(pane[1], /flex:\s*1/, '#editorPane braucht flex:1');
    const frame = css.match(/#editorFrame\s*\{([^}]*)\}/);
    assert.match(frame[1], /flex:\s*1/);
    assert.match(frame[1], /min-height:\s*0/, 'ohne min-height:0 verhindert der Inhalt das Schrumpfen');
  });
});