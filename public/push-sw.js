// Réception des notifications quand l'appli est fermée (chargé par le service worker).
self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (e) {
    d = {};
  }
  event.waitUntil(
    self.registration.showNotification(d.title || 'CovoitGo', {
      body: d.body || '',
      icon: 'icon.svg',
      badge: 'icon.svg',
      tag: d.tag,
      renotify: true,
      data: { url: d.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow(url);
    }),
  );
});
