import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  findMarkedAssetDescriptors,
  findRouteAssetDescriptor,
  getManifestAssetDescriptors,
  getManifestMetadata,
  normalizeManifestPath
} from '#helpers/site-manifest.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

describe('site manifest descriptors', () => {
  it('reads IRFS r tags with multiple paths and marks', () => {
    const manifest = {
      tags: [
        ['service', 'irfs'],
        ['r', A, 'path /index.html', 'path copy.html', 'mark icon', 'm text/html', 'size 42'],
        ['r', B, 'mark screenshot', 'country BR', 'm image/webp']
      ]
    }
    const assets = getManifestAssetDescriptors(manifest)
    assert.deepEqual(assets[0].paths, ['index.html', 'copy.html'])
    assert.deepEqual(assets[0].marks, ['icon'])
    assert.equal(assets[0].size, 42)
    assert.equal(findRouteAssetDescriptor('/', manifest).root, A)
    assert.equal(findMarkedAssetDescriptors('screenshot', manifest)[0].root, B)
  })

  it('reads Blossom path tags and defaults missing service to Blossom', () => {
    const manifest = { tags: [['path', '/index.html', A]] }
    const [asset] = getManifestAssetDescriptors(manifest)
    assert.equal(asset.service, 'blossom')
    assert.deepEqual(asset.paths, ['index.html'])
  })

  it('rejects unsafe paths and ignores invalid manifest references', () => {
    for (const path of ['', '//x', 'a//b', '.', '..', 'a/../b', 'a\\b', 'a\u0000b']) {
      assert.throws(() => normalizeManifestPath(path), /Unsafe/)
    }
    assert.deepEqual(getManifestAssetDescriptors({
      tags: [['service', 'irfs'], ['r', A, 'path ../secret'], ['r', 'BAD', 'path index.html']]
    }), [])
  })

  it('reads name, summary and descriptions directly from the manifest', () => {
    assert.deepEqual(getManifestMetadata({ tags: [
      ['name', ' App '], ['summary', 'Short'], ['description', 'Long', 'en']
    ] }), {
      name: 'App',
      summary: 'Short',
      descriptions: [{ text: 'Long', language: 'en' }]
    })
  })
})
