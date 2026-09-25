// Keeps the app's own page on the phone so it still OPENS with no signal. It caches nothing else:
// every /api call always goes to the network (a sale must be recorded live, never from a cache).
// Network-first with a short wait, so a fresh deploy is picked up whenever there is any signal,
// and the saved copy is only used when the network is absent or too slow to be useful.
const CACHE = 'pc-shell-v1';
const SHELL = ['/', '/index.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (!(req.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html'))) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const fresh = await fetch(req, { signal: ctl.signal });
      clearTimeout(timer);
      if (fresh.ok) cache.put('/index.html', fresh.clone());
      return fresh;
    } catch {
      clearTimeout(timer);
      return (await cache.match('/index.html')) || (await cache.match('/')) || Response.error();
    }
  })());
});
