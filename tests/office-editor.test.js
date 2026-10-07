'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Editor = require('../office/js/editor-adapter.js');

const ORIGIN = 'https://office.example.test';

describe('office/editor-adapter', () => {
  describe('Nachrichtenfilter', () => {
    const target = { name: 'editor-window' };

    it('akzeptiert eine gueltige Editor-Nachricht', () => {
      const filter = Editor.makeMessageFilter(ORIGIN, target);
      const out = filter({
        origin: ORIGIN, source: target,
        data: { id: '1', type: 'document:saved', payload: { fileName: 'a.docx' } },
      });
      assert.equal(out.type, 'document:saved');
      assert.equal(out.payload.fileName, 'a.docx');
    });

    it('verwirft Nachrichten von fremdem Origin', () => {
      const filter = Editor.makeMessageFilter(ORIGIN, target);
      assert.equal(filter({
        origin: 'https://evil.example', source: target, data: { type: 'document:saved' },
      }), null);
    });

    it('verwirft Nachrichten von einem anderen Fenster', () => {
      const filter = Editor.makeMessageFilter(ORIGIN, target);
      assert.equal(filter({
        origin: ORIGIN, source: { name: 'anderes' }, data: { type: 'document:saved' },
      }), null);
    });

    it('verwirft Nachrichten ohne document:-Praefix', () => {
      const filter = Editor.makeMessageFilter(ORIGIN, target);
      assert.equal(filter({ origin: ORIGIN, source: target, data: { type: 'evil:open' } }), null);
      assert.equal(filter({ origin: ORIGIN, source: target, data: { type: 'other' } }), null);
    });

    it('verwirft unbrauchbare Daten ohne zu werfen', () => {
      const filter = Editor.makeMessageFilter(ORIGIN, target);
      for (const data of [null, undefined, 'text', 42, [], { type: 42 }]) {
        assert.equal(filter({ origin: ORIGIN, source: target, data }), null);
      }
    });

    it('fehlende id und payload werden normalisiert', () => {
      const filter = Editor.makeMessageFilter(ORIGIN, target);
      const out = filter({ origin: ORIGIN, source: target, data: { type: 'document:ready' } });
      assert.equal(out.id, null);
      assert.deepEqual(out.payload, {});
    });
  });

  describe('Konstruktion', () => {
    it('verlangt frame und editorBase', () => {
      assert.throws(() => Editor.createEditorAdapter({ editorBase: ORIGIN }), /frame fehlt/);
      assert.throws(() => Editor.createEditorAdapter({ frame: {} }), /editorBase fehlt/);
      assert.throws(() => Editor.createEditorAdapter({ frame: {}, editorBase: '  ' }), /editorBase fehlt/);
    });

    it('frameUrl traegt embed=1 und die Origin-Allowlist', () => {
      const a = Editor.createEditorAdapter({
        frame: { src: '' }, editorBase: ORIGIN + '/', parentOrigin: 'https://app.example',
      });
      assert.equal(a.editorOrigin, ORIGIN, 'Trailing Slash darf die Origin nicht verfaelschen');
      assert.equal(a.frameUrl(), ORIGIN + '/editor?embed=1&embedOrigin=' + encodeURIComponent('https://app.example'));
    });

    it('base ist zur Laufzeit ablesbar', () => {
      const a = Editor.createEditorAdapter({ frame: { src: '' }, editorBase: ORIGIN + '/' });
      assert.equal(a.base, ORIGIN);
    });

    it('frameUrl erzeugt ein leeres Dokument ueber new=, nicht ueber open-url', () => {
      const a = Editor.createEditorAdapter({ frame: { src: '' }, editorBase: ORIGIN, parentOrigin: 'https://app.example' });
      const url = a.frameUrl({ newDoc: 'xlsx' });
      assert.match(url, /\/editor\?/);
      assert.ok(url.includes('new=xlsx'), 'new=<kind> muss als Seitenparameter drinstehen: ' + url);
      assert.ok(!a.frameUrl().includes('new='), 'ohne newDoc bleibt die URL aequivalent');
    });

    it('readonly und new lassen sich kombinieren', () => {
      const a = Editor.createEditorAdapter({ frame: { src: '' }, editorBase: ORIGIN, parentOrigin: 'https://app.example' });
      const url = a.frameUrl({ newDoc: 'docx', readonly: true });
      assert.ok(url.includes('new=docx'));
      assert.ok(url.includes('readonly=1'));
    });

    it('load setzt die src nur, wenn sie sich aendert', () => {
      const frame = { src: '' };
      const a = Editor.createEditorAdapter({ frame, editorBase: ORIGIN, parentOrigin: 'https://app.example' });
      a.load({ newDoc: 'docx' });
      const first = frame.src;
      assert.ok(first.includes('new=docx'));
      a.load({ newDoc: 'docx' });
      assert.equal(frame.src, first, 'identisches Ziel darf nicht neu laden');
      a.load();
      assert.notEqual(frame.src, first, 'anderes Ziel muss neu laden');
    });

    it('openBuffer braucht echte Bytes', () => {
      const a = Editor.createEditorAdapter({ frame: { src: '' }, editorBase: ORIGIN });
      assert.throws(() => a.openBuffer('keine bytes', 'a.docx'), TypeError);
    });
  });

  describe('bytesFromSaved', () => {
    it('liest Blob, ArrayBuffer, TypedArray und String', async () => {
      assert.deepEqual([...await Editor.bytesFromSaved({ file: new Blob([new Uint8Array([1, 2])]) })], [1, 2]);
      assert.deepEqual([...await Editor.bytesFromSaved({ file: new Uint8Array([3, 4]).buffer })], [3, 4]);
      assert.deepEqual([...await Editor.bytesFromSaved({ file: new Uint8Array([5, 6]) })], [5, 6]);
      assert.deepEqual([...await Editor.bytesFromSaved({ file: 'x' })], [120]);
    });

    it('fehlende Datei wird gemeldet, nicht stillschweigend ignoriert', async () => {
      await assert.rejects(() => Editor.bytesFromSaved({}), /ohne Datei/);
      await assert.rejects(() => Editor.bytesFromSaved({ file: 42 }), /unbekannter Dateityp/);
    });

    it('Dateiname mit Rueckfall', () => {
      assert.equal(Editor.fileNameFromSaved({ fileName: 'bericht.docx' }, 'x.docx'), 'bericht.docx');
      assert.equal(Editor.fileNameFromSaved({}, 'x.docx'), 'x.docx');
    });
  });
});
