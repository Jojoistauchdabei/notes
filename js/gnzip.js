/* Minimaler ZIP-Reader (stored + deflate), ohne Abhängigkeiten.
   Reicht für .goodnotes-Container (kein ZIP64, kein Split, kein Verschlüsselung).
   Import-Dateien sind untrusted: harte Limits gegen Zip-Bombs/Out-of-Bounds,
   null-Prototype-Objekt gegen __proto__-Einträge im Archiv. */
var GNZip = (function () {
  'use strict';

  var LIMITS = {
    entries: 4096,
    totalUncompressed: 256 * 1024 * 1024,
    singleEntry: 64 * 1024 * 1024,
    ratio: 200,
    nameBytes: 1024
  };

  function dv(data, o, n) { return new DataView(data.buffer, data.byteOffset + o, n); }
  function u32(data, o) {
    if (o < 0 || o + 4 > data.length) throw new Error('ZIP: Offset außerhalb der Datei');
    return dv(data, o, 4).getUint32(0, true);
  }
  function u16(data, o) {
    if (o < 0 || o + 2 > data.length) throw new Error('ZIP: Offset außerhalb der Datei');
    return dv(data, o, 2).getUint16(0, true);
  }

  function findEOCD(data) {
    for (let i = data.length - 22; i >= 0; i--) {
      if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x05 && data[i + 3] === 0x06) return i;
    }
    throw new Error('ZIP: EOCD nicht gefunden');
  }

  async function inflateRaw(raw, maxBytes) {
    // Browser: native DecompressionStream mit laufendem Limit (Zip-Bomb).
    const limit = maxBytes || LIMITS.singleEntry;
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate-raw');
      const reader = new Blob([raw]).stream().pipeThrough(ds).getReader();
      const chunks = [];
      let seen = 0;
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        seen += r.value.byteLength;
        if (seen > limit) {
          try { reader.cancel(); } catch (e) { /* ignore */ }
          throw new Error('ZIP: Entpackte Datei zu gro\u00df (Zip-Bomb?)');
        }
        chunks.push(r.value);
      }
      const out = new Uint8Array(seen);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.byteLength; }
      return out;
    }
    if (typeof require === 'function') {
      const zlib = require('node:zlib');
      return new Uint8Array(zlib.inflateRawSync(Buffer.from(raw), { maxOutputLength: limit }));
    }
    throw new Error('ZIP: Deflate wird von diesem Browser nicht unterst\u00fctzt');
  }

  var CTRL_NAME = new RegExp('[\\u0000-\\u001f\\u007f]', '');

  function safeName(name) {
    const n = String(name || '').replace(/\\/g, '/');
    if (!n || n.length > LIMITS.nameBytes) return null;
    if (n.charAt(0) === '/' || /^[a-z]:/i.test(n)) return null;
    if (n.split('/').some((seg) => seg === '..')) return null;
    if (CTRL_NAME.test(n)) return null;
    return n;
  }

  async function readZip(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (data.length < 22) throw new Error('ZIP: Datei zu klein');
    const eocd = findEOCD(data);
    const count = u16(data, eocd + 10);
    const cdOff = u32(data, eocd + 16);
    if (count > LIMITS.entries) throw new Error('ZIP: Zu viele Einträge (' + count + ')');
    if (cdOff >= data.length) throw new Error('ZIP: Central Directory außerhalb der Datei');
    const out = Object.create(null);
    let total = 0;
    let p = cdOff;
    for (let i = 0; i < count; i++) {
      if (u32(data, p) !== 0x02014b50) throw new Error('ZIP: Central Directory korrupt');
      const method = u16(data, p + 10);
      const cSize = u32(data, p + 20);
      const uSize = u32(data, p + 24);
      const nameLen = u16(data, p + 28), extraLen = u16(data, p + 30), comLen = u16(data, p + 32);
      const entryBytes = 46 + nameLen + extraLen + comLen;
      if (p + entryBytes > data.length) throw new Error('ZIP: Central Directory abgeschnitten');
      const nameBytes = data.subarray(p + 46, p + 46 + nameLen);
      const rawName = new TextDecoder().decode(nameBytes);
      const name = safeName(rawName);
      if (name === null) {
        p += entryBytes;
        continue;
      }
      const lho = u32(data, p + 42);
      if (u32(data, lho) !== 0x04034b50) throw new Error('ZIP: Local Header korrupt (' + name + ')');
      const lhNameLen = u16(data, lho + 26), lhExtraLen = u16(data, lho + 28);
      const start = lho + 30 + lhNameLen + lhExtraLen;
      if (start + cSize > data.length) throw new Error('ZIP: Datenbereich abgeschnitten (' + name + ')');
      if (name.endsWith('/')) { p += entryBytes; continue; }
      if (method !== 0 && method !== 8) throw new Error('ZIP: Kompressionsmethode ' + method + ' nicht unterstützt');
      if (uSize > LIMITS.singleEntry) throw new Error('ZIP: Eintrag zu groß (' + name + ')');
      if (cSize > 0 && uSize / cSize > LIMITS.ratio && uSize > 4 * 1024 * 1024) {
        throw new Error('ZIP: Verdächtiges Kompressionsverhältnis (' + name + ')');
      }
      total += uSize;
      if (total > LIMITS.totalUncompressed) throw new Error('ZIP: Entpackte Gesamtgröße zu groß');
      const raw = data.subarray(start, start + cSize);
      out[name] = method === 0 ? raw.slice() : await inflateRaw(raw, LIMITS.singleEntry - (total - uSize));
      if (out[name].length > LIMITS.singleEntry) throw new Error('ZIP: Entpackter Eintrag zu groß (' + name + ')');
      p += entryBytes;
    }
    return out;
  }

  return { readZip, LIMITS };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = GNZip;
