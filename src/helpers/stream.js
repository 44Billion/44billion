import fs from 'node:fs'
import { Readable } from 'node:stream'

const isDev = process.env.NODE_ENV === 'development'

export async function writeWithBackpressure (wstream, data) {
  return new Promise(resolve => {
    if (!wstream.write(data)) wstream.once('drain', resolve)
    else process.nextTick(resolve)
  })
}

export async function getBuiltFileRstream (filename) {
  if (isDev) {
    return {
      // served by esbuild from mem
      result: Readable.fromWeb((await fetch(`http://127.0.0.1:8080/${filename}`)).body),
      ts: undefined
    }
  } else {
    filename = `../../dist/44billion/${filename}`
    return { result: fs.createReadStream(filename), ts: await getFileModificationTime(filename) }
  }
}

async function getFileModificationTime (filename) {
  if (isDev) return
  try {
    const stats = await fs.promises.stat(filename)
    return stats.mtime.getTime()
  } catch (e) {
    if (e.code === 'ENOENT') return
    throw e
  }
}

// return "numCopies" number of node readable stream copies
export function dupeRstream (nodeRstream, numCopies = 2) {
  if (numCopies === 1) return [nodeRstream]

  const webStream = Readable.toWeb(nodeRstream)
  const copies = []
  let currentStream = webStream

  for (let i = 0; i < numCopies; i++) {
    if (i < numCopies - 1) {
      const [tee1, tee2] = currentStream.tee()
      copies.push(Readable.fromWeb(tee1))
      currentStream = tee2
    } else {
      copies.push(Readable.fromWeb(currentStream))
    }
  }

  return copies
}
