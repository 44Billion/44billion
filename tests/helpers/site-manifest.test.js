import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  findFaviconAssetDescriptor,
  findMarkedAssetDescriptors,
  findRouteAssetDescriptor,
  formatManifestVersion,
  getManifestAggregateHash,
  getManifestAssetDescriptors,
  getManifestFileSourceHints,
  getManifestMetadata,
  getManifestPublishedAt,
  getPreferredManifestIconDescriptors,
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

  it('finds nested favicon paths case-insensitively with an image allowlist', () => {
    const manifest = {
      tags: [
        ['service', 'irfs'],
        ['r', A, 'path assets/favicon.txt'],
        ['r', B, 'path index.html', 'path assets/Favicon.SVG']
      ]
    }
    const favicon = findFaviconAssetDescriptor(manifest)
    assert.equal(favicon.root, B)
    assert.equal(favicon.filename, 'assets/Favicon.SVG')
  })

  it('prefers a larger conventional icon when nappup marked the choice automatic', () => {
    const manifest = {
      tags: [
        ['service', 'blossom'],
        ['path', 'favicon-16x16.png', A],
        ['path', 'apple-touch-icon.png', B],
        ['r', A, 'mark icon', 'm image/png'],
        ['auto', 'icon']
      ]
    }
    assert.deepEqual(
      getPreferredManifestIconDescriptors(manifest).map(asset => asset.root),
      [B, A]
    )
  })

  it('normalizes signed relay and Blossom server hints', () => {
    const hints = getManifestFileSourceHints({
      tags: [
        ['relay', 'wss://relay.test/'],
        ['relay', 'wss://relay.test'],
        ['relay', 'ws://insecure-relay.test'],
        ['server', 'https://blossom.test/'],
        ['server', 'http://localhost:3000/'],
        ['server', 'https://blossom.test/path'],
        ['server', 'https://user:secret@blossom.test'],
        ['server', 'ftp://invalid.test']
      ]
    })
    assert.deepEqual(hints, {
      relays: ['wss://relay.test'],
      blossomServers: ['https://blossom.test']
    })
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
    assert.deepEqual(getManifestMetadata({
      tags: [
        ['name', ' App '], ['summary', 'Short'], ['description', 'Long', 'en']
      ]
    }), {
      name: 'App',
      summary: 'Short',
      descriptions: [{ text: 'Long', language: 'en' }]
    })
  })

  it('derives the same canonical aggregate from Blossom and IRFS routes', () => {
    const expected = createHash('sha256').update(`${A} /index.html\n${B} /style.css\n`).digest('hex')
    const blossom = {
      tags: [
        ['path', 'style.css', B], ['name', 'ignored'], ['path', '/index.html', A],
        ['x', '0'.repeat(64), 'aggregate'], ['published_at', '10'], ['service', 'blossom']
      ]
    }
    const irfs = {
      tags: [
        ['service', 'irfs'], ['r', A, 'path index.html', 'mark icon'], ['r', B, 'path /style.css', 'size 1']
      ]
    }
    assert.equal(getManifestAggregateHash(blossom), expected)
    assert.equal(getManifestAggregateHash(irfs), expected)
  })

  it('returns null aggregates for manifests without valid routes', () => {
    assert.equal(getManifestAggregateHash({ tags: [['service', 'irfs'], ['r', A, 'mark icon']] }), null)
    assert.equal(getManifestAggregateHash({ tags: [['service', 'unknown'], ['path', 'index.html', A]] }), null)
  })

  it('validates published_at with ten minutes of future skew and formats versions', () => {
    const now = 1722384000
    const manifest = timestamp => ({
      tags: [
        ['path', 'index.html', A], ['published_at', timestamp]
      ]
    })
    assert.equal(getManifestPublishedAt(manifest(String(now + 600)), { now }), now + 600)
    assert.equal(getManifestPublishedAt(manifest(String(now + 601)), { now }), null)
    assert.equal(getManifestPublishedAt(manifest('-1'), { now }), null)
    assert.equal(getManifestPublishedAt(manifest('1.5'), { now }), null)
    assert.match(formatManifestVersion(manifest(String(now)), { now }), /^2024-07-31-[0-9a-f]{8}$/)
    assert.match(formatManifestVersion(manifest(String(now + 601)), { now }), /^[0-9a-f]{8}$/)
  })
})
