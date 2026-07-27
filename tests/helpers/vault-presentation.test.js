import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { vaultModalLocales } from '../../src/components/zones/vault-modal/locales.js'
import {
  EZ_VAULT_URL,
  LEGACY_VAULT_URL,
  drawerPositionAtOpen,
  isLegacyVaultUrl,
  isSameVaultUrl,
  shouldShowVaultMigration
} from '../../src/components/zones/vault-modal/presentation.js'

const {
  getT,
  provideAppI18n
} = await import('../../src/i18n/index.js?vault-presentation')
const cleanupI18n = provideAppI18n()
after(cleanupI18n)

describe('vault presentation selection', () => {
  it('classifies only the official 44b-vault URL as legacy', () => {
    assert.equal(isLegacyVaultUrl(LEGACY_VAULT_URL), true)
    assert.equal(isLegacyVaultUrl(`${LEGACY_VAULT_URL}/`), true)
    assert.equal(isLegacyVaultUrl(`${LEGACY_VAULT_URL}///`), true)

    assert.equal(isLegacyVaultUrl(EZ_VAULT_URL), false)
    assert.equal(isLegacyVaultUrl('https://vault.44billion.net'), false)
    assert.equal(isLegacyVaultUrl('http://localhost:4000'), false)
    assert.equal(isLegacyVaultUrl(`${LEGACY_VAULT_URL}?fork=true`), false)
    assert.equal(isLegacyVaultUrl('https://user@44billion.github.io/44b-vault'), false)
    assert.equal(isLegacyVaultUrl('https://example.test/44b-vault'), false)
  })

  it('captures the drawer edge from orientation at opening time', () => {
    assert.equal(drawerPositionAtOpen(() => ({ matches: true })), 'start')
    assert.equal(drawerPositionAtOpen(() => ({ matches: false })), 'end')
  })

  it('requires the current legacy iframe handshake before showing migration', () => {
    const base = {
      vaultUrl: LEGACY_VAULT_URL,
      connectedVaultUrl: `${LEGACY_VAULT_URL}/`,
      vaultPort: {},
      isOpen: false
    }
    assert.equal(shouldShowVaultMigration(base), true)
    assert.equal(shouldShowVaultMigration({ ...base, vaultPort: null }), false)
    assert.equal(shouldShowVaultMigration({ ...base, isOpen: true }), false)
    assert.equal(shouldShowVaultMigration({
      ...base,
      connectedVaultUrl: EZ_VAULT_URL
    }), false)
  })

  it('normalizes equivalent canonical URLs for the pending EZ connection', () => {
    assert.equal(isSameVaultUrl(EZ_VAULT_URL, `${EZ_VAULT_URL}/`), true)
    assert.equal(isSameVaultUrl(EZ_VAULT_URL, LEGACY_VAULT_URL), false)
  })

  it('ships migration copy for every supported locale', () => {
    assert.equal(
      getT(vaultModalLocales, { locale: 'pt-BR' })('Use EZ Vault'),
      'Usar o EZ Vault'
    )
    assert.equal(
      getT(vaultModalLocales, { locale: 'ja' })('Back up in 44b-vault'),
      '44b-vault でバックアップ'
    )
  })
})
