'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const O = require('../js/optimize.js');

describe('optimize/kontext', () => {
  it('maxEdge + targetBytes pro Kontext', () => {
    assert.equal(O.maxEdgeFor('thumbnail'), 400);
    assert.equal(O.maxEdgeFor('page'), 1600);
    assert.equal(O.maxEdgeFor('export'), 2048);
    assert.equal(O.targetBytesFor('thumbnail'), 120 * 1024);
    assert.equal(O.targetBytesFor('page'), 350 * 1024);
    assert.equal(O.maxEdgeFor('unbekannt'), 1600);
  });
  it('scaledSize skaliert nie hoch', () => {
    assert.deepEqual(O.scaledSize(3200, 2000, 1600), { w: 1600, h: 1000, scale: 0.5 });
    assert.deepEqual(O.scaledSize(100, 80, 1600), { w: 100, h: 80, scale: 1 });
  });
  it('orientedSize tauscht bei EXIF 5-8', () => {
    assert.deepEqual(O.orientedSize(100, 200, 6), { w: 200, h: 100, swapped: true });
    assert.deepEqual(O.orientedSize(100, 200, 1), { w: 100, h: 200, swapped: false });
  });
});

describe('optimize/formatwahl', () => {
  it('opak -> JPEG, Alpha -> WebP, GIF/PDF keep', () => {
    assert.equal(O.chooseOutputMime('image/png', false), 'image/jpeg');
    assert.equal(O.chooseOutputMime('image/jpeg', false), 'image/jpeg');
    assert.equal(O.chooseOutputMime('image/png', true), 'image/webp');
    assert.equal(O.chooseOutputMime('image/jpeg', true), 'image/webp');
    assert.equal(O.chooseOutputMime('image/gif', false), 'image/gif');
    assert.equal(O.chooseOutputMime('application/pdf', false), 'application/pdf');
  });
  it('pickTarget: groß -> recompress, klein -> small, PDF/GIF -> keep', () => {
    assert.equal(O.pickTarget('image/jpeg', 500 * 1024, 'page').recompress, true);
    assert.equal(O.pickTarget('image/jpeg', 10 * 1024, 'page').recompress, false);
    assert.equal(O.pickTarget('application/pdf', 5 * 1024 * 1024, 'page').recompress, false);
    assert.equal(O.pickTarget('image/gif', 5 * 1024 * 1024, 'page').recompress, false);
    const t = O.pickTarget('image/png', 500 * 1024, 'thumbnail');
    assert.equal(t.maxEdge, 400);
    assert.equal(t.targetBytes, 120 * 1024);
  });
  it('searchBestQuality findet max q unter Target (mock, ohne Canvas)', () => {
    // probe: bytes = q * 1000
    const r = O.searchBestQuality(700, (q) => Math.round(q * 1000), 0.4, 0.9, 8);
    assert.ok(r.quality <= 0.9 && r.quality >= 0.4);
    assert.ok(r.bytes <= 700);
    assert.equal(r.fits, true);
    const miss = O.searchBestQuality(10, (q) => Math.round(q * 1000), 0.4, 0.9, 4);
    assert.equal(miss.fits, false);
  });
});

describe('optimize/rdp', () => {
  const line = [];
  for (let i = 0; i <= 20; i++) line.push({ x: i * 10, y: 0, p: 0.5 });
  it('kollineare Linie kollabiert auf Endpunkte', () => {
    const out = O.simplifyPoints(line, 1);
    assert.deepEqual(out.map((p) => p.x), [0, 200]);
  });
  it('epsilon 0 behält alles (nach Dedupe)', () => {
    assert.equal(O.simplifyPoints(line, 0).length, 21);
  });
  it('Spitze bleibt erhalten', () => {
    const pts = [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }];
    assert.equal(O.simplifyPoints(pts, 1).length, 3);
    assert.equal(O.simplifyPoints(pts, 100).length, 2);
  });
  it('Duplikate fliegen raus, Pressure bleibt dran', () => {
    const pts = [
      { x: 0, y: 0, p: 0.1 }, { x: 0, y: 0, p: 0.9 },
      { x: 10, y: 0, p: 0.5 }, { x: 20, y: 0, p: 0.7 },
    ];
    const out = O.simplifyPoints(pts, 1);
    assert.equal(out.length, 2);
    assert.equal(out[0].p, 0.1); // erstes Original-Objekt, kein Neubau
    assert.equal(out[1].p, 0.7);
  });
  it('Array-Punkte [x,y] werden unterstützt', () => {
    const out = O.simplifyPoints([[0, 0], [5, 0], [10, 0]], 1);
    assert.deepEqual(out, [[0, 0], [10, 0]]);
  });
  it('epsilonForPenSize skaliert mit Stiftstärke', () => {
    assert.ok(O.epsilonForPenSize(9) > O.epsilonForPenSize(2));
    assert.ok(O.epsilonForPenSize(3) >= 0.75);
  });
  it('simplifyStroke behält Stil, vereinfacht Punkte', () => {
    const s = { tool: 'pen', color: '#000', size: 3, points: line.map((p) => ({ ...p })) };
    const out = O.simplifyStroke(s);
    assert.equal(out.tool, 'pen');
    assert.equal(out.points.length, 2);
    assert.equal(s.points.length, 21); // Eingabe unverändert
  });
  it('simplifyBookStrokes mutiert + zählt', () => {
    const book = {
      pages: [{ strokes: [{ size: 3, points: line.map((p) => ({ ...p })) }] }],
    };
    const r = O.simplifyBookStrokes(book);
    assert.equal(r.strokes, 1);
    assert.equal(r.removed, 19);
    assert.equal(book.pages[0].strokes[0].points.length, 2);
  });
});

