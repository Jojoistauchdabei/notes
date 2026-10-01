// Federwerk Service Worker: App-Shell precachen, Rest per Stale-While-Revalidate.
// - dist/sw.js wird von scripts/build-dist.js umgeschrieben (Bundle-Hash statt
//   Einzeldateien) + per inject-version.js auf die Release-Version gestempelt.
// - Hinweis: js/updater.js ist im Release-Bundle js/app.bundle.*.js enthalten.
//   js/themes.js wird bewusst NICHT gebündelt (es laeuft synchron im <head>,
//   um data-theme vor dem ersten Paint zu setzen) und steht deshalb hier im
//   Precache: faellt es aus, gaebe es beim Offline-Start kein Theme-System
//   und damit auch kein Hell/Dunkel. Die Theme-Stylesheets unter css/themes/
//   sind nicht im Precache, sondern werden nach dem Start bei Bedarf
//   gecacht (Stale-While-Revalidate unten) – so bleibt die App-Shell schlank.
const CACHE = 'federwerk-v1.9.0';
const ASSETS = ['.', 'index.html', 'agent.html', 'present.html', 'css/styles.css', 'js/themes.js', 'js/sanitize.js', 'js/pencil.js', 'js/inkdraw.js', 'js/folders.js', 'js/split.js', 'js/markdown.js', 'js/editor.js', 'js/gnzip.js', 'js/goodnotes.js', 'js/gnpdf-worker.js', 'js/optimize.js', 'js/store.js', 'js/pages-import.js', 'js/paper-templates.js', 'js/erase.js', 'js/laser.js', 'js/ink-index.js', 'js/graph.js', 'js/search.js', 'js/format-doc.js', 'js/pageflow.js', 'js/presentflow.js', 'js/flashcards.js', 'js/dialog.js', 'js/app.js', 'js/flash-ui.js', 'js/present.js', 'js/present-view.js', 'js/appwrite-files.js', 'js/appwrite-sync.js', 'js/liveshare.js', 'js/updater.js', 'manifest.webmanifest', 'altes_Papier.webp', 'altes_Papier.jpg', 'icons/logo.svg', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()).catch(() => {}));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Navigationen: Netzwerk zuerst, offline auf die App-Shell zurückfallen.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('index.html', copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match('index.html')));
    return;
  }
  // Statische Assets: Cache zuerst, im Hintergrund aktualisieren.
  // /mcp (KI-Doku) und /mcp/ (API) werden nicht gecacht: Doku soll frisch
  // sein, die API ist ohnehin dynamisch (Bearer).
  if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/') || req.headers.has('authorization')) return;
  e.respondWith(caches.match(req).then((hit) => {
    const miss = fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => hit);
    return hit || miss;
  }));
});
