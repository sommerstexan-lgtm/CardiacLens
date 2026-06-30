const CACHE_NAME = 'cardiaclens-v9.10.347.123-gps-update-readiness-repair';
self.addEventListener('install', event => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', event => { event.respondWith(fetch(event.request).catch(() => caches.match(event.request))); });
