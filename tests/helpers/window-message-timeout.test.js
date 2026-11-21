import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

let ask
let askStream

before(async () => {
  globalThis.IS_DEVELOPMENT = false
  ;({ ask, askStream } = await import('../../src/helpers/window-message/index.js'))
})

describe('window-message stream timeout', () => {
  it('reports the generated request id on timeout so callers can cancel it remotely', async () => {
    const { port1, port2 } = new MessageChannel()
    const received = []
    port2.addEventListener('message', event => received.push(event.data))
    try {
      let cancelled
      const response = await ask(port1, { code: 'TEST', payload: null }, {
        timeout: 20,
        onCancel: (requestId, reason) => { cancelled = { requestId, reason } }
      })
      assert.match(response.error, /Timeout for TEST/)
      assert.equal(cancelled.requestId, received[0].reqId)
      assert.match(cancelled.reason, /Timeout for TEST/)
    } finally {
      port1.close()
      port2.close()
    }
  })

  it('aborts an individual request without waiting for its timeout', async () => {
    const { port1, port2 } = new MessageChannel()
    const controller = new AbortController()
    try {
      const pending = ask(port1, { code: 'TEST', payload: null }, {
        timeout: 60_000,
        signal: controller.signal
      })
      controller.abort(Object.assign(new Error('caller cancelled'), { code: 'CANCELLED' }))
      const response = await pending
      assert.equal(response.error.code, 'CANCELLED')
    } finally {
      port1.close()
      port2.close()
    }
  })

  it('yields a timeout error when the first reply never arrives', async () => {
    const { port1, port2 } = new MessageChannel()
    try {
      const iterator = askStream(port1, { code: 'TEST', payload: null }, { timeoutMs: 20 })
      const result = await iterator.next()
      assert.equal(result.value.error?.code, 'STREAM_TIMEOUT')
    } finally {
      port1.close()
      port2.close()
    }
  })
})
