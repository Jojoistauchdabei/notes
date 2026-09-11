const CACHE = 'grimoire-v1.3.1';
const ASSETS = ['.', 'index.html', 'css/styles.css', 'js/app.js', 'js/editor.js', 'js/gnzip.js', 'js/goodnotes.js', 'js/gnpdf-worker.js', 'manifest.webmanifest', 'altes_Papier.png', 'screenshots/preview-wide.png', 'screenshots/preview-narrow.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()).catch(() => {}));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match('index.html'))));
});
