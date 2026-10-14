/* Kivora PWA worker v2: network-first app code prevents stale auth/startup bundles. */
const CACHE_PREFIX = 'kivora-pwa-';
const CACHE_VERSION = 'v2';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-${CACHE_VERSION}`;
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(async cache => {
    // Cache essential shell files individually: a missing optional icon must not abort installation.
    for (const url of APP_SHELL) {
      try { const response = await fetch(url, {cache: 'reload'}); if (response.ok) await cache.put(url, response); } catch {}
    }
    await self.skipWaiting();
  }));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE && key !== RUNTIME_CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', event => { if (event.data?.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__/auth/')) return;

  // Never let a cached HTML shell mask the latest deployment when online.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) caches.open(SHELL_CACHE).then(cache => cache.put('/index.html', response.clone()));
      return response;
    }).catch(async () => (await caches.match('/index.html')) || (await caches.match('/')) || Response.error()));
    return;
  }
  // App code is network-first; only use cache as an offline fallback.
  if (['script', 'style'].includes(request.destination) || /\.(?:css|js)$/i.test(url.pathname)) {
    event.respondWith(fetch(request).then(response => {
      if (response.ok && response.type === 'basic') caches.open(RUNTIME_CACHE).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(async () => (await caches.match(request)) || Response.error()));
    return;
  }
  // Cache-first only for non-sensitive static assets.
  if (['image', 'font'].includes(request.destination) || /\.(?:png|svg|webp|woff2?)$/i.test(url.pathname)) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok && response.type === 'basic') caches.open(RUNTIME_CACHE).then(cache => cache.put(request, response.clone()));
      return response;
    })));
  }
});
