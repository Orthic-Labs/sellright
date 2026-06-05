// iOS Advanced Privacy Protection Service Worker
// This helps with caching and reduces network requests that might trigger privacy warnings

const CACHE_NAME = 'damned-designs-v1';
const STATIC_ASSETS = [
  '/fonts/Damned-Regular.woff2',
  '/fonts/Damned-Bold.woff2',
  '/manifest.json'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        return self.skipWaiting();
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// Fetch event - serve from cache first for static assets
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // Handle font and static asset requests
  if (event.request.url.includes('/fonts/') || 
      event.request.url.includes('/favicon') ||
      event.request.url.includes('/logo-') ||
      event.request.url.includes('/manifest.json')) {
    
    event.respondWith(
      caches.match(event.request)
        .then((response) => {
          // Return cached version or fetch from network
          return response || fetch(event.request);
        })
    );
  }
});
