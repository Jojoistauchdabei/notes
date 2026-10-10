/* Federwerk Speicherverbrauchstracker (Statuszeile + Dialog).
 *
 * - Reine, DOM-freie Helfer (Node-testbar): formatBytes, localStorageBytes,
 *   collectStateStats, summarize.
 * - Browser-Glue (window.FederwerkStorageUsage): collect() misst
 *   navigator.storage.estimate() (Quota/Usage), localStorage-Bytes,
 *   Blob-Store (GrimoireStore.blobStats) und State-Statistik; Badge in der
 *   Statuszeile + Dialog mit Details und Aufräumen-Buttons.
 * - Kein Build, plain <script> (wie js/store.js / js/optimize.js).
 */
(function () {
  'use strict';

  /* ---------- rein (testbar) ---------- */

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

  // localStorage-Volumen aus injizierbarem Storage (Tests: Memory-Mock).
  function localStorageBytes(ls) {
    let bytes = 0, keys = 0;
    try {
      if (!ls || typeof ls.length !== 'number') return { bytes: 0, keys: 0 };
      keys = ls.length;
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        const v = ls.getItem(k);
        bytes += String(k || '').length + String(v || '').length;
      }
    } catch { /* ignore */ }
    return { bytes, keys };
  }

  // Grobe State-Statistik (Bücher/Seiten/Strokes/Punkte/Texte/Bilder + JSON-Bytes).
  function collectStateStats(state) {
    const out = { books: 0, pages: 0, strokes: 0, points: 0, texts: 0, images: 0, jsonBytes: 0 };
    try {
      const books = (state && Array.isArray(state.books)) ? state.books : [];
      out.books = books.length;
      for (const b of books) {
        if (!b || !Array.isArray(b.pages)) continue;
        for (const p of b.pages) {
          if (!p) continue;
          out.pages++;
          if (Array.isArray(p.strokes)) {
            out.strokes += p.strokes.length;
            for (const s of p.strokes) if (s && Array.isArray(s.points)) out.points += s.points.length;
          }
          if (Array.isArray(p.texts)) out.texts += p.texts.length;
          if (Array.isArray(p.images)) out.images += p.images.length;
          if (p.bg) out.images += 1;
        }
        if (Array.isArray(b.cards)) out.texts += b.cards.length;
      }
      try { out.jsonBytes = (JSON.stringify(state) || '').length; } catch { out.jsonBytes = 0; }
    } catch { /* ignore */ }
    return out;
  }

  // Zusammenfassung für Badge/Dialog. quota/usage kommen aus
  // navigator.storage.estimate() (0 = unbekannt -> level aus Fallback).
  function summarize(o) {
    o = o || {};
    const quota = Math.max(0, Math.round(Number(o.quota) || 0));
    const usage = Math.max(0, Math.round(Number(o.usage) || 0));
    const stateBytes = Math.max(0, Math.round(Number(o.stateBytes) || 0));
    const lsBytes = Math.max(0, Math.round(Number(o.lsBytes) || 0));
    const blobBytes = Math.max(0, Math.round(Number(o.blobBytes) || 0));
    const blobCount = Math.max(0, Math.round(Number(o.blobCount) || 0));
    const quotaPct = quota > 0 ? Math.min(100, Math.round((usage / quota) * 1000) / 10) : 0;
    let level = 'ok';
    if (quota > 0) {
      if (quotaPct >= 90 || usage <= 0 && false) level = 'full';
      else if (quotaPct >= 70) level = 'warn';
      if (quotaPct >= 90) level = 'full';
    } else if (lsBytes > 4 * 1024 * 1024) {
      level = 'warn'; // ohne Quota-API: localStorage-Nähe zum 5MB-Limit warnt
    }
    const label = quota > 0
      ? formatBytes(usage) + ' / ' + formatBytes(quota) + ' (' + String(quotaPct).replace('.', ',') + ' %)'
      : formatBytes(stateBytes + blobBytes) + ' lokal';
    return { quota, usage, quotaPct, stateBytes, lsBytes, blobBytes, blobCount, level, label };
  }

  const Usage = {
    formatBytes, localStorageBytes, collectStateStats, summarize,
    async collect() { return browserCollect(); },
  };

  /* ---------- Browser-Glue ---------- */

  async function browserCollect() {
    const W = (typeof window !== 'undefined') ? window : null;
    let quota = 0, usage = 0;
    try {
      if (W && W.navigator && W.navigator.storage && typeof W.navigator.storage.estimate === 'function') {
        const e = await W.navigator.storage.estimate();
        quota = Number(e && e.quota) || 0;
        usage = Number(e && e.usage) || 0;
      }
    } catch { /* estimate optional */ }
    let lsBytes = 0, lsKeys = 0;
    try {
      if (W && W.localStorage) {
        const r = localStorageBytes(W.localStorage);
        lsBytes = r.bytes; lsKeys = r.keys;
      }
    } catch { /* ignore */ }
    let blobCount = 0, blobBytes = 0;
    try {
      const S = W && W.GrimoireStore;
      if (S && typeof S.blobStats === 'function') {
        const b = await S.blobStats();
        blobCount = Number(b && b.count) || 0;
        blobBytes = Number(b && b.bytes) || 0;
      }
    } catch { /* ignore */ }
    let st = { books: 0, pages: 0, strokes: 0, points: 0, texts: 0, images: 0, jsonBytes: 0 };
    try {
      if (W && W.state) st = collectStateStats(W.state);
    } catch { /* ignore */ }
    const sum = summarize({ quota, usage, stateBytes: st.jsonBytes, lsBytes, blobBytes, blobCount });
    return { quota, usage, lsBytes, lsKeys, blobCount, blobBytes, state: st, summary: sum, at: Date.now() };
  }

  function el(id) {
    try { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
    catch { return null; }
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function refreshBadge() {
    const badge = el('storageBadge');
    if (!badge) return null;
    badge.textContent = '💾 …';
    badge.classList.remove('warn', 'full');
    try {
      const r = await browserCollect();
      const icon = r.summary.level === 'full' ? '🟥' : r.summary.level === 'warn' ? '🟨' : '💾';
      badge.textContent = icon + ' ' + r.summary.label;
      badge.title = 'Speicher: ' + r.summary.label + ' · ' + r.blobCount + ' Bilder, ' +
        r.state.books + ' Bücher/' + r.state.pages + ' Seiten · Klicken für Details';
      if (r.summary.level === 'warn') badge.classList.add('warn');
      if (r.summary.level === 'full') badge.classList.add('full');
      return r;
    } catch {
      badge.textContent = '💾 –';
      return null;
    }
  }

  async function openDialog() {
    const ov = el('storageOverlay');
    const body = el('storageBody');
    if (!ov || !body) return;
    ov.style.display = 'flex';
    body.innerHTML = '<div style="font-size:13px;opacity:.75">Messe …</div>';
    try {
      const r = await browserCollect();
      const s = r.summary;
      body.innerHTML =
        '<div class="storage-grid">' +
        '<div><span>Browser-Quota (gesamt)</span><b>' + esc(s.label) + '</b></div>' +
        '<div><span>Notiz-State (JSON)</span><b>' + esc(formatBytes(r.state.jsonBytes)) + '</b></div>' +
        '<div><span>Bild-Blobs (IndexedDB)</span><b>' + esc(formatBytes(r.blobBytes)) + ' · ' + esc(String(r.blobCount)) + ' Dateien</b></div>' +
        '<div><span>localStorage (Backup)</span><b>' + esc(formatBytes(r.lsBytes)) + ' · ' + esc(String(r.lsKeys)) + ' Keys</b></div>' +
        '<div><span>Inhalt</span><b>' + esc(String(r.state.books)) + ' Bücher · ' + esc(String(r.state.pages)) +
        ' Seiten · ' + esc(String(r.state.strokes)) + ' Strokes · ' + esc(String(r.state.texts)) + ' Texte/Karten</b></div>' +
        '</div>' +
        '<div style="font-size:12px;opacity:.75;margin-top:8px">Tipp: „Bibliothek optimieren“ komprimiert Strokes + Bilder (siehe Ersparnis in ☁ Server-Sync). Große PDFs/Bilder als Erstes prüfen.</div>';
      const badge = el('storageBadge');
      if (badge) {
        const icon = s.level === 'full' ? '🟥' : s.level === 'warn' ? '🟨' : '💾';
        badge.textContent = icon + ' ' + s.label;
      }
    } catch {
      body.innerHTML = '<div style="font-size:13px">Messung fehlgeschlagen.</div>';
    }
  }
  function closeDialog() {
    const ov = el('storageOverlay');
    if (ov) ov.style.display = 'none';
  }

  if (typeof window !== 'undefined') {
    window.FederwerkStorageUsage = Object.assign({}, Usage, {
      refreshBadge, openDialog, closeDialog,
    });
    try {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => { refreshBadge().catch(() => {}); }, 1200);
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) refreshBadge().catch(() => {});
        });
        window.addEventListener('storage-refresh', () => refreshBadge().catch(() => {}));
      });
    } catch { /* ignore */ }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = Usage;
})();
