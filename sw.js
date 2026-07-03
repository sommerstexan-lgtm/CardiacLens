const CACHE_NAME = 'cardiaclens-v9.10.347.152-log-activity-open-google-maps';
self.addEventListener('install', event => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', event => {
  var req = event.request;
  if (req.mode === 'navigate' || (req.destination === 'document')) {
    event.respondWith(fetch(req, { cache: 'no-store' }).catch(() => caches.match(req)));
    return;
  }
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
