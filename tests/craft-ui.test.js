'use strict';
// tests/craft-ui.test.js – die Oberflaeche der Craft-Apps: Menue, Badge,
// Ansicht und die Verdrahtung in index.html/app.js.
//
// Die DOM-abhaengigen Teile laufen gegen ein minimales Fake-DOM (wie
// tests/dialog.test.js) – geprueft wird, was craft-ui.js wirklich tut, nicht
// eine Kopie davon.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'js', 'craft-bridge.js'), 'utf8');
const shim = fs.readFileSync(path.join(root, 'js', 'craft-gz-shim.js'), 'utf8');
const Catalog = require('../js/craft-catalog.js');
const Store = require('../js/craft-store.js');

/* ---- Fake-DOM ---------------------------------------------------------- */

function fakeEl(id) {
  const el = {
    id: id, hidden: false, innerHTML: '', textContent: '', className: '', dataset: {},
    style: {}, files: null, value: '', src: '', listeners: {}, _cls: new Set(),
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    setAttribute() {}, removeAttribute() {}, remove() {}, appendChild() {}, contains() { return false; },
    click() { (this.listeners.click || []).forEach((fn) => fn({ target: this, stopPropagation() {} })); },
    querySelectorAll() {
      const ids = [...String(this.innerHTML).matchAll(/data-craft="([a-z]+)"/g)].map((m) => m[1]);
      return ids.map((cid) => { const e = fakeEl('item-' + cid); e.dataset.craft = cid; return e; });
    },
  };
  el.classList = {
    add: (c) => el._cls.add(c),
    remove: (c) => el._cls.delete(c),
    contains: (c) => el._cls.has(c),
  };
  return el;
}

/* Fuehrt fn mit Fake-DOM aus und laedt craft-ui.js frisch. */
async function mitFakeDom(fn) {
  const els = {};
  const ids = ['viewCraft', 'newCraftMenu', 'newCraftBtn', 'craftBack', 'craftExport',
    'craftImport', 'craftFile', 'craftFrame', 'craftMissing', 'craftStatus', 'craftTitle', 'craftKind'];
  for (const id of ids) els[id] = fakeEl(id);
  const doc = {
    readyState: 'loading',
    getElementById: (id) => els[id] || null,
    addEventListener() {},
    querySelectorAll: () => [],
    createElement: (tag) => fakeEl(tag),
    body: { appendChild() {} },
  };
  const win = {
    addEventListener() {}, state: { books: [], folders: [] },
    FederwerkCraftCatalog: Catalog, FederwerkCraftStore: Store,
  };
  const alt = { document: global.document, window: global.window, fetch: global.fetch };
  global.document = doc;
  global.window = win;
  delete require.cache[require.resolve('../js/craft-ui.js')];
  const UI = require('../js/craft-ui.js');
  try {
    return await fn(UI, els, win);
  } finally {
    /* Die Fallback-Uhr aus open() (12 s) wuerde sonst nach dem Test feuern und
     * mit dem schon zurueckgesetzten Fake-DOM einen Fehler ausloesen. */
    try { clearTimeout(UI._internals.zustand.uhr); } catch { /* egal */ }
    global.document = alt.document;
    global.window = alt.window;
    global.fetch = alt.fetch;
  }
}


describe('craft-ui: Menue "+ Neu"', () => {
  it('baut eine Zeile pro Craft, aber keine fuer Apps ohne eigenes Format', async () => {
    await mitFakeDom((UI, els) => {
      UI.baueMenue();
      const erwartet = Catalog.CRAFTS.filter((c) => c.create !== false);
      const ids = [...els.newCraftMenu.innerHTML.matchAll(/data-craft="([a-z]+)"/g)].map((m) => m[1]);
      assert.deepEqual(ids.slice().sort(), erwartet.map((c) => c.id).sort());
      assert.ok(!ids.includes('lightcraft'), 'LightCraft hat kein eigenes Projektformat');
    });
  });

  it('trennt Office- und Adobe-Gruppe und bietet den Import an', async () => {
    await mitFakeDom((UI, els) => {
      UI.baueMenue();
      assert.match(els.newCraftMenu.innerHTML, /Office/);
      assert.match(els.newCraftMenu.innerHTML, /Adobe/);
      assert.match(els.newCraftMenu.innerHTML, /newCraftImport/);
      assert.match(els.newCraftMenu.innerHTML, /\.docx/);
    });
  });

  it('oeffnet, schliesst und meldet den Zustand an aria-expanded', async () => {
    await mitFakeDom((UI, els) => {
      els.newCraftMenu.hidden = true;
      UI.toggleMenue({ stopPropagation() {} });
      assert.equal(els.newCraftMenu.hidden, false);
      UI.toggleMenue({ stopPropagation() {} });
      assert.equal(els.newCraftMenu.hidden, true);
      UI.schliesseMenue();
      assert.equal(els.newCraftMenu.hidden, true);
    });
  });
});

