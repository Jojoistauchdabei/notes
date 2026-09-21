/* Federwerk Bild-/Bibliotheks-Optimierung (Aufgabe 4).
 *
 * Zentrale, kontextabhängige Größenoptimierung:
 * - Adaptive Bild-Kompression: maxLongEdge pro Kontext
 *   (Thumbnail 400, Seite 1600, Export 2048), Formatwahl JPEG/WebP nach
 *   Alpha, Qualität iterativ (Binary Search auf targetBytes,
 *   z. B. 350KB Seite / 120KB Thumb), EXIF-Orientation beachtet
 *   (createImageBitmap mit imageOrientation:'from-image', Maß-Swap 5-8).
 * - Stroke-Simplifizierung: Ramer-Douglas-Peucker für s.points
 *   (Epsilon aus penSize), Pressure (p) bleibt erhalten (Punkt-Objekte
 *   werden referenziert, nicht neu gebaut), Duplikate entfernt.
 * - Dedupe via SHA-256 (fileIdForHash-Schema `fw`+32 Hex, kompatibel zu
 *   js/appwrite-files.js).
 * - estimateSize(), optimizeBookStats() für "X MB gespart"-Anzeige.
 *
 * Kein Build, plain <script> (global `FederwerkOptimize` +
 * `FederwerkOptimizeUI`) + Node-export für Tests. DOM-frei testbar:
 * reine Helfer kommen ohne Canvas aus; die adaptiven Encoder nehmen
 * injizierbare deps (decode/encode/detectAlpha), sodass Tests mocken.
 */
