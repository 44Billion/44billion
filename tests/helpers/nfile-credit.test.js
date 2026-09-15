import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNfileCredit } from '#helpers/window-message/nfile-credit.js'

test('download credit blocks reads until demand and closes a pending read', async () => {
  const gate = createNfileCredit()
  let read = false
  const first = gate.take().then(value => { read = value })
  await Promise.resolve()
  assert.equal(read, false)
  gate.grant()
  await first
  assert.equal(read, true)
  gate.grant(); gate.grant()
  assert.equal(await gate.take(), true)
  const pending = gate.take()
  gate.close()
  assert.equal(await pending, false)
  gate.grant()
  assert.equal(await gate.take(), false)
})
