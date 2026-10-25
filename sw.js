// Offline support: the app works with no signal (studios, basements, trains).
// Bump VERSION whenever you change any app file so her phone picks up the update.
const VERSION = 'mays-studio-v7';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'soundtrack.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so updates show up), falling back to the cache when offline.
// Google Fonts are cached too so the app still looks right with no signal.
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const cacheable = url.origin === location.origin || FONT_HOSTS.includes(url.hostname);
  if (!cacheable) return;
  // 'no-cache' asks the server whether the file changed (cheap when it hasn't), so
  // edits on GitHub show up right away instead of after GitHub's 10-minute cache.
  const sameOrigin = url.origin === location.origin;
  e.respondWith(
    fetch(e.request, sameOrigin ? { cache: 'no-cache' } : undefined)
      .then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request).then((r) => r || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error()))
      )
  );
});
