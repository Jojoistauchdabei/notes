/* Federwerk – Import-als-neue-Seite Helfer (SPEC-32 + SPEC-15, ohne Cloud).
 *
 * Reine, DOM-freie Helfer für Bild-/PDF-Import als neue Seite(n).
 * - Kein Build, plain <script> (global `PagesImport`) + Node-export für Tests.
 * - DOM-Flows (Canvas-Resize, pdf.js-Render, Blob-Store, Navigation) leben in
 *   js/app.js (importImageAsNewPage, importPdfAsNewPages, Handler) und nutzen
 *   diese Helfer über `PagesImport`.
 */
(function () {
  'use strict';

  const MAX_IMAGE_LONG_EDGE = 1600;
  const PDF_TARGET_W = 1000;
  const OFFLINE_PHRASE = 'PDF-Hintergrund offline nicht ladbar';

  /* ---------- Seitenformate: unterschiedlich große Seiten in einem Dokument ----------
   * Jede Seite darf optional `size = { w, h }` tragen (Canvas-Einheiten).
   * Fehlt size (oder ungültig) -> Default A4-Hoch (1000×1414), d. h. Altbestand
   * und GoodNotes-Importe (fix auf A4 gemappt) bleiben unverändert.
   * Breite 1000 = Referenz (Stiftstärken/Fonts wie bisher); Bild-/PDF-Seiten
   * übernehmen ihr natives Seitenverhältnis bei Breite 1000. */
  const PAGE_DEFAULT_W = 1000, PAGE_DEFAULT_H = 1414;
  const PAGE_MIN_EDGE = 200, PAGE_MAX_EDGE = 2400;
  const PAGE_FORMATS = {
    a4p: { w: 1000, h: 1414 },
    a4l: { w: 1414, h: 1000 },
    square: { w: 1000, h: 1000 },
  };

  /* size sanitizen -> {w,h} | null (null = Default A4-Hoch, wird nicht
   * persistiert, damit alte Exporte/Leser unverändert funktionieren). */
  function sanitizePageSize(v) {
    if (v == null) return null;
    if (typeof v === 'string') {
      const preset = PAGE_FORMATS[v];
      if (preset) v = preset;
      else return null;
    }
    if (!v || typeof v !== 'object') return null;
    let w = Math.round(Number(v.w)), h = Math.round(Number(v.h));
    if (!isFiniteNum(w) || !isFiniteNum(h)) return null;
    w = Math.min(PAGE_MAX_EDGE, Math.max(PAGE_MIN_EDGE, w));
    h = Math.min(PAGE_MAX_EDGE, Math.max(PAGE_MIN_EDGE, h));
    // Exakter Default -> null (kein Ballast im State)
    if (w === PAGE_DEFAULT_W && h === PAGE_DEFAULT_H) return null;
    return { w, h };
  }

  /* Effektive Maße einer Seite (immer gültig, nie null). */
  function pageDims(page) {
    const s = sanitizePageSize(page && page.size);
    if (s) return s;
    return { w: PAGE_DEFAULT_W, h: PAGE_DEFAULT_H };
  }

  /* Preset-Key für ein size-Objekt ('a4p'|'a4l'|'square'|null=custom/default). */
  function matchPageFormat(size) {
    if (size == null) return 'a4p';
    const s = sanitizePageSize(size);
    // null nach sanitize == Default == a4p
    if (!s) return 'a4p';
    for (const k of Object.keys(PAGE_FORMATS)) {
      if (PAGE_FORMATS[k].w === s.w && PAGE_FORMATS[k].h === s.h) return k;
    }
    return null;
  }

  function formatLabel(size) {
    const m = matchPageFormat(size);
    if (m === 'a4p') return 'A4 Hoch';
    if (m === 'a4l') return 'A4 Quer';
    if (m === 'square') return 'Quadrat';
    const d = pageDims({ size });
    return 'Bildformat ' + d.w + '×' + d.h;
  }

  /* Natives Bild-/PDF-Seitenverhältnis als Seitengröße (Breite normiert 1000). */
  function sizeForImage(natW, natH) {
    natW = Number(natW); natH = Number(natH);
    if (!isFiniteNum(natW) || !isFiniteNum(natH) || natW <= 0 || natH <= 0) return null;
    return sanitizePageSize({ w: PAGE_DEFAULT_W, h: Math.round(PAGE_DEFAULT_W * natH / natW) });
  }

  /* Strokes beim Formatwechsel proportional umrechnen (Inhalt bleibt sichtbar).
   * Rein: gibt neue Array-Struktur zurück (Punkte kopiert, Rest per Referenz).
   * from/to: {w,h} (pageDims-Ergebnisse); identisch -> Original-Referenz. */
  function retargetStrokes(strokes, from, to) {
    if (!Array.isArray(strokes)) return strokes;
    const fw = Number(from && from.w), fh = Number(from && from.h);
    const tw = Number(to && to.w), th = Number(to && to.h);
    if (!isFiniteNum(fw) || !isFiniteNum(fh) || !isFiniteNum(tw) || !isFiniteNum(th) || fw <= 0 || fh <= 0) return strokes;
    const sx = tw / fw, sy = th / fh;
    if (sx === 1 && sy === 1) return strokes;
    return strokes.map(s => {
      if (!s || !Array.isArray(s.points)) return s;
      const size = (typeof s.size === 'number' && isFinite(s.size) && s.size > 0)
        ? Math.max(0.5, Math.round(s.size * (sx + sy) / 2 * 100) / 100) : s.size;
      const dash = Array.isArray(s.dash) && s.dash.length
        ? s.dash.map(d => (typeof d === 'number' && isFinite(d)) ? Math.max(0, Math.round(d * (sx + sy) / 2 * 100) / 100) : d)
        : s.dash;
      const out = Object.assign({}, s, {
        points: s.points.map(p => (p && typeof p.x === 'number' && typeof p.y === 'number')
          ? Object.assign({}, p, { x: Math.round(p.x * sx * 10) / 10, y: Math.round(p.y * sy * 10) / 10 })
          : p),
      });
      if (size !== s.size) out.size = size;
      if (dash !== s.dash) out.dash = dash;
      return out;
    });
  }

  /* Canvas-Backing (Gerätepixel) für Seitengröße: dpr gedeckelt, damit große
   * Formate nicht den GPU-Speicher sprengen (Ziel: <= ~9 MP pro Canvas). */
  function backingForPage(w, h, deviceDpr) {
    w = Number(w); h = Number(h);
    if (!isFiniteNum(w) || !isFiniteNum(h) || w <= 0 || h <= 0) { w = PAGE_DEFAULT_W; h = PAGE_DEFAULT_H; }
    let dpr = Number(deviceDpr);
    if (!isFiniteNum(dpr) || dpr <= 0) dpr = 1;
    dpr = Math.min(2, dpr);
    const cap = Math.sqrt(9000000 / (w * h));
    if (cap < dpr) dpr = Math.max(0.5, Math.floor(cap * 4) / 4);
    return { w: Math.max(1, Math.round(w * dpr)), h: Math.max(1, Math.round(h * dpr)), dpr };
  }

  function optimizer() {
    try {
      if (typeof window !== 'undefined' && window.FederwerkOptimize) return window.FederwerkOptimize;
      if (typeof globalThis !== 'undefined' && globalThis.FederwerkOptimize) return globalThis.FederwerkOptimize;
    } catch { /* ignore */ }
    return null;
  }

  /* Bild-dataURL beim Import komprimieren (Seiten-Kontext, Aufgabe 4).
   * Nutzt die zentrale Lib, fällt ohne Canvas/Lib auf das Original zurück.
   * Rein aufrufbar, DOM-frei testbar (Fallback-Pfad ohne Canvas). */
  async function compressImageDataUrl(dataUrl, context) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return dataUrl;
    try {
      const O = optimizer();
      if (O && O.downscaleDataUrl) return await O.downscaleDataUrl(dataUrl, context || 'page');
    } catch { /* ignore, Fallback unten */ }
    return dataUrl;
  }

  function isFiniteNum(n) {
    return typeof n === 'number' && isFinite(n);
  }

  /* Skalierungsfaktor, damit lange Kante <= limit (nie hochskalieren). */
  function scaleForLongEdge(w, h, limit) {
    limit = limit || MAX_IMAGE_LONG_EDGE;
    if (!isFiniteNum(w) || !isFiniteNum(h) || w <= 0 || h <= 0) return 1;
    if (!isFiniteNum(limit) || limit <= 0) return 1;
    const longest = Math.max(w, h);
    if (longest <= limit) return 1;
    return limit / longest;
  }

  /* Zielgröße (gerundet, mind. 1px) für Limit der langen Kante. */
  function scaledSizeForLimit(w, h, limit) {
    limit = limit || MAX_IMAGE_LONG_EDGE;
    const sc = scaleForLongEdge(w, h, limit);
    return {
      w: Math.max(1, Math.round(w * sc)),
      h: Math.max(1, Math.round(h * sc)),
      scale: sc,
    };
  }

  /* Contain-Fit: Quelle proportional in Ziel-Rechteck einpassen (z. B. Canvas).
   * Gibt { w, h, scale, dx, dy } zurück (dx/dy = zentrierte Offsets im Ziel).
   * Skaliert auch hoch (für Thumbnails); ungültige Eingaben -> Nullen. */
  function calcContainSize(srcW, srcH, dstW, dstH) {
    if (!isFiniteNum(srcW) || !isFiniteNum(srcH) || srcW <= 0 || srcH <= 0 ||
        !isFiniteNum(dstW) || !isFiniteNum(dstH) || dstW <= 0 || dstH <= 0) {
      return { w: 0, h: 0, scale: 0, dx: 0, dy: 0 };
    }
    const scale = Math.min(dstW / srcW, dstH / srcH);
    const w = srcW * scale;
    const h = srcH * scale;
    return { w, h, scale, dx: (dstW - w) / 2, dy: (dstH - h) / 2 };
  }

  function genId() {
    try {
      if (typeof uid === 'function') return uid();
    } catch { /* ignore, Fallback unten */ }
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  /* Neues leeres Seitenmodell (Ink leer, Layer-Trennung: bg separat).
   * opts: undefined | string (wird als id genutzt, leer -> generieren)
   *     | { id?, bg?, title?, size? } (title wird als optionales Label abgelegt,
   *       NICHT als Textbox – Ink bleibt leer; size = {w,h} oder Preset-Key,
   *       null/Default = A4-Hoch und wird nicht persistiert). */
  function buildNewPageModel(opts) {
    let id = null;
    let bg = null;
    let title = null;
    let size = null;
    if (typeof opts === 'string') {
      if (opts) id = opts;
    } else if (opts && typeof opts === 'object') {
      if (typeof opts.id === 'string' && opts.id) id = opts.id;
      if (typeof opts.bg === 'string' && opts.bg) bg = opts.bg;
      else if (opts.bg == null) bg = null;
      if (typeof opts.title === 'string' && opts.title) title = opts.title;
      if (opts.size != null) size = sanitizePageSize(opts.size);
    }
    const page = { id: id || genId(), strokes: [], texts: [], images: [], bg };
    if (size) page.size = size;
    if (title) page.title = title;
    return page;
  }

  /* Seitenbereich-Parser für PDF-Import („1-3,5", „2", „ 1 - 2 , 5 ").
   * - rangeStr leer/null -> alle Seiten 1..total
   * - Bereiche inklusiv, gedreht („3-1") wird normalisiert
   * - ungültige Tokens werden ignoriert, Ergebnis sortiert + deduped,
   *   auf 1..total geclampt. total<=0 -> []. */
  function parsePageRange(rangeStr, totalPages) {
    totalPages = Math.floor(Number(totalPages));
    if (!isFiniteNum(totalPages) || totalPages <= 0) return [];
    if (rangeStr == null || String(rangeStr).trim() === '') {
      const all = [];
      for (let i = 1; i <= totalPages; i++) all.push(i);
      return all;
    }
    const out = new Set();
    const parts = String(rangeStr).split(',');
    for (let raw of parts) {
      raw = raw.trim();
      if (!raw) continue;
      const mRange = /^(\d+)\s*-\s*(\d+)$/.exec(raw);
      if (mRange) {
        let a = parseInt(mRange[1], 10);
        let b = parseInt(mRange[2], 10);
        if (!isFinite(a) || !isFinite(b)) continue;
        if (a > b) { const t = a; a = b; b = t; }
        for (let n = a; n <= b; n++) {
          if (n >= 1 && n <= totalPages) out.add(n);
        }
        continue;
      }
      const mSingle = /^(\d+)$/.exec(raw);
      if (mSingle) {
        const n = parseInt(mSingle[1], 10);
        if (n >= 1 && n <= totalPages) out.add(n);
        continue;
      }
      // Rest (z. B. „abc", „-", „2-") tolerant ignorieren
    }
    return Array.from(out).sort((x, y) => x - y);
  }
  // Alias in SPEC-32-Wording („pageRangeParser „1-3,5"")
  const pageRangeParser = parsePageRange;

  /* Hinweis-HTML für Offline-Fallback (enthält OFFLINE_PHRASE). */
  function offlinePdfFallbackHtml(fileName, pageNo) {
    const bits = [];
    if (fileName) bits.push(String(fileName));
    if (pageNo != null) bits.push('Seite ' + pageNo);
    const suffix = bits.length ? ' (' + bits.join(', ') + ')' : '';
    const e = String(suffix).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return '<p><i>' + OFFLINE_PHRASE + e + ' – pdf.js konnte nicht geladen werden.</i></p>';
  }

  /* Statuszeilen-Text für sequentiellen PDF-Import. */
  function pdfImportStatus(done, total, fileName) {
    const name = fileName ? ' ' + String(fileName) : '';
    return 'Importiere PDF' + name + ' – Seite ' + done + '/' + total + ' …';
  }

  /* ---------- Dokument-in-Dokument-Import (Seiten übernehmen) ----------
   * clonePagesForImport(sourcePages, wanted): tiefe Kopie mit frischen IDs
   * (Strokes/Texte/Bilder/bg bleiben erhalten, blob:-Refs werden geteilt –
   * kein Byte-Copy nötig, Store-GC gibt es in V1 nicht).
   * wanted: null/undefined = alle; sonst Liste von 1-basierten Seiten-Nr.
   * buildTemplatePage(sourcePage): "saubere" Kopie OHNE Handschrift
   * (strokes), OHNE Textfelder (texts), OHNE Marker – Marker sind Strokes
   * mit tool==='marker', werden also mit strokes entfernt. Übrig bleibt
   * nur das Struktur-Gerüst: id neu, bg übernommen, images leer.
   * (Bilder-Overlays zählen als Inhalt, nicht als Vorlage – bewusst leer.) */
  function clonePagesForImport(sourcePages, wanted) {
    if (!Array.isArray(sourcePages)) return [];
    let idxs = null;
    if (Array.isArray(wanted) && wanted.length) {
      const set = new Set(wanted.map(n => Math.floor(Number(n))).filter(n => isFinite(n) && n >= 1 && n <= sourcePages.length));
      idxs = Array.from(set).sort((a, b) => a - b).map(n => n - 1);
    } else {
      idxs = sourcePages.map((_, i) => i);
    }
    return idxs.map(i => {
      const src = sourcePages[i] || { strokes: [], texts: [], images: [], bg: null };
      let copy;
      try { copy = JSON.parse(JSON.stringify(src)); } catch { copy = { strokes: [], texts: [], images: [], bg: null }; }
      copy.id = genId();
      if (!Array.isArray(copy.strokes)) copy.strokes = [];
      if (!Array.isArray(copy.texts)) copy.texts = [];
      if (!Array.isArray(copy.images)) copy.images = [];
      if (typeof copy.bg !== 'string') copy.bg = copy.bg || null;
      // Seitenformat übernehmen (fremde/ungültige Werte -> Default/A4)
      const cSize = sanitizePageSize(copy.size);
      if (cSize) copy.size = cSize;
      else delete copy.size;
      (copy.texts || []).forEach(t => { t.id = genId(); });
      (copy.images || []).forEach(im => { im.id = genId(); });
      // Marker-/Ink-Strokes brauchen keine neuen IDs (anonyme Punkte), Punkte bleiben.
      return copy;
    });
  }

  function buildTemplatePage(sourcePage) {
    const src = (sourcePage && typeof sourcePage === 'object') ? sourcePage : null;
    const page = buildNewPageModel({});
    page.bg = (src && typeof src.bg === 'string') ? src.bg : null;
    // Vorlage übernimmt das Seitenformat (sonst wäre sie kein Abbild der Seite)
    const size = sanitizePageSize(src && src.size);
    if (size) page.size = size;
    page.strokes = [];
    page.texts = [];
    page.images = [];
    return page;
  }

  const api = {
    MAX_IMAGE_LONG_EDGE,
    PDF_TARGET_W,
    OFFLINE_PHRASE,
    PAGE_DEFAULT_W,
    PAGE_DEFAULT_H,
    PAGE_FORMATS,
    sanitizePageSize,
    pageDims,
    matchPageFormat,
    formatLabel,
    sizeForImage,
    retargetStrokes,
    backingForPage,
    scaleForLongEdge,
    scaledSizeForLimit,
    calcContainSize,
    compressImageDataUrl,
    buildNewPageModel,
    parsePageRange,
    pageRangeParser,
    offlinePdfFallbackHtml,
    pdfImportStatus,
    clonePagesForImport,
    buildTemplatePage,
  };

  if (typeof window !== 'undefined') window.PagesImport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
