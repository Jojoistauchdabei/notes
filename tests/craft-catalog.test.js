'use strict';
// tests/craft-catalog.test.js – der Katalog der Upstream-Apps (SPEC-40).
// Er ist die einzige Quelle der Wahrheit fuer Endungen, MIME-Typen und den
// Build-Weg. Ein kaputter Katalog wuerde still ein falsches dist/ erzeugen,
// deshalb wird er hier gegen sich selbst und gegen crafts.lock.json geprueft.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Catalog = require('../js/craft-catalog.js');

const root = path.join(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'crafts.lock.json'), 'utf8'));

describe('craft-catalog: Katalog ist in Ordnung', () => {
  it('hat keine strukturellen Fehler', () => {
    assert.deepEqual(Catalog.problems(), []);
  });

  it('enthaelt die Word-, Excel- und PowerPoint-Klone', () => {
    for (const id of ['wordcraft', 'gridcraft', 'deckcraft']) {
      const c = Catalog.byId(id);
      assert.ok(c, id + ' fehlt');
      assert.equal(c.group, 'office');
      assert.match(c.repo, /^storytold\//);
    }
  });

  it('enthaelt die Adobe-Klone (Photoshop, Illustrator, InDesign, Lightroom, Premiere, After Effects, Acrobat)', () => {
    const adobe = Catalog.CRAFTS.filter((c) => c.group === 'adobe').map((c) => c.id);
    for (const id of ['photocraft', 'vectorcraft', 'designcraft', 'lightcraft', 'filmcraft', 'effectcraft', 'pdfcraft']) {
      assert.ok(adobe.includes(id), id + ' fehlt in der Adobe-Gruppe');
    }
  });

  it('nennt zu jedem Craft das Upstream-Repo und den Web-Build', () => {
    for (const c of Catalog.CRAFTS) {
      assert.match(c.repo, /^storytold\/[a-z]+$/);
      assert.match(c.build.app, new RegExp('^apps/' + c.id + '-web$'));
      assert.ok(['trunk', 'xtask'].includes(c.build.tool), c.id + ': unbekannter Build-Weg');
    }
  });

  it('haelt Versionen aus dem Katalog heraus (sie stehen im Lock)', () => {
    const text = fs.readFileSync(path.join(root, 'js', 'craft-catalog.js'), 'utf8');
    assert.ok(!/tag:|commit:|version:\s*['"]v\d/.test(text),
      'Katalog enthaelt Versionsangaben – die gehoeren in crafts.lock.json');
  });
});

describe('craft-catalog: Endungen bestimmen die App', () => {
  it('routet die Office-Formate', () => {
    assert.equal(Catalog.forFileName('Bericht.docx').id, 'wordcraft');
    assert.equal(Catalog.forFileName('Mappe.XLSX').id, 'gridcraft');
    assert.equal(Catalog.forFileName('Folien.pptx').id, 'deckcraft');
  });

  it('routet die Adobe-Formate', () => {
    assert.equal(Catalog.forFileName('bild.psd').id, 'photocraft');
    assert.equal(Catalog.forFileName('logo.svg').id, 'vectorcraft');
    assert.equal(Catalog.forFileName('satz.idml').id, 'designcraft');
    assert.equal(Catalog.forFileName('scan.pdf').id, 'pdfcraft');
    assert.equal(Catalog.forFileName('schnitt.fcproj').id, 'filmcraft');
    assert.equal(Catalog.forFileName('comp.ecproj').id, 'effectcraft');
    assert.equal(Catalog.forFileName('plan.dxf').id, 'cadcraft');
    assert.equal(Catalog.forFileName('mix.wav').id, 'soundcraft');
  });

  it('gibt unbekannten Endungen keine App', () => {
    assert.equal(Catalog.forFileName('notiz.xyz'), null);
    assert.equal(Catalog.forFileName('ohneendung'), null);
    assert.equal(Catalog.forExt(''), null);
  });

  it('kennt die Endung, die neue Dokumente bekommen', () => {
    assert.equal(Catalog.primaryExt('wordcraft'), 'docx');
    assert.equal(Catalog.primaryExt('deckcraft'), 'pptx');
    assert.equal(Catalog.primaryExt(Catalog.byId('photocraft')), 'pcraft');
  });

  it('meldet, welche Endungen mehrere Apps oeffnen koennen', () => {
    const shared = Catalog.sharedExts();
    assert.ok(shared.svg && shared.svg.includes('vectorcraft') && shared.svg.includes('photocraft'));
    assert.ok(shared.png.length > 1);
  });

  it('erkennt Office-Crafts', () => {
    assert.equal(Catalog.isOfficeCraft('wordcraft'), true);
    assert.equal(Catalog.isOfficeCraft('photocraft'), false);
  });
});

describe('craft-catalog: MIME-Typen', () => {
  it('liefert den Haupttyp je Craft', () => {
    assert.equal(Catalog.mimeFor('wordcraft'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(Catalog.mimeFor('deckcraft'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    assert.equal(Catalog.mimeFor('gridcraft'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('kennt Nebenformate, die einen eigenen Typ haben', () => {
    assert.equal(Catalog.mimeFor('photocraft', 'png'), 'image/png');
    assert.equal(Catalog.mimeFor('wordcraft', 'txt'), 'text/plain');
    assert.equal(Catalog.mimeFor('cadcraft', 'svg'), 'image/svg+xml');
  });

  it('faellt nicht auf unbekannte Endungen herein', () => {
    assert.equal(Catalog.mimeFor('wordcraft', 'docx'), Catalog.byId('wordcraft').mime);
    assert.equal(Catalog.mimeFor(null), 'application/octet-stream');
  });
});

describe('craft-catalog: Lock-Datei passt zum Katalog', () => {
  it('pinnt jedes Craft aus dem Katalog', () => {
    for (const id of Catalog.ids()) {
      const p = lock.crafts[id];
      assert.ok(p, id + ' fehlt in crafts.lock.json');
      assert.match(p.tag, /^v\d+\.\d+\.\d+$/, id + ': Tag sieht nicht wie ein Release aus');
      assert.match(p.commit, /^[0-9a-f]{40}$/, id + ': Commit-SHA fehlt');
      assert.equal(p.repo, Catalog.byId(id).repo, id + ': Repo weicht vom Katalog ab');
    }
  });

  it('hat keine Pins fuer Crafts, die es nicht (mehr) gibt', () => {
    for (const id of Object.keys(lock.crafts)) {
      assert.ok(Catalog.byId(id), 'Lock pinnt unbekanntes Craft: ' + id);
    }
  });
});
