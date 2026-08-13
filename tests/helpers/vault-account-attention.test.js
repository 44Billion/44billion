import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFile } from 'node:fs/promises'

import {
  FIRST_ACCOUNT_ATTENTION_MS,
  firstAccountActivationMetadata,
  shouldShowFirstAccountAttention
} from '../../src/components/zones/screen/account-attention.js'
import {
  createAccountStateCoordinator
} from '../../src/components/zones/vault-modal/account-state-coordinator.js'

describe('first vault account attention', () => {
  it('identifies only a default-user to one-real-account transition', () => {
    assert.deepEqual(firstAccountActivationMetadata({
      hasOnlyDefaultUser: true,
      defaultUserPk: 'default',
      nextUserPks: ['real']
    }), { activatedFirstAccount: true, userPk: 'real' })

    for (const input of [
      { hasOnlyDefaultUser: false, defaultUserPk: 'default', nextUserPks: ['real'] },
      { hasOnlyDefaultUser: true, defaultUserPk: 'default', nextUserPks: [] },
      { hasOnlyDefaultUser: true, defaultUserPk: 'default', nextUserPks: ['one', 'two'] },
      { hasOnlyDefaultUser: true, defaultUserPk: 'default', nextUserPks: ['default'] },
      { hasOnlyDefaultUser: true, defaultUserPk: null, nextUserPks: ['real'] }
    ]) {
      assert.deepEqual(firstAccountActivationMetadata(input), {
        activatedFirstAccount: false,
        userPk: null
      })
    }
  })

  it('shows only an unexpired signal for the sole active non-default account', () => {
    const attention = { id: 1, userPk: 'real', expiresAt: 2000 }
    const base = {
      attention,
      activeUserPk: 'real',
      accountUserPks: ['real'],
      defaultUserPk: undefined,
      now: 1000
    }
    assert.equal(shouldShowFirstAccountAttention(base), true)
    assert.equal(shouldShowFirstAccountAttention({ ...base, activeUserPk: 'other' }), false)
    assert.equal(shouldShowFirstAccountAttention({ ...base, accountUserPks: ['real', 'other'] }), false)
    assert.equal(shouldShowFirstAccountAttention({ ...base, defaultUserPk: 'real' }), false)
    assert.equal(shouldShowFirstAccountAttention({ ...base, now: 2000 }), false)
    assert.equal(shouldShowFirstAccountAttention({ ...base, attention: null }), false)
    assert.equal(FIRST_ACCOUNT_ATTENTION_MS, 2200)
  })

  it('waits for explicit account state before closing and emits afterward', async () => {
    const steps = []
    let finishApplication
    const applicationGate = new Promise(resolve => { finishApplication = resolve })
    const coordinator = createAccountStateCoordinator({
      applyAccountsState: async () => {
        steps.push('apply')
        await applicationGate
        return { activatedFirstAccount: true, userPk: 'real' }
      },
      closeVault: () => steps.push('close'),
      emitFirstAccountAttention: metadata => steps.push(`emit:${metadata.userPk}`)
    })

    const applying = coordinator.apply([{}], { allowAttention: true })
    const closing = coordinator.close()
    await Promise.resolve()
    assert.deepEqual(steps, ['apply'])

    finishApplication()
    await Promise.all([applying, closing])
    assert.deepEqual(steps, ['apply', 'close', 'emit:real'])
  })

  it('does not arm startup state and consumes explicit attention once', async () => {
    const emitted = []
    let closeCount = 0
    const coordinator = createAccountStateCoordinator({
      applyAccountsState: async () => ({ activatedFirstAccount: true, userPk: 'real' }),
      closeVault: () => { closeCount++ },
      emitFirstAccountAttention: metadata => emitted.push(metadata.userPk)
    })

    await coordinator.apply([{}])
    await coordinator.close()
    assert.deepEqual(emitted, [])

    await coordinator.apply([{}], { allowAttention: true })
    await coordinator.close()
    await coordinator.close()
    assert.deepEqual(emitted, ['real'])
    assert.equal(closeCount, 3)
  })

  it('emits when the first-account state arrives after the drawer already closed', async () => {
    const steps = []
    let vaultOpen = true
    const coordinator = createAccountStateCoordinator({
      applyAccountsState: async accounts => ({
        activatedFirstAccount: accounts.length === 1,
        userPk: accounts.length === 1 ? 'real' : null
      }),
      closeVault: () => {
        vaultOpen = false
        steps.push('close')
      },
      isVaultOpen: () => vaultOpen,
      emitFirstAccountAttention: metadata => steps.push(`emit:${metadata.userPk}`)
    })

    await coordinator.apply([], { allowAttention: true })
    await coordinator.close()
    await coordinator.apply([{}], { allowAttention: true })

    assert.deepEqual(steps, ['close', 'emit:real'])
  })

  it('keeps the halo scoped, themed and reduced-motion aware', async () => {
    const screen = await readFile(
      new URL('../../src/components/zones/screen/index.js', import.meta.url),
      'utf8'
    )
    const vault = await readFile(
      new URL('../../src/components/zones/vault-modal/index.js', import.meta.url),
      'utf8'
    )

    assert.match(screen, /#toolbar-active-avatar-button\.first-account-attention::before/)
    assert.match(screen, /#toolbar-active-avatar-button\.first-account-attention::after/)
    assert.match(screen, /border: 2px solid \$\{cssVars\.colors\.bgAccentPrimary\}/)
    assert.match(screen, /1\.4s ease-out/)
    assert.match(screen, /animation-delay: 550ms/)
    assert.match(screen, /prefers-reduced-motion: reduce/)
    assert.match(screen, /toolbar-first-account-outline/)
    assert.match(vault, /case 'CLOSE_VAULT_VIEW':[\s\S]*reply\([\s\S]*await accountState\.close\(\)/)
    assert.match(vault, /accountState\.apply\(e\.data\.payload\.accounts, \{ allowAttention: true \}\)/)
  })
})
