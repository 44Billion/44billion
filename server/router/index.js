import IttyRouter from './itty-router.js'

// <app>.<domain>
export const subdomainAppRouter = IttyRouter()
  // Here the sw uses the bundle event to load urls
  .get('/sw.js', (req, res) => {
    // https://jakearchibald.com/2016/caching-best-practices
    // just enough for sw to get from browser cache
    // avoiding double request on first install
    // // TODO: etag to pair with must-revalidate
    // TODO: also cache server side
    // res.setHeader('cache-control', 'must-revalidate, max-age=30')
    res.setHeader('content-type', 'text/javascript')
    res.writeHead(200)
    res.end(/* js */`
     // Any change to this file will reinstall sw
      const appName = location.hostname.split('.')[0]
      self.addEventListener('install', (event) => {
          console.log('Service Worker: Installing...')
      })

      self.addEventListener('activate', (event) => {
          console.log('Service Worker: Activating...')
          // Claim clients immediately so the new service worker takes over
          // without requiring a page reload.
          event.waitUntil(clients.claim())
          console.log('Service Worker: Activated and claimed clients.')
      })

      self.addEventListener('fetch', e => {
        e.respondWith(
          caches.match(e.request).then(cachedResponse => {
            if (cachedResponse) return cachedResponse // responding with cache
            else {
              return new Response(\`
                <!doctype html>
                <html>
                  <head>
                  </head>
                  <body>
                    Page from \${appName} \${e.request.toString()}
                  </body>
                </html>
              \`, { headers: { 'content-type': 'text/html' } })
            }
          })
        )
      })
    `)

    return res
  })
  // To support custom app sw, could check here if the
  // path is listed as a sw on the bundle event.
  // It does would have to be marked as sw to differentiate
  // it from any other regular path
  .get('/', (req, res) => {
    console.log('PEGANDO *')

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
              let registration = await navigator.serviceWorker.register('/sw.js')
              console.log('Service Worker registration successful with scope:', registration.scope, registration)
              // navigator.serviceWorker.getRegistration().then(v => v.update())
              registration = await navigator.serviceWorker.ready
              console.log('Service Worker is active and ready to take over HTTP requests:', registration)
              // check for sw updates besides the browser auto checks
              // setInterval(() => registration.update(), 60 * 60 * 1000)

              let refreshing = false
              // fired by sw.skipWaiting()
              // navigator.serviceWorker.addEventListener('controllerchange', () => {
              //  console.log('controllerchange')
              //  if (refreshing) return
              //  refreshing = true
              //  window.location.reload()
              // })
              window.location.reload()
            })()
          </script>
        </body>
      </html>
    `)

    return res
  })

// <domain>
// const domainRouter = IttyRouter()
//   .get('/sw.js', (req, res) => { return res })
