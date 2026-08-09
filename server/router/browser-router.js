import IttyRouter from './itty-router.js'
import { getBuiltFileRstream } from '#helpers/stream.js'
import { pipeline } from 'node:stream/promises'
import getChunk from '../shared-handlers/get-chunk.js'

const isProduction = process.env.NODE_ENV === 'production'

// <domain>
const domainRouter = IttyRouter()

if (isProduction) {
  // Cache-Control strategy (launcher root domain):
  //
  // - `no-cache` on /, /app.js, /sw.js and /site.webmanifest: these are
  //   mutable files with stable names, so Cloudflare and browsers must
  //   revalidate with the origin on every request. That way a new deploy
  //   reaches users on their next reload without toggling Cloudflare's
  //   "development mode" manually, and the browser always re-checks /sw.js
  //   so a new worker (and its update banner) is detected.
  // - `public, max-age=86400` on favicon/icons: stable names that may be
  //   redesigned occasionally, so a short shared TTL (1 day) is a safe
  //   compromise between caching and freshness; deliberately NOT immutable.
  // - Hashed chunks (`/chunks/*`, see shared-handlers/get-chunk.js) are
  //   `public, max-age=31536000, immutable`: a new deploy references new
  //   URLs, so a long TTL can never serve stale code.
  //
  // The launcher service worker (src/service-workers/launcher/index.js)
  // relies on these same guarantees: network-first for the no-cache entries
  // (fresh deploy on next reload, cached copy when offline) and cache-first
  // for the immutable chunks.
  const serveIndex = getServeBuilt('index.html', 'text/html', 'no-cache')
  domainRouter
    .get('/sw.js', getServeBuilt('launcher-sw.js', 'text/javascript', 'no-cache'))
    .get('/app.js', getServeBuilt('app.js', 'text/javascript', 'no-cache'))
    .get('/chunks/:name', getChunk)
    .get('/', serveIndex)
    .get('/\\+{1,3}:nappIdWithRoute+', serveIndex)
    .get('/app-updates', serveIndex)
    .get('/settings', serveIndex)
    .get('/favicon.png', getServeBuilt('favicon.png', 'image/png', 'public, max-age=86400'))
    .get('/apple-touch-icon.png', getServeBuilt('apple-touch-icon.png', 'image/png', 'public, max-age=86400'))
    .get('/icon-192.png', getServeBuilt('icon-192.png', 'image/png', 'public, max-age=86400'))
    .get('/icon-512.png', getServeBuilt('icon-512.png', 'image/png', 'public, max-age=86400'))
    .get('/site.webmanifest', getServeBuilt('site.webmanifest', 'application/manifest+json', 'no-cache'))

  function getServeBuilt (filename, contentType, cacheControl) {
    return async (req, res) => {
      res.setHeader('content-type', contentType)
      if (cacheControl) res.setHeader('cache-control', cacheControl)
      res.writeHead(200)
      await pipeline(
        (await getBuiltFileRstream(filename)).result,
        res
      )
      return res
    }
  }
}

export default domainRouter
