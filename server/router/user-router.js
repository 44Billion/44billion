import IttyRouter from './itty-router.js'
import { getBuiltFileRstream } from '#helpers/stream.js'
import { pipeline } from 'node:stream/promises'

// u<userPkBase62>.<domain>
const userRouter = IttyRouter()
  .get('/user-page.js', async (req, res) => {
    res.setHeader('content-type', 'text/javascript')
    res.writeHead(200)
    await pipeline(
      (await getBuiltFileRstream('user-page.js')).result,
      res
    )
    return res
  })
  // /<appId>
  .get('*', async (req, res) => {
    res.setHeader('content-type', 'text/html')
    res.writeHead(200)
    await pipeline(
      (await getBuiltFileRstream('user-page.html')).result,
      res
    )
    return res
  })

export default userRouter
