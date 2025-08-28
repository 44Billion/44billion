import IttyRouter from './itty-router.js'
import { getBuiltFileRstream, dupeRstream } from '#helpers/stream.js'
import handleEtag from '#helpers/middleware/etag.js'
import { pipeline } from 'node:stream/promises'

const isDev = process.env.NODE_ENV === 'development'

// <(a|b|c)appId>.<domain>
export const appRouter = IttyRouter()
  // Here the sw uses the bundle event to load urls
  .get('/sw.js', async (req, res) => {
    // https://jakearchibald.com/2016/caching-best-practices
    res.setHeader('cache-control', 'no-cache')
    res.setHeader('content-type', 'text/javascript')
    const { result, ts } = await getBuiltFileRstream('app-sw.js')
    const [rstreamForRes, rstreamForEtag] = dupeRstream(result, isDev ? 2 : 1)

    if (await handleEtag(req, res, { data: rstreamForEtag, ts })) return res

    res.writeHead(200)
    await pipeline(
      rstreamForRes,
      res
    )
    return res
  })
  // /~~napp or / or /inner/route
  .get('*', async (req, res) => {
    // Firefox problem:
    // Did set cache-control no-cache (even on production)
    // else on some browsers it may not handle the next
    // request, after this window.location.reload(), to the service worker
    // Also passed true to window.location.reload
    // but even then it isn't reloading from service worker but
    // from here in an infinite loop. window.location.replace
    // and window.location.pathname = '/~~napp' didn't work.
    // Also tried making /~~napp-loader be replaced with /~~napp
    // Also checked if it needed an user action (click) before calling reload
    // Alsi tried <script defer blocking="render"> on <head>
    const html = /* html */`
      <!doctype html>
      <html>
        <head>
          <style>
            body {
              margin: 0;
            }
          </style>
          <script>
            (async function () {
              // no-op during subsequent visits
              await navigator.serviceWorker.register('/sw.js')
              const registration = await navigator.serviceWorker.ready
              if (registration.active && registration.active.state === 'activated') {
                window.location.reload()
              } else {
                registration.active.addEventListener('statechange', e => {
                  if (e.target.state === 'activated') window.location.reload()
                })
              }
            })()
          </script>
        </head>
        <body>
        </body>
      </html>
    `
    if (await handleEtag(req, res, { data: html })) return res

    res.setHeader('cache-control', 'no-cache')
    res.setHeader('content-type', 'text/html')
    res.writeHead(200)
    res.end(html)

    return res
  })
  // To support custom app sw, could check here if the
  // path is listed as a sw on the bundle event.
  // It does would have to be marked as sw to differentiate
  // it from any other regular path
  // .get('*', (req, res) => {})

export default appRouter
