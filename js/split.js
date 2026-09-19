/* Federwerk – Split-Screen-Modell (2 Dokumente in einem Fenster).
 *
 * DOM-freie, testbare Zustandslogik für zwei nebeneinanderliegende
 * Dokumentbereiche (Panes). Das Rendering/DOM lebt in js/app.js + index.html,
 * hier nur: welcher Pane zeigt welches Buch/welche Seite, welcher ist aktiv,
 * Split an/aus, Tausch, Breitenverhältnis.
 *
 * - Kein Build, plain <script> (global `GrimoireSplit`) + Node-export für Tests.
 */
(function () {
  'use strict';

  const MIN_RATIO = 0.2;
  const MAX_RATIO = 0.8;

  function normIdx(i) { return i === 1 ? 1 : 0; }

  function clampRatio(r) {
    const v = Number(r);
    if (!isFinite(v)) return 0.5;
    return Math.min(MAX_RATIO, Math.max(MIN_RATIO, v));
  }

  function blankPane() { return { bookId: null, pageId: null }; }

  /* Neuer Split-State: Pane 0 = aktuelles Dokument, Pane 1 = leer. */
  function createSplitState(bookId, pageId) {
    return {
      enabled: false,
      active: 0,
      ratio: 0.5,
      panes: [
        { bookId: bookId || null, pageId: pageId || null },
        blankPane(),
      ],
    };
  }

  function isEnabled(s) { return !!(s && s.enabled && s.panes && s.panes.length === 2); }

  function activeIndex(s) { return s && s.active === 1 ? 1 : 0; }

  function getPane(s, idx) {
    if (!s || !Array.isArray(s.panes)) return blankPane();
    return s.panes[normIdx(idx)] || blankPane();
  }

  function setActive(s, idx) {
    if (!s) return null;
    s.active = normIdx(idx);
    return s.active;
  }

  function setPaneDoc(s, idx, bookId, pageId) {
    if (!s || !Array.isArray(s.panes)) return false;
    const i = normIdx(idx);
    s.panes[i] = { bookId: bookId || null, pageId: pageId || null };
    return true;
  }

  /* Split einschalten: Pane 1 bekommt (bookId/pageId) oder kopiert Pane 0. */
  function enableSplit(s, bookId, pageId) {
    if (!s) return false;
    s.enabled = true;
    if (!Array.isArray(s.panes) || s.panes.length !== 2) {
      s.panes = [blankPane(), blankPane()];
    }
    if (bookId) {
      s.panes[1] = { bookId: bookId || null, pageId: pageId || null };
    } else if (!s.panes[1] || !s.panes[1].bookId) {
      s.panes[1] = { bookId: s.panes[0] ? s.panes[0].bookId : null, pageId: s.panes[0] ? s.panes[0].pageId : null };
    }
    if (typeof s.ratio !== 'number') s.ratio = 0.5;
    s.ratio = clampRatio(s.ratio);
    return true;
  }

  function disableSplit(s, keepIdx) {
    if (!s) return false;
    const keep = normIdx(keepIdx == null ? s.active : keepIdx);
    if (Array.isArray(s.panes) && s.panes[keep]) {
      s.panes[0] = { bookId: s.panes[keep].bookId || null, pageId: s.panes[keep].pageId || null };
    }
    s.panes[1] = blankPane();
    s.enabled = false;
    s.active = 0;
    return true;
  }

  function swapPanes(s) {
    if (!s || !Array.isArray(s.panes) || s.panes.length !== 2) return false;
    const t = s.panes[0];
    s.panes[0] = s.panes[1];
    s.panes[1] = t;
    s.active = s.active === 1 ? 0 : 1;
    return true;
  }

  function setRatio(s, r) {
    if (!s) return 0.5;
    s.ratio = clampRatio(r);
    return s.ratio;
  }

  /* Nach Buch-Löschung: betroffene Panes auf null/anderes Buch zurücksetzen. */
  function handleBookDeleted(s, deletedBookId, fallback) {
    if (!s || !Array.isArray(s.panes)) return false;
    let changed = false;
    s.panes.forEach((p) => {
      if (p && p.bookId === deletedBookId) {
        p.bookId = (fallback && fallback.bookId) || null;
        p.pageId = (fallback && fallback.pageId) || null;
        changed = true;
      }
    });
    return changed;
  }

  /* Serialisierung für persistNow/state (nur IDs + Ratio, kein Ink). */
  function serialize(s) {
    if (!s) return null;
    return {
      enabled: !!s.enabled,
      active: activeIndex(s),
      ratio: clampRatio(s.ratio),
      panes: [getPane(s, 0), getPane(s, 1)].map((p) => ({ bookId: p.bookId || null, pageId: p.pageId || null })),
    };
  }

  function restore(raw) {
    const s = createSplitState();
    if (!raw || typeof raw !== 'object') return s;
    s.enabled = !!raw.enabled;
    s.active = normIdx(raw.active);
    s.ratio = clampRatio(raw.ratio);
    if (Array.isArray(raw.panes)) {
      for (let i = 0; i < 2; i++) {
        const p = raw.panes[i];
        if (p && typeof p === 'object') {
          s.panes[i] = {
            bookId: typeof p.bookId === 'string' ? p.bookId : null,
            pageId: typeof p.pageId === 'string' ? p.pageId : null,
          };
        }
      }
    }
    if (!s.enabled) { s.active = 0; }
    return s;
  }

  const api = {
    MIN_RATIO,
    MAX_RATIO,
    createSplitState,
    isEnabled,
    activeIndex,
    getPane,
    setActive,
    setPaneDoc,
    enableSplit,
    disableSplit,
    swapPanes,
    setRatio,
    clampRatio,
    handleBookDeleted,
    serialize,
    restore,
  };

  if (typeof window !== 'undefined') window.GrimoireSplit = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
