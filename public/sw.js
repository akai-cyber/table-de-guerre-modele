// Service worker : rend l'appli installable et affiche les notifications envoyées par le serveur.
// Pas de cache : les données sont toujours en direct.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { titre: 'Table de guerre', corps: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.titre || 'Table de guerre', {
    body: d.corps || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag || undefined, renotify: Boolean(d.tag),
    data: { url: d.url || '/' }, vibrate: [120, 60, 120],
  }));
});

// Toucher la notification ouvre (ou ramène au premier plan) la bonne page de l'appli.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((liste) => {
    for (const c of liste) if (c.url === url && 'focus' in c) return c.focus();
    return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
  }));
});
