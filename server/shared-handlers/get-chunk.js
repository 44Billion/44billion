import { pipeline } from 'node:stream/promises'
import { getBuiltFileRstream } from '#helpers/stream.js'

export default async function getChunk (req, res) {
  res.setHeader('content-type', 'text/javascript')
  // Chunks are hashed (chunks/[name]-[hash].js) and therefore immutable —
  // a new deploy references new URLs, so this long TTL never goes stale.
  res.setHeader('cache-control', 'public, max-age=31536000, immutable')
  res.writeHead(200)
  await pipeline(
    (await getBuiltFileRstream(`chunks/${req.params.name}`)).result,
    res
  )
  return res
}
