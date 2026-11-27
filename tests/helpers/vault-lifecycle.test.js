import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createVaultAuthorityState } from '../../src/components/zones/vault-modal/vault-authority.js'
import { createVaultLifecycleQueue } from '../../src/components/zones/vault-modal/vault-lifecycle.js'

test('a newer vault generation makes running work stale and commits serially', async () => {
  const lifecycle = createVaultLifecycleQueue()
  const gate = Promise.withResolvers()
  const steps = []

  const first = lifecycle.advance()
  const firstWork = first.run(async isCurrent => {
    steps.push('first-start')
    await gate.promise
    steps.push(`first-current:${isCurrent()}`)
    return 'first-result'
  })
  await new Promise(resolve => setImmediate(resolve))

  const second = lifecycle.advance()
  const secondWork = second.run(async isCurrent => {
    steps.push(`second-start-current:${isCurrent()}`)
    return 'second-result'
  })

  gate.resolve()
  const [firstResult, secondResult] = await Promise.all([firstWork, secondWork])
  assert.deepEqual(steps, [
    'first-start',
    'first-current:false',
    'second-start-current:true'
  ])
  assert.deepEqual(firstResult, {
    generation: first.generation,
    stale: true,
    result: 'first-result'
  })
  assert.deepEqual(secondResult, {
    generation: second.generation,
    stale: false,
    result: 'second-result'
  })
  assert.equal(lifecycle.currentGeneration(), second.generation)
})

test('work queued for a superseded generation is skipped', async () => {
  const lifecycle = createVaultLifecycleQueue()
  const first = lifecycle.advance()
  const firstGate = Promise.withResolvers()
  const steps = []

  const firstWork = first.run(async () => {
    await firstGate.promise
    steps.push('first')
  })
  await new Promise(resolve => setImmediate(resolve))
  const staleWork = first.run(() => steps.push('stale'))
  lifecycle.advance()
  firstGate.resolve()

  await Promise.all([firstWork, staleWork])
  assert.deepEqual(steps, ['first'])
})

test('a vault authority becomes final only when explicitly committed', () => {
  const authority = createVaultAuthorityState()
  assert.equal(authority.hasAuthoritativeState(), false)
  authority.markAuthoritative()
  assert.equal(authority.hasAuthoritativeState(), true)
})
