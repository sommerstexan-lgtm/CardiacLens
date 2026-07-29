const CACHE_NAME = 'cardiaclens-v9.10.347.216-storage-proof';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  var req = event.request;
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(fetch(req, { cache: 'no-store' }).catch(() => caches.match(req)));
    return;
  }
  if (new URL(req.url).origin === self.location.origin) {
    event.respondWith(fetch(req, { cache: 'no-store' }).catch(() => caches.match(req)));
    return;
  }
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});

self.addEventListener('push', function(event) {
  var data = {};
  try { data = event.data.json(); } catch (e) {}
  var title = data.title || 'CardiacLens';
  var tag = data.tag || 'cardiaclens-fluid-reminder';
  var options = {
    body: data.body || '',
    tag: tag,
    icon: './icon-192.png',
    badge: './icon-192.png',
    // v9.10.347.209: without this, notificationclick has no way to know
    // what the push was for, since options.tag alone is not exposed on
    // event.notification.data. This was silently dropping every real
    // background fluid push's identity, causing tap routing to fall
    // through to the generic Events queue instead of opening Log Fluid.
    data: { eventTag: tag }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  // v9.10.347.209: carry the event tag through so the app can open the
  // specific event's action card, not just focus the app root.
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
