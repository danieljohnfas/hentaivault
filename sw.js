// HentaiVault Service Worker
// Cache-first for static assets, network-first for HTML pages

const CACHE_NAME = 'hv-cache-v5'; // bump on every deploy that changes JS/CSS
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/css/style.css?v=4',
    '/js/i18n.js',
    '/js/app.js',
    '/assets/favicon.png',
    '/manifest.json'
];

// Ad domains — never cache these, always fresh
const AD_DOMAINS = [
    'revolthem.com',
    'pl29414985.profitablecpmratenetwork.com',
    'pl29414982.profitablecpmratenetwork.com',
    'pl29414983.profitablecpmratenetwork.com',
    'googletagmanager.com',
    'challenges.cloudflare.com',
    'hitscounter.dev',
    'api.qrserver.com',
    'highperformanceformat.com'
];

function isAdRequest(url) {
    return AD_DOMAINS.some(domain => url.hostname.includes(domain));
}

// Install: pre-cache core static assets
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(STATIC_ASSETS);
        }).then(() => self.skipWaiting())
    );
});

// Activate: clean up old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            )
        ).then(() => self.clients.claim())
    );
});

// Fetch strategy:
//  - Ad domains: always network, no caching
//  - HTML pages: network-first (always get fresh content), fallback to cache
//  - Static assets (JS/CSS/images): cache-first for speed, update in background
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Skip non-GET, cross-origin ads, and non-http requests
    if (event.request.method !== 'GET') return;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.pathname.startsWith('/api/')) return; // Don't cache dynamic API requests
    if (isAdRequest(url)) return; // Let ads fall through to network without caching

    const isHTML = event.request.headers.get('accept')?.includes('text/html') ||
                   url.pathname.endsWith('.html') ||
                   url.pathname === '/';

    if (isHTML) {
        // Network-first for HTML: fresh content always preferred
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    }
                    return response;
                })
                .catch(() => caches.match(event.request).then(cached => cached || caches.match('/')))
        );
    } else {
        // Cache-first for static assets (JS, CSS, images, fonts)
        event.respondWith(
            caches.match(event.request).then(cached => {
                if (cached) {
                    // Serve cached, update in background (stale-while-revalidate)
                    const fetchPromise = fetch(event.request).then(response => {
                        if (response.ok) {
                            caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
                        }
                        return response;
                    }).catch(error => {
                        console.error('Service Worker: Background update failed for', event.request.url, error);
                    });
                    return cached;
                }
                return fetch(event.request).then(response => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    }
                    return response;
                });
            })
        );
    }
});
