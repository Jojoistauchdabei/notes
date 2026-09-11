'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const B = require('./build-gn.js');
const GNZip = require('../js/gnzip.js');
const GoodNotes = require('../js/goodnotes.js');
const I = GoodNotes._internals;

describe('wire', () => {
  it('delimited roundtrip', () => {
    const f = B.delimited([B.msg([[1, 2, B.str('hi')], [3, 0, 42]]), B.msg([[7, 5, 1.5]])]);
    const recs = I.decodeDelimited(f);
    assert.equal(recs.length, 2);
    assert.equal(recs[0].fields[0].v.toString(), 'hi');
    assert.equal(recs[1].fields[0].v, I.decodeMessage(B.msg([[7, 5, 1.5]])).fields[0].v);
    assert.equal(recs[1].fields[0].v >>> 0, 0x3fc00000);
  });
  it('fixed32 float', () => {
    const m = I.decodeMessage(B.msg([[1, 5, 0.5], [2, 0, 7]]));
    assert.equal(m.fields[0].v >>> 0, 0x3f000000);
  });
  it('kaputte bytes werfen', () => {
    assert.throws(() => I.decodeMessage(Buffer.from([0xff, 0xff])));
  });
});

describe('lz4/apple', () => {
  it('literals roundtrip', () => {
    const raw = Buffer.from('tpl\0hello world, das ist tinte');
    const blob = B.bv41(raw);
    const { bytes, consumed } = I.decodeAppleLz4(blob);
    assert.equal(Buffer.from(bytes).toString(), raw.toString());
    assert.equal(consumed, blob.length - 0); // inkl. bv4$
  });
  it('abgeschnitten wirft', () => {
    assert.throws(() => I.decodeAppleLz4(Buffer.from('bv41')));
  });
});

describe('tpl', () => {
  it('schema1 roundtrip', () => {
    const P = (x, y) => [B.f32bits(x), B.f32bits(y)];
    const tpl = B.tplEncode('vuA(v)A(S(uu))A(S(uuuu))vA(f)',
      [0, B.f32bits(2.5), [1], [P(100, 200)], [[...P(100, 200), ...P(150, 250)]], 0, [1.0]]);
    const img = I.decodeTpl(tpl);
    assert.equal(img.format, 'vuA(v)A(S(uu))A(S(uuuu))vA(f)');
    assert.equal(img.values.length, 7);
    const { groups, width } = I.extractPoints(img);
    assert.equal(width, 2.5);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].map(p => [p.x, p.y]), [[100, 200], [150, 250]]);
  });
  it('falscher magic wirft', () => {
    assert.throws(() => I.decodeTpl(Buffer.from('xxxx')));
  });
});

describe('zip', () => {
  it('stored roundtrip + mehrere dateien', async () => {
    const z = B.zipStore([['a.txt', Buffer.from('hallo')], ['n/b.bin', Buffer.from([1, 2, 3])]]);
    const out = await GNZip.readZip(new Uint8Array(z));
    assert.deepEqual(Object.keys(out).sort(), ['a.txt', 'n/b.bin']);
    assert.equal(Buffer.from(out['a.txt']).toString(), 'hallo');
    assert.deepEqual(Array.from(out['n/b.bin']), [1, 2, 3]);
  });
  it('deflate wird entpackt', async () => {
    const zlib = require('zlib');
    const raw = Buffer.from('x'.repeat(500));
    const def = zlib.deflateRawSync(raw);
    // minimaler deflate-zip von hand (korrekte header-offsets)
    const nb = Buffer.from('f.bin');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8); // methode 8 = deflate
    lh.writeUInt32LE(0, 14); lh.writeUInt32LE(def.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(0, 16); cd.writeUInt32LE(def.length, 20); cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nb.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt32LE(0, 38); cd.writeUInt32LE(0, 42); // local header steht bei 0
    const cdStart = 30 + nb.length + def.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(46 + nb.length, 12); end.writeUInt32LE(cdStart, 16);
    const z = Buffer.concat([lh, nb, def, cd, nb, end]);
    const out = await GNZip.readZip(new Uint8Array(z));
    assert.equal(Buffer.from(out['f.bin']).toString(), raw.toString());
  });
});
