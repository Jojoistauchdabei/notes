'use strict';
/* Fixture-Builder: erzeugt synthetische .goodnotes-Dateien für die Tests.
   Spiegelt exakt die vom Decoder verstandenen Strukturen (Protobuf-Wire,
   TPL, bv41-LZ4 mit Literals, delimited Framing, Stored-ZIP). */
const zlib = require('zlib');

function varint(n) {
  if (n < 0) throw new Error('negativ');
  const out = [];
  let v = Math.floor(n);
  do { let b = v % 128; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
}
function fixed32(f) { const b = Buffer.alloc(4); b.writeFloatLE(f, 0); return b; }
function f64(f) { const b = Buffer.alloc(8); b.writeDoubleLE(f, 0); return b; }
function u32(u) { const b = Buffer.alloc(4); b.writeUInt32LE(u >>> 0, 0); return b; }
function u16(u) { const b = Buffer.alloc(2); b.writeUInt16LE(u, 0); return b; }
// Feld: [nummer, wiretype, wert] – wert: number | Buffer
function field(n, wt, v) {
  let key = varint(n * 8 + wt), body;
  if (wt === 0) body = varint(v);
  else if (wt === 5) body = fixed32(v);
  else if (wt === 2) { const l = varint(v.length); body = Buffer.concat([l, v]); }
  else throw new Error('wt');
  return Buffer.concat([key, body]);
}
const str = (s) => Buffer.from(s, 'utf8');
function msg(fields) { return Buffer.concat(fields.map(([n, wt, v]) => field(n, wt, v))); }
function delimited(frames) {
  return Buffer.concat(frames.map(f => Buffer.concat([varint(f.length), f])));
}

/* --- TPL --- */
function tplValue(node, val) {
  if (Array.isArray(node)) {
    const [kind, kids] = node;
    if (kind === 'S') return Buffer.concat(kids.map((k, i) => tplValue(k, val[i])));
    const items = val.map(it => kids.length === 1 ? tplValue(kids[0], it) : Buffer.concat(kids.map((k, i) => tplValue(k, it[i]))));
    return Buffer.concat([u32(val.length), ...items]);
  }
  if (node === 'u') return u32(val);
  if (node === 'v') return u16(val);
  if (node === 'i') { const b = Buffer.alloc(4); b.writeInt32LE(val, 0); return b; }
  if (node === 'f') return f64(val);
  throw new Error('tpl type ' + node);
}
function parseFmt(fmt) {
  let pos = 0;
  const group = (term) => {
    const nodes = [];
    while (pos < fmt.length) {
      const t = fmt[pos++];
      if (t === ')') { if (!term) throw new Error(')'); return nodes; }
      if (t === 'A' || t === 'S') { if (fmt[pos] !== '(') throw new Error('grp'); pos++; nodes.push([t, group(')')]); }
      else nodes.push(t);
    }
    if (term) throw new Error('offen');
    return nodes;
  };
  return group(null);
}
function tplEncode(format, values) {
  const nodes = parseFmt(format);
  const payload = Buffer.concat(nodes.map((n, i) => tplValue(n, values[i])));
  const head = Buffer.concat([Buffer.from('tpl', 'ascii'), Buffer.from([0]), u32(0), Buffer.from(format, 'ascii'), Buffer.from([0])]);
  const total = Buffer.concat([head, payload]);
  total.writeUInt32LE(total.length, 4);
  return total;
}
function f32bits(f) { const b = Buffer.alloc(4); b.writeFloatLE(f, 0); return b.readUInt32LE(0); }
/* LZ4 mit nur Literals (gültig, unkomprimiert) */
function lz4Literals(raw) {
  const out = [];
  let rest = raw.length;
  if (rest < 15) out.push(rest << 4);
  else {
    out.push(0xf0); rest -= 15;
    while (rest >= 255) { out.push(255); rest -= 255; }
    out.push(rest);
  }
  return Buffer.concat([Buffer.from(out), raw]);
}
function bv41(tplBytes) {
  const lz = lz4Literals(tplBytes);
  return Buffer.concat([Buffer.from('bv41'), u32(tplBytes.length), u32(lz.length), lz, Buffer.from('bv4$')]);
}

/* --- GoodNotes-Bausteine --- */
const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';
function colorMsg(r, g, b, a) {
  return msg([[1, 5, r], [2, 5, g], [3, 5, b], [4, 5, a]]);
}
// Schema-1-Stroke: pairs=[[x,y]...], quads=[[x1,y1,x2,y2]...], Farbe, Breite, optional Offset
function strokeField7(uuid, { pairs = [], quads = [], color = [0, 0, 0, 1], width = 2.5, offset = null } = {}) {
  const P = (pt) => [f32bits(pt[0]), f32bits(pt[1])];
  const Q = (q) => [f32bits(q[0]), f32bits(q[1]), f32bits(q[2]), f32bits(q[3])];
  const tpl = tplEncode('vuA(v)A(S(uu))A(S(uuuu))vA(f)',
    [0, f32bits(width), pairs.length ? [1] : [], pairs.map(P), quads.map(Q), 0, [1.0]]);
  const parts = [[1, 2, str(uuid)], [2, 2, bv41(tpl)], [4, 2, colorMsg(...color)]];
  if (offset) parts.push([6, 2, msg([[1, 5, offset[0]], [2, 5, offset[1]]])]);
  return msg(parts);
}
function metaFrame(uuid, erased) {
  const f = [[1, 2, str(uuid)]];
  if (erased) f.push([3, 0, 1]);
  return msg(f);
}
function pointMsg(x, y) { return msg([[1, 5, x], [2, 5, y]]); }
function imageRecord(recUuid, attUuid, x, y, w, h) {
  return msg([[1, 2, str(recUuid)], [7, 2, str(attUuid)],
    [8, 2, msg([[2, 2, msg([[1, 2, pointMsg(x, y)], [2, 2, pointMsg(w, h)]])]])]]);
}
function textItemPayload(text, { font = 'TestFont', size = 32, color = [1, 0, 0, 1], align = 2, list = null } = {}) {
  const item = [[1, 2, str(text)],
    [2, 2, msg([[30, 2, str(font)], [40, 5, size], [3, 2, colorMsg(...color)]])]];
  if (list || align !== 1) {
    const m3 = [];
    if (list === 'bullet') m3.push([3, 2, Buffer.alloc(0)]);
    if (list === 'numbered') m3.push([3, 2, msg([[1, 0, 1]])]);
    m3.push([4, 0, align]);
    item.push([3, 2, msg(m3)]);
  }
  return msg(item);
}
function textRecord(recUuid, x, y, w, h, items) {
  const decPayload = Buffer.concat(items.map(it => Buffer.concat([varint(1 * 8 + 2), varint(it.length), it])));
  const inner = msg([[2, 2, bv41(Buffer.from(decPayload))]]);
  return msg([[1, 2, str(recUuid)],
    [21, 2, msg([
      [20, 2, msg([[1, 2, pointMsg(x, y)]])],
      [32, 2, msg([
        [1, 2, inner],
        [2, 2, pointMsg(w, h)],
        [5, 2, msg([[1, 2, msg([[30, 2, str('TestFont')], [40, 5, 24]])]])],
        [10, 2, pointMsg(0, 0)]])]])]]);
}
function stickyRecord(recUuid, x, y, text) {
  const decPayload = Buffer.concat([varint(1 * 8 + 2), varint(textItemPayload(text, { size: 14, color: [0, 0, 0, 1], align: 1 }).length), textItemPayload(text, { size: 14, color: [0, 0, 0, 1], align: 1 })]);
  return msg([[20, 2, msg([
    [2, 0, 35], [1, 2, str(recUuid)],
    [20, 2, msg([[1, 2, pointMsg(x, y)]])],
    [31, 2, msg([[1, 2, msg([[2, 2, bv41(Buffer.from(decPayload))]])]])]])]]);
}
function shapeRecordF9(recUuid, x1, y1, x2, y2, { color = [0, 0.45, 0.33, 1], width = 3 } = {}) {
  const container = msg([[1, 2, pointMsg(x1, y1)], [2, 2, pointMsg(x2, y2)]]);
  const shapeMsg = msg([[1, 2, container], [15, 5, width]]);
  return msg([[1, 2, str(recUuid)],
    [7, 2, msg([[9, 2, shapeMsg], [4, 2, colorMsg(...color)]])]]);
}
function eventsWithTitle(title) {
  const inner = msg([[1, 2, str(title)], [1, 2, str(UUID_A)], [1, 2, str(UUID_B)]]);
  return delimited([msg([[30, 2, msg([[1, 2, inner]])]])]);
}
function png1x1() {
  const ihdr = Buffer.concat([u32(13), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])]);
  const raw = Buffer.concat([Buffer.from([0]), Buffer.from([255, 0, 0, 255])]);
  const idat = Buffer.concat([u32(raw.length + 2), Buffer.from('IDAT')]);
  const comp = zlib.deflateSync(raw);
  const table = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const h = Buffer.concat([u32(data.length), Buffer.from(type)]);
    const cb = Buffer.alloc(4); cb.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), data])), 0);
    return Buffer.concat([h, data, cb]);
  };
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr.subarray(8)), chunk('IDAT', comp), chunk('IEND', Buffer.alloc(0))]);
}
function minimalPdf(w = 200, h = 300, text = 'Hello') {
  const objs = [];
  objs[1] = Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'ascii');
  objs[2] = Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', 'ascii');
  objs[3] = Buffer.from(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents 4 0 R >>\nendobj\n`, 'ascii');
  const stream = Buffer.from(`BT /F1 12 Tf 10 10 Td (${text}) Tj ET`, 'ascii');
  objs[4] = Buffer.concat([Buffer.from(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n`, 'ascii'), stream, Buffer.from('\nendstream\nendobj\n', 'ascii')]);
  let out = Buffer.from('%PDF-1.7\n', 'ascii');
  const offsets = [0];
  for (let i = 1; i <= 4; i++) { offsets[i] = out.length; out = Buffer.concat([out, objs[i]]); }
  const xref = out.length;
  let tab = `xref\n0 5\n0000000000 65535 f \n`;
  for (let i = 1; i <= 4; i++) tab += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out = Buffer.concat([out, Buffer.from(tab + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`, 'ascii')]);
  return out;
}
/* Stored-ZIP (keine Kompression) */
function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nb = enc.encode(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(0, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, nb, Buffer.from(data));
    central.push({ name: nb, len: data.length, offset });
    offset += 30 + nb.length + data.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6);
    h.writeUInt16LE(0, 8); h.writeUInt16LE(0, 10);
    h.writeUInt32LE(0, 16); h.writeUInt32LE(c.len, 20); h.writeUInt32LE(c.len, 24);
    h.writeUInt16LE(c.name.length, 28); h.writeUInt16LE(0, 30); h.writeUInt16LE(0, 32);
    h.writeUInt32LE(0, 38); h.writeUInt32LE(c.offset, 42);
    chunks.push(h, c.name);
    cdSize += 46 + c.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cdStart, 16);
  chunks.push(end);
  return Buffer.concat(chunks);
}

module.exports = {
  varint, fixed32, f64, u32, u16, field, str, msg, delimited,
  tplEncode, f32bits, lz4Literals, bv41,
  strokeField7, metaFrame, pointMsg, imageRecord, textItemPayload, textRecord,
  stickyRecord, shapeRecordF9, eventsWithTitle, png1x1, minimalPdf, zipStore,
  UUID_A, UUID_B,
};
