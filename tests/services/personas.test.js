import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

mock.module('#f', {
  namedExports: {
    setWebStorageItem: (storageArea, key, value) => {
      if (value === undefined) storageArea.removeItem(key)
      else storageArea.setItem(key, JSON.stringify(value))
      return value
    }
  }
})

const {
  DEFAULT_PERSONA_ID,
  addPersona,
  cleanupPersonaReferences,
  getAppPersonaSelection,
  getDefaultPersonaUserPks,
  isUserPkInActivePersona,
  normalizePersonas,
  removePersona,
  resolvePersonaUserPks,
  setAppPersonaSelection,
  updatePersonaUserPks,
  userPksToHex
} = await import('#services/personas/index.js')

function storageMock (entries = {}) {
  const data = new Map(Object.entries({
    session_workspaceByKey_ws1_userPk: JSON.stringify(PK1),
    session_accountUserPks: JSON.stringify([PK1, PK2]),
    session_defaultUserPk: JSON.stringify('default'),
    ...entries
  }))
  return {
    get length () { return data.size },
    key (index) { return [...data.keys()][index] ?? null },
    getItem (key) { return data.has(key) ? data.get(key) : null },
    setItem (key, value) { data.set(key, String(value)) },
    removeItem (key) { data.delete(key) },
    _data: data
  }
}

function encode (entries) {
  return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)]))
}

const PK1 = 'a'.repeat(43)
const PK2 = 'b'.repeat(43)

