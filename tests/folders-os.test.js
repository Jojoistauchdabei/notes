const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../js/folders.js');

function mk() {
  const folders = [];
  const a = F.createFolder(folders, 'Arbeit');
  const b = F.createFolder(folders, 'Uni', a.id);
  const c = F.createFolder(folders, 'Vorlesung', b.id);
  return { folders, a, b, c };
}

describe('folders/os-baum', () => {
  test('createFolder mit parentId + Duplikat-Scope pro Parent', () => {
    const folders = [];
    const root = F.createFolder(folders, 'Arbeit');
    assert.equal(root.parentId, null);
    const sub = F.createFolder(folders, 'Uni', root.id);
    assert.equal(sub.parentId, root.id);
    // Gleicher Name unter anderem Parent -> eigener Ordner
    const other = F.createFolder(folders, 'Uni');
    assert.notEqual(other.id, sub.id);
    // Gleicher Name gleicher Parent -> wiederverwenden
    const dup = F.createFolder(folders, 'uni', root.id);
    assert.equal(dup.id, sub.id);
    // Ungültiger Parent -> null
    assert.equal(F.createFolder(folders, 'X', 'nope'), null);
  });

  test('getDescendants/isDescendant/getPath', () => {
    const { folders, a, b, c } = mk();
    assert.deepEqual(F.getDescendants(folders, a.id).map(f => f.id).sort(), [b.id, c.id].sort());
    assert.deepEqual(F.getDescendants(folders, b.id).map(f => f.id), [c.id]);
    assert.deepEqual(F.getDescendants(folders, c.id), []);
    assert.equal(F.isDescendant(folders, c.id, a.id), true);
    assert.equal(F.isDescendant(folders, b.id, a.id), true);
    assert.equal(F.isDescendant(folders, a.id, c.id), false);
    assert.equal(F.isDescendant(folders, a.id, a.id), false);
    assert.deepEqual(F.getPath(folders, c.id).map(f => f.id), [a.id, b.id, c.id]);
    assert.deepEqual(F.getPath(folders, a.id).map(f => f.id), [a.id]);
    assert.deepEqual(F.getPath(folders, 'unbekannt'), []);
  });

  test('moveFolder mit Zirkel-Schutz', () => {
    const { folders, a, b, c } = mk();
    // In sich selbst -> false
    assert.equal(F.moveFolder(folders, a.id, a.id), false);
    // In Descendant -> false
    assert.equal(F.moveFolder(folders, a.id, c.id), false);
    assert.equal(F.moveFolder(folders, b.id, c.id), false);
    // Unbekannter Parent -> false
    assert.equal(F.moveFolder(folders, a.id, 'ghost'), false);
    // Gültig: Blatt an Wurzel
    assert.equal(F.moveFolder(folders, c.id, null), true);
    assert.equal(folders.find(f => f.id === c.id).parentId, null);
    // Gültig: Blatt unter anderen Knoten
    assert.equal(F.moveFolder(folders, c.id, a.id), true);
    assert.equal(folders.find(f => f.id === c.id).parentId, a.id);
  });

  test('sortTree ordnet nach vollem Pfad', () => {
    const folders = [];
    const z = F.createFolder(folders, 'Z');
    const m = F.createFolder(folders, 'M');
    F.createFolder(folders, 'b-kind', z.id);
    F.createFolder(folders, 'a-kind', m.id);
    F.sortTree(folders);
    const names = folders.map(f => f.name);
    // M vor Z, jeweils Parent vor Kind im Pfad-Vergleich
    assert.ok(names.indexOf('M') < names.indexOf('Z'));
    assert.ok(names.indexOf('a-kind') > names.indexOf('M'));
    assert.ok(names.indexOf('b-kind') > names.indexOf('Z'));
  });

  test('deleteFolder löscht Teilbaum, Bücher -> Unsortiert', () => {
    const { folders, a, b, c } = mk();
    const state = {
      folders,
      books: [
        { id: 'b1', folderId: a.id },
        { id: 'b2', folderId: c.id },
        { id: 'b3', folderId: null },
      ],
    };
    assert.ok(F.deleteFolder(state, a.id));
    assert.equal(state.folders.length, 0);
    assert.deepEqual(state.books.map(x => x.folderId), [null, null, null]);
  });

  test('filterBooksTree + countSubtree + folderPathName', () => {
    const { folders, a, b } = mk();
    const books = [
      { id: '1', folderId: a.id },
      { id: '2', folderId: b.id },
      { id: '3', folderId: null },
    ];
    // Exakter Filter bleibt exakt (Kompat)
    assert.equal(F.filterBooks(books, a.id).length, 1);
    // Baum-Filter schließt Nachfahren ein
    assert.equal(F.filterBooksTree(books, a.id, folders).length, 2);
    assert.equal(F.filterBooksTree(books, 'all', folders).length, 3);
    assert.equal(F.filterBooksTree(books, 'unsorted', folders).length, 1);
    // Subtree-Zähler summiert Teilbaum
    const cnt = F.countSubtree(books, folders);
    assert.equal(cnt.byId[a.id], 2);
    assert.equal(cnt.byId[b.id], 1);
    assert.equal(cnt.unsorted, 1);
    assert.equal(cnt.all, 3);
    // Pfad-Label
    assert.equal(F.folderPathName(folders, b.id), 'Arbeit / Uni');
  });

  test('ensureFolders heilt Zyklen + Geister-Eltern', () => {
    const s = {
      books: [],
      folders: [
        { id: 'x', name: 'X', parentId: 'y' },
        { id: 'y', name: 'Y', parentId: 'x' },
        { id: 'z', name: 'Z', parentId: 'ghost' },
        { id: 's', name: 'S', parentId: 's' },
      ],
    };
    F.ensureFolders(s);
    const byId = Object.fromEntries(s.folders.map(f => [f.id, f]));
    assert.equal(byId.z.parentId, null);
    assert.equal(byId.s.parentId, null);
    // Zyklus x<->y aufgebrochen: mindestens einer ist Wurzel, Kette terminiert
    const chain = F.getPath(s.folders, 'x');
    assert.ok(chain.length >= 1 && chain.length <= 2);
    // isDescendant darf bei Zyklen nicht hängen
    assert.equal(typeof F.isDescendant(s.folders, 'x', 'y'), 'boolean');
  });

  test('toMirror/fromMirror/mergeFolders syncen parentId', () => {
    const { folders, b } = mk();
    const mirror = F.toMirror(folders);
    assert.equal(mirror[b.id].parentId, folders.find(f => f.id === b.id).parentId);
    const back = F.fromMirror(mirror);
    assert.equal(back.find(f => f.id === b.id).parentId, b.parentId);
    const merged = F.mergeFolders([], mirror);
    assert.equal(merged.find(f => f.id === b.id).parentId, b.parentId);
  });
});
