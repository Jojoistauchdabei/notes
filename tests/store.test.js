const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Store = require('../js/store.js');
const { isBlobRef, isDataUrl, dataUrlToBytes, bytesToDataUrl,
  collectRefs, stripRuntime, parseLegacy, _setForceMemBlobs, _reset } = Store._internals;

const PIXEL_JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function bookWithInline() {
  return {
    id: 'b1', title: 'T', updatedAt: 1, pages: [
      { id: 'p1', strokes: [], texts: [], bg: PIXEL_JPEG, images: [{ id: 'i1', x: 0, y: 0, w: 1, src: PIXEL_PNG }] },
      { id: 'p2', strokes: [], texts: [], bg: null, images: [] },
    ],
  };
}

describe('store/helpers', () => {
  it('isBlobRef/isDataUrl erkennen Formate', () => {
    assert.equal(isBlobRef('blob:abc'), true);
    assert.equal(isBlobRef('blob:'), false);
    assert.equal(isBlobRef(PIXEL_PNG), false);
    assert.equal(isBlobRef(null), false);
    assert.equal(isDataUrl(PIXEL_PNG), true);
    assert.equal(isDataUrl('blob:abc'), false);
    assert.equal(isDataUrl('https://x/y.png'), false);
  });
  it('dataUrl roundtrip Bytes <-> dataURL', () => {
    const { mime, bytes } = dataUrlToBytes(PIXEL_PNG);
    assert.equal(mime, 'image/png');
    assert.ok(bytes.length > 0);
    const back = bytesToDataUrl(bytes, mime);
    assert.equal(back, PIXEL_PNG);
  });
  it('collectRefs sammelt src + bg', () => {
    assert.deepEqual(collectRefs(bookWithInline()), [PIXEL_PNG, PIXEL_JPEG]);
    assert.deepEqual(collectRefs({ pages: [] }), []);
    assert.deepEqual(collectRefs(null), []);
  });
  it('stripRuntime entfernt _-Keys, Rest bleibt', () => {
    const out = stripRuntime({ a: 1, _x: 2, nested: { _y: 3, z: 4 } });
    assert.deepEqual(out, { a: 1, nested: { z: 4 } });
  });
  it('parseLegacy validiert State-Form', () => {
    assert.ok(parseLegacy(JSON.stringify({ books: [] })));
    assert.equal(parseLegacy('kaputt'), null);
    assert.equal(parseLegacy(JSON.stringify({ books: 'nein' })), null);
    assert.equal(parseLegacy(null), null);
  });
});

describe('store/blobs (memory-backend)', () => {
  beforeEach(() => { _reset(); _setForceMemBlobs(true); });

  it('putDataUrl lagert aus, dataUrl löst auf', async () => {
    const ref = await Store.putDataUrl(PIXEL_PNG);
    assert.match(ref, /^blob:/);
    assert.equal(await Store.dataUrl(ref), PIXEL_PNG);
  });
  it('putDataUrl ohne Backend lässt Inline (Fallback)', async () => {
    _setForceMemBlobs(false);
    assert.equal(await Store.putDataUrl(PIXEL_PNG), PIXEL_PNG);
  });
  it('url() liefert Cache nach Hintergrund-Auflösung', async () => {
    const ref = await Store.putDataUrl(PIXEL_PNG);
    assert.equal(Store.url(ref), ''); // noch nicht geladen
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(Store.url(ref).length > 0);
  });
  it('extract/inline Roundtrip erhält alle Bilder', async () => {
    const book = bookWithInline();
    await Store.extractBook(book);
    const refs = collectRefs(book);
    assert.equal(refs.length, 2);
    assert.ok(refs.every(isBlobRef), 'keine dataURL mehr im State, kein localStorage-Overflow');
    const back = await Store.inlineBook(book);
    assert.deepEqual(collectRefs(back), [PIXEL_PNG, PIXEL_JPEG]);
  });
  it('extractBook lässt Fremd-URLs + leere Seiten in Ruhe', async () => {
    const book = { id: 'b', pages: [{ images: [{ src: 'https://x/y.png' }], bg: null }] };
    await Store.extractBook(book);
    assert.equal(book.pages[0].images[0].src, 'https://x/y.png');
  });
  it('putBlob nimmt Blob-Objekte', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    const ref = await Store.putBlob(blob);
    assert.match(ref, /^blob:/);
  });
});
