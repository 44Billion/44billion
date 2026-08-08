import IttyRouter from './itty-router.js'
import { getBuiltFileRstream } from '#helpers/stream.js'
import { pipeline } from 'node:stream/promises'
import getChunk from '../shared-handlers/get-chunk.js'

const isProduction = process.env.NODE_ENV === 'production'

// <domain>
const domainRouter = IttyRouter()

if (isProduction) {
  const serveIndex = getServeBuilt('index.html', 'text/html')
  domainRouter
    .get('/app.js', getServeBuilt('app.js', 'text/javascript'))
    .get('/chunks/:name', getChunk)
    .get('/', serveIndex)
    .get('/\\+{1,3}:nappIdWithRoute+', serveIndex)
    .get('/app-updates', serveIndex)
    .get('/settings', serveIndex)
    .get('/favicon.png', getServeBuilt('favicon.png', 'image/png'))
    .get('/apple-touch-icon.png', getServeBuilt('apple-touch-icon.png', 'image/png'))
    .get('/icon-192.png', getServeBuilt('icon-192.png', 'image/png'))
    .get('/icon-512.png', getServeBuilt('icon-512.png', 'image/png'))
    .get('/site.webmanifest', getServeBuilt('site.webmanifest', 'application/manifest+json'))

  function getServeBuilt (filename, contentType) {
    return async (req, res) => {
      res.setHeader('content-type', contentType)
      res.writeHead(200)
      await pipeline(
        (await getBuiltFileRstream(filename)).result,
        res
      )
      return res
    }
  }
}

// // We need this to make the platform work offline
// domainRouter.get('/sw.js', (req, res) => { return res })

export default domainRouter
