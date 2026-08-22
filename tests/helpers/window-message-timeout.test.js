import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

let askStream

before(async () => {
  globalThis.IS_DEVELOPMENT = false
  ;({ askStream } = await import('../../src/helpers/window-message/index.js'))
})

describe('window-message stream timeout', () => {
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
