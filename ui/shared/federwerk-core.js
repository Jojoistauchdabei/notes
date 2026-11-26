/* ============================================================================
 * ui/shared/federwerk-core.js
 * GEMEINSAME BASIS / Shared JS-Module fuer Business-Logik.
 *
 * Beide Varianten (ui/shadcn + ui/liquid) laden EXAKT dieselben App-Module
 * aus js/ (Single Source of Truth: Canvas, Sync, Export, GoodNotes-Import,
 * Split, Liveshare, Office, Flashcards, ...). Diese Datei dupliziert KEINE
 * Logik; sie stellt eine sichere Fassade `window.FederwerkCore` bereit, die
 * App-Globals zur Laufzeit aufloest (nachdem js/app.js gelaufen ist) und
 * Helfer buendelt. UI-spezifisches bleibt in ui/shared + ui/<variante>.
 * ========================================================================== */
(function () {
  'use strict';
  var W = window;

  /* Namespaces, die die App selbst exportiert (window.*), sicher zugreifen. */
  var NS = ['FederwerkInk', 'FederwerkCanvas', 'FederwerkPencil', 'FederwerkErase',
    'FederwerkPaper', 'FederwerkDialog', 'FederwerkLive', 'FederwerkSyncUI',
    'FederwerkFilesUI', 'FederwerkOptimizeUI', 'FederwerkThemes', 'FederwerkInkIndex',
    'GrimoireFolders', 'PagesImport', 'OfficeDoc', 'FederwerkOffice', 'FederwerkCraft',
    'FederwerkSanitize', 'FederwerkSha256', 'FederwerkMD', 'FederwerkFormatDoc'];

  /* Globale Funktionen der App, die beide Varianten nutzen. */
  var FNS = ['openCanvasFlow', 'setTool', 'setColor', 'setSize', 'setEraserMode',
    'undo', 'redo', 'clearPage', 'showLibrary', 'showBook', 'openBook', 'createNotebook',
    'createFolderUI', 'createFlashDeck', 'createOfficeDoc', 'exportAllJSON', 'importAllJSON',
    'importGoodNotes', 'importImage', 'importImageAsPage', 'importPdfAsPages', 'openDocImportDialog',
    'duplicatePageAsTemplate', 'duplicatePageInPane', 'addPageInPane', 'deletePageInPane',
    'exportPagePNGInPane', 'clearPageBgInPane', 'setPaper', 'setPaperInPane', 'setPageSizeInPane',
    'openTextEditorForSelected', 'closeTextEditor', 'saveTextEditor', 'toggleSplit', 'swapSplitPanes',
    'closeSplit', 'setActivePane', 'activePaneIdx', 'setSplitRatio', 'presentToggle', 'presentStop',
    'openGraphOverlay', 'closeGraphOverlay', 'openCraftOverlay', 'closeCraftOverlay',
    'renderLibrarySoon', 'renameBook', 'renameBookInPane', 'openBookInPane', 'setFingerDraw',
    'setEraserHighlighterOnly', 'openFlashDeck', 'toggleEditorMode', 'applyEditorFormat',
    'openPagePreview', 'closePagePreview', 'stepPreview', 'openPreviewPage', 'windowPrint'];

  function ns(name) { try { return W[name]; } catch (e) { return undefined; } }

  /* sicherer Call: no-op + console.warn wenn App-Fn (noch) nicht da */
  function call(name /*, ...args */) {
    var args = Array.prototype.slice.call(arguments, 1);
    var fn = W[name];
    if (typeof fn !== 'function') { if (W.console) console.warn('[FederwerkCore] Funktion nicht verfuegbar:', name); return undefined; }
    return fn.apply(W, args);
  }

  /* Event-Bus, den beide Varianten teilen koennen */
  var bus = W.FederwerkBus || (W.FederwerkBus = { _l: {},
    on: function (ev, fn) { (this._l[ev] = this._l[ev] || []).push(fn); return this; },
    off: function (ev, fn) { var a = this._l[ev] || []; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); return this; },
    emit: function (ev, data) { (this._l[ev] || []).slice().forEach(function (fn) { try { fn(data); } catch (e) {} }); return this; }
  });

  W.FederwerkCore = {
    ns: ns, call: call, bus: bus,
    NS: NS, FNS: FNS,
    namespaces: function () { var o = {}; NS.forEach(function (n) { o[n] = ns(n); }); return o; },
    ready: function (fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); },
    /* app.js ist klassisches Script (keine Module); Sync-Hooks nach Laden. */
    onAppReady: function (fn) { W.FederwerkCore.ready(function () { fn(W.FederwerkCore); }); }
  };
})();
