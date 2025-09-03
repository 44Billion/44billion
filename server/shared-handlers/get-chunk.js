import { pipeline } from 'node:stream/promises'
import { getBuiltFileRstream } from '#helpers/stream.js'

export default async function getChunk (req, res) {
  res.setHeader('content-type', 'text/javascript')
  res.writeHead(200)
  await pipeline(
    (await getBuiltFileRstream(`chunks/${req.params.name}`)).result,
    res
  )
  return res
}