describe('craft-ui: Badge der Bibliothekskarte', () => {
  it('zeigt App, Farbe und Kurzname', async () => {
    await mitFakeDom((UI) => {
      const out = UI.badgeHtml(Store.create('photocraft', 'Bild 1'));
      assert.match(out, /fw-craft-badge/);
      assert.match(out, /Photoshop/);
      assert.match(out, /#31a8ff/);
    });
  });

  it('schweigt bei fremden Buechern', async () => {
    await mitFakeDom((UI) => {
      assert.equal(UI.badgeHtml({ id: 'b', pages: [] }), '');
    });
  });
});

describe('craft-ui: Ansicht', () => {
  it('erklaert ein fehlendes WASM, statt eine weisse Flaeche zu zeigen', async () => {
    await mitFakeDom(async (UI, els, win) => {
      global.fetch = async () => ({ ok: false, status: 404 });
      const b = Store.create('wordcraft', 'Dokument 1');
      win.state.books.push(b);
      await UI.open('wordcraft', b.id);
      assert.equal(els.craftMissing.hidden, false);
      assert.match(els.craftMissing.innerHTML, /WordCraft/);
      assert.match(els.craftMissing.innerHTML, /dist\/crafts\/wordcraft/);
      assert.match(els.craftStatus.textContent, /Engine fehlt/);
      assert.equal(els.craftFrame.hidden, true);
    });
  });

  it('laedt die App und holt die abgelegte Datei bereit', async () => {
    await mitFakeDom(async (UI, els, win) => {
      global.fetch = async () => ({ ok: true, json: async () => ({ id: 'wordcraft', tag: 'v0.5.0' }) });
      global.window.GrimoireStore = {
        putBlob: async () => 'blob:neu',
        dataUrl: async () => 'data:application/octet-stream;base64,QUJD',
      };
      global.window.FederwerkFiles = {
        dataUrlToBytes: () => ({ bytes: new Uint8Array([65, 66, 67]), mime: 'application/octet-stream' }),
      };
      const b = Store.create('wordcraft', 'Dokument 1');
      Store.setFile(b, { ref: 'blob:alt', size: 3 });
      win.state.books.push(b);
      await UI.open('wordcraft', b.id);
      assert.equal(els.craftMissing.hidden, true);
      assert.match(els.craftFrame.src, /crafts\/wordcraft\/index\.html/);
      assert.equal(UI._internals.zustand.wartend.name, 'Dokument 1.docx');
      assert.equal(UI._internals.zustand.wartend.bytes.length, 3);
    });
  });

  it('legt die Bytes aus der App als Dokumentdatei ab', async () => {
    await mitFakeDom(async (UI, els, win) => {
      const b = Store.create('wordcraft', 'Dokument 1');
      win.state.books.push(b);
      UI._internals.zustand.bookId = b.id;
      UI._internals.zustand.craftId = 'wordcraft';
      global.window.GrimoireStore = { putBlob: async () => 'blob:neu' };
      await UI.ablegen(new Uint8Array([1, 2, 3, 4]), 'Bericht.docx', 'application/octet-stream', false);
      assert.equal(b.craft.file, 'blob:neu');
      assert.equal(b.craft.size, 4);
      assert.equal(b.craft.name, 'Bericht.docx');
      assert.match(els.craftStatus.textContent, /In Federwerk gespeichert/);
    });
  });
});


describe('craft-ui: Verdrahtung in der App', () => {
  it('index.html hat die Ansicht und ihre Knoepfe', () => {
    assert.match(html, /id="viewCraft"/);
    assert.match(html, /id="craftFrame"/);
    assert.match(html, /id="craftImport"/);
    assert.match(html, /id="craftExport"/);
    assert.match(html, /id="craftFile"/);
    assert.match(html, /id="craftMissing"/);
    assert.match(html, /id="craftStatus"/);
  });

  it('laedt die Craft-Skripte vor app.js und in der richtigen Reihenfolge', () => {
    const catalog = html.indexOf('js/craft-catalog.js');
    const store = html.indexOf('js/craft-store.js');
    const ui = html.indexOf('js/craft-ui.js');
    const appJs = html.indexOf('js/app.js');
    assert.ok(catalog > 0 && store > catalog && ui > store && appJs > ui,
      'Katalog -> Modell -> Oberflaeche -> app.js');
  });

  it('laedt die Bruecke NICHT in der App (sie gehoert in den iframe)', () => {
    /* Der Kommentar in index.html nennt die Dateien – geprueft wird, dass sie
     * nicht als <script src> eingebunden sind. */
    assert.ok(!/<script src="js\/craft-bridge\.js"/.test(html), 'die Bruecke laeuft im Craft-Verzeichnis');
    assert.ok(!/<script src="js\/craft-gz-shim\.js"/.test(html), 'der Shim gehoert vor das Modul-Skript der App');
  });

  it('hat keinen Rest der alten Office-Implementierung', () => {
    for (const datei of ['index.html', 'js/app.js', 'css/styles.css']) {
      const text = fs.readFileSync(path.join(root, datei), 'utf8');
      assert.ok(!/office/i.test(text), datei + ' enthaelt noch Office-Reste');
    }
    assert.ok(!fs.existsSync(path.join(root, 'js', 'office-writer.js')));
    assert.ok(!fs.existsSync(path.join(root, 'office-wasm')));
  });

  it('bietet das "+ Neu"-Menue in der Bibliothek an', () => {
    assert.match(html, /id="newCraftBtn"/);
    assert.match(html, /id="newCraftMenu"/);
    assert.match(html, /FederwerkCraftUI\.toggleMenue/);
  });

  it('app.js kennt Craft-Dokumente und leitet sie an die Ansicht', () => {
    assert.match(app, /function isCraftDoc\(b\)/);
    assert.match(app, /FederwerkCraftStore\.isCraftBook\(b\)/);
    assert.match(app, /if \(b0 && isCraftDoc\(b0\)\) \{ openCraftDoc\(id\); return; \}/);
    assert.match(app, /function openCraftDoc\(id\)[\s\S]{0,200}FederwerkCraftUI\.open\(b\.craft\.id, id\)/);
    assert.match(app, /function createCraftDoc\(craftId\)/);
    assert.match(app, /function exportCraftFile\(id, event\)/);
  });

  it('die Bibliothekskarte zeigt Badge, Öffnen und Datei', () => {
    assert.match(app, /const craft = isCraftDoc\(b\)/);
    assert.match(app, /FederwerkCraftUI\.badgeHtml\(b\)/);
    /* app.js baut die Knoepfe als: onclick="openCraftDoc(\'' + b.id + '\',event)" -
     * der Backslash vor dem Anfuehrungszeichen steht so in der JS-Quelle. */
    const bs = String.fromCharCode(92);   // Backslash
    const q = String.fromCharCode(39);    // einfaches Anfuehrungszeichen
    assert.ok(app.includes('onclick="openCraftDoc(' + bs + q), 'Karte oeffnet die App');
    assert.ok(app.includes('onclick="exportCraftFile(' + bs + q), 'Karte bietet den Datei-Download');
    assert.match(app, /\(deck \|\| craft \? deckActions/, 'Craft-Karten bekommen keine Split-/GoodNotes-Knoepfe');
  });

  it('styles.css bringt die Klassen der Ansicht mit', () => {
    for (const cls of ['.fw-craft', '.fw-craft-frame', '.fw-craft-badge', '.fw-new-craft-menu']) {
      assert.ok(css.includes(cls), cls + ' fehlt in css/styles.css');
    }
  });
});

describe('craft-bridge: Vertrag mit der Upstream-App', () => {
  it('liest engine.json und horcht auf Nachrichten der App-Seite', () => {
    assert.match(bridge, /fetch\('\.\/engine\.json'/);
    assert.match(bridge, /d\.fw !== 'host'/);
    assert.match(bridge, /art === 'open'/);
    assert.match(bridge, /postMessage\(Object\.assign\(\{ fw: 'craft' \}/);
  });

  it('schiebt die Datei als Drop-Ereignis in die App', () => {
    assert.match(bridge, /new DataTransfer\(\)/);
    assert.match(bridge, /dt\.items\.add\(file\)/);
    assert.match(bridge, /new DragEvent\(typ, \{ bubbles: true, cancelable: true, dataTransfer: dt \}\)/);
  });

  it('nutzt die Agent-API, wenn die App eine anbietet', () => {
    assert.match(bridge, /window\.filmcraft/);
    assert.match(bridge, /typeof f\.openProject === 'function'/);
  });

  it('faengt den Speichern-Download ab und schickt die Bytes an Federwerk', () => {
    assert.match(bridge, /URL\.createObjectURL = function/);
    assert.match(bridge, /HTMLAnchorElement\.prototype/);
    assert.match(bridge, /blob\.arrayBuffer\(\)\.then/);
    assert.match(bridge, /art: 'save'/);
  });

  it('laesst Downloads ohne Download-Namen weiterlaufen', () => {
    assert.match(bridge, /return originalClick\.apply\(this, arguments\)/);
  });
});

describe('craft-gz-shim: WASM groesser als 25 MiB ausliefern', () => {
  it('biegt die .wasm-Anfrage auf die .gz-Datei um', () => {
    assert.match(shim, /IST_WASM =/);
    assert.match(shim, /function gzUrl\(url\)/);
    assert.match(shim, /new DecompressionStream\('gzip'\)/);
  });

  it('liefert das Entpackte wieder als WebAssembly aus', () => {
    assert.match(shim, /'Content-Type': 'application\/wasm'/);
    assert.match(shim, /new Response\(bytes/);
  });

  it('faellt auf die Originaldatei zurueck, wenn die .gz fehlt oder kaputt ist', () => {
    assert.match(shim, /if \(!res \|\| !res\.ok \|\| !res\.body\) return original\(input, init\)/);
    assert.match(shim, /return original\(input, init\);/);
  });

  it('ist harmlos, wenn der Browser kein Entpacken kann', () => {
    assert.match(shim, /typeof DecompressionStream === 'undefined'\) return;/);
  });
});
