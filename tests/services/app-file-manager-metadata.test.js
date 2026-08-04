import assert from 'node:assert/strict'
import { before, describe, it, mock } from 'node:test'
import { encode } from 'libp2r2p/base93'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const I = 'd'.repeat(64)
const F = 'e'.repeat(64)
const bytesByRoot = new Map([
  [A, Uint8Array.of(1)],
  [B, Uint8Array.of(2)],
  [C, Uint8Array.of(3)],
  [F, Uint8Array.of(4)],
  [I, new TextEncoder().encode('<link rel="icon" href="html-icon.png">')]
])

mock.module('#services/idb/browser/queries/file-chunk.js', {
  namedExports: {
    deleteFileChunksFromDb: async () => {},
    streamFileChunksFromDb: async function * (_appId, root) {
      yield { evt: { content: encode(bytesByRoot.get(root)) } }
    }
  }
})
mock.module('#services/connectivity-retry.js', {
  defaultExport: { confirmOnline: async () => true }
})

let getNextIcon

before(async () => {
  class TestFileReader {
    readAsDataURL (blob) {
      blob.arrayBuffer().then(buffer => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`
        this.onload()
      }, error => {
        this.onerror(error)
      })
    }

    readAsText (blob) {
      blob.text().then(text => {
        this.result = text
        this.onload()
      }, error => {
        this.onerror(error)
      })
    }
  }
  globalThis.FileReader = TestFileReader
  ;({ getNextIcon } = await import('#services/app-file-manager/get-metadata.js'))
})

function createManager () {
  const reads = []
  const manager = {
    appId: 'app',
    siteManifest: {
      id: 'manifest',
      tags: [
        ['service', 'irfs'],
        ['r', A, 'mark icon', 'm image/png'],
        ['r', B, 'mark icon', 'm image/png'],
        ['r', F, 'path favicon.avif', 'm image/avif'],
        ['r', I, 'path index.html', 'm text/html'],
        ['r', C, 'path html-icon.png', 'm image/png']
      ]
    },
    async getFileCacheStatus (_pathname, asset) {
      reads.push(asset.root)
      return {
        isCached: true,
        fileRootHash: asset.root,
        mimeType: asset.mimeType,
        contentType: asset.mimeType,
        size: null,
        service: 'irfs'
      }
    },
    getCachedMetadata () {
      return null
    },
    cacheMetadata () {}
  }
  return { manager, reads }
}

describe('lazy AppFileManager icon metadata', () => {
  it('reads only the first non-rejected manifest candidate', async () => {
    const { manager, reads } = createManager()
    assert.equal((await getNextIcon(manager)).fx, A)
    assert.deepEqual(reads, [A])
  })

  it('moves to the next marked icon without touching index.html', async () => {
    const { manager, reads } = createManager()
    assert.equal((await getNextIcon(manager, { rejected: [{ fx: A, url: 'failed' }] })).fx, B)
    assert.deepEqual(reads, [B])
  })

  it('tries favicon assets before reading index.html', async () => {
    const { manager, reads } = createManager()
    assert.equal((await getNextIcon(manager, {
      rejected: [{ fx: A, url: 'a' }, { fx: B, url: 'b' }]
    })).fx, F)
    assert.deepEqual(reads, [F])
  })

  it('reads index.html only after manifest candidates are exhausted', async () => {
    const { manager, reads } = createManager()
    const icon = await getNextIcon(manager, {
      rejected: [{ fx: A, url: 'a' }, { fx: B, url: 'b' }, { fx: F, url: 'f' }]
    })
    assert.equal(icon.fx, C)
    assert.deepEqual(reads, [I, C])
  })

  it('uses a cached candidate without reading any asset', async () => {
    const { manager, reads } = createManager()
    const cached = { fx: A, url: 'data:image/png;base64,A' }
    assert.deepEqual(await getNextIcon(manager, { cachedIcon: cached }), cached)
    assert.deepEqual(reads, [])
  })
})
