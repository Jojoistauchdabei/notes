const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../js/folders.js');

describe('folders/modell', () => {
  test('ensureFolders migriert Altbestand (keine folders, keine folderId)', () => {
    const s = { books: [{ id: 'b1', title: 'A' }], openBookId: null, openPageId: null };
    F.ensureFolders(s);
    assert.ok(Array.isArray(s.folders));
    assert.equal(s.books[0].folderId, null);
  });

  test('create/rename/move/delete rundetrip', () => {
    const state = { books: [{ id: 'b1', title: 'A', folderId: null }], folders: [] };
    F.ensureFolders(state);
    const f = F.createFolder(state.folders, ' Uni ');
    assert.equal(f.name, 'Uni');
    assert.ok(F.moveBook(state.books, 'b1', f.id, state.folders));
    assert.equal(state.books[0].folderId, f.id);
    assert.ok(F.renameFolder(state.folders, f.id, 'Arbeit'));
    assert.equal(state.folders[0].name, 'Arbeit');
    assert.deepEqual(F.filterBooks(state.books, f.id).length, 1);
    assert.deepEqual(F.filterBooks(state.books, 'unsorted').length, 0);
    assert.ok(F.deleteFolder(state, f.id));
    assert.equal(state.books[0].folderId, null);
  });

  test('doppelte Namen werden wiederverwendet, leer abgelehnt', () => {
    const folders = [];
    const a = F.createFolder(folders, 'Uni');
    const b = F.createFolder(folders, 'uni');
    assert.equal(a.id, b.id);
    assert.equal(folders.length, 1);
    assert.equal(F.createFolder(folders, '   '), null);
  });

  test('mirror roundtrip + merge', () => {
    const folders = [];
    const f = F.createFolder(folders, 'Uni');
    const mirror = F.toMirror(folders);
    assert.ok(mirror[f.id]);
    const back = F.fromMirror(mirror);
    assert.equal(back[0].name, 'Uni');
    const merged = F.mergeFolders([], mirror);
    assert.equal(merged[0].name, 'Uni');
  });

  test('countByFolder zählt all/unsorted/byId', () => {
    const c = F.countByFolder([{ folderId: null }, { folderId: 'x' }, {}]);
    assert.equal(c.all, 3);
    assert.equal(c.unsorted, 2);
    assert.equal(c.byId.x, 1);
  });
});
