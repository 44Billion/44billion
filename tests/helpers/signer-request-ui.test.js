import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFile } from 'node:fs/promises'

describe('signer request UI', () => {
  it('renders the read-only avatar overlay and menu hint with themed tokens', async () => {
    const screen = await readFile(
      new URL('../../src/components/zones/screen/index.js', import.meta.url),
      'utf8'
    )

    assert.match(screen, /icon-pencil-off/)
    assert.match(screen, /overlaySelected/)
    assert.match(screen, /t\('Read-only'\)/)
    assert.match(screen, /user-unlock-hint/)
    assert.match(screen, /takes one tap/)
    assert.match(screen, /t\('Tap to unlock'\)/)
    assert.match(screen, /t\('Click to unlock'\)/)
    assert.match(screen, /useIsMobile\(\)/)
    assert.match(screen, /isToolbarHidden\$\.set\(false\)/)
    assert.match(screen, /getElementById\('unified-toolbar'\)/)
    assert.match(screen, /transitionend/)

    const hook = await readFile(
      new URL('../../src/components/hooks/use-is-mobile.js', import.meta.url),
      'utf8'
    )
    assert.match(hook, /jsVars\.breakpoints\.mobile/)
    assert.match(hook, /matchMedia/)
  })

  it('keeps the signer-request halo scoped, themed and reduced-motion aware', async () => {
    const screen = await readFile(
      new URL('../../src/components/zones/screen/index.js', import.meta.url),
      'utf8'
    )
    const tooltip = await readFile(
      new URL('../../src/components/shared/signer-request-tooltip.js', import.meta.url),
      'utf8'
    )

    assert.match(screen, /#toolbar-active-avatar-button\.signer-request-attention::before/)
    assert.match(screen, /#toolbar-active-avatar-button\.signer-request-attention::after/)
    assert.match(screen, /border: 2px solid \$\{cssVars\.colors\.bgAccentPrimary\}/)
    assert.match(screen, /1\.4s ease-out/)
    assert.match(screen, /animation-delay: 550ms/)
    assert.match(screen, /prefers-reduced-motion: reduce/)

    assert.match(tooltip, /signer-request-tooltip-root/)
    assert.match(tooltip, /signerRequestTooltipBorder/)
    assert.match(tooltip, /stroke-dasharray/)
    assert.match(tooltip, /prefers-reduced-motion: reduce/)
    assert.match(tooltip, /role="button"/)
    assert.match(tooltip, /onActivate/)
    assert.match(screen, /handleTooltipActivate/)
  })
})
