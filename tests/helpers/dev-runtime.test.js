import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
let sequence = 0

async function setup (t, { existing, conflict, autoBuild = true } = {}) {
  const children = []
  const checkedPorts = []
  let serving = false
  const health = () => existing ?? (serving ? { service: '44billion', protocol: 2, root, ready: true } : null)
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => health() }))
  t.mock.module('node:fs/promises', { namedExports: { ...fs, access: async () => {}, realpath: async value => value } })
  t.mock.module('node:net', {
    namedExports: {
      createServer: () => Object.assign(new EventEmitter(), {
        listen (port, host, ready) {
          checkedPorts.push(port)
          queueMicrotask(() => port === conflict ? this.emit('error', Object.assign(new Error('busy'), { code: 'EADDRINUSE' })) : ready())
        },
        close (done) { done() }
      })
    }
  })
  t.mock.module('node:child_process', {
    namedExports: {
      spawn: (executable, args, options) => {
        const child = Object.assign(new EventEmitter(), {
          executable, args, options, stdout: new EventEmitter(), stderr: new EventEmitter(),
          exitCode: null, signalCode: null, killed: [],
          kill (signal) {
            this.killed.push(signal)
            this.signalCode = signal
            queueMicrotask(() => { this.emit('exit', null, signal); this.emit('close') })
          }
        })
        children.push(child)
        if (args[0] === 'server/dev-server.js') serving = true
        if (autoBuild) {
          queueMicrotask(() => {
            child.emit('message', { type: 'build-end', ok: true })
            child.stdout.emit('data', 'watching src/')
          })
        }
        return child
      }
    }
  })
  const api = await import(`../../bin/dev-runtime.js?test=${sequence++}`)
  return { ...api, children, checkedPorts }
}

test('compatible runtime reuse neither starts nor stops processes', async t => {
  const api = await setup(t, { existing: { service: '44billion', protocol: 2, root, ready: true } })
  const runtime = await api.ensureRuntime()
  assert.equal(runtime.owned, false)
  await runtime.close()
  assert.deepEqual(api.children, [])
  assert.deepEqual(api.checkedPorts, [])
})

test('an incompatible occupied launcher fails without touching its processes', async t => {
  const api = await setup(t, { existing: { service: 'other' }, conflict: 10000 })
  await assert.rejects(api.ensureRuntime(), /Port 10000 is occupied/)
  assert.deepEqual(api.children, [])
})

test('startup waits for builds and shutdown stops each owned process once', async t => {
  const api = await setup(t, { autoBuild: false })
  const starting = api.ensureRuntime({ log: () => {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(api.children.length, 2)
  assert.deepEqual(api.checkedPorts, [10000, 8080, 4000])
  api.children[0].emit('message', { type: 'build-end', ok: false })
  api.children[1].stdout.emit('data', 'watching src/')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(api.children.length, 2)
  api.children[0].emit('message', { type: 'build-end', ok: true })
  const runtime = await starting
  assert.equal(runtime.owned, true)
  assert.equal(api.children.length, 4)
  assert.equal(api.children[2].options.env.EZ_VAULT_SERVE_DIR, '.dev')
  await Promise.all([runtime.close(), runtime.close()])
  assert.ok(api.children.every(child => child.killed.length === 1))
  await runtime.closed
})

test('fatal child failure shuts down siblings and rejects the runtime handle', async t => {
  const api = await setup(t)
  const runtime = await api.ensureRuntime({ log: () => {} })
  api.children[0].exitCode = 1
  api.children[0].emit('exit', 1)
  await assert.rejects(runtime.closed, /exited \(1\)/)
  await runtime.close()
  assert.ok(api.children.slice(1).every(child => child.killed.length === 1))
})

test('startup timeout and aborted startup clean up owned builders', async t => {
  const api = await setup(t, { autoBuild: false })
  await assert.rejects(api.ensureRuntime({ log: () => {}, timeoutMs: 20 }), /Timed out starting/)
  assert.ok(api.children.every(child => child.killed.length === 1))
  const count = api.children.length
  await assert.rejects(api.ensureRuntime({ signal: AbortSignal.abort() }), { name: 'AbortError' })
  assert.equal(api.children.length, count)
})
