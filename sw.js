const CACHE_NAME = 'cardiaclens-v9.10.351.232-nosecui';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    )).then(() => self.clients.claim()).then(() => {
      return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        clients.forEach(client => {
          try { client.postMessage({ type: 'CL_SW_ACTIVATED', cache: CACHE_NAME }); } catch (e) {}
        });
      });
    })
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  var req = event.request;
  if (req.method !== 'GET') return;
  // Always network-first for navigations and same-origin app shell so version bumps are not stuck
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(fetch(req, { cache: 'no-store' }).catch(() => caches.match(req)));
    return;
  }
  var url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // version.json and main app files: never serve stale
    if (/version\.json$/.test(url.pathname) || /index\.html$/.test(url.pathname) || /\/$/.test(url.pathname) || /all\.js$/.test(url.pathname) || /sw\.js$/.test(url.pathname)) {
      event.respondWith(fetch(req, { cache: 'no-store' }).catch(() => caches.match(req)));
      return;
    }
    event.respondWith(fetch(req, { cache: 'no-store' }).catch(() => caches.match(req)));
    return;
  }
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});

self.addEventListener('push', function(event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  var title = data.title || 'CardiacLens';
  var options = {
    body: data.body || 'Reminder',
    icon: data.icon || './icon-192.png',
    badge: data.badge || './icon-192.png',
    data: data.data || {},
    tag: (data.data && data.data.eventTag) || data.tag || 'cardiaclens'
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  var tag = (event.notification && event.notification.data && event.notification.data.eventTag) || null;
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ('focus' in client) {
          client.focus();
          if (tag) client.postMessage({ type: 'OPEN_EVENT_CARD', eventTag: tag });
          return;
        }
      }
      if (self.clients.openWindow) {
        var url = tag ? ('./?openEvent=' + encodeURIComponent(tag)) : './';
        return self.clients.openWindow(url);
      }
    })
  );
});