describe('optimize/groesse', () => {
  it('estimateSize: Bytes, dataURL, Objekt', () => {
    assert.equal(O.estimateSize(new Uint8Array([1, 2, 3])), 3);
    const du = 'data:image/jpeg;base64,' + Buffer.from('abcdef').toString('base64');
    assert.equal(O.estimateSize(du), 6);
    assert.ok(O.estimateSize({ a: 1 }) > 0);
    assert.equal(O.estimateSize(null), 0);
  });
  it('estimateBookSize zählt Punkte/Bilder', () => {
    const st = O.estimateBookSize({
      pages: [{ strokes: [{ points: [{ x: 1, y: 2 }] }], images: [{ src: 'x' }], bg: 'y' }],
    });
    assert.equal(st.points, 1);
    assert.equal(st.images, 2);
    assert.ok(st.jsonBytes > 0);
  });
  it('optimizeBookStats rechnet Ersparnis + Label', () => {
    const s = O.optimizeBookStats(1000, 600);
    assert.equal(s.savedBytes, 400);
    assert.equal(s.savedPct, 40);
    assert.match(s.label, /gespart/);
    const mb = O.optimizeBookStats(3 * 1024 * 1024, 1024 * 1024);
    assert.match(mb.label, /MB gespart/);
  });
  it('formatBytes de-Format', () => {
    assert.equal(O.formatBytes(512), '512 B');
    assert.match(O.formatBytes(2048), /KB/);
  });
});

describe('optimize/dedupe', () => {
  it('fileIdForHash Schema fw+32hex', () => {
    const fid = O.fileIdForHash('BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD');
    assert.match(fid, /^fw[0-9a-f]{32}$/);
    assert.throws(() => O.fileIdForHash('abc'), /zu kurz/);
  });
  it('sha256 Vektor (ohne Canvas)', async () => {
    assert.equal(await O.sha256Hex(new TextEncoder().encode('abc')),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('optimize/adaptiv-mock', () => {
  // Simulierter Decoder/Encoder ganz ohne Canvas/DOM.
  const fakeDecode = async () => ({ width: 3200, height: 2000, close() {} });
  const mkEncode = (log) => async (canvas, mime, q) => {
    log.push({ mime, q });
    const bytes = new Uint8Array(Math.round(500000 * (q || 0.8))); // monoton in q, q0 darüber Target
    return { bytes, mime };
  };
  it('skaliert + sucht Qualität unter Target', async () => {
    const log = [];
    const big = new Uint8Array(500000).fill(7);
    const out = await O.optimizeImageAdaptive(big, 'image/jpeg', { context: 'page' }, {
      decode: fakeDecode,
      encode: mkEncode(log),
      detectAlpha: () => true,
      draw: () => ({ canvas: {}, ctx: null }),
    });
    assert.equal(out.optimized, true);
    assert.equal(out.mime, 'image/jpeg');
    assert.equal(out.w, 1600);
    assert.ok(out.bytes.length < big.length);
    assert.ok(log.length > 1); // Binary Search hat iteriert
  });
  it('kleine Datei ohne force bleibt unangetastet', async () => {
    let calls = 0;
    const out = await O.optimizeImageAdaptive(new Uint8Array(1000), 'image/jpeg', { context: 'page' }, {
      decode: async () => { calls++; return { width: 100, height: 80 }; },
      encode: async () => { calls++; return null; },
      draw: () => ({}),
    });
    assert.equal(out.optimized, false);
    assert.equal(out.reason, 'small');
    assert.equal(calls, 1); // nur decode, kein encode
  });
  it('ohne deps (Node, kein Canvas) degradiert sauber', async () => {
    const out = await O.optimizeImageAdaptive(new Uint8Array([1, 2, 3]), 'image/jpeg', { context: 'page' });
    assert.equal(out.optimized, false);
    assert.equal(out.reason, 'no-canvas');
  });
  it('downscaleDataUrl Fallback ohne Canvas gibt Original', async () => {
    const du = 'data:image/jpeg;base64,' + Buffer.alloc(300 * 1024, 7).toString('base64');
    assert.equal(await O.downscaleDataUrl(du, 'page'), du);
  });
});
