/* Minimaler ZIP-Reader (stored + deflate), ohne Abhängigkeiten.
   Reicht für .goodnotes-Container (kein ZIP64, kein Split, keine Verschlüsselung). */
var GNZip = (function () {
  'use strict';
  function dv(data, o, n) { return new DataView(data.buffer, data.byteOffset + o, n); }
  function u32(data, o) { return dv(data, o, 4).getUint32(0, true); }
  function u16(data, o) { return dv(data, o, 2).getUint16(0, true); }

  function findEOCD(data) {
    for (let i = data.length - 22; i >= 0; i--) {
      if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x05 && data[i + 3] === 0x06) return i;
    }
    throw new Error('ZIP: EOCD nicht gefunden');
  }

  async function inflateRaw(raw) {
    // Browser: native DecompressionStream. Node-Test: globaler Shim via zlib.
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([raw]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function readZip(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const eocd = findEOCD(data);
    const count = u16(data, eocd + 10);
    const cdOff = u32(data, eocd + 16);
    const out = {};
    let p = cdOff;
    for (let i = 0; i < count; i++) {
      if (u32(data, p) !== 0x02014b50) throw new Error('ZIP: Central Directory korrupt');
      const method = u16(data, p + 10);
      const cSize = u32(data, p + 20);
      const nameLen = u16(data, p + 28), extraLen = u16(data, p + 30), comLen = u16(data, p + 32);
      const nameBytes = data.subarray(p + 46, p + 46 + nameLen);
      const name = new TextDecoder().decode(nameBytes);
      const lho = u32(data, p + 42);
      if (u32(data, lho) !== 0x04034b50) throw new Error('ZIP: Local Header korrupt (' + name + ')');
      const lhNameLen = u16(data, lho + 26), lhExtraLen = u16(data, lho + 28);
      const start = lho + 30 + lhNameLen + lhExtraLen;
      const raw = data.subarray(start, start + cSize);
      if (name.endsWith('/')) { p += 46 + nameLen + extraLen + comLen; continue; }
      out[name] = method === 0 ? raw.slice() : await inflateRaw(raw);
      p += 46 + nameLen + extraLen + comLen;
    }
    return out;
  }

  return { readZip };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = GNZip;
