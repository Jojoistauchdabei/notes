const CACHE = 'federwerk-v1.8.0';
const ASSETS = ['.', 'index.html', 'css/styles.css', 'js/pencil.js', 'js/folders.js', 'js/split.js', 'js/markdown.js', 'js/editor.js', 'js/gnzip.js', 'js/goodnotes.js', 'js/gnpdf-worker.js', 'js/optimize.js', 'js/store.js', 'js/pages-import.js', 'js/paper-templates.js', 'js/erase.js', 'js/ink-index.js', 'js/graph.js', 'js/search.js', 'js/format-doc.js', 'js/flashcards.js', 'js/app.js', 'js/flash-ui.js', 'js/appwrite-files.js', 'js/appwrite-sync.js', 'js/liveshare.js', 'js/updater.js', 'manifest.webmanifest', 'altes_Papier.png', 'icons/logo.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'screenshots/preview-wide.png', 'screenshots/preview-narrow.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()).catch(() => {}));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match('index.html'))));
});
