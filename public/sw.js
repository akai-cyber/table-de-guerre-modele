// Service worker minimal : rend l'appli installable. Pas de cache, les données sont en direct.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
