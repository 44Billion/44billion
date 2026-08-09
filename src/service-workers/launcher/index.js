// Launcher (root domain) service worker.
//
// Makes the 44billion shell work offline while keeping deploys fresh on the
// next reload: stable-name entries (index.html, app.js) use network-first so
// the browser revalidates through Cloudflare, and hashed chunks are cached
// forever because a new deploy references new URLs.
//
// Updates are never applied automatically. A new worker installs and waits;
// the app shows an "Update available" banner and, if dismissed, a persistent
// entry in the toolbar more menu. Only an explicit user action sends
// SKIP_WAITING. The script itself must be served with Cache-Control: no-cache
// and registered with updateViaCache: 'none', or browsers/CDNs may keep an
// old worker for up to 24h.

// VERSION is injected by the build (bin/plugins/sw-module.js) as a content
// hash of this worker's logic, so the cache name changes exactly when the
// worker/precache strategy changes — and the activate step drops stale
// caches. Normal feature deploys don't touch this file and keep the cache.
const VERSION = LAUNCHER_SW_VERSION
const APP_PREFIX = '44billion-launcher'
const CACHE_KEY = `${APP_PREFIX}:${VERSION}`
const PRECACHE_URLS = ['/', '/app.js']

const isSameOriginGet = request =>
  request.method === 'GET' &&
  new URL(request.url).origin === self.location.origin

const isCacheable = response =>
  response.ok && response.type === 'basic'

async function cachePut (request, response) {
  const cache = await caches.open(CACHE_KEY)
  await cache.put(request, response.clone())
}

// Network-first with cache fallback, used for the stable-name entry files and
// navigations. Fetches bypass the HTTP cache so Cloudflare revalidates with
// the origin and a fresh deploy is picked up on the next online reload.
//
// Accepted risk: because index.html and app.js keep stable filenames, a
// network drop between the two fetches in the same reload can pair a fresh
// HTML document with a stale JS bundle (or vice versa). This is the usual
// PWA trade-off for stable entry names; the manual update flow keeps the
// window small and the user in control — no atomic pairing is attempted.
async function networkFirst (request) {
  try {
    const response = await fetch(request, { cache: 'no-cache' })
    if (isCacheable(response)) await cachePut(request, response)
    return response
  } catch {
    const cached = await caches.match(request)
    return cached || Response.error()
  }
}

// Navigations may target SPA routes (/settings, /app-updates, /+nappId...).
// Cache the successful document under '/' so the shell is the offline
// fallback for any route.
async function networkFirstNavigation (request) {
  try {
    const response = await fetch(request, { cache: 'no-cache' })
    if (isCacheable(response)) {
      const cache = await caches.open(CACHE_KEY)
      await cache.put('/', response.clone())
    }
    return response
  } catch {
    return (await caches.match('/')) || Response.error()
  }
}

// Hashed chunks are immutable: serve from cache forever, populate on miss.
async function cacheFirst (request) {
  const cached = await caches.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (isCacheable(response)) await cachePut(request, response)
  return response
}

// Small stable-name assets (favicon, manifest, icons...): serve the cached
// copy immediately and refresh it in the background.
async function staleWhileRevalidate (request) {
  const cached = await caches.match(request)
  if (cached) {
    fetch(request)
      .then(response => { if (isCacheable(response)) return cachePut(request, response) })
      .catch(() => {})
    return cached
  }
  const response = await fetch(request)
  if (isCacheable(response)) await cachePut(request, response)
  return response
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_KEY)
    await Promise.all(PRECACHE_URLS.map(url =>
      cache.add(new Request(self.location.origin + url, { cache: 'no-cache' }))
    ))
  })())
})

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys
      .filter(key => key.startsWith(`${APP_PREFIX}:`) && key !== CACHE_KEY)
      .map(key => caches.delete(key)))
    // Take control right after a user-approved skipWaiting so the
    // controllerchange listener in the app reloads the fresh version.
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', e => {
  if (!isSameOriginGet(e.request)) return
  const { pathname } = new URL(e.request.url)

  if (e.request.mode === 'navigate') {
    e.respondWith(networkFirstNavigation(e.request))
  } else if (pathname === '/app.js') {
    e.respondWith(networkFirst(e.request))
  } else if (pathname.startsWith('/chunks/')) {
    e.respondWith(cacheFirst(e.request))
  } else {
    e.respondWith(staleWhileRevalidate(e.request))
  }
})

// Never call self.skipWaiting() automatically — only on explicit user action
// (update banner or toolbar menu button).
self.addEventListener('message', e => {
  if (e.data?.code === 'SKIP_WAITING') self.skipWaiting()
})
