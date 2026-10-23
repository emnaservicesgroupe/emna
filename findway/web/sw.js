'use strict';
// App-shell cache only. API responses (especially authenticated ones) are NEVER cached.
const VERSION = 'fw-shell-v1';
const SHELL = ['./', 'index.html', 'offline.html', 'css/app.css', 'js/main.js', 'js/api.js', 'js/i18n.js', 'js/router.js', 'js/ui.js', 'js/format.js',
  'js/views/public.js', 'js/views/auth.js', 'js/views/candidate.js', 'js/views/employer.js', 'js/views/agency.js', 'js/views/staff.js', 'js/views/admin.js', 'js/views/shared.js',
  'i18n/en.json', 'i18n/ar.json', 'i18n/sq.json', 'i18n/fr.json', 'assets/findway-logo-header.png', 'assets/icon-192.png', 'manifest.webmanifest'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return; // network only
  if (req.mode === 'navigate') { e.respondWith(fetch(req).catch(() => caches.match('offline.html'))); return; }
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const hit = await cache.match(req);
    const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
