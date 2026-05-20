// PathBinder Service Worker
// v214 — Two bug fixes:
//  1. Sealed-product set matching was too strict (missing wildcards
//     on the ilike OR filter), so only sets whose pokemontcg.io id
//     happened to align with our catalog set_code showed products.
//     Now matches loosely on both set_code and set_name.
//  2. The binder sidebar (renderBinderSidebar) had no edit affordance
//     — the ✎ button that existed lived on the hidden binder shelf.
//     Added: ✎ overlay on each sidebar icon + right-click + long-press
//     handlers that all open the edit modal.
const CACHE = 'pathbinder-v214';

const PRECACHE = [
  '/offline.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/pokedex.png',
  'https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap'
];

// Install: cache core assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for API/Supabase calls, cache-first for static assets
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always go network for Supabase, API calls, and auth
  if (
    url.hostname.includes('supabase.co') ||
    url.pathname.startsWith('/api/') ||
    e.request.method !== 'GET'
  ) {
    return; // Let browser handle normally
  }

  // For navigation requests (page loads): network ONLY. Never cache the
  // HTML and never serve stale HTML from cache — go straight to network.
  // If the network is completely down, fall back to /offline.html. This
  // is the dev-friendly mode: a deploy is visible on the very next load.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/offline.html'))
    );
    return;
  }

  // For static assets: cache first, then network
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => new Response('', { status: 408, statusText: 'Network unavailable' }));
    })
  );
});
