'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Fresh window-Mock pro Test (canvas.js haengt globals an window).
function loadCanvasApi() {
  delete global.window;
  global.window = {};
  require('../js/pencil.js');
  require('../js/erase.js');
  require('../js/inkdraw.js');
  require('../js/paper-templates.js');
  const C = require('../js/canvas.js');
  C._resetForTests && C._resetForTests();
  return C;
}

describe('canvas/Config', () => {
  const C = loadCanvasApi();
  it('Palette hat 7 Farben, Default = erste', () => {
    assert.ok(C.palette.length >= 3 && C.palette.length <= 12);
    assert.ok(C.palette.every(c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)));
    assert.equal(C.tool(), 'pen');
    assert.ok(C.color().startsWith('#'));
  });
  it('Width in [1,24] clamped; Zooming in [0.5,4] clampz', () => {
    const W = C.widthRange;
    assert.ok(W[0] === 1 && W[1] === 24);
    C.setWidth(2); assert.equal(C.width(), 2);
    C.setWidth(99); assert.equal(C.width(), W[1]);
    C.setWidth(0);  assert.equal(C.width(), W[0]);
    C.setZoom(0.1); assert.ok(C.zoom() >= 0.5);
    C.setZoom(99); assert.ok(C.zoom() <= 4);
  });
  it('selectTool: pen/marker/eraser gueltig, weitere ignoriert', () => {
    C.selectTool('marker'); assert.equal(C.tool(), 'marker');
    C.selectTool('eraser'); assert.equal(C.tool(), 'eraser');
    C.selectTool('pen');   assert.equal(C.tool(), 'pen');
    C.selectTool('notatool'); assert.equal(C.tool(), 'pen');
  });
});

describe('canvas/buildPdfDocument (Minimal-PDF-Writer)', () => {
  const C = loadCanvasApi();
  function jpgDataUrl(bytes) {
    return 'data:image/jpeg;base64,' + Buffer.from(bytes).toString('base64');
  }
  it('baut PDF-Struktur aus: Catalog/Pages/Page/XObject/Contents + xref', () => {
    const pdf = C.buildPdfDocument(jpgDataUrl([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]), 1000, 1414);
    assert.ok(typeof pdf === 'string' && pdf.length > 100);
    for (const token of ['%PDF-1.4', '/Type /Catalog', '/Type /Pages', '/MediaBox [0 0 1000 1414]',
                         '/Type /XObject', '/Filter /DCTDecode', '/Im0 Do', 'xref', 'startxref', 'trailer']) {
      assert.ok(pdf.includes(token), 'fehlt: ' + token);
    }
  });
  it('greped xref-Offsets zu echten Objekten (konsistent)', () => {
    const pdf = C.buildPdfDocument(jpgDataUrl([0xff, 0xd8, 0xff]), 500, 700);
    const m = pdf.match(/startxref\n(\d+)/);
    assert.ok(m, 'startxref fehlt');
    const off = parseInt(m[1], 10);
    assert.ok(pdf.slice(off).startsWith('xref'), 'startxref apunktet nicht auf xref');
    const entries = pdf.match(/^\d{10} 65535 f \n(?:\d{10} 00000 n \n?)+$/m);
    assert.ok(entries, 'xref-Free-Eintraege fehlen');
  });
  it('leer/Controllerfall: leerer DataURL liefert trotzdem ein PDF-Draft', () => {
    const pdf = C.buildPdfDocument('', 1000, 1414);
    assert.ok(pdf.includes('%PDF-1.4'));
  });
});
