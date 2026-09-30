/* sw.js — offline shell + last-known-data cache for the RBI Weekly Dashboard.
 *
 * Strategy:
 *   - App shell (index.html, icons, manifest): network-first with cache
 *     fallback, so a deploy ships immediately when online and the shell still
 *     opens offline.
 *   - Data (rbi-data.json, external-debt.json): network-first with a
 *     24-hour-tolerant cache fallback. When the network is unreachable, the
 *     last successfully fetched data still renders — charts, tiles and tables
 *     work offline with the newest numbers this device ever saw.
 *   - Fonts + vendored Lucide: cache-first (immutable, versioned by URL).
 *   - CDN scripts (Chart.js, GSAP, three.js): network-only with an opportunistic
 *     cache write — the dashboard already degrades gracefully without them.
 *
 * Bump CACHE_VERSION whenever the shell's asset list changes.
 */
const CACHE_VERSION = 'rbi-dash-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './lucide.min.js',
];
const DATA_URLS = ['rbi-data.json', 'external-debt.json'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Individually tolerate a partial shell — a miss must never fail install.
    await Promise.all(SHELL.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    // Cross-origin: CDN scripts/fonts. Cache them opportunistically on
    // success, but always go to the network first (they are deferred deps,
    // not the shell).
    if (/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.hostname)) {
      event.respondWith((async () => {
        const cache = await caches.open(CACHE_VERSION);
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) cache.put(req, fresh.clone());
          return fresh;
        } catch (_) {
          const hit = await cache.match(req);
          return hit || Response.error();
        }
      })());
    }
    return; // Netlify functions and everything else: browser default (live data)
  }

  // Data files: network-first, fall back to the newest cached copy (stale
  // data clearly beats a blank screen offline).
  if (DATA_URLS.includes(url.pathname.split('/').pop())) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (_) {
        const hit = await cache.match(req);
        if (hit) return hit;
        return new Response(JSON.stringify({ records: [] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
    })());
    return;
  }

  // Same-origin navigations + assets: network-first, cache fallback.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok && req.headers.get('accept')?.includes('text/html')) {
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (_) {
      const hit = (await cache.match(req)) || (await cache.match('./index.html'));
      return hit || Response.error();
    }
  })());
});
