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
  /* Lokaler stripHtml-Fallback (app.js definiert global eins mit DOM;
     für Node-Tests ohne document Tags per Regex entfernen). */
  function stripHtml(h) {
    const s = String(h == null ? '' : h);
    if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
      try {
        const d = document.createElement('div');
        d.innerHTML = s;
        const t = d.textContent;
        if (typeof t === 'string') return t;
      } catch { /* fall through to regex */ }
    }
    return s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(p|div|h[1-6]|li|ul|ol|tr)[^>]*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }

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

  /* ---------- Shapes (Port von shape.py) ---------- */
  function shapeFixedOf(msg, n) { const a = byNumber(msg, n); return a.length ? fixedFloat(a[0]) : null; }
  function shapeExtractPoint(msg) {
    const fs = msg.fields.slice().sort((a, b) => a.n - b.n);
    const vals = [];
    for (const f of fs) { const v = fixedFloat(f); if (v != null) vals.push(v); }
    return vals.length >= 2 ? [vals[0], vals[1]] : null;
  }
  function shapeGetPoint(msg) {
    let pt = shapeExtractPoint(msg);
    if (pt) return pt;
    const fs = msg.fields.slice().sort((a, b) => a.n - b.n);
    for (const f of fs) {
      if (!(f.v instanceof Uint8Array)) continue;
      const sub = tryDecode(f.v);
      if (sub) { pt = shapeExtractPoint(sub); if (pt) return pt; }
    }
    return null;
  }
  function parseCurves(container) {
    const dict = {};
    for (const f of container.fields) {
      if (!(f.v instanceof Uint8Array)) continue;
      const sub = tryDecode(f.v);
      if (sub) { const pt = shapeGetPoint(sub); if (pt) dict[f.n] = pt; }
    }
    const bez = (p0, c1, c2, pe, cubic) => {
      const r = [];
      for (let j = 1; j < 30; j++) {
        const t = j / 30, u = 1 - t;
        if (!cubic) r.push([u * u * p0[0] + 2 * u * t * c1[0] + t * t * pe[0], u * u * p0[1] + 2 * u * t * c1[1] + t * t * pe[1]]);
        else r.push([u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * pe[0], u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * pe[1]]);
      }
      return r;
    };
    if (dict[1] && dict[2] && (dict[3] || dict[4])) {
      const pts = [dict[1]], p0 = dict[1];
      if (dict[3] && !dict[4]) bez(p0, dict[2], null, dict[3], false).forEach(p => pts.push(p));
      else if (dict[3] && dict[4]) bez(p0, dict[2], dict[3], dict[4], true).forEach(p => pts.push(p));
      else pts.push(dict[2]);
      return pts;
    }
    const cmds = [];
    for (const f of container.fields) {
      if (!(f.v instanceof Uint8Array)) continue;
      const item = tryDecode(f.v);
      if (!item) continue;
      let cmd = f.n;
      if (item.fields.length && [1, 2, 3, 4, 5].includes(item.fields[0].n)) cmd = item.fields[0].n;
      const pt = shapeGetPoint(item);
      if (pt) cmds.push([cmd, pt]);
    }
    const pts = [];
    let i = 0;
    while (i < cmds.length) {
      const cmd = cmds[i][0], pt = cmds[i][1];
      if (cmd === 3 && i + 1 < cmds.length) {
        const p0 = pts.length ? pts[pts.length - 1] : pt;
        bez(p0, pt, null, cmds[i + 1][1], false).forEach(p => pts.push(p));
        i += 2; continue;
      }
      if (cmd === 4 && i + 2 < cmds.length) {
        const p0 = pts.length ? pts[pts.length - 1] : pt;
        bez(p0, pt, cmds[i + 1][1], cmds[i + 2][1], true).forEach(p => pts.push(p));
        i += 3; continue;
      }
      pts.push(pt); i++;
    }
    return pts;
  }
  function shapeUuid(msg) {
    const a = byNumber(msg, 1);
    if (a.length && a[0].v instanceof Uint8Array) {
      const s = bytesToStr(a[0].v);
      if (looksLikeUuid(s)) return s;
    }
    return null;
  }
  function shapeRgb(m) {
    const g = (n) => { const a = byNumber(m, n); return a.length ? fixedFloat(a[0]) : null; };
    const hx = (v) => Math.min(255, Math.max(0, Math.round((v || 0) * 255))).toString(16).padStart(2, '0');
    const r = g(1), gg = g(2), b = g(3), a = g(4);
    return { color: '#' + hx(r) + hx(gg) + hx(b), alpha: a == null ? 1 : a };
  }
  function shapeMoveOffset(msg) {
    for (const fn of [14, 6]) {
      const f = byNumber(msg, fn);
      if (f.length && f[0].v instanceof Uint8Array && f[0].v.length) {
        try {
          const om = decodeMessage(f[0].v);
          const dx = shapeFixedOf(om, 1), dy = shapeFixedOf(om, 2);
          if (dx != null || dy != null) return [dx || 0, dy || 0];
        } catch { /* ignore */ }
      }
    }
    return [0, 0];
  }
  function type31Shape(msg) {
    const uuid = shapeUuid(msg);
    const vi = (n) => { const a = byNumber(msg, n); return (a.length && !(a[0].v instanceof Uint8Array)) ? a[0].v : 0; };
    let pts = [];
    const f21 = byNumber(msg, 21);
    if (f21.length && f21[0].v instanceof Uint8Array) {
      const m21 = tryDecode(f21[0].v);
      if (m21) pts = parseCurves(m21);
    }
    if (!pts.length) {
      const f20 = byNumber(msg, 20);
      if (f20.length && f20[0].v instanceof Uint8Array) {
        const m20 = tryDecode(f20[0].v);
        if (m20) for (const sf of byNumber(m20, 2)) {
          if (!(sf.v instanceof Uint8Array)) continue;
          const mp = tryDecode(sf.v);
          if (mp && byNumber(mp, 1).length && byNumber(mp, 2).length) {
            const fx = fixedFloat(byNumber(mp, 1)[0]), fy = fixedFloat(byNumber(mp, 2)[0]);
            if (fx != null && fy != null) pts.push([fx, fy]);
          }
        }
      }
    }
    if (!pts.length) return null;
    let width = 1, color = '#1e1b1b', dash = null;
    const f32 = byNumber(msg, 32);
    if (f32.length && f32[0].v instanceof Uint8Array) {
      const m32 = tryDecode(f32[0].v);
      if (m32) {
        if (byNumber(m32, 1).length) width = fixedFloat(byNumber(m32, 1)[0]) || 1;
        const d2 = byNumber(m32, 2);
        if (d2.length && d2[0].v instanceof Uint8Array) {
          const m2 = tryDecode(d2[0].v);
          if (m2 && byNumber(m2, 2).length && byNumber(m2, 2)[0].v instanceof Uint8Array) {
            const md = tryDecode(byNumber(m2, 2)[0].v);
            if (md) {
              const dv = md.fields.map(f => fixedFloat(f)).filter(v => v != null);
              if (dv.length) dash = dv;
            }
          }
        }
        const c3 = byNumber(m32, 3);
        if (c3.length && c3[0].v instanceof Uint8Array) {
          const mc = tryDecode(c3[0].v);
          if (mc && byNumber(mc, 1).length && byNumber(mc, 1)[0].v instanceof Uint8Array) {
            const mrgb = tryDecode(byNumber(mc, 1)[0].v);
            if (mrgb) color = shapeRgb(mrgb).color;
          }
        }
      }
    }
    const [dx, dy] = shapeMoveOffset(msg);
    if (dx || dy) pts = pts.map(p => [p[0] + dx, p[1] + dy]);
    return { uuid, points: pts, width, color, alpha: 1, fill: null, fillAlpha: 0, type: 'polyline', dash, closed: false };
  }
  function type35Shape(msg) {
    const uuid = shapeUuid(msg);
    let px = 0, py = 0;
    const f20 = byNumber(msg, 20);
    if (f20.length && f20[0].v instanceof Uint8Array) {
      const m20 = tryDecode(f20[0].v);
      if (m20 && byNumber(m20, 1).length && byNumber(m20, 1)[0].v instanceof Uint8Array) {
        const mp = tryDecode(byNumber(m20, 1)[0].v);
        if (mp) { px = fixedFloat(byNumber(mp, 1)[0]) || 0; py = fixedFloat(byNumber(mp, 2)[0]) || 0; }
      }
    }
    let w = 0, h = 0;
    const f21s = byNumber(msg, 21);
    if (f21s.length && f21s[0].v instanceof Uint8Array) {
      const m21 = tryDecode(f21s[0].v);
      if (m21 && byNumber(m21, 2).length && byNumber(m21, 2)[0].v instanceof Uint8Array) {
        const ms = tryDecode(byNumber(m21, 2)[0].v);
        if (ms) { w = fixedFloat(byNumber(ms, 1)[0]) || 0; h = fixedFloat(byNumber(ms, 2)[0]) || 0; }
      }
    }
    if (!(w > 0 && h > 0)) return null;
    let color = '#1e1b1b', fillAlpha = 0;
    const f30 = byNumber(msg, 30);
    if (f30.length && f30[0].v instanceof Uint8Array) {
      const m30 = tryDecode(f30[0].v);
      if (m30 && byNumber(m30, 1).length && byNumber(m30, 1)[0].v instanceof Uint8Array) {
        const mc = tryDecode(byNumber(m30, 1)[0].v);
        if (mc && byNumber(mc, 1).length && byNumber(mc, 1)[0].v instanceof Uint8Array) {
          const mrgb = tryDecode(byNumber(mc, 1)[0].v);
          if (mrgb) {
            const c = shapeRgb(mrgb);
            color = c.color;
            fillAlpha = Math.max(0, Math.min(1, c.alpha));
          }
        }
      }
    }
    let width = 1, alpha = 1, dash = null;
    const f31 = byNumber(msg, 31);
    if (f31.length && f31[0].v instanceof Uint8Array) {
      const m31 = tryDecode(f31[0].v);
      if (m31) {
        if (byNumber(m31, 1).length) width = fixedFloat(byNumber(m31, 1)[0]) || 1;
        const d2 = byNumber(m31, 2);
        if (d2.length && d2[0].v instanceof Uint8Array) {
          const m2 = tryDecode(d2[0].v);
          if (m2 && byNumber(m2, 2).length && byNumber(m2, 2)[0].v instanceof Uint8Array) {
            const md = tryDecode(byNumber(m2, 2)[0].v);
            if (md) {
              const dv = md.fields.map(f => fixedFloat(f)).filter(v => v != null);
              if (dv.length) dash = dv;
            }
          }
        }
        const c3 = byNumber(m31, 3);
        if (c3.length && c3[0].v instanceof Uint8Array) {
          const m3 = tryDecode(c3[0].v);
          if (m3 && byNumber(m3, 1).length && byNumber(m3, 1)[0].v instanceof Uint8Array) {
            const m1 = tryDecode(byNumber(m3, 1)[0].v);
            if (m1 && byNumber(m1, 4).length) {
              const av = fixedFloat(byNumber(m1, 4)[0]);
              if (av != null) alpha = Math.max(0, Math.min(1, av));
            }
          }
        }
      }
    }
    let type = 'rectangle', norm = [];
    const f22 = byNumber(msg, 22);
    if (f22.length && f22[0].v instanceof Uint8Array) {
      const m22 = tryDecode(f22[0].v);
      if (m22) {
        const g3 = byNumber(m22, 3);
        if (g3.length && g3[0].v instanceof Uint8Array) {
          const m3 = tryDecode(g3[0].v);
          if (m3 && byNumber(m3, 1).length && byNumber(m3, 1)[0].v instanceof Uint8Array) {
            const m1 = tryDecode(byNumber(m3, 1)[0].v);
            if (m1) for (const item of byNumber(m1, 1)) {
              if (!(item.v instanceof Uint8Array)) continue;
              const mp = tryDecode(item.v);
              if (!mp) continue;
              const fi = byNumber(mp, 1);
              if (fi.length && fi[0].v instanceof Uint8Array) {
                const mxy = tryDecode(fi[0].v);
                if (mxy && byNumber(mxy, 1).length && byNumber(mxy, 2).length)
                  norm.push([fixedFloat(byNumber(mxy, 1)[0]) || 0, fixedFloat(byNumber(mxy, 2)[0]) || 0]);
              }
            }
          }
          if (norm.length) type = 'polygon';
        } else if (byNumber(m22, 2).length) type = 'ellipse';
        else if (byNumber(m22, 1).length && byNumber(m22, 1)[0].v instanceof Uint8Array) {
          const m1 = tryDecode(byNumber(m22, 1)[0].v);
          const rv = (m1 && byNumber(m1, 1).length) ? (fixedFloat(byNumber(m1, 1)[0]) || 0) : 0;
          type = rv >= 50 ? 'capsule' : 'rectangle';
        }
      }
    }
    const cx = px + w / 2, cy = py + h / 2, rx = w / 2, ry = h / 2;
    let pts;
    if (type === 'ellipse') {
      pts = [];
      for (let i = 0; i < 144; i++) {
        const t = 2 * Math.PI * i / 144;
        pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
      }
      pts.push(pts[0].slice());
    } else if (type === 'polygon' && norm.length) {
      pts = norm.map(n => [px + n[0] * w, py + n[1] * h]);
      pts.push(pts[0].slice());
    } else {
      pts = [[px, py], [px + w, py], [px + w, py + h], [px, py + h], [px, py]];
      if (type !== 'capsule') type = 'rectangle';
    }
    const [dx, dy] = shapeMoveOffset(msg);
    if (dx || dy) pts = pts.map(p => [p[0] + dx, p[1] + dy]);
    const filled = fillAlpha > 0;
    return { uuid, points: pts, width, color, alpha, fill: filled ? color : null, fillAlpha, type, dash, closed: true };
  }
  function geometryFromField9(m) {
    const geom = { points: [], type: 'polygon', cx: null, cy: null, rx: null, ry: null, rot: 0 };
    const cont = byNumber(m, 1).concat(byNumber(m, 2));
    if (cont.length && cont[0].v instanceof Uint8Array) {
      const c = tryDecode(cont[0].v);
      if (c) {
        const pts = parseCurves(c);
        if (pts.length >= 2) { geom.points = pts; return geom; }
      }
    }
    const f4 = byNumber(m, 4);
    if (f4.length && f4[0].v instanceof Uint8Array) {
      try {
        const sub = decodeMessage(f4[0].v);
        const c1 = byNumber(sub, 1), c2 = byNumber(sub, 2), c3 = byNumber(sub, 3);
        if (c1.length && c2.length && c1[0].v instanceof Uint8Array && c2[0].v instanceof Uint8Array) {
          const m1 = tryDecode(c1[0].v), m2 = tryDecode(c2[0].v);
          const ce = m1 && shapeExtractPoint(m1), ra = m2 && shapeExtractPoint(m2);
          if (ce && ra) {
            geom.cx = ce[0]; geom.cy = ce[1]; geom.rx = ra[0]; geom.ry = ra[1];
            if (c3.length) geom.rot = fixedFloat(c3[0]) || 0;
            geom.type = 'ellipse';
            const pts = [], N = 144, cr = Math.cos(geom.rot), sr = Math.sin(geom.rot);
            for (let i = 0; i < N; i++) {
              const t = 2 * Math.PI * i / N, ct = Math.cos(t), st = Math.sin(t);
              pts.push([geom.cx + geom.rx * ct * cr - geom.ry * st * sr, geom.cy + geom.rx * ct * sr + geom.ry * st * cr]);
            }
            pts.push(pts[0].slice());
            geom.points = pts;
            return geom;
          }
        }
      } catch { /* ignore */ }
    }
    const f3 = byNumber(m, 3);
    if (f3.length && f3[0].v instanceof Uint8Array) {
      try {
        const sub = decodeMessage(f3[0].v);
        const c1 = byNumber(sub, 1), c2 = byNumber(sub, 2);
        if (c1.length && c2.length && c1[0].v instanceof Uint8Array && c2[0].v instanceof Uint8Array) {
          const m1 = tryDecode(c1[0].v), m2 = tryDecode(c2[0].v);
          const ce = m1 && shapeExtractPoint(m1), sz = m2 && shapeExtractPoint(m2);
          if (ce && sz) {
            const cx = ce[0], cy = ce[1], w = sz[0], h = sz[1];
            geom.type = 'rectangle';
            geom.cx = cx; geom.cy = cy; geom.rx = w / 2; geom.ry = h / 2;
            geom.points = [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2], [cx - w / 2, cy - h / 2]];
            return geom;
          }
        }
      } catch { /* ignore */ }
    }
    return geom;
  }
  function parseShapeRecord(ri, record, hasText) {
    const f22 = byNumber(record, 22);
    if (f22.length && f22[0].v instanceof Uint8Array) {
      const m22 = tryDecode(f22[0].v);
      if (m22 && byNumber(m22, 2).length && !(byNumber(m22, 2)[0].v instanceof Uint8Array) && byNumber(m22, 2)[0].v === 31) {
        const t = type31Shape(m22);
        if (t) return t;
      }
    }
    const f21 = byNumber(record, 21);
    if (f21.length && f21[0].v instanceof Uint8Array && !hasText) {
      const m21 = tryDecode(f21[0].v);
      if (m21) {
        const t = type35Shape(m21);
        if (t) return t;
      }
    }
    const f7 = byNumber(record, 7);
    if (!f7.length || !(f7[0].v instanceof Uint8Array)) return null;
    const outer = tryDecode(f7[0].v);
    if (!outer) return null;
    const o22 = byNumber(outer, 22);
    if (o22.length && o22[0].v instanceof Uint8Array) {
      const m22 = tryDecode(o22[0].v);
      if (m22 && byNumber(m22, 2).length && !(byNumber(m22, 2)[0].v instanceof Uint8Array) && byNumber(m22, 2)[0].v === 31) {
        const t = type31Shape(m22);
        if (t) return t;
      }
    }
    const o21 = byNumber(outer, 21);
    if (o21.length && o21[0].v instanceof Uint8Array && !hasText) {
      const m21 = tryDecode(o21[0].v);
      if (m21) {
        const t = type35Shape(m21);
        if (t) return t;
      }
    }
    const f9 = byNumber(outer, 9);
    if (!f9.length || !(f9[0].v instanceof Uint8Array)) return null;
    const sm = tryDecode(f9[0].v);
    if (!sm) return null;
    const geom = geometryFromField9(sm);
    if (geom.points.length < 2) return null;
    let dx = 0, dy = 0;
    const off = shapeMoveOffset(outer);
    if (off[0] || off[1]) { dx = off[0]; dy = off[1]; }
    else { const off2 = shapeMoveOffset(record); dx = off2[0]; dy = off2[1]; }
    let pts = geom.points;
    if (dx || dy) pts = pts.map(p => [p[0] + dx, p[1] + dy]);
    let width = 1;
    const wf = byNumber(sm, 15);
    if (wf.length) width = fixedFloat(wf[0]) || 1;
    let color = '#1e1b1b', alpha = 1;
    const cf = byNumber(outer, 4);
    if (cf.length && cf[0].v instanceof Uint8Array) {
      try {
        const cm = decodeMessage(cf[0].v);
        const c = shapeRgb(cm);
        color = c.color; alpha = c.alpha;
      } catch { /* ignore */ }
    }
    let dash = null;
    const d5 = byNumber(sm, 5);
    if (d5.length && d5[0].v instanceof Uint8Array) {
      const m5 = tryDecode(d5[0].v);
      if (m5 && byNumber(m5, 1).length && byNumber(m5, 1)[0].v instanceof Uint8Array) {
        const bv = byNumber(m5, 1)[0].v;
        if (bv.length >= 8) {
          const dv = new DataView(bv.buffer, bv.byteOffset, bv.length);
          const vals = [];
          for (let o = 0; o + 4 <= bv.length; o += 4) vals.push(dv.getFloat32(o, true));
          if (vals.some(v => v > 0)) dash = vals;
        }
      }
    }
    const closed = geom.type !== 'polygon' || Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6;
    return { uuid: shapeUuid(outer), points: pts, width, color, alpha, fill: null, fillAlpha: 0, type: geom.type, dash, closed, cx: geom.cx, cy: geom.cy, rx: geom.rx, ry: geom.ry, rot: geom.rot };
  }

  /* ---------- Typed Text (Port von text.py) ---------- */
  function parseTextRuns(decMsg, dflt) {
    const runs = [];
    for (const field of decMsg.fields) {
      if (!(field.v instanceof Uint8Array)) continue;
      const item = tryDecode(field.v);
      if (!item) continue;
      const t1 = byNumber(item, 1);
      if (!t1.length || !(t1[0].v instanceof Uint8Array)) continue;
      const txt = bytesToStr(t1[0].v);
      if (!txt) continue;
      const run = { text: txt, bold: false, italic: false, underline: false, strike: false, list: null, align: 'left', font: dflt.font, size: dflt.size, color: dflt.color };
      const f2 = byNumber(item, 2);
      if (f2.length && f2[0].v instanceof Uint8Array) {
        const m2 = tryDecode(f2[0].v);
        if (m2) {
          const is1 = (n) => { const a = byNumber(m2, n); return a.length && !(a[0].v instanceof Uint8Array) && a[0].v === 1; };
          if (is1(1)) run.strike = true;
          if (is1(2)) run.underline = true;
          if (is1(50)) run.italic = true;
          const s30 = byNumber(m2, 30);
          if (s30.length && s30[0].v instanceof Uint8Array) run.font = bytesToStr(s30[0].v) || run.font;
          const s40 = byNumber(m2, 40);
          if (s40.length && fixedFloat(s40[0]) > 0) run.size = fixedFloat(s40[0]);
          const s60 = byNumber(m2, 60);
          if ((s60.length && !(s60[0].v instanceof Uint8Array) && s60[0].v >= 18446744073709551000) || /bold/i.test(run.font)) run.bold = true;
          const c3 = byNumber(m2, 3);
          if (c3.length && c3[0].v instanceof Uint8Array) {
            const cm = tryDecode(c3[0].v);
            if (cm) {
              const c = shapeRgb(cm);
              run.color = c.color;
            }
          }
        }
      }
      const f3 = byNumber(item, 3);
      if (f3.length && f3[0].v instanceof Uint8Array) {
        const m3 = tryDecode(f3[0].v);
        if (m3) {
          const l3 = byNumber(m3, 3);
          if (l3.length && l3[0].v instanceof Uint8Array) {
            if (l3[0].v.length === 0) run.list = 'bullet';
            else {
              const mm = tryDecode(l3[0].v);
              if (mm && byNumber(mm, 1).length && !(byNumber(mm, 1)[0].v instanceof Uint8Array) && byNumber(mm, 1)[0].v === 1) run.list = 'numbered';
              else if (mm && !mm.fields.length) run.list = 'bullet';
            }
          }
          const al = byNumber(m3, 4);
          if (al.length && !(al[0].v instanceof Uint8Array)) {
            const c = +al[0].v;
            run.align = c === 2 ? 'center' : c === 3 ? 'right' : 'left';
          }
        }
      }
      runs.push(run);
    }
    return runs;
  }
  function textBoxPos(msg) {
    // msg = f21-Payload (Typ 35): f20 -> f1 -> {f1 x, f2 y}
    const f20 = byNumber(msg, 20);
    if (f20.length && f20[0].v instanceof Uint8Array) {
      const m20 = tryDecode(f20[0].v);
      if (m20 && byNumber(m20, 1).length && byNumber(m20, 1)[0].v instanceof Uint8Array) {
        const mp = tryDecode(byNumber(m20, 1)[0].v);
        if (mp && byNumber(mp, 1).length && byNumber(mp, 2).length)
          return [fixedFloat(byNumber(mp, 1)[0]) || 0, fixedFloat(byNumber(mp, 2)[0]) || 0];
      }
    }
    return [0, 0];
  }
  function textBoxBg(msg) {
    const f30 = byNumber(msg, 30);
    if (f30.length && f30[0].v instanceof Uint8Array) {
      const m30 = tryDecode(f30[0].v);
      if (m30 && byNumber(m30, 1).length && byNumber(m30, 1)[0].v instanceof Uint8Array) {
        const mf = tryDecode(byNumber(m30, 1)[0].v);
        if (mf && byNumber(mf, 1).length && byNumber(mf, 1)[0].v instanceof Uint8Array) {
          const bg = tryDecode(byNumber(mf, 1)[0].v);
          if (bg) {
            const c = shapeRgb(bg);
            if (c.alpha > 0) return { color: c.color, alpha: c.alpha };
          }
        }
      }
    }
    return null;
  }
  function parseTexts(records) {
    const boxes = [], byRecord = new Set();
    const dflt = { font: 'Helvetica Neue', size: 24, color: '#000000' };
    records.forEach((record, ri) => {
      const f1 = byNumber(record, 1);
      let recUuid = '';
      if (f1.length && f1[0].v instanceof Uint8Array) {
        const s = bytesToStr(f1[0].v);
        if (looksLikeUuid(s)) recUuid = s;
      }
      const f21 = byNumber(record, 21);
      if (!f21.length || !(f21[0].v instanceof Uint8Array)) return;
      const msg = tryDecode(f21[0].v);
      if (!msg) return;
      const [x, y] = textBoxPos(msg);
      const f32 = byNumber(msg, 32);
      if (!f32.length || !(f32[0].v instanceof Uint8Array)) return;
      const msg32 = tryDecode(f32[0].v);
      if (!msg32) return;
      let w = 0, h = 0;
      const d2 = byNumber(msg32, 2);
      if (d2.length && d2[0].v instanceof Uint8Array) {
        const md = tryDecode(d2[0].v);
        if (md) { w = fixedFloat(byNumber(md, 1)[0]) || 0; h = fixedFloat(byNumber(md, 2)[0]) || 0; }
      }
      const f10 = byNumber(msg32, 10);
      if (f10.length && f10[0].v instanceof Uint8Array) {
        const m10 = tryDecode(f10[0].v);
        if (m10 && byNumber(m10, 1).length && byNumber(m10, 2).length) {
          w += 2 * (fixedFloat(byNumber(m10, 1)[0]) || 0);
          h += 2 * (fixedFloat(byNumber(m10, 2)[0]) || 0);
        }
      }
      const font = { ...dflt };
      const f5 = byNumber(msg32, 5);
      if (f5.length && f5[0].v instanceof Uint8Array) {
        const m5 = tryDecode(f5[0].v);
        if (m5 && byNumber(m5, 1).length && byNumber(m5, 1)[0].v instanceof Uint8Array) {
          const m51 = tryDecode(byNumber(m5, 1)[0].v);
          if (m51) {
            const s30 = byNumber(m51, 30);
            if (s30.length && s30[0].v instanceof Uint8Array) font.font = bytesToStr(s30[0].v) || font.font;
            const s40 = byNumber(m51, 40);
            if (s40.length && fixedFloat(s40[0]) > 0) font.size = fixedFloat(s40[0]);
          }
        }
      }
      const m1 = byNumber(msg32, 1);
      if (!m1.length || !(m1[0].v instanceof Uint8Array)) return;
      const mm1 = tryDecode(m1[0].v);
      if (!mm1) return;
      const b2 = byNumber(mm1, 2);
      if (!b2.length || !(b2[0].v instanceof Uint8Array)) return;
      if (findBytes(b2[0].v, BV41, 0) < 0) return;
      let dec = null;
      try {
        const lz = decodeAppleLz4(b2[0].v.subarray(findBytes(b2[0].v, BV41, 0)));
        dec = tryDecode(lz.bytes);
      } catch { return; }
      if (!dec) return;
      const runs = parseTextRuns(dec, font);
      if (!runs.length) return;
      boxes.push({ uuid: recUuid, x, y, w, h, runs, bg: textBoxBg(msg), sticky: false });
      byRecord.add(ri);
    });
    // Sticky Notes (Typ 35 in record.f20)
    records.forEach((record, ri) => {
      for (const f of byNumber(record, 20)) {
        if (!(f.v instanceof Uint8Array)) continue;
        const msg = tryDecode(f.v);
        if (!msg) continue;
        if (!byNumber(msg, 2).some(x => !(x.v instanceof Uint8Array) && x.v === 35)) continue;
        const f1 = byNumber(msg, 1);
        const ustr = (f1.length && f1[0].v instanceof Uint8Array) ? bytesToStr(f1[0].v) : '';
        const [nx, ny] = textBoxPos(msg);
        for (const f31 of byNumber(msg, 31)) {
          if (!(f31.v instanceof Uint8Array)) continue;
          const m31 = tryDecode(f31.v);
          if (!m31) continue;
          for (const it1 of byNumber(m31, 1)) {
            if (!(it1.v instanceof Uint8Array)) continue;
            const m311 = tryDecode(it1.v);
            if (!m311) continue;
            for (const it2 of byNumber(m311, 2)) {
              if (!(it2.v instanceof Uint8Array) || findBytes(it2.v, BV41, 0) < 0) continue;
              try {
                const lz = decodeAppleLz4(it2.v.subarray(findBytes(it2.v, BV41, 0)));
                const dec = tryDecode(lz.bytes);
                if (!dec) continue;
                const runs = parseTextRuns(dec, { font: 'Helvetica Neue', size: 14, color: '#000000' });
                if (!runs.length) continue;
                boxes.push({ uuid: ustr, x: nx, y: ny, w: 256, h: 256, runs, bg: { color: '#FAE778', alpha: 1 }, sticky: true });
                byRecord.add(ri);
              } catch { /* ignore */ }
            }
          }
        }
      }
    });
    return { boxes, byRecord };
  }
  function runsToHtml(box) {
    const escH = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let html = '', open = null;
    const close = () => { if (open) { html += open === 'bullet' ? '</ul>' : '</ol>'; open = null; } };
    for (const r of box.runs) {
      if (r.list !== open) { close(); if (r.list) { html += r.list === 'bullet' ? '<ul>' : '<ol>'; open = r.list; } }
      let t = escH(r.text);
      if (r.bold) t = '<b>' + t + '</b>';
      if (r.italic) t = '<i>' + t + '</i>';
      if (r.underline) t = '<u>' + t + '</u>';
      if (r.strike) t = '<s>' + t + '</s>';
      if (r.size >= 40) t = '<h1>' + t + '</h1>';
      else if (r.size >= 32) t = '<h2>' + t + '</h2>';
      else if (r.size >= 28) t = '<h3>' + t + '</h3>';
      if (r.color && r.color.toLowerCase() !== '#000000') t = '<span style="color:' + r.color + '">' + t + '</span>';
      if (r.list) t = '<li>' + t + '</li>';
      else if (r.align && r.align !== 'left') t = '<p style="text-align:' + r.align + '">' + t + '</p>';
      html += t;
    }
    close();
    html = html.replace(/\n/g, '<br>');
    if (box.bg && box.bg.alpha > 0) {
      const m = /^#([0-9a-f]{6})$/i.exec(box.bg.color || '');
      const bg = m ? 'rgba(' + parseInt(m[1].slice(0, 2), 16) + ',' + parseInt(m[1].slice(2, 4), 16) + ',' + parseInt(m[1].slice(4, 6), 16) + ',' + (Math.round(box.bg.alpha * 100) / 100) + ')' : box.bg.color;
      html = '<div style="background:' + bg + ';padding:6px;border-radius:4px">' + html + '</div>';
    }
    return html || '(leerer Text)';
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

  function r3(v) { return Math.round(v * 1000) / 1000; }

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
    let pdfBg = false, imgCount = 0;

    for (const e of entries) {
      let records;
      try { records = decodeDelimited(members[e.path]); }
      catch { continue; }

      // Metadaten: UUID -> radiert? + alle Record-UUIDs
      const erased = {}, allUuids = new Set();
      for (const rec of records) {
        const f1 = byNumber(rec, 1);
        if (f1.length && f1[0].v instanceof Uint8Array) {
          const s = bytesToStr(f1[0].v);
          if (looksLikeUuid(s)) {
            allUuids.add(s);
            // Nur Metadata-Records mit f3 ändern das Flag (Stroke-Records
            // ohne f3 dürfen ein früheres „radiert“ nicht zurücksetzen)
            const f3 = byNumber(rec, 3);
            if (f3.length && !(f3[0].v instanceof Uint8Array)) erased[s] = (f3[0].v === 1);
          }
        }
      }

      // Typed Text + Stickies (vor Shapes: Textbox-Hintergründe unterdrücken)
      const { boxes: textBoxes, byRecord: textRecords } = parseTexts(records);
      const textRects = new Set();
      for (const t of textBoxes)
        if (t.w > 0 && t.h > 0)
          textRects.add([r3(t.x), r3(t.y), r3(t.w), r3(t.h)].join(','));
      const textShapeUuids = new Set();
      // Linearer Regex-Scan nur über f21-Records (statt Records × UUIDs)
      const uuidRe = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;
      records.forEach(rec => {
        if (!byNumber(rec, 21).length) return; // nur f21-Records scannen (linear statt quadratisch)
        let recUuid = null;
        const top1 = byNumber(rec, 1);
        if (top1.length && top1[0].v instanceof Uint8Array) {
          const s = bytesToStr(top1[0].v);
          if (looksLikeUuid(s)) recUuid = s;
        }
        for (const f of byNumber(rec, 21)) {
          if (!(f.v instanceof Uint8Array)) continue;
          const inner = tryDecode(f.v);
          let innerUuid = null;
          if (inner) {
            const i1 = byNumber(inner, 1);
            if (i1.length && i1[0].v instanceof Uint8Array) {
              const s = bytesToStr(i1[0].v);
              if (looksLikeUuid(s)) innerUuid = s;
            }
          }
          uuidRe.lastIndex = 0;
          const s = bytesToStr(f.v);
          let m;
          while ((m = uuidRe.exec(s))) {
            const cand = m[0];
            if (!allUuids.has(cand)) continue;
            if (cand === recUuid || cand === innerUuid) continue;
            textShapeUuids.add(cand);
          }
        }
      });

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
      });

      // Shapes (mit Textbox-Unterdrückung + radiert-Skip wie im Referenzparser)
      const shapes = [];
      records.forEach((rec, ri) => {
        let sh = null;
        try { sh = parseShapeRecord(ri, rec, textRecords.has(ri)); } catch { return; }
        if (!sh || !sh.points.length) return;
        if (sh.uuid && erased[sh.uuid]) return;
        if (sh.type === 'rectangle' && sh.points.length >= 4) {
          const xs = sh.points.map(p => p[0]), ys = sh.points.map(p => p[1]);
          const key = [r3(Math.min(...xs)), r3(Math.min(...ys)), r3(Math.max(...xs) - Math.min(...xs)), r3(Math.max(...ys) - Math.min(...ys))].join(',');
          if (!sh.fill && (textShapeUuids.has(sh.uuid) || textRects.has(key))) return;
        }
        shapes.push(sh);
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
      pages.push({ uuid: e.uuid, strokes, shapes, textBoxes, images, dim });
    }
    const nShapes = pages.reduce((n, p) => n + p.shapes.length, 0);
    const nTexts = pages.reduce((n, p) => n + p.textBoxes.length, 0);
    return { title, pages, stats: { shapes: nShapes, texts: nTexts, pdfBg, imgCount } };
  }

  /* ---------- Mapping auf Grimoire-Modell (A4-Canvas 1000×1414) ---------- */
  const CW = 1000, CH = 1414, DPI = 132 / 72;
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
    for (const sh of (pg.shapes || [])) {
      if (!sh.points.length) continue;
      const pts = sh.points.map(p => ([
        Math.round((p[0] * sc) * 10) / 10,
        Math.round((p[1] * sc + offY) * 10) / 10
      ])).map(p => ({ x: p[0], y: p[1] }));
      const closed = pts.length > 2 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 0.6;
      strokes.push({
        tool: 'pen',
        color: sh.color,
        size: Math.max(0.5, Math.round(sh.width * wsc * 100) / 100),
        points: pts,
        alpha: sh.alpha == null ? 1 : Math.max(0, Math.min(1, sh.alpha)),
        dash: sh.dash ? sh.dash.map(d => Math.round(d * wsc * 100) / 100) : null,
        closed: closed || !!sh.fill,
        fill: sh.fill || null,
        fillAlpha: sh.fillAlpha || 0
      });
    }
    const texts = (pg.textBoxes || []).map(t => ({
      x: Math.round((t.x / iw) * 10000) / 10000,
      y: Math.round(((t.y * sc + offY)) / CH * 10000) / 10000,
      html: runsToHtml(t)
    }));
    return { strokes, texts, dim: pg.dim, scale: sc, offY };
  }


  /* ==================== EXPORT ==================== */

  /* ---------- Protobuf Encoder ---------- */
  function wvarint(n) {
    const out = [];
    let v = Math.floor(n);
    do { let b = v % 128; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(b); } while (v);
    return new Uint8Array(out);
  }
  function wfield(n, wt, v) {
    const key = wvarint(n * 8 + wt);
    let body;
    if (wt === 0) body = wvarint(v);
    else if (wt === 5) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); body = b; }
    else if (wt === 2) body = new Uint8Array([...wvarint(v.length), ...v]);
    else if (wt === 1) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v) << 32n >> 32n, true); body = b; }
    else throw new Error('wt ' + wt);
    return new Uint8Array([...key, ...body]);
  }
  function wmsg(fields) { return concatU8(fields.map(([n, wt, v]) => wfield(n, wt, v))); }
  function wdelimited(frames) { return concatU8(frames.map(f => concatU8([wvarint(f.length), f]))); }
  function concatU8(arr) { const total = arr.reduce((s, a) => s + a.length, 0); const out = new Uint8Array(total); let o = 0; for (const a of arr) { out.set(a, o); o += a.length; } return out; }
  function strToBytes(s) { return new TextEncoder().encode(s); }
  function f32bytes(f) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, f, true); return b; }
  function f64bytes(f) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, f, true); return b; }
  function u32bytes(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }
  function f32bits(f) { return new DataView(f32bytes(f).buffer).getUint32(0, true); }

  /* ---------- TPL Encoder ---------- */
  function tplEncode(fmt, vals) {
    const nodes = []; let pos = 0;
    function grp(term) {
      const nodes = [];
      while (pos < fmt.length) {
        const t = fmt[pos++];
        if (t === ')') { if (!term) throw new Error('tpl )'); return nodes; }
        if (t === 'A' || t === 'S') { if (fmt[pos] !== '(') throw new Error('tpl grp'); pos++; nodes.push([t, grp(')')]); }
        else if ('jviuIUcsfB'.includes(t)) nodes.push(t);
        else throw new Error('tpl tok ' + t);
      }
      if (term) throw new Error('tpl offen');
      return nodes;
    }
    const top = grp(null);
    function tplVal(node, val) {
      if (Array.isArray(node)) {
        const [kind, kids] = node;
        if (kind === 'S') return concatU8(kids.map((k, i) => tplVal(k, val[i])));
        const items = val.map(it => kids.length === 1 ? tplVal(kids[0], it) : concatU8(kids.map((k, i) => tplVal(k, it[i]))));
        return concatU8([u32bytes(val.length), ...items]);
      }
      if (node === 'u') return u32bytes(val);
      if (node === 'v') { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, val, true); return b; }
      if (node === 'i') { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, val, true); return b; }
      if (node === 'f') return f64bytes(val);
      if (node === 'c') return new Uint8Array([val & 0xff]);
      if (node === 'j') { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, val, true); return b; }
      if (node === 'U') return u32bytes(val);
      throw new Error('tpl node ' + node);
    }
    function u32bytes(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }
    const payload = concatU8(top.map((n, i) => tplVal(n, vals[i])));
    const fmtBytes = strToBytes(fmt);
    const head = concatU8([new Uint8Array([0x74, 0x70, 0x6c, 0x00]), u32bytes(0), fmtBytes, new Uint8Array([0])]);
    const total = concatU8([head, payload]);
    total.set(u32bytes(total.length), 4);
    return total;
  }

  /* ---------- LZ4 / Apple LZ4 (bv4) Encoder ---------- */
  function lz4Literals(raw) {
    if (!(raw instanceof Uint8Array)) raw = new Uint8Array(raw);
    const out = []; let rest = raw.length;
    if (rest < 15) out.push(rest << 4);
    else { out.push(0xf0); rest -= 15; while (rest >= 255) { out.push(255); rest -= 255; } out.push(rest); }
    return new Uint8Array([...out, ...raw]);
  }
  function bv4n(tplBytes) {
    const lz = lz4Literals(tplBytes);
    const h = new Uint8Array(12);
    h.set([0x62, 0x76, 0x34, 0x31], 0); // 'bv41' (LZ4-block, vom Decoder verstanden)
    h.set(u32bytes(tplBytes.length), 4);
    h.set(u32bytes(lz.length), 8);
    return concatU8([h, lz, new Uint8Array([0x62, 0x76, 0x34, 0x24])]);
  }

  /* ---------- Stroke TPL from points ---------- */
  function pointsToTpl(points, width) {
    const fpts = points.map(p => [p.x != null ? p.x : 0, p.y != null ? p.y : 0]);
    const pairs = [fpts[0]];
    const quads = [];
    for (let i = 1; i < fpts.length; i++) {
      quads.push([fpts[i - 1][0], fpts[i - 1][1], fpts[i][0], fpts[i][1]]);
    }
    const w = width || 2.5;
    return tplEncode('vuA(v)A(S(uu))A(S(uuuu))vA(f)', [
      0, f32bits(w), pairs.length ? [1] : [],
      pairs.map(P => [f32bits(P[0]), f32bits(P[1])]),
      quads.map(Q => [f32bits(Q[0]), f32bits(Q[1]), f32bits(Q[2]), f32bits(Q[3])]),
      0, [1.0]
    ]);
  }

  /* ---------- Color & Offset ---------- */
  function parseColor(c) {
    if (!c || c[0] !== '#' || c.length < 7) return [0, 0, 0, 1];
    const r = parseInt(c.slice(1, 3), 16) / 255, g = parseInt(c.slice(3, 5), 16) / 255, b = parseInt(c.slice(5, 7), 16) / 255;
    return [r, g, b, c.length > 7 ? parseInt(c.slice(7, 9), 16) / 255 : 1];
  }
  function colorMsg(r, g, b, a) { return wmsg([[1, 5, r], [2, 5, g], [3, 5, b], [4, 5, a]]); }
  function offsetMsg(dx, dy) { return wmsg([[1, 5, dx || 0], [2, 5, dy || 0]]); }

  /* ---------- Build records ---------- */
  function strokeRecord(uuid, points, color, width) {
    const crgb = parseColor(color || '#000000');
    const tpl = pointsToTpl(points, width || 2.5);
    const parts = [[1, 2, strToBytes(uuid)], [2, 2, bv4n(tpl)], [4, 2, colorMsg(...crgb)]];
    const f7 = wmsg(parts);
    return wmsg([[1, 2, strToBytes(uuid)], [7, 2, f7]]);
  }
  function textItemPayload(text, { font = 'Helvetica Neue', size = 24, color = '#000000', align = 'left' } = {}) {
    const crgb = parseColor(color);
    const m2 = wmsg([[30, 2, strToBytes(font)], [40, 5, size], [3, 2, colorMsg(...crgb)]]);
    const al = align === 'center' ? 2 : align === 'right' ? 3 : 1;
    const m3 = [[4, 0, al]];
    const item = [[1, 2, strToBytes(text)], [2, 2, m2], [3, 2, wmsg(m3)]];
    return wmsg(item);
  }
  function textRecord(uuid, x, y, w, h, html, runs) {
    const items = runs.map(r => textItemPayload(r.text, r));
    const decPayload = concatU8(items.map(it => concatU8([wvarint(1 * 8 + 2), wvarint(it.length), it])));
    const inner = wmsg([[2, 2, bv4n(decPayload)]]);
    const dims = wmsg([[1, 5, w], [2, 5, h]]);
    const f32 = wmsg([[1, 2, inner], [2, 2, dims]]);
    const f20 = wmsg([[1, 2, wmsg([[1, 5, x], [2, 5, y]])]]);
    const f21 = wmsg([[20, 2, f20], [32, 2, f32]]);
    return wmsg([[1, 2, strToBytes(uuid)], [21, 2, f21]]);
  }
  function shapeRecord(uuid, points, color, width) {
    const crgb = parseColor(color || '#1e1b1b');
    const ptMsg = wmsg([[1, 5, points[0][0]], [2, 5, points[0][1]]]);
    const container = wmsg([[1, 2, ptMsg], [2, 2, wmsg([[1, 5, width || 1]])]]);
    const shapeMsg = wmsg([[1, 2, container], [15, 5, width || 1]]);
    const outer = wmsg([[1, 2, strToBytes(uuid)], [7, 2, wmsg([[9, 2, shapeMsg], [4, 2, colorMsg(...crgb)]])]]);
    return outer;
  }
  function imageRecord(recUuid, attUuid, x, y, w, h) {
    const pt = (x, y) => wmsg([[1, 5, x], [2, 5, y]]);
    const wh = wmsg([[1, 2, pt(x, y)], [2, 2, pt(w, h)]]);
    return wmsg([[1, 2, strToBytes(recUuid)], [7, 2, strToBytes(attUuid)], [8, 2, wmsg([[2, 2, wh]])]]);
  }
  function metaRecord(uuid, erased) {
    const parts = [[1, 2, strToBytes(uuid)]];
    if (erased) parts.push([3, 0, 1]);
    return wmsg(parts);
  }

  /* ---------- ZIP Writer ---------- */
  function writeZip(files) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    for (const [name, data] of files) {
      const nb = enc.encode(name);
      if (data instanceof Uint8Array === false) data = new Uint8Array(data);
      const lh = new Uint8Array(30);
      const dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true);
      dv.setUint16(6, 0, true); dv.setUint16(8, 0, true);
      dv.setUint32(14, 0, true); dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nb.length, true); dv.setUint16(28, 0, true);
      chunks.push(lh, nb, data);
      central.push({ name: nb, len: data.length, offset });
      offset += 30 + nb.length + data.length;
    }
    const cdStart = offset; let cdSize = 0;
    for (const c of central) {
      const h = new Uint8Array(46);
      const dv = new DataView(h.buffer);
      dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true);
      dv.setUint16(8, 0, true); dv.setUint16(10, 0, true);
      dv.setUint32(16, 0, true); dv.setUint32(20, c.len, true); dv.setUint32(24, c.len, true);
      dv.setUint16(28, c.name.length, true); dv.setUint16(30, 0, true); dv.setUint16(32, 0, true);
      dv.setUint32(38, 0, true); dv.setUint32(42, c.offset, true);
      chunks.push(h, c.name); cdSize += 46 + c.name.length;
    }
    const end = new Uint8Array(22);
    const edv = new DataView(end.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, central.length, true); edv.setUint16(10, central.length, true);
    edv.setUint32(12, cdSize, true); edv.setUint32(16, cdStart, true);
    chunks.push(end);
    return concatU8(chunks);
  }

  /* ---------- Make minimal JPEG ---------- */
  function makeThumbnail() {
    const w = 100, h = 75;
    const raw = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { raw[i * 3] = 255; raw[i * 3 + 1] = 253; raw[i * 3 + 2] = 246; }
    const crcTbl = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTbl[n] = c >>> 0; }
    function crc(b) { let c = 0xffffffff; for (const x of b) c = crcTbl[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
    function chunk(type, data) {
      const h = new Uint8Array([...u32bytes(data.length), ...strToBytes(type)]);
      const cb = new Uint8Array(4); new DataView(cb.buffer).setUint32(0, crc(new Uint8Array([...strToBytes(type), ...data])), false);
      return new Uint8Array([...h, ...data, ...cb]);
    }
    function u32bytes(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; }
    const ihdr = new Uint8Array([...u32bytes(13), ...strToBytes('IHDR'), new Uint8Array([0, 0, 0, w, 0, 0, 0, h, 8, 6, 0, 0, 0])]);
    const idat = new Uint8Array([...u32bytes(raw.length + 2), ...strToBytes('IDAT'), raw]);
    return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', ihdr.subarray(8)), ...chunk('IDAT', idat), ...chunk('IEND', new Uint8Array(0))]);
  }

  /* ---------- Document protobuf ---------- */
  function documentPb(title, pageCount) {
    const inner = wmsg([[1, 2, strToBytes(title)], [2, 2, u32bytes(pageCount)]]);
    return wdelimited([inner]);
  }
  function documentInfoPb(title) {
    const inner = wmsg([[1, 2, strToBytes(title)]]);
    return wdelimited([inner]);
  }
  function indexNotesPb(pages) {
    const entries = pages.map((p, i) => {
      const uuid = p.uuid || ('page' + i);
      const path = 'notes/page' + (i + 1);
      return wmsg([[1, 2, strToBytes(uuid)], [2, 2, strToBytes(path)]]);
    });
    return wdelimited(entries);
  }
  function indexEventsPb(title) {
    const inner = wmsg([[1, 2, strToBytes(title)], [1, 2, strToBytes('aaaaaaaa-0000-4000-8000-aaaaaaaa0001')]]);
    return wdelimited([wmsg([[30, 2, wmsg([[1, 2, inner]])]])]);
  }

  /* ---------- Main export function ---------- */
  function exportGoodNotes(book) {
    const title = book.title || 'Grimoire';
    const pages = book.pages || [];
    const uuids = pages.map((_, i) => 'aaaaaaaa-0000-4000-8000-' + String(i + 1).padStart(12, '0'));
    const files = [];

    files.push(['index.notes.pb', indexNotesPb(pages.map((p, i) => ({ uuid: uuids[i], path: 'notes/page' + (i + 1) })))]);

    for (let pi = 0; pi < pages.length; pi++) {
      const page = pages[pi];
      const recs = [];
      recs.push(metaRecord(uuids[pi], false));

      for (let si = 0; si < (page.strokes || []).length; si++) {
        const s = page.strokes[si];
        if (!s.points || !s.points.length) continue;
        const su = 'stroke-' + pi + '-' + si;
        recs.push(strokeRecord(su, s.points, s.color || '#000000', s.size || 2.5));
      }

      for (let ti = 0; ti < (page.texts || []).length; ti++) {
        const t = page.texts[ti];
        const runs = parseHtmlToRuns(t.html);
        if (!runs.length) continue;
        const tx = Math.round((t.x || 0) * 10000) / 10000;
        const ty = Math.round((t.y || 0) * 10000) / 10000;
        recs.push(textRecord('text-' + pi + '-' + ti, tx, ty, 200, 100, t.html, runs));
      }

      for (let ii = 0; ii < (page.images || []).length; ii++) {
        const im = page.images[ii];
        const attUuid = 'img-' + pi + '-' + ii;
        recs.push(imageRecord('imgrec-' + pi + '-' + ii, attUuid, (im.x || 0) * 1000, (im.y || 0) * 1000, (im.w || 0.5) * 1000, 100));
      }

      if (recs.length) files.push(['notes/page' + (pi + 1), wdelimited(recs)]);
    }

    files.push(['index.events.pb', indexEventsPb(title)]);
    files.push(['document.pb', documentPb(title, pages.length)]);
    files.push(['document.info.pb', documentInfoPb(title)]);

    for (let pi = 0; pi < pages.length; pi++) {
      for (let ii = 0; ii < (pages[pi].images || []).length; ii++) {
        const im = pages[pi].images[ii];
        const attUuid = 'img-' + pi + '-' + ii;
        let imgData = null;
        if (im.src) {
          try {
            if (im.src.startsWith('data:')) {
              const comma = im.src.indexOf(',');
              if (comma >= 0) imgData = Uint8Array.from(atob(im.src.slice(comma + 1)), c => c.charCodeAt(0));
            }
          } catch { /* ignore */ }
        }
        if (!imgData) imgData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
        files.push(['attachments/' + attUuid, imgData]);
      }
    }

    files.push(['thumbnail.jpg', makeThumbnail()]);
    files.push(['search/0', new Uint8Array(0)]);

    return writeZip(files);
  }

  /* ---------- Parse HTML to runs ---------- */
  function parseHtmlToRuns(html) {
    if (!html) return [];
    const runs = [];
    const text = stripHtml(html || '');
    if (!text.trim()) return [];
    let color = '#000000', size = 24;
    const parts = text.split('\n').filter(s => s.trim());
    for (const part of parts) {
      runs.push({ text: part, color, size });
    }
    if (!runs.length) runs.push({ text: text || '(leerer Text)', color, size });
    return runs;
  }

  return {
    parseDocument, mapPage, runsToHtml, exportGoodNotes,
    _internals: { decodeMessage, decodeDelimited, decodeTpl, decodeAppleLz4, extractPoints, parseStrokeField, parseImageElements, parseShapeRecord, parseTexts, parseCurves, geometryFromField9, writeZip, strokeRecord, textRecord, imageRecord, metaRecord, indexNotesPb, indexEventsPb, documentPb, documentInfoPb, parseHtmlToRuns, tplEncode, bv4n, lz4Literals, wvarint, wfield, wmsg, wdelimited, concatU8, stripHtml }
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = GoodNotes;
