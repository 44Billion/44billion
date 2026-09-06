import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { resetDraftAppRuntimeData } from '../../src/components/zones/screen/helpers/draft-app-runtime-reset.js'

describe('draft app runtime reset helper', () => {
  it('clears app origin data and owner-scoped NostrDB rows', async () => {
    const ownerPubkey = 'a'.repeat(64)
    const cleared = []
    const deleted = []

    assert.equal(await resetDraftAppRuntimeData({
      appId: 'draft-app',
      userPk: 'owner-pk',
      appSubdomain: '42',
      _askAppToClearData: async appSubdomain => { cleared.push(appSubdomain) },
      _base62ToBase16: () => ownerPubkey,
      _getNostrDb: owner => ({
        async deleteEventsByApp (appId) { deleted.push({ owner, appId }) }
      })
    }), true)

    assert.deepEqual(cleared, ['42'])
    assert.deepEqual(deleted, [{ owner: ownerPubkey, appId: 'draft-app' }])
  })

  it('continues when clearing or NostrDB deletion fails', async () => {
    const warnings = []

    assert.equal(await resetDraftAppRuntimeData({
      appId: 'draft-app',
      userPk: 'owner-pk',
      appSubdomain: '42',
      _askAppToClearData: async () => { throw new Error('clear failed') },
      _base62ToBase16: () => { throw new Error('bad owner') },
      _console: { warn: (...args) => warnings.push(args) }
    }), true)

    assert.equal(warnings.length, 2)
    assert.match(warnings[0][0], /origin data/)
    assert.match(warnings[1][0], /NostrDB/)
  })

  it('does nothing without an app id', async () => {
    const clear = mock.fn(async () => {})

    assert.equal(await resetDraftAppRuntimeData({
      appId: '',
      _askAppToClearData: clear
    }), false)
    assert.equal(clear.mock.callCount(), 0)
  })
})

it('accepts cleanup confirmation only from its own iframe and request', async () => {
  const { askAppToClearData } = await import('../../src/components/zones/screen/helpers/draft-app-runtime-reset.js')
  let receive
  const iframe = { style: {}, contentWindow: {}, remove: mock.fn() }
  const window = {
    location: { protocol: 'https:', host: 'launcher.test' },
    addEventListener: (_, listener) => { receive = listener },
    removeEventListener: mock.fn()
  }
  let completed = false
  const pending = askAppToClearData('7', {
    requestId: 'expected', strict: true, _window: window,
    _document: { createElement: () => iframe, body: { appendChild () {} } }
  }).then(value => { completed = true; return value })
  receive({ origin: 'https://7.launcher.test', source: {}, data: { code: 'DATA_CLEARED', requestId: 'expected' } })
  receive({ origin: 'https://7.launcher.test', source: iframe.contentWindow, data: { code: 'DATA_CLEARED', requestId: 'old' } })
  await Promise.resolve()
  assert.equal(completed, false)
  assert.match(iframe.src, /strictClear=1/)
  receive({ origin: 'https://7.launcher.test', source: iframe.contentWindow, data: { code: 'DATA_CLEARED', requestId: 'expected' } })
  assert.equal(await pending, true)
  assert.equal(iframe.remove.mock.callCount(), 1)
})
