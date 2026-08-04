import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  extractHtmlMetadata,
  extractWebManifestIcons,
  resolveAppPath,
  resolveExternalImageUrl
} from '#helpers/html-metadata.js'

describe('HTML app metadata', () => {
  it('extracts text and orders browser, platform and social icon sources', () => {
    const metadata = extractHtmlMetadata(`
      <base href="/assets/">
      <meta property="og:description" content="Social description">
      <meta property="og:image" content="social.png">
      <link href='touch.png' rel='apple-touch-icon-precomposed'>
      <link sizes=any href="icon.svg?rev=1&amp;mode=dark" rel="shortcut icon">
      <meta name="description" content="Preferred description">
      <meta name="twitter:image:src" content="twitter.png">
      <title>App &amp; friends</title>
    `)

    assert.equal(metadata.name, 'App & friends')
    assert.equal(metadata.description, 'Preferred description')
    assert.equal(metadata.baseHref, '/assets/')
    assert.deepEqual(metadata.iconSources, [
      { href: 'icon.svg?rev=1&mode=dark', kind: 'icon' },
      { href: 'touch.png', kind: 'apple-touch-icon' },
      { href: 'social.png', kind: 'social-image' },
      { href: 'twitter.png', kind: 'social-image' }
    ])
  })

  it('extracts Web App Manifest icons in purpose fallback order', () => {
    assert.deepEqual(extractWebManifestIcons({
      icons: [
        { src: 'mono.svg', purpose: 'monochrome' },
        { src: 'any.png' },
        { src: 'mask.png', purpose: 'maskable' }
      ]
    }), [
      { href: 'any.png', kind: 'web-app-manifest' },
      { href: 'mask.png', kind: 'web-app-manifest' },
      { href: 'mono.svg', kind: 'web-app-manifest' }
    ])
  })

  it('resolves bundled paths and only exposes safe external image schemes', () => {
    assert.equal(resolveAppPath('icon.png', 'nested/index.html'), 'nested/icon.png')
    assert.equal(resolveAppPath('data:image/png;base64,x'), null)
    assert.equal(resolveExternalImageUrl('icon.png', 'https://cdn.test/assets/'), 'https://cdn.test/assets/icon.png')
    assert.equal(resolveExternalImageUrl('https://cdn.test/content-hash'), 'https://cdn.test/content-hash')
    assert.equal(resolveExternalImageUrl('/icon.png'), null)
    assert.equal(resolveExternalImageUrl('https://user:secret@cdn.test/icon.png'), null)
    assert.equal(resolveExternalImageUrl('javascript:alert(1)'), null)
    assert.equal(resolveExternalImageUrl('data:text/html,x'), null)
  })

  it('does not throw for invalid numeric character references', () => {
    assert.equal(extractHtmlMetadata('<title>&#99999999;</title>').name, '&#99999999;')
  })

  it('ignores metadata-looking markup inside comments and scripts', () => {
    const metadata = extractHtmlMetadata(`
      <!-- <link rel="icon" href="comment.png"> -->
      <script>const example = '<meta property="og:image" content="script.png">'</script>
      <link rel="icon" href="real.png">
    `)
    assert.deepEqual(metadata.iconSources, [{ href: 'real.png', kind: 'icon' }])
  })
})
