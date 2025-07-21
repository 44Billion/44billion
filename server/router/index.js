import browserRouter from './browser-router.js'
import userRouter from './user-router.js'
import appRouter from './app-router.js'

export default { fetch: handleRequest }

async function handleRequest (req, res) {
  if (req.subdomain && req.subdomain.split('.')[0].length !== req.subdomain.length) return
  if (!req.subdomain) {
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
    case 'u': {
      console.log('user router:', req.url)
      await userRouter.fetch(req, res)
      break
    }
  }
}
