import assert from 'node:assert/strict'
import { before, describe, it, mock } from 'node:test'
import { encode } from 'libp2r2p/base93'
import { relayPool as nostrRelays } from 'libp2r2p/relay'
import { clearBlossomServersCache } from '#services/blossom-file-downloader/index.js'

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
    countFileChunksFromDb: async () => ({ count: 0, total: 1 }),
    deleteFileChunksFromDb: async () => {},
    getFileChunksFromDb: async () => [],
    saveFileChunksToDB: async () => {},
    streamFileChunksFromDb: async function * (_appId, root) {
      yield { evt: { content: encode(bytesByRoot.get(root)) } }
    }
  }
})
mock.module('#services/connectivity-retry.js', {
  defaultExport: { confirmOnline: async () => true }
})
mock.module('#helpers/nostr-queries.js', {
  namedExports: {
    getEventsByStrategy: async () => ({ events: [] }),
    getUserRelays: async () => ({ [A]: { read: [], write: [] } })
  }
})
mock.module('#hooks/use-web-storage.js', {
  namedExports: {
    setWebStorageItem: () => {}
  }
})
mock.module('#services/app-file-manager/get-site-manifest-event.js', {
  defaultExport: async () => ({
    kind: 35128,
    pubkey: A,
    tags: [['d', 'invalidate-test']]
  })
})

let getNextIcon
let getPreferredIcon

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
  ;({ getNextIcon, getPreferredIcon } = await import('#services/app-file-manager/get-metadata.js'))
})

function createManager () {
  const reads = []
  const writes = []
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
    cacheMetadata (...args) { writes.push(args) }
  }
  return { manager, reads, writes }
}

function createBlossomManager () {
  const writes = []
  const manager = {
    appId: 'app',
    siteManifest: {
      id: 'blossom-manifest',
      pubkey: A,
      tags: [
        ['service', 'blossom'],
        ['r', A, 'mark icon', 'm image/svg+xml', 'size 100'],
        ['path', 'favicon.svg', A, 'm image/svg+xml']
      ]
    },
    async getFileCacheStatus () {
      return {
        isCached: false,
        fileRootHash: A,
        mimeType: 'image/svg+xml',
        contentType: 'image/svg+xml',
        size: null,
        service: 'blossom'
      }
    },
    async cacheFile () {
      // Mirrors the browser CORS block when fetching the blossom CDN.
      throw new TypeError('Failed to fetch')
    },
    getCachedMetadata () { return null },
    cacheMetadata (...args) { writes.push(args) }
  }
  return { manager, writes }
}

describe('lazy AppFileManager icon metadata', () => {
  it('lets a caller invalidate a cached manager instance safely', async () => {
    const { default: AppFileManager } = await import('#services/app-file-manager/index.js')
    const address = { kind: 35128, pubkey: A, dTag: 'invalidate-test' }
    const first = await AppFileManager.create('invalidate-test-app', address)
    const invalidated = await AppFileManager.invalidateCachedInstance('invalidate-test-app')
    assert.equal(invalidated, first)
    const second = await AppFileManager.create('invalidate-test-app', address)
    assert.notEqual(second, first)
  })

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

  it('falls back to direct blossom server URLs when the data URL fetch is CORS-blocked', async () => {
    const getEvents = mock.method(nostrRelays, 'getEvents', async () => ({
      result: [{ kind: 10063, created_at: 1, tags: [['server', 'https://blossom.test']] }]
    }))
    const previousFetch = globalThis.fetch
    globalThis.fetch = mock.fn(async () => new Response(null, { status: 200 }))
    const { manager, writes } = createBlossomManager()
    try {
      const icon = await getNextIcon(manager)
      assert.equal(icon.fx, A)
      assert.match(icon.url, /^https:\/\/blossom\.test\//)
      assert.ok(icon.url.endsWith(A))
      assert.equal(icon.persistable, false)
      // The fallback URL must never be persisted as the cached icon choice.
      assert.deepEqual(writes, [])
    } finally {
      getEvents.mock.restore()
      globalThis.fetch = previousFetch
      clearBlossomServersCache()
    }
  })

  it('reconciles a legacy cached icon against automatic manifest quality metadata', async () => {
    const { manager, reads, writes } = createManager()
    manager.siteManifest = {
      ...manager.siteManifest,
      id: 'automatic-manifest',
      tags: [
        ['service', 'irfs'],
        ['r', A, 'mark icon', 'path favicon-16x16.png', 'm image/png'],
        ['r', B, 'path apple-touch-icon.png', 'm image/png'],
        ['auto', 'icon']
      ]
    }
    const cachedIcon = { fx: A, url: 'data:image/png;base64,OLD' }

    const first = getPreferredIcon(manager, { cachedIcon })
    const second = getPreferredIcon(manager, { cachedIcon })
    const [firstResult, secondResult] = await Promise.all([first, second])

    assert.equal(first, second)
    assert.equal(firstResult.icon.fx, B)
    assert.equal(firstResult.manifestId, 'automatic-manifest')
    assert.equal(firstResult.selectionComplete, true)
    assert.deepEqual(secondResult, firstResult)
    assert.deepEqual(reads, [B])
    assert.deepEqual(writes, [])
  })

  it('can prefer an update manifest without replacing the installed manifest', async () => {
    const { manager, reads, writes } = createManager()
    const installedManifest = manager.siteManifest
    const updateManifest = {
      id: 'remote-update',
      tags: [
        ['service', 'irfs'],
        ['r', C, 'mark icon', 'm image/png']
      ]
    }

    const result = await getPreferredIcon(manager, { manifest: updateManifest })

    assert.equal(result.icon.fx, C)
    assert.equal(result.manifestId, 'remote-update')
    assert.equal(result.selectionComplete, true)
    assert.equal(manager.siteManifest, installedManifest)
    assert.deepEqual(reads, [C])
    assert.deepEqual(writes, [])
  })

  it('allows a later retry when no preferred candidate could be resolved', async () => {
    const { manager } = createManager()
    manager.siteManifest = { id: 'no-icon', tags: [] }

    const first = getPreferredIcon(manager)
    assert.equal((await first).icon, null)

    const second = getPreferredIcon(manager)
    assert.notEqual(second, first)
    assert.equal((await second).icon, null)
  })

  it('does not finalize selection when a better asset was temporarily unavailable', async () => {
    const { manager, reads } = createManager()
    const getFileCacheStatus = manager.getFileCacheStatus
    manager.siteManifest = {
      id: 'transient-failure',
      tags: [
        ['service', 'irfs'],
        ['r', A, 'mark icon', 'm image/png'],
        ['r', B, 'mark icon', 'm image/png']
      ]
    }
    manager.getFileCacheStatus = async (pathname, asset) => {
      if (asset.root === A) {
        reads.push(asset.root)
        throw new Error('Temporarily unavailable')
      }
      return getFileCacheStatus(pathname, asset)
    }

    const first = getPreferredIcon(manager)
    const result = await first

    assert.equal(result.icon.fx, B)
    assert.equal(result.selectionComplete, false)
    assert.deepEqual(reads, [A, B])
    assert.notEqual(getPreferredIcon(manager), first)
  })
})