describe('personas', () => {
  it('default persona contains real accounts and excludes the default user', () => {
    assert.deepEqual(
      getDefaultPersonaUserPks({ accountUserPks: ['default', PK1, PK2], defaultUserPk: 'default' }),
      [PK1, PK2]
    )
  })

  it('default persona falls back to the default user when no real accounts exist', () => {
    assert.deepEqual(
      getDefaultPersonaUserPks({ accountUserPks: ['default'], defaultUserPk: 'default' }),
      ['default']
    )
    assert.deepEqual(
      getDefaultPersonaUserPks({ accountUserPks: [], defaultUserPk: 'default' }),
      ['default']
    )
  })

  it('resolves null selection to the workspace user', () => {
    assert.deepEqual(
      resolvePersonaUserPks({
        personaId: null,
        personas: {},
        accountUserPks: [PK1],
        defaultUserPk: 'default',
        workspaceUserPk: PK2
      }),
      [PK2]
    )
  })

  it('resolves the virtual default persona id without a stored record', () => {
    assert.deepEqual(
      resolvePersonaUserPks({
        personaId: DEFAULT_PERSONA_ID,
        personas: {},
        accountUserPks: [PK1, PK2],
        defaultUserPk: 'default',
        workspaceUserPk: PK1
      }),
      [PK1, PK2]
    )
  })

  it('resolves a custom persona and falls back for unknown ids', () => {
    const personas = { p1: { userPks: [PK1, PK2] } }
    assert.deepEqual(
      resolvePersonaUserPks({
        personaId: 'p1',
        personas,
        accountUserPks: [],
        defaultUserPk: 'default',
        workspaceUserPk: PK2
      }),
      [PK1, PK2]
    )
    assert.deepEqual(
      resolvePersonaUserPks({
        personaId: 'missing',
        personas,
        accountUserPks: [],
        defaultUserPk: 'default',
        workspaceUserPk: PK2
      }),
      [PK2]
    )
  })

  it('checks whether a pubkey belongs to the active persona', () => {
    const personas = { p1: { userPks: [PK1] } }
    const base = {
      personaId: 'p1',
      personas,
      accountUserPks: [PK2],
      defaultUserPk: 'default',
      workspaceUserPk: PK1
    }
    assert.equal(isUserPkInActivePersona({ userPk: PK1, ...base }), true)
    assert.equal(isUserPkInActivePersona({ userPk: PK2, ...base }), false)
  })

  it('converts userPks to hex and drops invalid values', () => {
    const result = userPksToHex([PK1, PK2, 'not-base62'])
    assert.equal(result.length, 2)
    assert.match(result[0], /^[0-9a-f]{64}$/)
    assert.match(result[1], /^[0-9a-f]{64}$/)
    assert.notEqual(result[0], result[1])
  })

  it('adds, reads and updates personas', () => {
    const local = storageMock()
    const id = addPersona({ localStorageArea: local, userPks: [PK1, PK2], personaId: 'p1', now: 100 })
    assert.equal(id, 'p1')
    assert.deepEqual(JSON.parse(local.getItem('local_personas')).p1.userPks, [PK1, PK2])

    updatePersonaUserPks({ localStorageArea: local, personaId: 'p1', userPks: [PK1], now: 200 })
    assert.deepEqual(JSON.parse(local.getItem('local_personas')).p1.userPks, [PK1])
  })

  it('stores and reads app persona selections per workspace and app', () => {
    const local = storageMock(encode({ local_personas: { p1: { userPks: [PK1] } } }))
    setAppPersonaSelection({ localStorageArea: local, wsKey: 'ws1', appId: 'app1', personaId: 'p1' })
    setAppPersonaSelection({ localStorageArea: local, wsKey: 'ws1', appId: 'app2', personaId: DEFAULT_PERSONA_ID })
    assert.equal(getAppPersonaSelection({ localStorageArea: local, wsKey: 'ws1', appId: 'app1' }), 'p1')
    assert.equal(getAppPersonaSelection({ localStorageArea: local, wsKey: 'ws1', appId: 'app2' }), DEFAULT_PERSONA_ID)
    assert.equal(getAppPersonaSelection({ localStorageArea: local, wsKey: 'ws1', appId: 'app3' }), null)

    setAppPersonaSelection({ localStorageArea: local, wsKey: 'ws1', appId: 'app1', personaId: null })
    assert.equal(getAppPersonaSelection({ localStorageArea: local, wsKey: 'ws1', appId: 'app1' }), null)
  })

  it('removing a persona clears selections referencing it', () => {
    const local = storageMock(encode({
      local_personas: { p1: { userPks: [PK1], createdAt: 1, updatedAt: 1 } },
      local_appPersonaSelections: {
        ws1: { app1: 'p1', app2: DEFAULT_PERSONA_ID }
      }
    }))
    removePersona({ localStorageArea: local, personaId: 'p1' })
    assert.deepEqual(JSON.parse(local.getItem('local_personas')), {})
    assert.deepEqual(JSON.parse(local.getItem('local_appPersonaSelections')), {
      ws1: { app2: DEFAULT_PERSONA_ID }
    })
  })

  it('normalizes empty personas and stale references', () => {
    const local = storageMock(encode({
      local_personas: {
        p1: { userPks: [PK1], createdAt: 1, updatedAt: 1 },
        p2: { userPks: [], createdAt: 1, updatedAt: 1 },
        p3: 'invalid'
      },
      local_appPersonaSelections: {
        ws1: { app1: 'p1', app2: 'p2', app3: 'missing' }
      }
    }))
    const personas = normalizePersonas(local)
    assert.deepEqual(Object.keys(personas), ['p1'])
    assert.deepEqual(JSON.parse(local.getItem('local_appPersonaSelections')), {
      ws1: { app1: 'p1' }
    })
  })

  it('cleanupPersonaReferences keeps the virtual default persona', () => {
    const local = storageMock(encode({
      local_personas: {},
      local_appPersonaSelections: {
        ws1: { app1: 'missing', app2: DEFAULT_PERSONA_ID }
      }
    }))
    cleanupPersonaReferences(local)
    assert.deepEqual(JSON.parse(local.getItem('local_appPersonaSelections')), {
      ws1: { app2: DEFAULT_PERSONA_ID }
    })
  })
})

const { createPersonaPublicKeysService, readAppPersonaPublicKeys } = await import('../../src/services/personas/public-keys.js')
globalThis.IS_DEVELOPMENT = false
const { connectPersonaPublicKeysPort } = await import('../../src/helpers/window-message/persona-public-keys-port.js')
const tick = () => new Promise(resolve => queueMicrotask(resolve))

