import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { base16ToBase62 } from 'libp2r2p/base62'
import { createSignerStateService } from '../../src/services/signer-state.js'

const owner = '11'.repeat(32)
const bunker = '33'.repeat(32)
const legacy = '01'.repeat(32)
const key = pubkey => `session_accountByUserPk_${base16ToBase62(pubkey)}_supportsContentKeyMethods`

function storage () {
  const data = new Map()
  const area = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key)
  }
  const signals = new Proxy({}, {
    get: (_, name) => (...values) => {
      const key = name.slice(0, -1)
      if (values.length) {
        if (values[0] === undefined) area.removeItem(key)
        else area.setItem(key, JSON.stringify(values[0]))
      } else return JSON.parse(area.getItem(key) ?? 'null') ?? undefined
    }
  })
  return { area, signals }
}

function setup () {
  const local = storage()
  const tab = storage()
  const pubkeys = [owner, bunker, legacy]
  local.signals.session_accountUserPks$(pubkeys.map(pubkey => base16ToBase62(pubkey)))
  local.signals.session_workspaceKeys$(['ws0', 'ws1', 'ws2'])
  local.signals.session_openWorkspaceKeys$(['ws0'])
  pubkeys.forEach((pubkey, i) => {
    local.signals[`session_workspaceByKey_ws${i}_userPk$`](base16ToBase62(pubkey))
    local.signals[`session_workspaceByKey_ws${i}_pinnedAppIds$`]([])
    local.signals[`session_workspaceByKey_ws${i}_unpinnedAppIds$`]([])
  })
  const source = readFileSync(new URL('../../src/components/zones/screen/use-init-or-reset-screen.js', import.meta.url), 'utf8')
  const context = vm.createContext({
    localStorage: local.area, base16ToBase62,
    firstAccountActivationMetadata: () => ({}),
    addWorkspaceForUser: () => assert.fail('existing accounts need no new workspace'),
    removeWidgetsForWorkspace: () => {}, removeSelectionsForWorkspace: () => {},
    retireSubdomainsFor: async () => {}, subdomainStorage: () => ({})
  })
  vm.runInContext(source.slice(source.indexOf('export async function setAccountsState')).replace('export ', ''), context)
  const apply = accounts => context.setAccountsState(accounts, local.signals, tab.signals)
  return { local, apply }
}

const account = (pubkey, capability) => ({
  pubkey, isReadOnly: false, isLocked: true, profile: {}, relays: {},
  ...(capability === undefined ? {} : { supportsContentKeyMethods: capability })
})

test('cached capabilities use the writable legacy fallback without persisting it', async () => {
  const { local, apply } = setup()
  await apply([account(owner, true), account(bunker, false), account(legacy)])
  assert.equal(local.area.getItem(key(owner)), 'true')
  assert.equal(local.area.getItem(key(bunker)), 'false')
  assert.equal(local.area.getItem(key(legacy)), null)
  const service = createSignerStateService({ getStorage: () => local.area })
  const scope = { ownerPubkey: owner, readKeys: () => [bunker, legacy] }
  assert.deepEqual(service.readContentKeyCapabilities(scope), {
    ownerPubkey: owner, pubkeysSupportingContentKeyMethods: [legacy, owner].sort()
  })
  assert.equal(service.read({ ...scope, readFlags: () => ({ isLocked: true }) }).connection, 'unknown')
  assert.equal(local.area.getItem(key(legacy)), null, 'reading the fallback does not write it')
  // Invalid metadata also uses the fallback, respecting the read-only flag.
  local.area.setItem(key(legacy), '"true"')
  local.area.setItem(`session_accountByUserPk_${base16ToBase62(legacy)}_isReadOnly`, 'true')
  assert.deepEqual(service.readContentKeyCapabilities(scope).pubkeysSupportingContentKeyMethods, [owner])
})

test('explicit false overrides the fallback and a recovered snapshot withdraws provisional support', async () => {
  const { local, apply } = setup()
  await apply([account(owner, false), account(bunker, false), account(legacy)])
  const service = createSignerStateService({ getStorage: () => local.area })
  const scope = { ownerPubkey: owner, readKeys: () => [bunker, legacy] }
  const updates = []
  service.subscribeContentKeyCapabilities(scope, snapshot => updates.push(snapshot))
  assert.deepEqual(updates.at(-1).pubkeysSupportingContentKeyMethods, [legacy])
  const recovered = [account(owner, false), account(bunker, false), account(legacy, false)]
  service.setAccounts(recovered)
  await apply(recovered)
  assert.deepEqual(updates.at(-1).pubkeysSupportingContentKeyMethods, [])
  assert.equal(local.area.getItem(key(legacy)), 'false')
  service.setAccounts([account(owner), { ...account(legacy), isReadOnly: true }])
  assert.deepEqual(updates.at(-1).pubkeysSupportingContentKeyMethods, [owner])
})

test('recovered snapshots replace cached capabilities, update subscriptions and fill legacy records', async () => {
  const { local, apply } = setup()
  await apply([account(owner, true), account(bunker, false), account(legacy)])
  const service = createSignerStateService({ getStorage: () => local.area })
  const scope = { ownerPubkey: owner, readKeys: () => [bunker, legacy] }
  const snapshots = []
  service.subscribeContentKeyCapabilities(scope, snapshot => snapshots.push(snapshot))
  const recovered = [account(owner, false), account(bunker, true), account(legacy, true)]
  service.setAccounts(recovered)
  await apply(recovered)
  assert.deepEqual(snapshots.at(-1).pubkeysSupportingContentKeyMethods, [legacy, bunker].sort())
  assert.equal(local.area.getItem(key(owner)), 'false')
  assert.equal(local.area.getItem(key(legacy)), 'true')
  const reopened = createSignerStateService({ getStorage: () => local.area })
  assert.deepEqual(reopened.readContentKeyCapabilities(scope), snapshots.at(-1))
  // Once the vault provides a snapshot, removed accounts never fall back to
  // cached support, even before account cleanup has committed.
  service.setAccounts([account(owner, false)])
  assert.deepEqual(snapshots.at(-1).pubkeysSupportingContentKeyMethods, [])
})

test('ordinary account removal clears the capability and missing snapshot fields remain unknown', async () => {
  const { local, apply } = setup()
  await apply([account(owner, true), account(bunker, false), account(legacy, true)])
  await apply([account(owner), account(legacy, true)])
  assert.equal(local.area.getItem(key(owner)), null)
  assert.equal(local.area.getItem(key(bunker)), null)
  assert.equal(local.area.getItem(key(legacy)), 'true')
})
