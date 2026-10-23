// The Parish Gateway's own service worker. It only ever controls /go/ (the page people reach from the QR code or short link),
// so nothing in the rest of the app is touched, and public/sw.js is left alone.
// It keeps the last good page and the last good answer from public_gateway, so the page still OPENS with no signal.
// Network first with a short wait: whenever there is any signal the visitor gets the fresh page; the saved copy is only used
// when the network is absent or too slow. A saved answer is marked (X-Gateway-Saved) so the page can say so, and never claim to be current.
// Only the read-only public_gateway look-up is handled. Every other /api call goes straight to the network, untouched.
const CACHE = 'gw-v1';
const SHELL = '/go.html';
const FONTS = ['/fonts/HankenGrotesk-400-700.woff2', '/fonts/Spectral-500.woff2', '/fonts/Spectral-600.woff2'];
const WAIT_MS = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([SHELL, ...FONTS])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function networkFirst(request, cache, key, mark) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), WAIT_MS);
  try {
    const fresh = await fetch(request, { signal: ctl.signal });
    clearTimeout(timer);
    if (fresh.ok) await cache.put(key, fresh.clone());
    return fresh;
  } catch {
    clearTimeout(timer);
    const saved = await cache.match(key);
    if (!saved) return Response.error();
    if (!mark) return saved;
    const headers = new Headers(saved.headers); headers.set('X-Gateway-Saved', '1');
    return new Response(await saved.blob(), { status: saved.status, headers });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // the page itself: one shell serves every /go/<address>
  if (req.method === 'GET' && req.mode === 'navigate' && url.pathname.startsWith('/go/') && url.pathname !== '/go/sw.js') {
    e.respondWith(caches.open(CACHE).then((cache) => networkFirst(req, cache, SHELL, false)));
    return;
  }
  // the fonts never change
  if (req.method === 'GET' && url.pathname.startsWith('/fonts/')) { e.respondWith(caches.match(req).then((hit) => hit || fetch(req))); return; }
  // the page's data: read-only, keyed by the page address
  if (req.method === 'POST' && url.pathname === '/api/public_gateway') {
    e.respondWith((async () => {
      let slug = '';
      try { slug = String((await req.clone().json()).slug || '').toLowerCase().slice(0, 40); } catch { /* fall through to the network */ }
      if (!/^[a-z0-9-]{3,40}$/.test(slug)) return fetch(req);
      const cache = await caches.open(CACHE);
      return networkFirst(req, cache, '/__gateway-data/' + slug, true);
    })());
  }
  // anything else (every other /api call included) is not ours: it goes to the network as it always did
});
