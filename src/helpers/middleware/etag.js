import crypto from 'node:crypto'
import { typeof2 } from '#helpers/operator.js'

const textEncoder = new TextEncoder()

export default async function handleEtag (req, res, { data, etag, ts } = {}) {
  if (res.headersSent) return

  etag ??= await getEtag(data, ts)
  res.setHeader('etag', etag)
  if (ts) {
    res.setHeader('last-modified', new Date(ts).toUTCString())
  }

  const ifNoneMatch = req.headers['if-none-match']
  const ifModifiedSince = req.headers['if-modified-since']

  if (ifNoneMatch && ifNoneMatch !== etag) {
    return
  }

  try {
    if (
      ifModifiedSince && ts &&
      Math.floor(new Date(ifModifiedSince).getTime() / 1000) < Math.floor(ts / 1000)
    ) return
  } catch (_err) { return } // invalid date

  if (ifNoneMatch || (ifModifiedSince && ts)) {
    res.writeHead(304) // not modified
    res.end()
    return res
  }
}

async function getEtag (data, ts) {
  // weak ETag based on modification time
  if (ts !== undefined) return `W/"${ts.toString(16)}"`

  switch (typeof2(data)) {
    case 'string': { data = [textEncoder.encode(data)]; break }
    case 'uint8array': { data = [data]; break } // buffer falls into here too
  }

  const hash = crypto.createHash('sha1')
  let byteLength = 0
  for await (const bytes of data) {
    hash.update(bytes)
    byteLength += bytes.length
  }

  if (byteLength === 0) return '"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"'

  const etagHash = hash.digest('base64').replace(/=/g, '')

  return '"' + byteLength.toString(16) + '-' + etagHash + '"'
}
