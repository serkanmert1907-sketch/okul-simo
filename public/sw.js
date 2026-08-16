const CACHE='okul-simo-static-v2026-08-17-auth1';
const STATIC_ASSETS=['./manifest.webmanifest','./zoom_meeting_embed.html'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Teacher/student HTML navigation always goes to the Worker first.
  // This prevents an old cached teacher page from bypassing the login screen.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req));
    return;
  }

  // Never cache API, realtime, auth or media traffic.
  if (
    url.pathname === '/health' ||
    url.pathname === '/system/health' ||
    url.pathname === '/ws' ||
    url.pathname.startsWith('/media/') ||
    url.pathname.startsWith('/zoom/') ||
    url.pathname.startsWith('/teacher/')
  ) return;

  event.respondWith(
    fetch(req).then(res => {
      if (!res || !res.ok || res.type !== 'basic') return res;
      const copy = res.clone();
      caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req))
  );
});
