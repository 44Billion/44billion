import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../../src/scripts/app-page.txt.js', import.meta.url), 'utf8')
const injection = source.slice(source.indexOf('function injectNip07 ('), source.indexOf('// Intercept and cancel navigations'))

function setup () {
  const handshake = Promise.withResolvers()
  const messages = []
  const warnings = []
  const context = vm.createContext({
    window: {},
    originalConsole: { warn: (...args) => warnings.push(args) },
    tell: (port, message) => messages.push({ port, ...structuredClone(message) })
  })
  vm.runInContext(injection, context)
  context.injectNip07(handshake.promise)
  return { ...handshake, setMinWidth: context.window.napp.setMinWidth, messages, warnings }
}

test('setMinWidth waits for the handshake and sends queued commands in call order', async () => {
  const { setMinWidth, resolve, messages } = setup()
  const first = setMinWidth(640.4)
  const second = setMinWidth('320.6')
  const third = setMinWidth(0)
  await Promise.resolve()
  assert.deepEqual(messages, [])

  const port = {}
  resolve(port)
  assert.deepEqual(await Promise.all([first, second, third]), [undefined, undefined, undefined])
  await setMinWidth(800)
  assert.deepEqual(messages, [640, 321, 0, 800].map(minWidth => ({
    port, code: 'AUTO_FIT', payload: { op: 'setMinWidth', minWidth }
  })))
  assert.ok(messages.every(message => message.port === port))
})

test('setMinWidth ignores invalid values without waiting for the handshake', async () => {
  const { setMinWidth, messages, warnings } = setup()
  for (const value of [-1, NaN, Infinity, 'invalid']) {
    assert.equal(await setMinWidth(value), undefined)
  }
  assert.equal(warnings.length, 4)
  assert.deepEqual(messages, [])
})

test('setMinWidth rejects when the handshake fails without sending the command', async () => {
  const { setMinWidth, reject, messages } = setup()
  const pending = setMinWidth(640)
  const error = new Error('Handshake failed')
  reject(error)
  await assert.rejects(pending, caught => caught === error)
  assert.deepEqual(messages, [])
})
