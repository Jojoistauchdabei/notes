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
   *     | { id?, bg?, title? } (title wird als optionales Label abgelegt,
   *       NICHT als Textbox – Ink bleibt leer). */
  function buildNewPageModel(opts) {
    let id = null;
    let bg = null;
    let title = null;
    if (typeof opts === 'string') {
      if (opts) id = opts;
    } else if (opts && typeof opts === 'object') {
      if (typeof opts.id === 'string' && opts.id) id = opts.id;
      if (typeof opts.bg === 'string' && opts.bg) bg = opts.bg;
      else if (opts.bg == null) bg = null;
      if (typeof opts.title === 'string' && opts.title) title = opts.title;
    }
    const page = { id: id || genId(), strokes: [], texts: [], images: [], bg };
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
    page.strokes = [];
    page.texts = [];
    page.images = [];
    return page;
  }

  const api = {
    MAX_IMAGE_LONG_EDGE,
    PDF_TARGET_W,
    OFFLINE_PHRASE,
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