describe('persona eligibility and live public keys', () => {
  const context = { personas: { p: { userPks: [PK2] } }, accountUserPks: [PK2], defaultUserPk: 'default', workspaceUserPk: PK1 }
  it('falls back immediately when a custom or virtual persona excludes the workspace user', () => {
    for (const personaId of ['p', DEFAULT_PERSONA_ID, 'missing']) {
      assert.deepEqual(resolvePersonaUserPks({ ...context, personaId }), [PK1])
    }
  })

  it('revalidates stale choices, clears only affected selections, and avoids redundant writes', () => {
    const local = storageMock(encode({
      session_workspaceByKey_ws2_userPk: PK2,
      local_personas: { p: { userPks: [PK1, PK2] }, solo: { userPks: [PK1] } },
      local_appPersonaSelections: { ws1: { app1: 'p', app2: 'solo' }, ws2: { app1: 'p' } }
    }))
    updatePersonaUserPks({ localStorageArea: local, personaId: 'p', userPks: [PK2] })
    assert.deepEqual(JSON.parse(local.getItem('local_appPersonaSelections')), { ws1: { app2: 'solo' }, ws2: { app1: 'p' } })
    setAppPersonaSelection({ localStorageArea: local, wsKey: 'ws1', appId: 'app2', personaId: 'p' })
    assert.deepEqual(JSON.parse(local.getItem('local_appPersonaSelections')), { ws2: { app1: 'p' } })
    const write = local.setItem
    let writes = 0
    local.setItem = (...args) => { writes++; write(...args) }
    cleanupPersonaReferences(local)
    setAppPersonaSelection({ localStorageArea: local, wsKey: 'ws1', appId: 'app1', personaId: null })
    assert.equal(writes, 0)
    local.setItem('session_workspaceByKey_ws2_userPk', JSON.stringify(PK1))
    cleanupPersonaReferences(local)
    assert.deepEqual(JSON.parse(local.getItem('local_appPersonaSelections')), {})
  })

  it('resets virtual selections when the guest is excluded by newly connected accounts', () => {
    const local = storageMock(encode({
      session_workspaceByKey_ws1_userPk: 'default', session_accountUserPks: [],
      local_appPersonaSelections: { ws1: { app1: DEFAULT_PERSONA_ID } }
    }))
    cleanupPersonaReferences(local)
    assert.equal(getAppPersonaSelection({ localStorageArea: local, wsKey: 'ws1', appId: 'app1' }), DEFAULT_PERSONA_ID)
    local.setItem('session_accountUserPks', JSON.stringify([PK2]))
    cleanupPersonaReferences(local)
    assert.equal(getAppPersonaSelection({ localStorageArea: local, wsKey: 'ws1', appId: 'app1' }), null)
  })

  it('coalesces resets to final keys across instances and preserves replacements after old cleanup', async () => {
    const local = storageMock(encode({ local_personas: { p: { userPks: [PK1, PK2] } }, local_appPersonaSelections: { ws1: { app1: 'p' } } }))
    const read = record => readAppPersonaPublicKeys(record, local)
    const service = createPersonaPublicKeysService({ read })
    const record = { instanceKey: 'window', wsKey: 'ws1', appId: 'app1' }
    const port = new EventTarget()
    const ac = new AbortController()
    const messages = []
    assert.deepEqual(connectPersonaPublicKeysPort(service, { record, port, signal: ac.signal, send: (_, msg) => messages.push(msg) }), userPksToHex([PK1, PK2]))
    const widget = []
    service.connect({ ...record, instanceKey: 'widget' }, keys => widget.push(keys))
    const unrelated = []
    service.connect({ ...record, instanceKey: 'other-app', appId: 'app2' }, keys => unrelated.push(keys))
    service.invalidate()
    await tick()
    assert.deepEqual(messages, [])
    updatePersonaUserPks({ localStorageArea: local, personaId: 'p', userPks: [PK2] })
    service.invalidate(); service.invalidate()
    await tick()
    assert.deepEqual(messages, [{ code: 'PERSONA_PUBLIC_KEYS_CHANGED', payload: userPksToHex([PK1]) }])
    assert.deepEqual(widget, [userPksToHex([PK1])])
    assert.deepEqual(unrelated, [])
    const replacement = []
    const fresh = new EventTarget()
    const nextAc = new AbortController()
    connectPersonaPublicKeysPort(service, { record, port: fresh, signal: nextAc.signal, send: (_, msg) => replacement.push(msg) })
    ac.abort()
    port.dispatchEvent(new MessageEvent('message', { data: { code: 'INSTANCE_DOCUMENT_UNLOADED' } }))
    setAppPersonaSelection({ localStorageArea: local, wsKey: 'ws1', appId: 'app1', personaId: DEFAULT_PERSONA_ID })
    service.invalidate()
    await tick()
    assert.equal(messages.length, 1)
    assert.deepEqual(replacement.at(-1).payload, userPksToHex([PK1, PK2]))
    fresh.dispatchEvent(new MessageEvent('message', { data: { code: 'INSTANCE_DOCUMENT_UNLOADED' } }))
    nextAc.abort()
    setAppPersonaSelection({ localStorageArea: local, wsKey: 'ws1', appId: 'app1', personaId: null })
    service.invalidate()
    await tick()
    assert.equal(replacement.length, 1)
  })
})