(function () {
  'use strict';

  const MAX_EDGE = { thumbnail: 400, page: 1600, export: 2048 };
  const TARGET_BYTES = {
    thumbnail: 120 * 1024,
    page: 350 * 1024,
    export: 700 * 1024,
  };
  const DEFAULT_Q = { 'image/jpeg': 0.82, 'image/webp': 0.85 };
  const MIN_Q = 0.4;
  const MAX_Q = 0.92;
  const SMALL_RECOMPRESS = 200 * 1024; // nie über diesem Schwellwert anfangen
  const FILE_PREFIX = 'fw';

  /* ---------- kleine Helfer ---------- */

  function normalizeMime(m) {
    m = String(m || '').toLowerCase().split(';')[0].trim();
    if (m === 'image/jpg') return 'image/jpeg';
    return m;
  }
  function maxEdgeFor(context) {
    return MAX_EDGE[context] || MAX_EDGE.page;
  }
  function targetBytesFor(context) {
    return TARGET_BYTES[context] || TARGET_BYTES.page;
  }
  function defaultQualityFor(mime) {
    return DEFAULT_Q[normalizeMime(mime)] || 0.82;
  }
  // EXIF-Orientation 5-8 = transponiert (Breit/Hoch vertauscht).
  function orientedSize(w, h, orientation) {
    w = Math.max(1, Math.round(Number(w) || 1));
    h = Math.max(1, Math.round(Number(h) || 1));
    const o = Number(orientation) || 1;
    if (o >= 5 && o <= 8) return { w: h, h: w, swapped: true };
    return { w, h, swapped: false };
  }
  function scaledSize(w, h, limit) {
    w = Math.max(1, Math.round(Number(w) || 1));
    h = Math.max(1, Math.round(Number(h) || 1));
    limit = Number(limit) || MAX_EDGE.page;
    const sc = Math.min(1, limit / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * sc)), h: Math.max(1, Math.round(h * sc)), scale: sc };
  }

  /* ---------- Formatwahl (rein, testbar) ---------- */

  // Alpha -> WebP (klein, mit Transparenz), opak -> JPEG. GIF/PDF nie anfassen.
  function chooseOutputMime(origMime, hasAlpha) {
    const m = normalizeMime(origMime);
    if (m === 'image/gif' || m === 'application/pdf') return m;
    if (hasAlpha === true) return 'image/webp';
    if (hasAlpha === false) return 'image/jpeg';
    // Unbekannt: verlustfrei wirkende Quelle bevorzugt WebP, Rest JPEG.
    if (m === 'image/png' || m === 'image/webp') return 'image/webp';
    return 'image/jpeg';
  }
  // Reine Upload-/Recompress-Entscheidung (ohne Pixel), kontextsensitiv.
  // Kompatibel zur alten Heuristik: Seite >= 200KB -> recompress.
  function pickTarget(mime, sizeBytes, context) {
    mime = normalizeMime(mime);
    sizeBytes = Number(sizeBytes) || 0;
    const maxEdge = maxEdgeFor(context);
    const targetBytes = targetBytesFor(context);
    if (mime === 'application/pdf' || mime === 'image/gif') {
      return { mime, recompress: false, reason: 'keep', targetBytes, maxEdge };
    }
    if (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp') {
      const threshold = Math.min(SMALL_RECOMPRESS, Math.floor(targetBytes / 2));
      if (sizeBytes >= threshold) return { mime, recompress: true, reason: 'large', targetBytes, maxEdge };
      return { mime, recompress: false, reason: 'small', targetBytes, maxEdge };
    }
    return { mime, recompress: false, reason: 'unknown', targetBytes, maxEdge };
  }

  /* ---------- Qualitäts-Binary-Search (rein, testbar) ---------- */

  // probe(q) -> Bytes (monoton steigend in q). Sucht max. q mit bytes <= target.
  // q-Range [lo, hi], n Iterationen. Fällt alles darüber, bleibt lo (kleinstes).
  function searchBestQuality(targetBytes, probe, lo, hi, iterations) {
    lo = lo == null ? MIN_Q : lo;
    hi = hi == null ? MAX_Q : hi;
    iterations = iterations || 6;
    let bestQ = lo;
    let bestBytes = probe(lo);
    if (bestBytes > targetBytes) return { quality: lo, bytes: bestBytes, fits: false };
    let l = lo, h = hi;
    bestQ = lo;
    for (let i = 0; i < iterations; i++) {
      const mid = (l + h) / 2;
      const b = probe(mid);
      if (b <= targetBytes) { bestQ = mid; bestBytes = b; l = mid; }
      else h = mid;
    }
    // Einmal Hi prüfen (Schleife nähert nur an): passt hi, nimm hi.
    const hiBytes = probe(hi);
    if (hiBytes <= targetBytes) return { quality: hi, bytes: hiBytes, fits: true };
    return { quality: bestQ, bytes: bestBytes, fits: true };
  }

  /* ---------- Stroke-Simplifizierung: Ramer-Douglas-Peucker ---------- */

  function ptXY(p) {
    if (Array.isArray(p)) return [Number(p[0]) || 0, Number(p[1]) || 0];
    return [Number(p && p.x) || 0, Number(p && p.y) || 0];
  }
  function perpDist(p, a, b) {
    const px = ptXY(p)[0], py = ptXY(p)[1];
    const ax = ptXY(a)[0], ay = ptXY(a)[1];
    const bx = ptXY(b)[0], by = ptXY(b)[1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = ((px - ax) * dx + (py - ay) * dy) / len2;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  // Aufeinanderfolgende Positions-Duplikate entfernen (Pressure egal).
  function dedupePoints(points) {
    const out = [];
    for (const p of points) {
      const q = out[out.length - 1];
      if (q) {
        const a = ptXY(q), b = ptXY(p);
        if (a[0] === b[0] && a[1] === b[1]) continue;
      }
      out.push(p);
    }
    return out;
  }
  // Epsilon aus Stiftstärke: feine Linien tolerant klein, Marker großzügiger.
  function epsilonForPenSize(size) {
    const s = Number(size);
    const base = isFinite(s) && s > 0 ? s : 3;
    return Math.max(0.75, base * 0.35);
  }
  // RDP; gibt Original-Referenzen zurück (p/pressure bleibt erhalten).
  function simplifyPoints(points, epsilon) {
    points = Array.isArray(points) ? points : [];
    const eps = Math.max(0, Number(epsilon) || 0);
    const clean = dedupePoints(points);
    if (clean.length < 3 || eps <= 0) return clean.slice();
    const keep = new Array(clean.length).fill(false);
    keep[0] = true;
    keep[clean.length - 1] = true;
    const stack = [[0, clean.length - 1]];
    while (stack.length) {
      const seg = stack.pop();
      const a = seg[0], b = seg[1];
      let maxD = 0, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = perpDist(clean[i], clean[a], clean[b]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps && idx > 0) {
        keep[idx] = true;
        stack.push([a, idx], [idx, b]);
      }
    }
    const out = [];
    for (let i = 0; i < clean.length; i++) if (keep[i]) out.push(clean[i]);
    return out;
  }
  // Stroke -> Kopie mit vereinfachten Punkten (Farbe/Größe/Tool unangetastet).
  function simplifyStroke(stroke, epsilon) {
    if (!stroke || !Array.isArray(stroke.points)) return stroke;
    const eps = epsilon == null ? epsilonForPenSize(stroke.size) : Number(epsilon);
    const before = stroke.points.length;
    const pts = simplifyPoints(stroke.points, eps);
    if (pts.length === before) return stroke; // nichts zu holen: Referenz behalten
    const copy = Object.assign({}, stroke);
    copy.points = pts;
    return copy;
  }
  // Buch-Mutation in place + Statistik (Bibliotheks-Optimierung).
  function simplifyBookStrokes(book, opts) {
    opts = opts || {};
    let strokes = 0, removed = 0, kept = 0;
    if (!book || !Array.isArray(book.pages)) return { strokes: 0, removed: 0, kept: 0 };
    for (const page of book.pages) {
      if (!page || !Array.isArray(page.strokes)) continue;
      for (let i = 0; i < page.strokes.length; i++) {
        const s = page.strokes[i];
        if (!s || !Array.isArray(s.points) || s.points.length < 3) continue;
        const eps = opts.epsilon != null ? opts.epsilon : epsilonForPenSize(s.size);
        const pts = simplifyPoints(s.points, eps);
        strokes++;
        removed += s.points.length - pts.length;
        kept += pts.length;
        if (pts.length !== s.points.length) {
          const copy = Object.assign({}, s);
          copy.points = pts;
          page.strokes[i] = copy;
        }
      }
    }
    return { strokes, removed, kept };
  }

  /* ---------- Dedupe via SHA-256 ---------- */

  function fileIdForHash(hash) {
    const h = String(hash || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    if (h.length < 32) throw new Error('hash zu kurz');
    return FILE_PREFIX + h.slice(0, 32);
  }
  async function sha256Hex(bytes) {
    let subtle = null;
    try {
      if (typeof crypto !== 'undefined' && crypto.subtle) subtle = crypto.subtle;
      else if (typeof require === 'function') subtle = require('crypto').webcrypto.subtle;
    } catch { subtle = null; }
    if (!subtle) throw new Error('kein subtle crypto');
    const d = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /* ---------- Größenschätzung + Stats ---------- */

  function formatBytes(n) {
    n = Math.max(0, Math.round(Number(n) || 0));
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) {
      const kb = n / 1024;
      const v = kb >= 100 ? String(Math.round(kb)) : String(Math.round(kb * 10) / 10);
      return v.replace('.', ',') + ' KB';
    }
    const mb = n / (1024 * 1024);
    const v = mb >= 100 ? String(Math.round(mb * 10) / 10) : String(Math.round(mb * 100) / 100);
    return v.replace('.', ',') + ' MB';
  }
  // Byte-Schätzung für heterogene Eingaben (rein, testbar).
  function estimateSize(v) {
    if (v == null) return 0;
    if (v instanceof Uint8Array) return v.length;
    if (typeof v === 'string') {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(v);
      if (m && m[2]) return Math.floor(m[3].length * 3 / 4);
      return v.length;
    }
    if (typeof v === 'object') {
      try {
        const s = JSON.stringify(v);
        return s ? s.length : 0;
      } catch { return 0; }
    }
    return 0;
  }
  // Grobe Buch-Statistik (JSON-Bytes ohne ausgelagerte Blobs + Zählwerte).
  function estimateBookSize(book) {
    let points = 0, strokes = 0, images = 0;
    try {
      if (book && Array.isArray(book.pages)) {
        for (const p of book.pages) {
          if (p && Array.isArray(p.strokes)) {
            strokes += p.strokes.length;
            for (const s of p.strokes) if (s && Array.isArray(s.points)) points += s.points.length;
          }
          if (p && Array.isArray(p.images)) images += p.images.length;
          if (p && p.bg) images += 1;
        }
      }
    } catch { /* ignore */ }
    return { jsonBytes: estimateSize(book), points, strokes, images };
  }
  function optimizeBookStats(beforeBytes, afterBytes) {
    beforeBytes = Math.max(0, Math.round(Number(beforeBytes) || 0));
    afterBytes = Math.max(0, Math.round(Number(afterBytes) || 0));
    const savedBytes = Math.max(0, beforeBytes - afterBytes);
    const savedPct = beforeBytes > 0 ? Math.round((savedBytes / beforeBytes) * 1000) / 10 : 0;
    return {
      beforeBytes, afterBytes, savedBytes, savedPct,
      label: formatBytes(savedBytes) + ' gespart',
    };
  }

  /* ---------- Adaptive Bild-Kompression (Browser + mockbar) ---------- */

  function hasCanvas() {
    try {
      if (typeof document !== 'undefined' && document.createElement) {
        const c = document.createElement('canvas');
        if (c && c.getContext && c.toBlob) return true;
      }
    } catch { /* ignore */ }
    return false;
  }
  function parseDataUrl(du) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(du || '');
    if (!m) throw new Error('kein dataURL');
    const mime = normalizeMime(m[1] || 'image/jpeg');
    let bytes;
    if (m[2]) {
      const bin = (typeof atob !== 'undefined')
        ? atob(m[3])
        : Buffer.from(m[3], 'base64').toString('binary');
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(m[3]));
    }
    return { mime, bytes };
  }
  function bytesToDataUrl(bytes, mime) {
    mime = mime || 'image/jpeg';
    if (typeof Buffer !== 'undefined') {
      return 'data:' + mime + ';base64,' + Buffer.from(bytes).toString('base64');
    }
    let bin = '';
    const CH = 8192;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return 'data:' + mime + ';base64,' + btoa(bin);
  }
  function defaultDecode(bytes, mime) {
    // Bitmap + Maße; EXIF Orientation beachtet (from-image, Fallback ohne).
    return (async () => {
      const blob = new Blob([bytes], { type: mime });
      let bmp = null;
      try {
        bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      } catch {
        bmp = await createImageBitmap(blob);
      }
      return bmp;
    })();
  }
  function drawToCanvas(bmp, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    return { canvas, ctx };
  }
  function detectCanvasAlpha(ctx, w, h) {
    try {
      const step = Math.max(1, Math.floor(((w * h) || 1) / 20000));
      const d = ctx.getImageData(0, 0, w, h).data;
      for (let i = 3; i < d.length; i += 4 * step) {
        if (d[i] < 250) return false; // transparent -> nicht opak
      }
      return true;
    } catch { return null; } // unbekannt (z. B. getImageData blockiert)
  }
  function canvasEncode(canvas, mime, quality) {
    return new Promise((resolve) => {
      try {
        canvas.toBlob((b) => {
          if (!b) { resolve(null); return; }
          if (b.arrayBuffer) {
            b.arrayBuffer().then(
              (ab) => resolve({ bytes: new Uint8Array(ab), mime: normalizeMime(b.type || mime) }),
              () => resolve(null)
            );
          } else {
            const r = new FileReader();
            r.onload = () => resolve({ bytes: new Uint8Array(r.result), mime: normalizeMime(b.type || mime) });
            r.onerror = () => resolve(null);
            r.readAsArrayBuffer(b);
          }
        }, mime, quality);
      } catch { resolve(null); }
    });
  }
  // Kern: skaliert auf Kontext-Kante, wählt Format nach Alpha, sucht Qualität
  // per Binary Search auf targetBytes. deps injizierbar für Tests:
  // { decode(bytes,mime)->{width,height,close?}|Bitmap, draw自然?, encode(canvas,mime,q)->{bytes,mime}, detectAlpha(ctx,w,h)->bool|null }
  async function optimizeImageAdaptive(bytes, mime, opts, deps) {
    opts = opts || {};
    deps = deps || {};
    mime = normalizeMime(mime);
    const context = opts.context || 'page';
    const maxEdge = opts.maxEdge || maxEdgeFor(context);
    const targetBytes = opts.targetBytes || targetBytesFor(context);
    if (!(bytes instanceof Uint8Array)) {
      try { bytes = new Uint8Array(bytes); }
      catch { return { bytes, mime, optimized: false, reason: 'bad-input' }; }
    }
    if (mime === 'application/pdf' || mime === 'image/gif') {
      return { bytes, mime, optimized: false, reason: 'keep' };
    }
    if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp') {
      return { bytes, mime, optimized: false, reason: 'unknown' };
    }
    const decode = deps.decode || ((typeof createImageBitmap !== 'undefined' && typeof document !== 'undefined') ? defaultDecode : null);
    const encode = deps.encode || ((typeof document !== 'undefined') ? canvasEncode : null);
    const detectAlpha = deps.detectAlpha || detectCanvasAlpha;
    if (!decode || !encode) return { bytes, mime, optimized: false, reason: 'no-canvas' };

    let bmp = null;
    try {
      bmp = await decode(bytes, mime);
    } catch {
      return { bytes, mime, optimized: false, reason: 'decode-error' };
    }
    try {
      const bw = (bmp && (bmp.width || bmp.naturalWidth)) || 0;
      const bh = (bmp && (bmp.height || bmp.naturalHeight)) || 0;
      if (!bw || !bh) return { bytes, mime, optimized: false, reason: 'no-size' };
      // EXIF: decode liefert bereits orientiert (from-image); reine
      // Breite/Höhe-Orientierung zusätzlich über orientedSize absicherbar.
      const os = orientedSize(bw, bh, opts.exifOrientation || 1);
      const sc = scaledSize(os.w, os.h, maxEdge);
      const smallEnough = bytes.length < Math.min(SMALL_RECOMPRESS, Math.floor(targetBytes / 2));
      if (sc.scale >= 1 && smallEnough && opts.force !== true) {
        return { bytes, mime, optimized: false, reason: 'small', w: os.w, h: os.h };
      }
      // Zeichnen: Mock-deps liefern canvas-ähnliches Objekt direkt.
      let canvas = null, ctx = null;
      if (deps.draw) {
        const d = deps.draw(bmp, sc.w, sc.h);
        canvas = d && d.canvas ? d.canvas : d;
        ctx = (d && d.ctx) || null;
      } else {
        const d = drawToCanvas(bmp, sc.w, sc.h);
        canvas = d.canvas;
        ctx = d.ctx;
      }
      let opaque = null;
      try {
        if (opts.hasAlpha === true) opaque = false;
        else if (opts.hasAlpha === false) opaque = true;
        else if (ctx) opaque = detectAlpha(ctx, sc.w, sc.h);
        if (opaque == null) opaque = !(mime === 'image/png' || mime === 'image/webp');
      } catch { opaque = !(mime === 'image/png' || mime === 'image/webp'); }
      const primary = chooseOutputMime(mime, opaque ? false : true);
      const order = opaque ? ['image/jpeg'] : [primary, 'image/jpeg'];
      const tried = new Set();
      for (const tm of order) {
        if (tried.has(tm)) continue;
        tried.add(tm);
        if (tm !== 'image/jpeg' && tm !== 'image/webp' && tm !== 'image/png') continue;
        const q0 = defaultQualityFor(tm);
        const first = await encode(canvas, tm, tm === 'image/png' ? undefined : q0);
        if (!first || !first.bytes || !first.bytes.length) continue;
        // Kein Gewinn gegenüber Original? Nächste Option versuchen.
        if (first.bytes.length >= bytes.length && sc.scale >= 1) continue;
        if (tm === 'image/png' || first.bytes.length <= targetBytes) {
          if (first.bytes.length < bytes.length || sc.scale < 1) {
            return {
              bytes: first.bytes, mime: normalizeMime(first.mime || tm),
              optimized: first.bytes.length < bytes.length,
              reason: first.bytes.length < bytes.length ? (opaque ? 'jpeg' : 'alpha') : 'no-gain',
              w: sc.w, h: sc.h, quality: q0,
            };
          }
          continue;
        }
        // Über Ziel: Binary Search nach unten (mockbar, synchroner probe-Ansatz
        // ist hier async; daher eigene Schleife statt searchBestQuality).
        let lo = MIN_Q, hi = q0;
        let best = null;
        for (let i = 0; i < 5; i++) {
          const mid = (lo + hi) / 2;
          const out = await encode(canvas, tm, mid);
          if (out && out.bytes && out.bytes.length <= targetBytes) { best = { out, q: mid }; lo = mid; }
          else hi = mid;
        }
        if (best && best.out.bytes.length < bytes.length) {
          return {
            bytes: best.out.bytes, mime: normalizeMime(best.out.mime || tm),
            optimized: true, reason: opaque ? 'jpeg-target' : 'alpha-target',
            w: sc.w, h: sc.h, quality: best.q,
          };
        }
        // Auch Minimum zu groß: nimm kleinstes, wenn überhaupt kleiner.
        const minOut = await encode(canvas, tm, MIN_Q);
        if (minOut && minOut.bytes && minOut.bytes.length < bytes.length) {
          return {
            bytes: minOut.bytes, mime: normalizeMime(minOut.mime || tm),
            optimized: true, reason: opaque ? 'jpeg-min' : 'alpha-min',
            w: sc.w, h: sc.h, quality: MIN_Q,
          };
        }
      }
      return { bytes, mime, optimized: false, reason: 'no-gain', w: sc.w, h: sc.h };
    } finally {
      try { if (bmp && bmp.close) bmp.close(); } catch { /* ignore */ }
    }
  }
  // Bequemlichkeit: Bytes -> Bytes (Kontext-Default 'page').
  async function downscaleBytes(bytes, mime, context, opts) {
    return optimizeImageAdaptive(bytes, mime, Object.assign({}, opts, { context: context || 'page' }));
  }
  // Bequemlichkeit: dataURL -> dataURL (Store-/Import-Pfade).
  async function downscaleDataUrl(dataUrl, context, opts) {
    let parsed;
    try { parsed = parseDataUrl(dataUrl); }
    catch { return dataUrl; }
    const pick = pickTarget(parsed.mime, parsed.bytes.length, context);
    if (!pick.recompress && !(opts && opts.force)) return dataUrl;
    try {
      const out = await optimizeImageAdaptive(parsed.bytes, parsed.mime, Object.assign({}, opts, { context: context || 'page' }));
      if (out && out.optimized && out.bytes && out.bytes.length < parsed.bytes.length) {
        return bytesToDataUrl(out.bytes, out.mime);
      }
    } catch { /* Fallback: Original */ }
    return dataUrl;
  }

  const Optimize = {
    MAX_EDGE, TARGET_BYTES, DEFAULT_Q, MIN_Q, MAX_Q,
    normalizeMime, maxEdgeFor, targetBytesFor, defaultQualityFor,
    orientedSize, scaledSize,
    chooseOutputMime, pickTarget, searchBestQuality,
    ptXY, perpDist, dedupePoints, epsilonForPenSize,
    simplifyPoints, simplifyStroke, simplifyBookStrokes,
    fileIdForHash, sha256Hex,
    formatBytes, estimateSize, estimateBookSize, optimizeBookStats,
    hasCanvas, parseDataUrl, bytesToDataUrl,
    optimizeImageAdaptive, downscaleBytes, downscaleDataUrl,
    compressDataUrl: downscaleDataUrl,
  };

  /* ---------- UI-Glue: Bibliothek optimieren (nur Browser) ---------- */

  function statusSay(t) {
    try {
      const el = (typeof document !== 'undefined' && document.getElementById('awStatus')) || null;
      if (el) el.textContent = t;
      const msg = (typeof document !== 'undefined' && document.getElementById('awMsg')) || null;
      if (msg) msg.textContent = t;
    } catch { /* ignore */ }
  }
  function savedSay(stats) {
    try {
      const el = (typeof document !== 'undefined' && document.getElementById('awSaved')) || null;
      if (el && stats) el.textContent = 'Ersparnis: ' + (stats.label || formatBytes(stats.savedBytes || 0));
    } catch { /* ignore */ }
  }

  async function optimizeLibrary(progress) {
    const say = typeof progress === 'function' ? progress : statusSay;
    const W = (typeof window !== 'undefined') ? window : null;
    const state = W && W.state;
    if (!state || !Array.isArray(state.books)) {
      say('Bibliothek optimieren: kein State gefunden.');
      return { strokes: 0, removed: 0, images: 0, savedBytes: 0, label: formatBytes(0) + ' gespart' };
    }
    const store = W.GrimoireStore || null;
    let strokeStats = { strokes: 0, removed: 0, kept: 0 };
    let images = 0, imgSaved = 0;
    const totalBooks = state.books.length;
    // 1) Strokes: synchron, billig, immer möglich.
    for (let bi = 0; bi < state.books.length; bi++) {
      const r = simplifyBookStrokes(state.books[bi]);
      strokeStats.strokes += r.strokes;
      strokeStats.removed += r.removed;
      strokeStats.kept += r.kept;
    }
    // Grob: ~12 Byte pro entferntem Punkt (x,y,p + JSON-Overhead).
    let savedBytes = strokeStats.removed * 12;
    say('Optimiere Bibliothek … Strokes vereinfacht (' + strokeStats.removed + ' Punkte), prüfe Bilder …');
    // 2) Bilder: nur mit Canvas + Store (Fehler pro Bild tolerant).
    if (store && hasCanvas()) {
      let n = 0;
      for (const book of state.books) {
        if (!book || !Array.isArray(book.pages)) continue;
        for (const page of book.pages) {
          const slots = [];
          if (page && Array.isArray(page.images)) {
            for (const im of page.images) if (im && im.src) slots.push({ obj: im, key: 'src' });
          }
          if (page && page.bg) slots.push({ obj: page, key: 'bg' });
          for (const slot of slots) {
            const ref = slot.obj[slot.key];
            if (typeof ref !== 'string' || (!ref.startsWith('blob:') && !ref.startsWith('data:'))) continue;
            n++;
            if (n % 5 === 0) say('Optimiere Bibliothek … Bild ' + n + ' …');
            try {
              const du = ref.startsWith('data:') ? ref : await store.dataUrl(ref);
              if (!du || !du.startsWith('data:')) continue;
              const parsed = parseDataUrl(du);
              if (parsed.mime === 'application/pdf') continue;
              const before = parsed.bytes.length;
              const out = await optimizeImageAdaptive(parsed.bytes, parsed.mime, { context: 'page' });
              if (out && out.optimized && out.bytes && out.bytes.length < before) {
                const rec = { mime: out.mime, bytes: out.bytes };
                let newRef = null;
                try {
                  if (typeof Blob !== 'undefined' && store.putBlob) {
                    newRef = await store.putBlob(new Blob([rec.bytes], { type: rec.mime }));
                    // putBlob ohne IDB fällt auf dataURL zurück – ok.
                    if (newRef && !newRef.startsWith('blob:') && !newRef.startsWith('data:')) newRef = null;
                  } else if (store.putDataUrl) {
                    newRef = await store.putDataUrl(bytesToDataUrl(rec.bytes, rec.mime));
                  }
                } catch { newRef = null; }
                if (newRef) {
                  slot.obj[slot.key] = newRef;
                  images++;
                  imgSaved += before - out.bytes.length;
                }
              }
            } catch { /* einzelnes Bild überspringen */ }
          }
        }
      }
    }
    savedBytes += imgSaved;
    const stats = {
      strokes: strokeStats.strokes,
      removed: strokeStats.removed,
      images,
      savedBytes,
      label: formatBytes(savedBytes) + ' gespart',
    };
    try {
      if (store && store.saveSoon) store.saveSoon(state);
      else if (store && store.saveNow) await store.saveNow(state);
    } catch { /* ignore */ }
    try {
      if (W.renderLibrary) W.renderLibrary();
      else if (W.renderAll) W.renderAll();
    } catch { /* ignore */ }
    say('Bibliothek optimiert: ' + stats.label +
      ' (' + stats.removed + ' Punkte, ' + stats.images + ' Bilder, ' +
      totalBooks + ' Bücher) · ' + new Date().toLocaleTimeString('de-DE'));
    savedSay(stats);
    return stats;
  }

  if (typeof window !== 'undefined') {
    window.FederwerkOptimize = Optimize;
    window.FederwerkOptimizeUI = { optimizeLibrary };
    try {
      document.addEventListener('DOMContentLoaded', () => {
        // Anzeige initialisieren, falls Button/Span eingebunden sind.
        savedSay({ label: '–' });
      });
    } catch { /* ignore */ }
  }
  if (typeof globalThis !== 'undefined' && typeof window === 'undefined') {
    try { globalThis.FederwerkOptimize = Optimize; } catch { /* ignore */ }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = Optimize;
})();
