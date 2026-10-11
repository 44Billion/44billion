import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

let sequence = 0
const validPackage = JSON.stringify({ name: 'ez-vault', scripts: { build: 'node bin/build.js' } })

async function setup (t, {
  sibling = true, packageText = validPackage, autoClose = true,
  failureIndex, exitCode = 7, signal, spawnError
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'launcher-production-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = path.join(directory, '44billion')
  const vaultRoot = path.join(directory, 'ez-vault')
  await mkdir(root)
  if (sibling) {
    await mkdir(vaultRoot)
    if (packageText !== null) await writeFile(path.join(vaultRoot, 'package.json'), packageText)
  }

  const calls = []
  const messages = []
  const changes = new EventEmitter()
  t.mock.module('node:child_process', {
    namedExports: {
      spawn (executable, args, options) {
        const child = new EventEmitter()
        const index = calls.length
        calls.push({ executable, args, options, child })
        changes.emit('spawn', index)
        if (autoClose) {
          queueMicrotask(() => {
            if (index === failureIndex && spawnError) child.emit('error', spawnError)
            else child.emit('close', index === failureIndex ? (signal ? null : exitCode) : 0, index === failureIndex ? signal : null)
          })
        }
        return child
      }
    }
  })
  const { prepareProductionBuild } = await import(`../../bin/prepare-production-build.js?test=${sequence++}`)
  const env = { NODE_ENV: 'production', BUILD_TEST_MARKER: 'preserved' }
  const run = options => prepareProductionBuild({ root, env, log: message => messages.push(message), ...options })
  const waitForCall = index => calls[index]
    ? Promise.resolve(calls[index])
    : new Promise(resolve => changes.once('spawn', () => resolve(calls[index])))
  return { root, vaultRoot, run, calls, messages, waitForCall }
}

test('production waits for both installs and the vault build before returning', async t => {
  const api = await setup(t, { autoClose: false })
  let finished = false
  const preparing = api.run().then(() => { finished = true })
  const expected = [
    { cwd: api.root, args: ['i', '--include=dev'] },
    { cwd: api.vaultRoot, args: ['i', '--include=dev'] },
    { cwd: api.vaultRoot, args: ['run', 'build'] }
  ]
  for (const [index, command] of expected.entries()) {
    const call = await api.waitForCall(index)
    assert.equal(api.calls.length, index + 1)
    assert.equal(finished, false)
    assert.equal(call.executable, 'npm')
    assert.deepEqual(call.args, command.args)
    assert.equal(call.options.cwd, command.cwd)
    assert.equal(call.options.env.NODE_ENV, 'production')
    assert.equal(call.options.env.BUILD_TEST_MARKER, 'preserved')
    assert.equal(call.options.stdio, 'inherit')
    call.child.emit('close', 0, null)
  }
  await preparing
  assert.equal(finished, true)
  assert.equal(api.messages.length, 3)
})

test('a missing sibling warns and installs only the launcher', async t => {
  const api = await setup(t, { sibling: false })
  await api.run()
  assert.equal(api.calls.length, 1)
  assert.equal(api.calls[0].options.cwd, api.root)
  assert.deepEqual(api.calls[0].args, ['i', '--include=dev'])
  assert.match(api.messages[0], /ez-vault not found.*building only the launcher/)
})

test('development skips validation, installations and vault builds', async t => {
  const api = await setup(t, { packageText: 'invalid JSON' })
  await api.run({ env: { NODE_ENV: 'development' } })
  assert.deepEqual(api.calls, [])
  assert.deepEqual(api.messages, [])
})

test('an invalid sibling aborts before any installation', async t => {
  for (const packageText of [
    null, 'invalid JSON', 'null',
    JSON.stringify({ name: 'other', scripts: { build: 'node build.js' } }),
    JSON.stringify({ name: 'ez-vault' }),
    JSON.stringify({ name: 'ez-vault', scripts: { build: ' ' } })
  ]) {
    await t.test(`rejects manifest ${packageText}`, async t => {
      const api = await setup(t, { packageText })
      await assert.rejects(api.run(), /Invalid ez-vault package.json|Expected package name/)
      assert.deepEqual(api.calls, [])
    })
  }
})

test('a file at the sibling path is rejected before installation', async t => {
  const api = await setup(t, { sibling: false })
  await writeFile(api.vaultRoot, 'not a project directory')
  await assert.rejects(api.run(), /Expected an ez-vault project directory/)
  assert.deepEqual(api.calls, [])
})

test('a failed command stops every later production step', async t => {
  for (const failureIndex of [0, 1, 2]) {
    await t.test(`stops after command ${failureIndex + 1}`, async t => {
      const api = await setup(t, { failureIndex })
      await assert.rejects(api.run(), /failed \(exit 7\)/)
      assert.equal(api.calls.length, failureIndex + 1)
    })
  }
})

test('a subprocess startup error is preserved and stops preparation', async t => {
  const cause = Object.assign(new Error('npm not found'), { code: 'ENOENT' })
  const api = await setup(t, { failureIndex: 0, spawnError: cause })
  await assert.rejects(api.run(), error => {
    assert.match(error.message, /Could not start 44billion: npm i/)
    assert.equal(error.cause, cause)
    return true
  })
  assert.equal(api.calls.length, 1)
})

test('a subprocess terminated by a signal stops preparation', async t => {
  const api = await setup(t, { failureIndex: 1, signal: 'SIGTERM' })
  await assert.rejects(api.run(), /failed \(SIGTERM\)/)
  assert.equal(api.calls.length, 2)
})

test('the development builder never calls production preparation', async t => {
  const previousEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'development'
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousEnv
  })
  let watched = false
  t.mock.module('../../bin/prepare-production-build.js', {
    namedExports: { prepareProductionBuild: () => { throw new Error('Production preparation ran in development') } }
  })
  t.mock.module('esbuild', {
    defaultExport: { context: async () => ({ watch: async () => { watched = true } }) }
  })
  t.mock.module('../../bin/build-output.js', {
    namedExports: { createBuildOutput: () => ({ plugin: {}, serve: async () => ({}) }) }
  })
  const originalHandlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, process.listeners(signal)]))
  t.after(() => {
    for (const [signal, original] of originalHandlers) {
      for (const handler of process.listeners(signal)) {
        if (!original.includes(handler)) process.removeListener(signal, handler)
      }
    }
  })
  await import(`../../bin/build.js?test=${sequence++}`)
  assert.equal(watched, true)
})
