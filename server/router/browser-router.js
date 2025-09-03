import IttyRouter from './itty-router.js'
import { getBuiltFileRstream } from '#helpers/stream.js'
import { pipeline } from 'node:stream/promises'
import getChunk from '../shared-handlers/get-chunk.js'

const isProduction = process.env.NODE_ENV === 'production'

// <domain>
const domainRouter = IttyRouter()

if (isProduction) {
  domainRouter
    .get('/app.js', async (req, res) => {
      res.setHeader('content-type', 'text/javascript')
      res.writeHead(200)
      await pipeline(
        (await getBuiltFileRstream('app.js')).result,
        res
      )
      return res
    })
    .get('/chunks/:name', getChunk)
    .get('/', serveIndex)
    .get('/\\+{1,3}:nappIdWithRoute+', serveIndex)

  async function serveIndex (req, res) {
    res.setHeader('content-type', 'text/html')
    res.writeHead(200)
    await pipeline(
      (await getBuiltFileRstream('index.html')).result,
      res
    )
    return res
  }
}

// // We need this to make the platform work offline
// domainRouter.get('/sw.js', (req, res) => { return res })

export default domainRouter
