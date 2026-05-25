// PathBinder Service Worker
// v222 — Image loading optimization:
//  Wired up the existing _thumbUrl() helper that was defined but
//  never called. Adds Supabase Storage render/image transforms
//  (?width=N&quality=80) on every grid thumbnail render site. Saves
//  ~70-90% bytes on thumbnails vs. shipping the full 480px WebP.
//   Sets singles row:        width=80   (36px element)
//   Marketplace browse:      width=400  (200px card)
//   Binder card grid:        width=400  (150-300px element)
//   Public binder:           width=320
//   All-cards list:          width=100
//   All-cards grid:          width=300
//   Sealed product grid:     width=300
//   Dashboard mini thumbs:   width=160-200
//  Lightbox + binder detail modal keep full resolution for zoom.
//  Plus missing decoding="async" added to several sites for consistency.
const CACHE = 'pathbinder-v272';

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

  // For static assets: cache first, then network.
  // Only cache fully-formed 200 responses. `res.ok` is true for the whole
  // 200-299 range, which includes 206 Partial Content — the response type
  // browsers return for ranged audio/video requests. cache.put rejects 206
  // with "Partial response (status code 206) is unsupported", surfacing as
  // an uncaught TypeError in the console. Filtering to status === 200 also
  // skips redirects (3xx) and opaque cross-origin responses.
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.status === 200 && res.type !== 'opaque') {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone)).catch(() => {});
        }
        return res;
      }).catch(() => new Response('', { status: 408, statusText: 'Network unavailable' }));
    })
  );
});
