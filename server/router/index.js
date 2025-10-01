import browserRouter from './browser-router.js'
import appRouter from './app-router.js'
import vaultRouter from './vault-router.js'

export default { fetch: handleRequest }

async function handleRequest (req, res) {
  if (req.subdomain && req.subdomain.split('.')[0].length !== req.subdomain.length) return
  if (!req.subdomain) {
    console.log('browser router:', req.url)
    return browserRouter.fetch(req, res)
  }

  switch (req.subdomain[0]) {
    case 'a':
    case 'b':
    case 'c': {
      console.log('app router:', req.url)
      await appRouter.fetch(req, res)
      break
    }
    case 'v': {
      if (req.subdomain !== 'vault') return
      console.log('vault router:', req.url)
      await vaultRouter.fetch(req, res)
      break
    }
  }
}
