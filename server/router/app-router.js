import IttyRouter from './itty-router.js'
import { getBuiltFileRstream, dupeRstream } from '#helpers/stream.js'
import handleEtag from '#helpers/middleware/etag.js'
import { pipeline } from 'node:stream/promises'

const isDev = process.env.NODE_ENV === 'development'

// <(a|b|c)appId>.<domain>
export const appRouter = IttyRouter()
  // Here the sw uses the bundle event to load urls
  .get('/sw.js', async (req, res) => {
    res.setHeader('cache-control', 'no-cache')
    res.setHeader('content-type', 'text/javascript')
    const { result, ts } = await getBuiltFileRstream('app-sw.js')
    const [rstreamForRes, rstreamForEtag] = dupeRstream(result, isDev ? 2 : 1)

    if (await handleEtag(req, res, rstreamForEtag, ts)) return res

    res.writeHead(200)
    await pipeline(
      rstreamForRes,
      res
    )
    return res
  })
  // To support custom app sw, could check here if the
  // path is listed as a sw on the bundle event.
  // It does would have to be marked as sw to differentiate
  // it from any other regular path
  .get('*', (req, res) => {
    res.setHeader('content-type', 'text/html')
    res.writeHead(200)
    res.end(/* html */`
      <!doctype html>
      <html>
        <head>
          <style>
            body {
              margin: 0;
            }
          </style>
        </head>
        <body>
          <script>
            (async function () {
              // no-op during subsequent visits
              const registration = await navigator.serviceWorker.register('/sw.js')
              await navigator.serviceWorker.ready
              window.location.reload()
            })()
          </script>
        </body>
      </html>
    `)

    return res
  })

export default appRouter
