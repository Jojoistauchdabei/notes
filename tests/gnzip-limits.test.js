// tests/gnzip-limits.test.js – Import-Härtung: Zip-Bombs, Bounds-Checks,
// __proto__-Einträge und abgeschnittene Central Directories.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const GNZip = require('../js/gnzip.js');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function makeZip(entries, opts = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '', 'utf8');
    const store = !!e.store;
    const comp = store ? data : zlib.deflateRawSync(data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(store ? 0 : 8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(store ? 0 : 8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const body = Buffer.concat([...locals, cd]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.count != null ? opts.count : entries.length, 8);
  eocd.writeUInt16LE(opts.count != null ? opts.count : entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(opts.cdOff != null ? opts.cdOff : body.length - cd.length, 16);
  return new Uint8Array(Buffer.concat([body, eocd]));
}

describe('gnzip/limits', () => {
  it('liest ein normales ZIP weiterhin', async () => {
    const zip = makeZip([
      { name: 'notes/notes.pb', data: 'hello' },
      { name: 'notes/', data: '' },
    ]);
    const out = await GNZip.readZip(zip);
    assert.equal(Buffer.from(out['notes/notes.pb']).toString('utf8'), 'hello');
  });

  it('verwirft __proto__/constructor-Einträge (kein Proto-Pollution)', async () => {
    const zip = makeZip([
      { name: '__proto__', data: '{"polluted":1}' },
      { name: 'constructor', data: 'x' },
      { name: 'ok.json', data: '{}' },
    ]);
    const out = await GNZip.readZip(zip);
    assert.equal(Object.getPrototypeOf(out), null);
    assert.equal(({}).polluted, undefined);
    assert.equal(out['ok.json'] instanceof Uint8Array, true);
  });

  it('verwirft Zip-Slip-Namen mit .. oder absolutem Pfad', async () => {
    const zip = makeZip([
      { name: '../../evil.txt', data: 'x' },
      { name: '/etc/passwd', data: 'x' },
      { name: 'notes/ok.txt', data: 'y' },
    ]);
    const out = await GNZip.readZip(zip);
    assert.deepEqual(Object.keys(out), ['notes/ok.txt']);
  });

  it('bricht bei Zip-Bomb (huge Kompressionsverhältnis) ab', async () => {
    const bomb = Buffer.alloc(24 * 1024 * 1024, 0);
    const zip = makeZip([{ name: 'big.bin', data: bomb }]);
    await assert.rejects(() => GNZip.readZip(zip), /Verdächtiges Kompressionsverhältnis|zu groß|Zip-Bomb/);
  });

  it('bricht bei zu vielen Eintraegen ab', async () => {
    const zip = makeZip([{ name: 'a.txt', data: 'x' }], { count: 5000 });
    await assert.rejects(() => GNZip.readZip(zip), /Zu viele Einträge/);
  });

  it('bricht bei abgeschnittenem Central Directory ab (kein RangeError)', async () => {
    const zip = makeZip([{ name: 'a.txt', data: 'x' }], { cdOff: 5 });
    await assert.rejects(() => GNZip.readZip(zip), /ZIP:/);
  });

  it('meldet kaputte Container sauber als Fehler', async () => {
    await assert.rejects(() => GNZip.readZip(new Uint8Array([1, 2, 3])), /ZIP: Datei zu klein|EOCD/);
  });
});
