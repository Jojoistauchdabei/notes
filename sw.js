const CACHE = 'grimoire-v1.2.0';
const ASSETS = ['.', 'index.html', 'css/styles.css', 'js/app.js', 'js/editor.js', 'js/gnzip.js', 'js/goodnotes.js', 'manifest.webmanifest', 'altes_Papier.png', 'screenshots/preview-wide.png', 'screenshots/preview-narrow.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()).catch(() => {}));
});
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match('index.html'))));
});
