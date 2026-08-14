import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  appIconMonogramPalettes,
  getAppIconLayerState,
  getAppIconMonogram,
  isDataAppIconUrl,
  normalizeAppIconCandidates,
  reconcileAppIconCandidates,
  shouldShowAppIconShimmer
} from '#helpers/app-icon.js'

// Converts an sRGB hex color to its WCAG relative luminance.
function getRelativeLuminance (hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map(channel => parseInt(channel, 16) / 255)
    .map(channel => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
    )
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2])
}

// Calculates the WCAG contrast ratio between two sRGB colors.
function getContrastRatio (first, second) {
  const luminances = [getRelativeLuminance(first), getRelativeLuminance(second)]
    .sort((a, b) => b - a)
  return (luminances[0] + 0.05) / (luminances[1] + 0.05)
}

describe('app icon candidates', () => {
  it('identifies data image icons without depending on scheme casing', () => {
    assert.equal(isDataAppIconUrl('data:image/svg+xml,%3Csvg%2F%3E'), true)
    assert.equal(isDataAppIconUrl('DATA:image/png;base64,AAAA'), true)
    assert.equal(isDataAppIconUrl('https://example.test/icon.png'), false)
  })

  it('builds Unicode-aware monograms from names', () => {
    assert.equal(getAppIconMonogram('app-one', 'OpenDork').label, 'OD')
    assert.equal(getAppIconMonogram('app-two', '  Radio   Garden  ').label, 'RG')
    assert.equal(getAppIconMonogram('app-three', 'Árvore').label, 'ÁR')
    assert.equal(getAppIconMonogram('app-four', '   ').label, '◈')
  })

  it('keeps colors tied to app identity rather than mutable metadata', () => {
    const first = getAppIconMonogram('stable-id', 'Short name')
    const renamed = getAppIconMonogram('stable-id', 'A much longer name')
    assert.deepEqual(
      { lightBg: first.lightBg, lightFg: first.lightFg, darkBg: first.darkBg, darkFg: first.darkFg },
      { lightBg: renamed.lightBg, lightFg: renamed.lightFg, darkBg: renamed.darkBg, darkFg: renamed.darkFg }
    )
    assert.notEqual(first.label, renamed.label)
  })

  it('keeps every light and dark palette above WCAG AA text contrast', () => {
    for (const palette of appIconMonogramPalettes) {
      assert.ok(getContrastRatio(palette.lightBg, palette.lightFg) >= 4.5)
      assert.ok(getContrastRatio(palette.darkBg, palette.darkFg) >= 4.5)
    }
  })

  it('supports legacy icons and ordered candidate chains without duplicate URLs', () => {
    assert.deepEqual(normalizeAppIconCandidates({
      fx: 'first',
      url: 'https://cdn.test/first.png',
      candidates: [
        { fx: 'first', url: 'https://cdn.test/first.png' },
        { fx: null, url: 'https://cdn.test/second.png' },
        { fx: 'ignored' }
      ]
    }), [
      { fx: 'first', url: 'https://cdn.test/first.png' },
      { fx: null, url: 'https://cdn.test/second.png' }
    ])
  })

  it('rejects malformed cached values', () => {
    assert.deepEqual(normalizeAppIconCandidates(null), [])
    assert.deepEqual(normalizeAppIconCandidates({ url: ' ' }), [])
  })

  it('accepts extensionless HTTP icons and rejects unsafe cached sources', () => {
    assert.deepEqual(normalizeAppIconCandidates({
      url: 'https://cdn.test/content-hash',
      candidates: [
        { url: 'data:image/svg+xml,%3Csvg%3E' },
        { url: '/relative/icon.png' },
        { url: 'https://user:secret@cdn.test/icon.png' },
        { url: 'javascript:alert(1)' },
        { url: 'data:text/html,not-an-image' },
        { url: ' https://cdn.test/spaced.png' }
      ]
    }), [
      { fx: null, url: 'https://cdn.test/content-hash' },
      { fx: null, url: 'data:image/svg+xml,%3Csvg%3E' }
    ])
  })

  it('keeps an already loaded URL selected when refreshed candidates are reordered', () => {
    const displayed = { fx: 'same-root', url: 'https://loaded.test/icon' }
    const candidates = [
      { fx: 'same-root', url: 'https://new-primary.test/icon' },
      displayed
    ]

    assert.deepEqual(reconcileAppIconCandidates(candidates, displayed, new Set()), {
      candidates,
      index: 1
    })
  })

  it('keeps a loaded root without switching between equivalent servers', () => {
    const displayed = { fx: 'same-root', url: 'https://loaded.test/icon' }
    const candidates = [{ fx: 'same-root', url: 'https://new.test/icon' }]

    assert.deepEqual(reconcileAppIconCandidates(candidates, displayed, new Set()), {
      candidates: [displayed, ...candidates],
      index: 0
    })
  })

  it('selects a genuinely different candidate while retaining the displayed image separately', () => {
    const displayed = { fx: 'old-root', url: 'https://loaded.test/icon' }
    const candidates = [{ fx: 'new-root', url: 'https://new.test/icon' }]

    assert.deepEqual(reconcileAppIconCandidates(candidates, displayed, new Set()), {
      candidates,
      index: 0
    })
  })

  it('shows shimmer only before the first image and keeps the old layer during preload', () => {
    const oldIcon = { fx: 'old-root', url: 'https://old.test/icon' }
    const newIcon = { fx: 'new-root', url: 'https://new.test/icon' }

    assert.deepEqual(getAppIconLayerState(null, newIcon), {
      isShimmerVisible: true,
      isDisplayedLayerVisible: false,
      isCandidateLayerVisible: false
    })
    assert.deepEqual(getAppIconLayerState(oldIcon, newIcon), {
      isShimmerVisible: false,
      isDisplayedLayerVisible: true,
      isCandidateLayerVisible: false
    })
    assert.deepEqual(getAppIconLayerState(newIcon, newIcon), {
      isShimmerVisible: false,
      isDisplayedLayerVisible: false,
      isCandidateLayerVisible: true
    })
  })

  it('shows the initial shimmer until resolution confirms the numeric fallback', () => {
    const initial = {
      resolutionPending: true,
      isLoading: false,
      candidateIcon: null,
      displayedIcon: null
    }
    assert.equal(shouldShowAppIconShimmer(initial), true)
    assert.equal(shouldShowAppIconShimmer({
      ...initial,
      resolutionPending: false,
      isLoading: true
    }), true)
    assert.equal(shouldShowAppIconShimmer({
      ...initial,
      resolutionPending: false
    }), false)
    assert.equal(shouldShowAppIconShimmer({
      ...initial,
      candidateIcon: { url: 'https://icon.test/image' }
    }), false)
  })
})
