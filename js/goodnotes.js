/* GoodNotes .goodnotes Import-Decoder (client-seitig, ohne Abhängigkeiten).
   Dekodierlogik portiert aus dem MIT-lizenzierten Parser:
   Kaih1825/parser-for-goodnotes (https://github.com/Kaih1825/parser-for-goodnotes)
   Copyright (c) 2025 Document Parser for GoodNotes contributors, MIT License.
   Abgedeckt: ZIP via GNZip, Protobuf-Wire, Apple-LZ4 (bv41), Troy-Hanson-TPL,
   Stroke-Punkte, Farben, Lasso-Offsets, Seiten, Bild-Elemente, Titel.
   v1-Limits: Shapes und getippte Textboxen werden gezählt, aber nicht importiert;
   PDF-Hintergründe werden erkannt und gemeldet (nicht gerastert). */
var GoodNotes = (function () {
  'use strict';

  /* ---------- Helpers ---------- */
  const td = new TextDecoder('utf-8');
  function bytesToStr(b) { try { return td.decode(b); } catch { return ''; } }
  function looksLikeUuid(s) {
    return typeof s === 'string' && s.length === 36 &&
      s[8] === '-' && s[13] === '-' && s[18] === '-' && s[23] === '-';
  }
  function u32ToF32(u) {
    const b = new ArrayBuffer(4); new DataView(b).setUint32(0, u >>> 0, true);
    return new DataView(b).getFloat32(0, true);
  }
  function findBytes(hay, needle, from) {
    const n = needle.length; from = from || 0;
    outer: for (let i = from; i + n <= hay.length; i++) {
      for (let j = 0; j < n; j++) if (hay[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }
  const BV41 = [0x62, 0x76, 0x34, 0x31]; // 'bv41'

  /* ---------- Protobuf Wire ---------- */
  function readVarint(d, pos) {
    let v = 0, s = 0;
    for (let k = 0; k < 10; k++) {
      if (pos >= d.length) throw new Error('varint abgeschnitten');
      const b = d[pos++];
      v += (b & 0x7f) * Math.pow(2, s); s += 7;
      if (!(b & 0x80)) return [v, pos];
    }
    throw new Error('varint zu lang');
  }
  // Field: {n, wt, v} – v: number (varint/fixed als uint) oder Uint8Array
  function decodeMessage(d) {
    const fields = [];
    let pos = 0;
    while (pos < d.length) {
      const start = pos;
      let key; [key, pos] = readVarint(d, pos);
      const n = Math.floor(key / 8), wt = key % 8;
      if (n === 0) throw new Error('field 0 ungültig');
      let v;
      if (wt === 0) { [v, pos] = readVarint(d, pos); }
      else if (wt === 1) {
        if (pos + 8 > d.length) throw new Error('fixed64 abgeschnitten');
        v = 0; for (let i = 0; i < 8; i++) v += d[pos + i] * Math.pow(2, 8 * i); pos += 8;
      } else if (wt === 5) {
        if (pos + 4 > d.length) throw new Error('fixed32 abgeschnitten');
        v = (d[pos] + d[pos + 1] * 256 + d[pos + 2] * 65536 + d[pos + 3] * 16777216) >>> 0; pos += 4;
      } else if (wt === 2) {
        let len; [len, pos] = readVarint(d, pos);
        if (pos + len > d.length) throw new Error('len-delim abgeschnitten');
        v = d.subarray(pos, pos + len); pos += len;
      } else throw new Error('wire-type ' + wt);
      fields.push({ n, wt, v, start });
    }
    return { fields };
  }
  function tryDecode(d) {
    if (!d || !d.length) return null;
    try { return decodeMessage(d); } catch { return null; }
  }
  function decodeDelimited(d) {
    const out = []; let pos = 0;
    while (pos < d.length) {
      let len; [len, pos] = readVarint(d, pos);
      if (pos + len > d.length) throw new Error('delimited record abgeschnitten');
      out.push(decodeMessage(d.subarray(pos, pos + len))); pos += len;
    }
    return out;
  }
  function byNumber(msg, n) { return msg.fields.filter(f => f.n === n); }
  function fixedFloat(f) {
    if (!f) return null;
    if (f.wt === 5) return u32ToF32(f.v);
    return null;
  }

  /* ---------- Apple LZ4 (bv41 / bv4- / bv4$) ---------- */
  function lz4Block(src, expected, dict) {
    const out = [];
    let pos = 0;
    const get = (i) => i < 0 ? dict[dict.length + i] : out[i];
    const histLen = () => dict.length + out.length;
    while (pos < src.length) {
      const token = src[pos++];
      let lit = token >> 4;
      if (lit === 15) { for (;;) { if (pos >= src.length) throw new Error('lz4 lit'); const e = src[pos++]; lit += e; if (e !== 255) break; } }
      if (pos + lit > src.length) throw new Error('lz4 lit bytes');
      for (let i = 0; i < lit; i++) out.push(src[pos++]);
      if (pos === src.length) break;
      if (pos + 2 > src.length) throw new Error('lz4 offset');
      const off = src[pos] + src[pos + 1] * 256; pos += 2;
      if (off === 0 || off > histLen()) throw new Error('lz4 offset range');
      let ml = token & 15;
      if (ml === 15) { for (;;) { if (pos >= src.length) throw new Error('lz4 ml'); const e = src[pos++]; ml += e; if (e !== 255) break; } }
      ml += 4;
      for (let i = 0; i < ml; i++) out.push(get(out.length - off));
    }
    if (out.length !== expected) throw new Error('lz4 size');
    return Uint8Array.from(out);
  }
  function decodeAppleLz4(data) {
    let out = [], pos = 0;
    const dv = new DataView(data.buffer, data.byteOffset, data.length);
    for (;;) {
      if (pos + 4 > data.length) throw new Error('lz4 endmarker');
      const magic = String.fromCharCode(data[pos], data[pos + 1], data[pos + 2], data[pos + 3]);
      pos += 4;
      if (magic === 'bv4$') return { bytes: Uint8Array.from(out), consumed: pos };
      if (magic !== 'bv41' && magic !== 'bv4-') throw new Error('lz4 magic ' + magic);
      if (pos + 8 > data.length) throw new Error('lz4 header');
      const usize = dv.getUint32(pos, true), ssize = dv.getUint32(pos + 4, true);
      pos += 8;
      if (pos + ssize > data.length) throw new Error('lz4 block');
      const block = data.subarray(pos, pos + ssize); pos += ssize;
      if (magic === 'bv4-') {
        if (block.length !== usize) throw new Error('lz4 stored size');
        for (const b of block) out.push(b);
      } else {
        const dec = lz4Block(block, usize, Uint8Array.from(out));
        for (const b of dec) out.push(b);
      }
    }
  }

  /* ---------- TPL ---------- */
  function parseTplFormat(fmt) {
    let pos = 0;
    function group(term) {
      const nodes = [];
      while (pos < fmt.length) {
        const t = fmt[pos++];
        if (t === ')') {
          if (!term) throw new Error('tpl ) unerwartet');
          return nodes;
        }
        if (t === 'A' || t === 'S') {
          if (fmt[pos] !== '(') throw new Error('tpl gruppe');
          pos++;
          nodes.push([t, group(')')]);
        } else if ('jviuIUcsfB'.includes(t)) nodes.push(t);
        else throw new Error('tpl token ' + t);
      }
      if (term) throw new Error('tpl gruppe offen');
      return nodes;
    }
    return group(null);
  }
  function decodeTpl(data) {
    if (data.length < 9 || data[0] !== 0x74 || data[1] !== 0x70 || data[2] !== 0x6c) throw new Error('kein tpl');
    const dv = new DataView(data.buffer, data.byteOffset, data.length);
    const flags = data[3];
    if (flags & 1) throw new Error('tpl big-endian');
    const size = dv.getUint32(4, true);
    if (size !== data.length) throw new Error('tpl size');
    let end = 8;
    while (end < data.length && data[end] !== 0) end++;
    if (end >= data.length) throw new Error('tpl format offen');
    const fmt = String.fromCharCode.apply(null, Array.from(data.subarray(8, end)));
    const nodes = parseTplFormat(fmt);
    let pos = end + 1;
    const take = (n) => { if (pos + n > data.length) throw new Error('tpl kurz'); const s = pos; pos += n; return s; };
    const U32 = () => dv.getUint32(take(4), true);
    function val(node) {
      if (Array.isArray(node)) {
        const [kind, kids] = node;
        if (kind === 'S') return kids.map(val);
        const count = U32();
        if (kids.length === 1) { const a = []; for (let i = 0; i < count; i++) a.push(val(kids[0])); return a; }
        const a = []; for (let i = 0; i < count; i++) a.push(kids.map(val)); return a;
      }
      if (node === 's') { const n = U32(); const b = data.subarray(take(Math.max(n - 1, 0)), pos); return bytesToStr(b); }
      if (node === 'B') { const n = U32(); const b = data.subarray(take(n), pos); return b; }
      const sizes = { c: 1, j: 2, v: 2, i: 4, u: 4, I: 8, U: 8, f: 8 };
      const o = take(sizes[node]);
      if (node === 'c') return dv.getInt8(o);
      if (node === 'j') return dv.getInt16(o, true);
      if (node === 'v') return dv.getUint16(o, true);
      if (node === 'i') return dv.getInt32(o, true);
      if (node === 'u') return dv.getUint32(o, true);
      if (node === 'I') return Number(dv.getBigInt64(o, true));
      if (node === 'U') return Number(dv.getBigUint64(o, true));
      return dv.getFloat64(o, true); // f
    }
    const values = nodes.map(val);
    if (pos !== data.length) throw new Error('tpl restbytes');
    return { format: fmt, values };
  }

  /* ---------- Stroke-Punkte (Port von extract_points_from_tpl) ---------- */
  function validCoord(v) { return v >= -5000 && v <= 5000 && !(Math.abs(v) > 0 && Math.abs(v) < 1e-6); }
  function validPress(p) { return p >= 0.001 && p <= 100; }
  function jitterRatio(pts) {
    if (pts.length < 3) return 0;
    let rev = 0, seg = 0, pdx = pts[1].x - pts[0].x, pdy = pts[1].y - pts[0].y;
    for (let i = 1; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
      const pl = Math.hypot(pdx, pdy), cl = Math.hypot(dx, dy);
      if (pl > 1e-6 && cl > 1e-6) { seg++; if ((pdx * dx + pdy * dy) / (pl * cl) < -0.3) rev++; }
      pdx = dx; pdy = dy;
    }
    return seg ? rev / seg : 0;
  }
  function F(u) { return typeof u === 'number' ? u32ToF32(u) : u; }

  function extractPoints(tpl) {
    const fmt = tpl.format, V = tpl.values;
    const groups = [];
    let defaultWidth = 1.0;
    const widthFromList = fmt.includes('A(S(');
    for (const v of V) {
      if (typeof v === 'number') { const w = u32ToF32(v); if (w >= 0.05 && w <= 100) { defaultWidth = w; break; } }
      else if (widthFromList && Array.isArray(v) && v.length > 1 && typeof v[1] === 'number') {
        const w = u32ToF32(v[1]); if (w >= 0.05 && w <= 100) { defaultWidth = w; break; }
      }
    }
    const R = defaultWidth / 2;

    // 0. radierte/segmentierte Strokes: values[4] flache 6-Tupel
    const isErased = V.length > 9 && Array.isArray(V[9]) && V[9].length > 0;
    if (isErased && V.length > 4 && Array.isArray(V[4]) && V[4].length >= 6) {
      const v4 = V[4];
      if (typeof v4[0] === 'number' && v4.length % 6 === 0 && !fmt.includes('A(S(')) {
        const fl = v4.map(F);
        if (fl.length >= 4 && fl.slice(0, 4).every(x => validCoord(x) && Math.abs(x) >= 10)) {
          const segs = [];
          for (let i = 0; i + 6 <= fl.length; i += 6) segs.push(fl.slice(i, i + 6));
          const rs = segs.map(s => s[4]).filter(r => r > 1).sort((a, b) => a - b);
          const nom = rs.length ? rs[Math.floor(rs.length / 2)] : 8.87;
          const mx = nom * 1.1;
          const cs = segs.map(s => [s[0], s[1], s[2], s[3], Math.min(mx, s[4]), Math.min(mx, s[5])]);
          const subs = []; let cur = [cs[0]];
          for (let i = 0; i < cs.length - 1; i++) {
            const a = cs[i], b = cs[i + 1];
            const sl = Math.hypot(a[2] - a[0], a[3] - a[1]);
            const gap = Math.hypot(b[0] - a[2], b[1] - a[3]);
            const ratio = gap / Math.max(1e-3, sl);
            if (gap > 30 || (gap > 18 && ratio > 2.2) || (gap > 12 && ratio > 3.5)) { subs.push(cur); cur = [b]; }
            else cur.push(b);
          }
          subs.push(cur);
          const out = [];
          for (const s of subs) {
            const raw = [[s[0][0], s[0][1], s[0][4]]];
            for (const q of s) raw.push([q[2], q[3], q[5]]);
            const clean = [raw[0]];
            for (let i = 1; i < raw.length; i++)
              if (Math.hypot(raw[i][0] - clean[clean.length - 1][0], raw[i][1] - clean[clean.length - 1][1]) >= 1.2) clean.push(raw[i]);
            if (clean.length >= 2) out.push(clean.map(p => ({ x: p[0], y: p[1], p: p[2] })));
          }
          if (out.length) return { groups: out, width: defaultWidth };
        }
      }
    }

    // 1. Schema 1: ...A(S(uuuu))... (4-Tupel)
    if (fmt.includes('A(S(uuuu))') && !fmt.includes('A(S(uuuuuuuuuuu')) {
      if (V.length > 4 && Array.isArray(V[4]) && V[4].length > 0) {
        const vis = (V.length > 2 && Array.isArray(V[2])) ? V[2] : [];
        const visOk = Array.isArray(vis) && vis.every(x => x === 0 || x === 1);
        let g = []; let seg = 0;
        if (V.length > 3 && Array.isArray(V[3])) {
          for (const pr of V[3]) {
            if (Array.isArray(pr) && pr.length >= 2) {
              const x0 = F(pr[0]), y0 = F(pr[1]);
              if (validCoord(x0) && validCoord(y0) && (!g.length || Math.hypot(x0 - g[g.length - 1].x, y0 - g[g.length - 1].y) >= 1e-3))
                g.push({ x: x0, y: y0, p: R });
            }
          }
        }
        for (const q of V[4]) {
          seg++;
          if (!(Array.isArray(q) && q.length >= 4)) continue;
          if (visOk && seg < vis.length && vis[seg] === 0 && g.length) { groups.push(g); g = []; }
          const x1 = F(q[0]), y1 = F(q[1]), x2 = F(q[2]), y2 = F(q[3]);
          if (validCoord(x1) && validCoord(y1) && (!g.length || Math.hypot(x1 - g[g.length - 1].x, y1 - g[g.length - 1].y) >= 1e-3))
            g.push({ x: x1, y: y1, p: R });
          if (validCoord(x2) && validCoord(y2) && (!g.length || Math.hypot(x2 - g[g.length - 1].x, y2 - g[g.length - 1].y) >= 1e-3))
            g.push({ x: x2, y: y2, p: R });
        }
        if (g.length) groups.push(g);
        const vg = groups.filter(x => x.length >= 2);
        if (vg.length) return { groups: vg, width: defaultWidth };
      }
      if (V.length > 3 && Array.isArray(V[3]) && V[3].length > 0) {
        const g = [];
        for (const pr of V[3]) {
          if (Array.isArray(pr) && pr.length >= 2) {
            const x = F(pr[0]), y = F(pr[1]);
            if (validCoord(x) && validCoord(y) && (!g.length || Math.hypot(x - g[g.length - 1].x, y - g[g.length - 1].y) >= 1e-3))
              g.push({ x, y, p: R });
          }
        }
        if (g.length >= 2) return { groups: [g], width: defaultWidth };
      }
    }

    // 2. Schema 2: ...A(S(uuuuuuuuuuu... (11-Tupel)
    if (fmt.includes('A(S(uuuuuuuuuuu')) {
      if (V.length > 4 && Array.isArray(V[4]) && V[4].length > 0) {
        const g = [];
        if (V.length > 3 && Array.isArray(V[3]) && V[3].length > 0) {
          for (const p5 of V[3]) {
            if (Array.isArray(p5) && p5.length >= 5) {
              const x0 = F(p5[0]), y0 = F(p5[1]);
              let p0 = F(p5[4]); if (!validPress(p0)) p0 = R;
              if (validCoord(x0) && validCoord(y0) && (!g.length || Math.hypot(x0 - g[g.length - 1].x, y0 - g[g.length - 1].y) >= 1e-3))
                g.push({ x: x0, y: y0, p: p0 });
            }
          }
        }
        for (const p11 of V[4]) {
          if (Array.isArray(p11) && p11.length >= 11) {
            const x1 = F(p11[1]), y1 = F(p11[2]);
            const x2 = F(p11[6]), y2 = F(p11[7]);
            let p1 = F(p11[5]); if (!validPress(p1)) p1 = R;
            let p2 = F(p11[10]); if (!validPress(p2)) p2 = R;
            if (validCoord(x1) && validCoord(y1) && (!g.length || Math.hypot(x1 - g[g.length - 1].x, y1 - g[g.length - 1].y) >= 1e-3))
              g.push({ x: x1, y: y1, p: p1 });
            if (validCoord(x2) && validCoord(y2) && (!g.length || Math.hypot(x2 - g[g.length - 1].x, y2 - g[g.length - 1].y) >= 1e-3))
              g.push({ x: x2, y: y2, p: p2 });
          }
        }
        if (g.length >= 2) return { groups: [g], width: defaultWidth };
      }
    }

    // 3. Kandidaten: flache Arrays (3er / 5er / 2er)
    const cands = [];
    const flat = (v) => Array.isArray(v) && v.length && typeof v[0] === 'number';
    V.forEach((v, idx) => {
      if (idx > 5 || !flat(v)) return;
      if (v.length >= 3 && v.length % 3 === 0) {
        const ps = []; let ok = true;
        for (let k = 0; k < v.length; k += 3) {
          const x = F(v[k]), y = F(v[k + 1]), p = F(v[k + 2]);
          if (!(validCoord(x) && validCoord(y) && validPress(p))) { ok = false; break; }
          if (!ps.length || Math.hypot(x - ps[ps.length - 1].x, y - ps[ps.length - 1].y) >= 1e-3) ps.push({ x, y, p });
        }
        if (ok && ps.length) cands.push({ hp: 1, n: ps.length, idx, ps });
      }
      if (v.length >= 5 && v.length % 5 === 0) {
        const ps = []; let ok = true;
        for (let k = 0; k < v.length; k += 5) {
          const x = F(v[k]), y = F(v[k + 1]), p = F(v[k + 2]);
          if (!(validCoord(x) && validCoord(y) && validPress(p))) { ok = false; break; }
          if (!ps.length || Math.hypot(x - ps[ps.length - 1].x, y - ps[ps.length - 1].y) >= 1e-3) ps.push({ x, y, p });
        }
        if (ok && ps.length) cands.push({ hp: 1, n: ps.length, idx, ps });
      }
      if (v.length >= 2 && v.length % 2 === 0) {
        const ps = []; let ok = true;
        for (let k = 0; k < v.length; k += 2) {
          const x = F(v[k]), y = F(v[k + 1]);
          if (!(validCoord(x) && validCoord(y))) { ok = false; break; }
          if (!ps.length || Math.hypot(x - ps[ps.length - 1].x, y - ps[ps.length - 1].y) >= 1e-3) ps.push({ x, y, p: R });
        }
        if (ok && ps.length) cands.push({ hp: 0, n: ps.length, idx, ps });
      }
    });
    if (cands.length) {
      const multi = cands.filter(c => c.n >= 2);
      const pool = multi.length ? multi : cands;
      const plaus = pool.filter(c => jitterRatio(c.ps) <= 0.35);
      const tgt = plaus.length ? plaus : pool;
      tgt.sort((a, b) => (b.hp - a.hp) || (b.n - a.n) || (jitterRatio(a.ps) - jitterRatio(b.ps)) || (a.idx - b.idx));
      let best = tgt[0].ps;
      const normal = best.filter(p => !(p.x < 10 && p.y < 10));
      if (normal.length >= 1) best = normal;
      groups.push(best);
      return { groups, width: defaultWidth };
    }
    return { groups, width: defaultWidth };
  }

  function splitChains(pts, th) {
    if (!pts.length) return [];
    if (pts.length < 2) return [pts];
    th = th == null ? 300 : th;
    const out = []; let cur = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      if (Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) > th) { out.push(cur); cur = [pts[i]]; }
      else cur.push(pts[i]);
    }
    out.push(cur);
    return out;
  }

  /* ---------- Trailer: Farbe + Lasso-Offset ---------- */
  function trailerColor(t) {
    if (!t || !t.length) return ['#000000', 1];
    try {
      const msg = decodeMessage(t);
      for (const f of msg.fields) {
        if (f.n === 4 && f.v instanceof Uint8Array) {
          const cm = decodeMessage(f.v);
          const g = (n) => { const a = byNumber(cm, n); return a.length ? fixedFloat(a[0]) : null; };
          let r = g(1) || 0, gg = g(2) || 0, b = g(3) || 0;
          const al = byNumber(cm, 4);
          const a = al.length && fixedFloat(al[0]) != null ? fixedFloat(al[0]) : 1;
          const hx = (v) => Math.min(255, Math.max(0, Math.round(v * 255))).toString(16).padStart(2, '0');
          return ['#' + hx(r) + hx(gg) + hx(b), a];
        }
      }
    } catch { /* ignore */ }
    return ['#000000', 1];
  }
  function trailerOffset(t) {
    if (!t || !t.length) return [0, 0];
    try {
      const msg = decodeMessage(t);
      for (const f of msg.fields) {
        if (f.n === 6 && f.v instanceof Uint8Array && f.v.length) {
          const om = decodeMessage(f.v);
          const dx = byNumber(om, 1), dy = byNumber(om, 2);
          return [(dx.length ? fixedFloat(dx[0]) : 0) || 0, (dy.length ? fixedFloat(dy[0]) : 0) || 0];
        }
      }
    } catch { /* ignore */ }
    return [0, 0];
  }

  function parseStrokeField(uuid, fieldData) {
    const pos = findBytes(fieldData, BV41, 0);
    if (pos < 0) return [];
    let lz;
    try { lz = decodeAppleLz4(fieldData.subarray(pos)); } catch { return []; }
    if (lz.bytes[0] !== 0x74 || lz.bytes[1] !== 0x70 || lz.bytes[2] !== 0x6c) return [];
    let tpl;
    try { tpl = decodeTpl(lz.bytes); } catch { return []; }
    const { groups, width } = extractPoints(tpl);
    if (!groups.length) return [];
    const trailer = fieldData.subarray(pos + lz.consumed);
    const [color, alpha] = trailerColor(trailer);
    const [dx, dy] = trailerOffset(trailer);
    if (dx || dy) groups.forEach(g => g.forEach(p => { p.x += dx; p.y += dy; }));
    const hl = alpha < 0.95;
    const out = [];
    for (const g of groups)
      for (const ch of splitChains(g, 300))
        if (ch.length) out.push({ uuid, points: ch, color, alpha, width, highlighter: hl, dot: ch.length === 1, format: tpl.format });
    return out;
  }

  /* ---------- Bild-Elemente (Port von parse_image_elements) ---------- */
  function parseImageElements(records) {
    const imgs = [];
    records.forEach((rec, i) => {
      let att = null;
      for (const fn of [7, 4]) {
        const fs = byNumber(rec, fn);
        if (fs.length && fs[0].v instanceof Uint8Array) {
          const s = bytesToStr(fs[0].v);
          if (looksLikeUuid(s)) { att = s; break; }
        }
      }
      if (!att) return;
      const f3 = byNumber(rec, 3);
      if (f3.length && !(f3[0].v instanceof Uint8Array) && f3[0].v === 1) return; // Tombstone
      let recUuid = '';
      const f1 = byNumber(rec, 1);
      if (f1.length && f1[0].v instanceof Uint8Array) {
        const s = bytesToStr(f1[0].v);
        if (looksLikeUuid(s)) recUuid = s;
      }
      let ox = 0, oy = 0, ow = 0, oh = 0, rot = 0, cx = 0, cy = 0, cw = 0, ch = 0, crop = false, found = false;
      const candRecs = [rec].concat(i + 1 < records.length ? [records[i + 1]] : []);
      outer: for (const cand of candRecs) {
        for (const f of cand.fields) {
          if (!(f.v instanceof Uint8Array)) continue;
          const msg = tryDecode(f.v);
          if (!msg) continue;
          const m2 = byNumber(msg, 2), m3 = byNumber(msg, 3);
          if (m2.length && m2[0].v instanceof Uint8Array) {
            const mm = tryDecode(m2[0].v);
            if (mm) {
              const a1 = byNumber(mm, 1), a2 = byNumber(mm, 2);
              // orig box: m2.f1 = xy-Msg, m2.f2 = wh-Msg
              if (a1.length && a1[0].v instanceof Uint8Array) {
                const mx = tryDecode(a1[0].v);
                if (mx) { const X = byNumber(mx, 1), Y = byNumber(mx, 2); if (X.length && Y.length) { ox = fixedFloat(X[0]) || 0; oy = fixedFloat(Y[0]) || 0; } }
              }
              if (a2.length && a2[0].v instanceof Uint8Array) {
                const mw = tryDecode(a2[0].v);
                if (mw) { const W = byNumber(mw, 1), H = byNumber(mw, 2); if (W.length && H.length) { ow = fixedFloat(W[0]) || 0; oh = fixedFloat(H[0]) || 0; found = true; } }
              }
            }
          }
          if (m3.length && m3[0].v instanceof Uint8Array) {
            const m = tryDecode(m3[0].v);
            if (m) {
              const c1 = byNumber(m, 1), c2 = byNumber(m, 2), c3 = byNumber(m, 3);
              if (c1.length && c1[0].v instanceof Uint8Array) {
                const mc = tryDecode(c1[0].v);
                if (mc) { const X = byNumber(mc, 1), Y = byNumber(mc, 2); if (X.length && Y.length) { cx = fixedFloat(X[0]) || 0; cy = fixedFloat(Y[0]) || 0; } }
              }
              if (c2.length && c2[0].v instanceof Uint8Array) {
                const mc = tryDecode(c2[0].v);
                if (mc) { const W = byNumber(mc, 1), H = byNumber(mc, 2); if (W.length && H.length) { cw = fixedFloat(W[0]) || 0; ch = fixedFloat(H[0]) || 0; crop = true; } }
              }
              if (c3.length && fixedFloat(c3[0]) != null) rot = fixedFloat(c3[0]);
            }
          }
          if (found) break outer;
        }
      }
      let fx, fy, fw, fh;
      if (crop && cw > 0 && ch > 0) {
        fw = cw; fh = ch;
        fx = cx > 0 ? cx - cw / 2 : ox;
        fy = cy > 0 ? cy - ch / 2 : oy;
      } else { fx = ox; fy = oy; fw = ow; fh = oh; }
      if (fw > 0 && fh > 0) imgs.push({ uuid: recUuid || att, attachment: att, x: fx, y: fy, w: fw, h: fh, rot });
    });
    return imgs;
  }

  /* ---------- Dokument: Seiten, Titel, Maße ---------- */
  function pdfMediaBox(pdfBytes) {
    const s = Array.from(pdfBytes.subarray(0, Math.min(pdfBytes.length, 200000)))
      .map(c => String.fromCharCode(c)).join('');
    const m = /\/MediaBox\s*\[\s*([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)\s*\]/.exec(s);
    if (m) {
      const w = Math.abs(+m[3] - +m[1]), h = Math.abs(+m[4] - +m[2]);
      if (w > 0 && h > 0) return { w, h };
    }
    return null;
  }
  function guessTitle(members) {
    try {
      if (!members['index.events.pb']) return null;
      const recs = decodeDelimited(members['index.events.pb']);
      const seenSingle = [];
      const visit = (msg, depth) => {
        const ones = byNumber(msg, 1).filter(x => x.v instanceof Uint8Array).map(x => bytesToStr(x.v));
        if (ones.length >= 2 && ones.some(looksLikeUuid)) {
          const t = ones.find(s => !looksLikeUuid(s) && s.length >= 1 && s.length <= 120);
          if (t) return t;
        }
        if (ones.length === 1 && !looksLikeUuid(ones[0]) && ones[0].length >= 2 && ones[0].length <= 120 &&
            /^[\x20-\x7e]+$/.test(ones[0]) && /[A-Za-z0-9]/.test(ones[0])) seenSingle.push(ones[0]);
        if (depth >= 3) return null;
        for (const f of msg.fields) {
          if (!(f.v instanceof Uint8Array)) continue;
          const m = tryDecode(f.v);
          if (!m) continue;
          const t = visit(m, depth + 1);
          if (t) return t;
        }
        return null;
      };
      for (const rec of recs.slice(0, 3)) {
        const t = visit(rec, 0);
        if (t) return t;
      }
      const best = seenSingle.find(s => s.length >= 4) || seenSingle[0];
      if (best) return best;
    } catch { /* ignore */ }
    return null;
  }

  function parseDocument(members, fallbackName) {
    // Seiten-Einträge
    let entries = [];
    try {
      if (members['index.notes.pb']) {
        for (const rec of decodeDelimited(members['index.notes.pb'])) {
          let pu = '', pp = '';
          for (const f of rec.fields) {
            if (!(f.v instanceof Uint8Array)) continue;
            const s = bytesToStr(f.v);
            if (s.startsWith('notes/')) pp = s;
            else if (looksLikeUuid(s)) pu = s;
          }
          if (pp && members[pp]) entries.push({ uuid: pu || pp.replace('notes/', ''), path: pp });
        }
      }
    } catch { /* ignore */ }
    if (!entries.length)
      entries = Object.keys(members).filter(k => k.startsWith('notes/')).sort()
        .map(k => ({ uuid: k.replace('notes/', ''), path: k }));

    const title = guessTitle(members) || fallbackName || 'GoodNotes-Import';
    const pages = [];
    let skippedShapes = 0, pdfBg = false, imgCount = 0;

    for (const e of entries) {
      let records;
      try { records = decodeDelimited(members[e.path]); }
      catch { continue; }

      // Metadaten: UUID -> radiert?
      const erased = {};
      for (const rec of records) {
        const f1 = byNumber(rec, 1);
        if (f1.length && f1[0].v instanceof Uint8Array) {
          const s = bytesToStr(f1[0].v);
          if (looksLikeUuid(s)) {
            const f3 = byNumber(rec, 3);
            erased[s] = !!(f3.length && !(f3[0].v instanceof Uint8Array) && f3[0].v === 1);
          }
        }
      }

      // Strokes
      const strokes = [];
      const seen = new Set();
      records.forEach((rec, ri) => {
        const f1 = byNumber(rec, 1);
        let recUuid = 'r' + ri;
        if (f1.length && f1[0].v instanceof Uint8Array) {
          const s = bytesToStr(f1[0].v);
          if (looksLikeUuid(s)) recUuid = s;
        }
        const handle = (val, sub) => {
          let su = recUuid + sub;
          if (val.length >= 38 && val[0] === 10 && val[1] === 36) {
            const s = bytesToStr(val.subarray(2, 38));
            if (looksLikeUuid(s)) su = s;
          }
          if (seen.has(su)) return;
          seen.add(su);
          if (erased[su]) return;
          try {
            const ss = parseStrokeField(su, val);
            for (const s of ss) strokes.push(s);
          } catch { /* ignore */ }
        };
        rec.fields.forEach((f, fi) => {
          if (f.v instanceof Uint8Array && findBytes(f.v, BV41, 0) >= 0) handle(f.v, '_' + fi);
        });
        const f7 = byNumber(rec, 7);
        if (f7.length && f7[0].v instanceof Uint8Array && findBytes(f7[0].v, BV41, 0) < 0) {
          const sub = tryDecode(f7[0].v);
          if (sub) sub.fields.forEach((sf, sfi) => {
            if (sf.v instanceof Uint8Array && findBytes(sf.v, BV41, 0) >= 0) handle(sf.v, '_7_' + sfi);
          });
        }
        // Shapes zählen (Typ 31/35-Geometrie), v1: nicht importiert
        const f21 = byNumber(rec, 21), f22 = byNumber(rec, 22);
        if ((f21.length && f21[0].v instanceof Uint8Array) || (f22.length && f22[0].v instanceof Uint8Array)) {
          // grob: Datensätze mit Geometrie-Payload, die kein Stroke sind
          const hasInk = rec.fields.some(f => f.v instanceof Uint8Array && findBytes(f.v, BV41, 0) >= 0);
          if (!hasInk) skippedShapes++;
        }
      });

      // Bilder
      const imgEls = parseImageElements(records);
      const images = [];
      for (const ie of imgEls) {
        const attPath = 'attachments/' + ie.attachment;
        const bytes = members[attPath];
        if (!bytes) continue;
        let mime = null;
        if (bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50) mime = 'image/png';
        else if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) mime = 'image/jpeg';
        else if (bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50) { pdfBg = true; continue; }
        if (!mime) continue;
        imgCount++;
        images.push({ ie, bytes, mime });
      }
      // PDF-Hintergrund generell erkennen
      if (!pdfBg) {
        for (const k of Object.keys(members)) {
          if (k.startsWith('attachments/') && members[k].length > 5 &&
            members[k][0] === 0x25 && members[k][1] === 0x50) { pdfBg = true; break; }
        }
      }

      // Maße: PDF-MediaBox oder Letter-Default (pt @72dpi)
      let dim = { w: 612, h: 792 };
      for (const k of Object.keys(members)) {
        if (k.startsWith('attachments/') && members[k].length > 5 &&
          members[k][0] === 0x25 && members[k][1] === 0x50) {
          const mb = pdfMediaBox(members[k]);
          if (mb) { dim = mb; break; }
        }
      }
      pages.push({ uuid: e.uuid, strokes, images, dim });
    }
    return { title, pages, stats: { skippedShapes, pdfBg, imgCount } };
  }

  /* ---------- Mapping auf Grimoire-Modell (Canvas 1000×1294) ---------- */
  const CW = 1000, CH = 1294, DPI = 132 / 72;
  function mapPage(pg) {
    const iw = pg.dim.w * DPI, ih = pg.dim.h * DPI;
    const sc = CW / iw;
    const offY = (CH - ih * sc) / 2;
    const wsc = CW / pg.dim.w;
    const strokes = [];
    for (const s of pg.strokes) {
      if (!s.points.length) continue;
      const pts = s.points.map(p => ({
        x: Math.round((p.x * sc) * 10) / 10,
        y: Math.round((p.y * sc + offY) * 10) / 10
      }));
      strokes.push({
        tool: s.highlighter ? 'marker' : 'pen',
        color: s.color,
        size: Math.max(0.5, Math.round(s.width * wsc * 100) / 100),
        points: pts
      });
    }
    return { strokes, dim: pg.dim, scale: sc, offY };
  }

  return {
    parseDocument, mapPage,
    _internals: { decodeMessage, decodeDelimited, decodeTpl, decodeAppleLz4, extractPoints, parseStrokeField, parseImageElements }
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = GoodNotes;
