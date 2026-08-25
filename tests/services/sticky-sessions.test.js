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
  ackStickySessionDeletion,
  buildSnapshotFromDraft,
  claimAndHydrateStickySession,
  collectValidAppKeys,
  commitStickySnapshot,
  duplicateStickySession,
  gcStickySessions,
  heartbeatStickyClaim,
  hydrateSnapshot,
  isClaimActive,
  isSnapshotEmpty,
  listSessionWorkspaceAppGroups,
  LOCAL_STICKY_CLAIMS,
  LOCAL_STICKY_DELETIONS,
  LOCAL_STICKY_SEEN_IDS,
  LOCAL_STICKY_SNAPSHOTS,
  markStickySessionsSeen,
  pickSnapshotToRestore,
  purgeStickySessions,
  releaseStickyClaim,
  removeStickySession,
  requestStickySessionDelete,
  resetStickySessionState,
  SESSION_STICKY_TAB_ID,
  unseenUnclaimedCount,
  validateAndCleanSnapshot
} = await import('#services/sticky-sessions/index.js')

function storageMock (entries = {}) {
  const data = new Map(Object.entries(entries))
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

function installedState (overrides = {}) {
  return {
    local: storageMock(encode({
      session_workspaceKeys: ['ws1'],
      session_workspaceByKey_ws1_appById_app1_appKeys: ['key1', 'key2'],
      session_appByKey_key1_id: 'app1',
      session_appByKey_key2_id: 'app1',
      ...overrides
    })),
    session: storageMock()
  }
}

describe('sticky sessions', () => {
  it('resetStickySessionState removes cloned sticky window state', () => {
    const session = storageMock(encode({
      session_stickyTabId: 'opener-tab',
      session_tabWorkspaceKeys: ['ws1'],
      session_workspaceByKey_ws1_openAppKeys: ['k1', 'k2'],
      session_workspaceByKey_ws2_openAppKeys: ['k3'],
      session_appByKey_k1_visibility: 'open',
      session_appByKey_k2_visibility: 'minimized',
      session_appByKey_k3_visibility: 'closed',
      session_unrelated: 'keep'
    }))

    resetStickySessionState({ sessionStorageArea: session })

    assert.equal(session.getItem(SESSION_STICKY_TAB_ID), null)
    assert.equal(session.getItem('session_tabWorkspaceKeys'), null)
    assert.equal(session.getItem('session_workspaceByKey_ws1_openAppKeys'), null)
    assert.equal(session.getItem('session_workspaceByKey_ws2_openAppKeys'), null)
    assert.equal(session.getItem('session_appByKey_k1_visibility'), null)
    assert.equal(session.getItem('session_appByKey_k2_visibility'), null)
    assert.equal(session.getItem('session_appByKey_k3_visibility'), null)
    assert.deepEqual(JSON.parse(session.getItem('session_unrelated')), 'keep')
  })

  it('resetStickySessionState tolerates a missing storage area', () => {
    assert.equal(resetStickySessionState({ sessionStorageArea: null }), undefined)
  })

  it('builds a snapshot from a live-tab draft, skipping invalid visibility', () => {
    const snapshot = buildSnapshotFromDraft({
      workspaceKeys: ['ws1', 'ws2'],
      byWorkspace: {
        ws1: {
          openKeys: ['key1', 'key2'],
          minimizedKeys: ['key3'],
          visibility: { key1: 'open', key2: 'closed', key3: 'minimized' }
        },
        ws2: {
          openKeys: [],
          minimizedKeys: [],
          visibility: {}
        }
      }
    })

    assert.deepEqual(snapshot.workspaces, {
      ws1: {
        openKeys: ['key1'],
        minimizedKeys: ['key3']
      }
    })
    assert.equal(isSnapshotEmpty(snapshot), false)
    assert.equal(isSnapshotEmpty({ workspaces: {} }), true)
  })

  it('collects only appKeys that still exist for a workspace', () => {
    const local = storageMock(encode({
      session_workspaceByKey_ws1_appById_app1_appKeys: ['key1', 'gone'],
      session_appByKey_key1_id: 'app1'
    }))
    const valid = collectValidAppKeys(local, 'ws1')
    assert.deepEqual([...valid], ['key1'])
  })

  it('validates and hydrates a snapshot, dropping uninstalled appKeys', () => {
    const { local, session } = installedState()
    const snapshot = {
      updatedAt: 1000,
      workspaceKeys: ['ws1', 'ghost-ws'],
      workspaces: {
        ws1: {
          openKeys: ['key1', 'missing'],
          minimizedKeys: ['key2']
        },
        ghostWs: {
          openKeys: ['key1'],
          minimizedKeys: []
        }
      }
    }

    const { cleaned, droppedKeys } = hydrateSnapshot(snapshot, {
      localStorageArea: local,
      sessionStorageArea: session,
      workspaceKeys: ['ws1']
    })

    assert.deepEqual(droppedKeys, ['missing'])
    assert.deepEqual(cleaned.workspaces.ws1.openKeys, ['key1'])
    assert.deepEqual(cleaned.workspaces.ws1.minimizedKeys, ['key2'])
    assert.equal(cleaned.workspaces.ghostWs, undefined)
    assert.deepEqual(JSON.parse(session.getItem('session_workspaceByKey_ws1_openAppKeys')), ['key1'])
    assert.equal(session.getItem('session_appByKey_key1_visibility'), JSON.stringify('open'))
    assert.equal(session.getItem('session_appByKey_key2_visibility'), JSON.stringify('minimized'))
  })

  it('validates and cleans without writing when no drop happens', () => {
    const { local, session } = installedState()
    const snapshot = {
      updatedAt: 1000,
      workspaceKeys: ['ws1'],
      workspaces: {
        ws1: {
          openKeys: ['key1'],
          minimizedKeys: []
        }
      }
    }
    const { cleaned, droppedKeys } = validateAndCleanSnapshot(snapshot, {
      localStorageArea: local,
      workspaceKeys: ['ws1']
    })
    assert.deepEqual(droppedKeys, [])
    assert.deepEqual(cleaned.workspaces.ws1.openKeys, ['key1'])
    assert.deepEqual(cleaned.workspaces.ws1.minimizedKeys, [])
    assert.equal(session.getItem('session_workspaceByKey_ws1_openAppKeys'), null)
  })

  it('claims the oldest unclaimed snapshot and re-keys it to the new tab', async () => {
    const { local, session } = installedState()
    local.setItem(LOCAL_STICKY_SNAPSHOTS, JSON.stringify({
      snapA: {
        updatedAt: Date.now(),
        workspaceKeys: ['ws1'],
        workspaces: {
          ws1: { openKeys: ['key1'], minimizedKeys: [] }
        }
      },
      snapB: {
        updatedAt: Date.now(),
        workspaceKeys: ['ws1'],
        workspaces: {
          ws1: { openKeys: ['key2'], minimizedKeys: [] }
        }
      }
    }))
    local.setItem(LOCAL_STICKY_CLAIMS, JSON.stringify({
      snapA: { tabId: 'old-tab', claimedAt: Date.now() }
    }))
    const warns = []
    const navigatorArea = {
      locks: {
        request: async (name, callback) => {
          assert.equal(name, 'sticky-session-restore')
          return callback({})
        }
      }
    }

    const result = await claimAndHydrateStickySession({
      localStorageArea: local,
      sessionStorageArea: session,
      navigatorArea,
      tabId: 'new-tab',
      workspaceKeys: ['ws1'],
      now: Date.now(),
      log: { warn: (...args) => warns.push(args.join(' ')) }
    })

    assert.equal(result.hydrated, true)
    assert.equal(result.snapshotId, 'new-tab')
    assert.equal(session.getItem(SESSION_STICKY_TAB_ID), JSON.stringify('new-tab'))
    assert.deepEqual(JSON.parse(session.getItem('session_workspaceByKey_ws1_openAppKeys')), ['key2'])
    const snapshots = JSON.parse(local.getItem(LOCAL_STICKY_SNAPSHOTS))
    assert.equal(snapshots.snapB, undefined)
    assert.ok(snapshots['new-tab'])
    const claims = JSON.parse(local.getItem(LOCAL_STICKY_CLAIMS))
    assert.equal(claims['new-tab'].tabId, 'new-tab')
    assert.ok(Number.isFinite(claims['new-tab'].claimedAt))
    assert.deepEqual(warns, [])
  })

  it('restoring a requested snapshot discards the opener cloned sticky state', async () => {
    const local = storageMock(encode({
      session_workspaceKeys: ['ws1', 'ws2'],
      session_workspaceByKey_ws1_appById_app1_appKeys: ['key1'],
      session_workspaceByKey_ws2_appById_app2_appKeys: ['key2'],
      session_appByKey_key1_id: 'app1',
      session_appByKey_key2_id: 'app2',
      [LOCAL_STICKY_SNAPSHOTS]: {
        snapX: {
          updatedAt: Date.now() - 100,
          workspaceKeys: ['ws1'],
          workspaces: {
            ws1: { openKeys: ['key1'], minimizedKeys: [] }
          }
        },
        snapY: {
          updatedAt: Date.now() - 50,
          workspaceKeys: ['ws2'],
          workspaces: {
            ws2: { openKeys: ['key2'], minimizedKeys: [] }
          }
        }
      },
      [LOCAL_STICKY_CLAIMS]: {
        snapY: { tabId: 'tabB', claimedAt: Date.now() }
      }
    }))
    // sessionStorage cloned from the opener (tab B, owner of snapY).
    const session = storageMock(encode({
      session_stickyTabId: 'tabB',
      session_tabWorkspaceKeys: ['ws2'],
      session_workspaceByKey_ws2_openAppKeys: ['key2'],
      session_appByKey_key2_visibility: 'open'
    }))

    const result = await claimAndHydrateStickySession({
      localStorageArea: local,
      sessionStorageArea: session,
      tabId: 'tabC',
      requestedSnapshotId: 'snapX',
      resetClonedState: true,
      workspaceKeys: ['ws1', 'ws2'],
      now: Date.now()
    })

    assert.equal(result.hydrated, true)
    assert.equal(session.getItem(SESSION_STICKY_TAB_ID), JSON.stringify('tabC'))
    assert.deepEqual(JSON.parse(session.getItem('session_tabWorkspaceKeys')), ['ws1'])
    assert.deepEqual(JSON.parse(session.getItem('session_workspaceByKey_ws1_openAppKeys')), ['key1'])
    assert.deepEqual(JSON.parse(session.getItem('session_appByKey_key1_visibility')), 'open')
    assert.equal(session.getItem('session_workspaceByKey_ws2_openAppKeys'), null)
    assert.equal(session.getItem('session_appByKey_key2_visibility'), null)
    const snapshots = JSON.parse(local.getItem(LOCAL_STICKY_SNAPSHOTS))
    assert.equal(snapshots.snapX, undefined)
    assert.deepEqual(snapshots.tabC.workspaces.ws1.openKeys, ['key1'])
    assert.deepEqual(Object.keys(JSON.parse(local.getItem(LOCAL_STICKY_CLAIMS))).sort(), ['snapY', 'tabC'])
  })

  it('losing a double-restore race keeps the opener cloned sticky state', async () => {
    const local = storageMock(encode({
      session_workspaceKeys: ['ws1', 'ws2'],
      session_workspaceByKey_ws1_appById_app1_appKeys: ['key1'],
      session_workspaceByKey_ws2_appById_app2_appKeys: ['key2'],
      session_appByKey_key1_id: 'app1',
      session_appByKey_key2_id: 'app2',
      // The requested snapshot was already claimed and re-keyed by the
      // winning tab in the race.
      [LOCAL_STICKY_SNAPSHOTS]: {
        tabC: {
          updatedAt: Date.now(),
          workspaceKeys: ['ws1'],
          workspaces: {
            ws1: { openKeys: ['key1'], minimizedKeys: [] }
          }
        }
      },
      [LOCAL_STICKY_CLAIMS]: {
        tabC: { tabId: 'tabC', claimedAt: Date.now() }
      }
    }))
    const session = storageMock(encode({
      session_stickyTabId: 'tabB',
      session_tabWorkspaceKeys: ['ws2'],
      session_workspaceByKey_ws2_openAppKeys: ['key2'],
      session_appByKey_key2_visibility: 'open'
    }))
    const warns = []

    const result = await claimAndHydrateStickySession({
      localStorageArea: local,
      sessionStorageArea: session,
      tabId: 'tabD',
      requestedSnapshotId: 'snapX',
      resetClonedState: true,
      workspaceKeys: ['ws1', 'ws2'],
      now: Date.now(),
      log: { warn: (...args) => warns.push(args.join(' ')) }
    })

    assert.equal(result.hydrated, false)
    assert.equal(result.reason, 'none')
    assert.equal(warns.length, 1)
    assert.match(warns[0], /Requested snapshot snapX not found/)
    // The clone must not have been wiped by a restore this tab did not win.
    assert.equal(session.getItem(SESSION_STICKY_TAB_ID), JSON.stringify('tabB'))
    assert.deepEqual(JSON.parse(session.getItem('session_workspaceByKey_ws2_openAppKeys')), ['key2'])
    assert.deepEqual(JSON.parse(session.getItem('session_appByKey_key2_visibility')), 'open')
  })

  it('logs and drops uninstalled apps during claim, persisting the cleaned snapshot', async () => {
    const { local, session } = installedState()
    local.setItem(LOCAL_STICKY_SNAPSHOTS, JSON.stringify({
      snapA: {
        updatedAt: Date.now(),
        workspaceKeys: ['ws1'],
        workspaces: {
          ws1: {
            openKeys: ['key1', 'gone'],
            minimizedKeys: []
          }
        }
      }
    }))
    const warns = []
    const navigatorArea = {
      locks: { request: async (name, callback) => callback({}) }
    }

    const result = await claimAndHydrateStickySession({
      localStorageArea: local,
      sessionStorageArea: session,
      navigatorArea,
      tabId: 'new-tab',
      workspaceKeys: ['ws1'],
      now: Date.now(),
      log: { warn: (...args) => warns.push(args.join(' ')) }
    })

    assert.deepEqual(result.dropped, ['gone'])
    assert.equal(warns.length, 1)
    assert.match(warns[0], /descartou 1 app\(s\) não instalado\(s\): gone/)
    const snapshots = JSON.parse(local.getItem(LOCAL_STICKY_SNAPSHOTS))
    assert.deepEqual(snapshots['new-tab'].workspaces.ws1.openKeys, ['key1'])
  })

  it('listSessionWorkspaceAppGroups orders pinned first and groups by app id', () => {
    const local = storageMock(encode({
      session_workspaceByKey_ws1_pinnedAppIds: ['app1'],
      session_workspaceByKey_ws1_unpinnedAppIds: ['app2'],
      session_workspaceByKey_ws1_appById_app1_appKeys: ['k1', 'k2'],
      session_workspaceByKey_ws1_appById_app2_appKeys: ['k3']
    }))

    const groups = listSessionWorkspaceAppGroups({
      localStorageArea: local,
      wsKey: 'ws1',
      openKeys: ['k2'],
      minimizedKeys: ['k1', 'k3']
    })

    assert.deepEqual(groups, [
      { appId: 'app1', openCount: 1, minimizedCount: 1 },
      { appId: 'app2', openCount: 0, minimizedCount: 1 }
    ])
  })

  it('listSessionWorkspaceAppGroups merges instances when the app id is in both lists', () => {
    const local = storageMock(encode({
      session_workspaceByKey_ws1_pinnedAppIds: ['app1'],
      session_workspaceByKey_ws1_unpinnedAppIds: ['app1', 'app2'],
      session_workspaceByKey_ws1_appById_app1_appKeys: ['k1', 'k2'],
      session_workspaceByKey_ws1_appById_app2_appKeys: ['k3']
    }))

    const groups = listSessionWorkspaceAppGroups({
      localStorageArea: local,
      wsKey: 'ws1',
      openKeys: ['k1'],
      minimizedKeys: ['k2', 'k3']
    })

    assert.deepEqual(groups, [
      { appId: 'app1', openCount: 1, minimizedCount: 1 },
      { appId: 'app2', openCount: 0, minimizedCount: 1 }
    ])
  })

  it('gc removes expired snapshots, expired claims and overflow', () => {
    const snapshots = { old: { updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 } }
    for (let index = 0; index < 11; index++) snapshots[`s${index}`] = { updatedAt: Date.now() - index }
    const local = storageMock(encode({
      [LOCAL_STICKY_SNAPSHOTS]: snapshots,
      [LOCAL_STICKY_CLAIMS]: {
        stale: { tabId: 't', claimedAt: 1 }
      },
      [LOCAL_STICKY_SEEN_IDS]: ['old', 's0', 's1']
    }))
    const now = Date.now()

    const result = gcStickySessions({ localStorageArea: local, now })

    assert.ok(result.removedSnapshots.includes('old'))
    assert.deepEqual(result.removedClaims, ['stale'])
    const remaining = JSON.parse(local.getItem(LOCAL_STICKY_SNAPSHOTS))
    assert.equal(Object.keys(remaining).length, 10)
    assert.equal(remaining.old, undefined)
    const seen = JSON.parse(local.getItem(LOCAL_STICKY_SEEN_IDS))
    assert.equal(seen.includes('old'), false)
    assert.equal(seen.includes('s10'), false)
    assert.equal(seen.includes('s1'), true)
  })

  it('pickSnapshotToRestore prefers requested id and otherwise the oldest unclaimed', () => {
    const local = storageMock(encode({
      [LOCAL_STICKY_SNAPSHOTS]: {
        a: { updatedAt: 100 },
        b: { updatedAt: 200 }
      },
      [LOCAL_STICKY_CLAIMS]: {
        a: { tabId: 't', claimedAt: Date.now() }
      }
    }))
    assert.equal(pickSnapshotToRestore({ localStorageArea: local }), 'b')
    assert.equal(pickSnapshotToRestore({ localStorageArea: local, requestedSnapshotId: 'a' }), 'a')
    assert.equal(pickSnapshotToRestore({ localStorageArea: local, requestedSnapshotId: 'missing' }), null)
  })

  it('commit removes empty snapshots and re-creates claims; heartbeat/release manage leases', () => {
    const local = storageMock()
    commitStickySnapshot({
      localStorageArea: local,
      tabId: 'tab',
      snapshot: { workspaceKeys: ['ws1'], workspaces: {} }
    })
    assert.equal(local.getItem(LOCAL_STICKY_SNAPSHOTS), null)

    commitStickySnapshot({
      localStorageArea: local,
      tabId: 'tab',
      snapshot: {
        workspaceKeys: ['ws1'],
        workspaces: { ws1: { openKeys: ['k'], minimizedKeys: [] } }
      },
      now: 1000
    })
    assert.deepEqual(JSON.parse(local.getItem(LOCAL_STICKY_CLAIMS))['tab'], { tabId: 'tab', claimedAt: 1000 })

    assert.equal(heartbeatStickyClaim({ localStorageArea: local, tabId: 'tab', now: 2000 }), true)
    assert.equal(JSON.parse(local.getItem(LOCAL_STICKY_CLAIMS))['tab'].claimedAt, 2000)
    assert.equal(releaseStickyClaim({ localStorageArea: local, tabId: 'tab' }), true)
    assert.equal(local.getItem(LOCAL_STICKY_CLAIMS), null)
  })

  it('heartbeat re-asserts a missing claim for the tab own snapshot', () => {
    const local = storageMock(encode({
      [LOCAL_STICKY_SNAPSHOTS]: {
        tab: {
          updatedAt: Date.now(),
          workspaceKeys: ['ws1'],
          workspaces: {
            ws1: { openKeys: ['k'], minimizedKeys: [] }
          }
        }
      }
    }))

    assert.equal(heartbeatStickyClaim({ localStorageArea: local, tabId: 'tab', now: 1000 }), true)
    assert.deepEqual(
      JSON.parse(local.getItem(LOCAL_STICKY_CLAIMS))['tab'],
      { tabId: 'tab', claimedAt: 1000 }
    )

    const empty = storageMock()
    assert.equal(heartbeatStickyClaim({ localStorageArea: empty, tabId: 'tab', now: 1000 }), false)
    assert.equal(empty.getItem(LOCAL_STICKY_CLAIMS), null)
  })

  it('remove, purge, markSeen and unseen count behave as expected', () => {
    const local = storageMock(encode({
      [LOCAL_STICKY_SNAPSHOTS]: { a: { updatedAt: 1 }, b: { updatedAt: 2 } },
      [LOCAL_STICKY_CLAIMS]: { a: { tabId: 't', claimedAt: Date.now() } },
      [LOCAL_STICKY_SEEN_IDS]: ['b']
    }))

    assert.equal(unseenUnclaimedCount({
      snapshots: JSON.parse(local.getItem(LOCAL_STICKY_SNAPSHOTS)),
      claims: JSON.parse(local.getItem(LOCAL_STICKY_CLAIMS)),
      seenIds: JSON.parse(local.getItem(LOCAL_STICKY_SEEN_IDS))
    }), 0)

    markStickySessionsSeen({ localStorageArea: local })
    const seen = JSON.parse(local.getItem(LOCAL_STICKY_SEEN_IDS))
    assert.ok(seen.includes('b'))

    assert.equal(removeStickySession({ localStorageArea: local, snapshotId: 'a' }), true)
    assert.deepEqual(Object.keys(JSON.parse(local.getItem(LOCAL_STICKY_SNAPSHOTS))), ['b'])

    purgeStickySessions({ localStorageArea: local })
    assert.equal(local.getItem(LOCAL_STICKY_SNAPSHOTS), null)
    assert.equal(local.getItem(LOCAL_STICKY_CLAIMS), null)
    assert.equal(local.getItem(LOCAL_STICKY_SEEN_IDS), null)
  })

  it('isClaimActive respects the lease window', () => {
    const now = Date.now()
    assert.equal(isClaimActive({ tabId: 't', claimedAt: now }, now), true)
    assert.equal(isClaimActive({ tabId: 't', claimedAt: now - 6 * 60 * 1000 }, now), false)
    assert.equal(isClaimActive(null, now), false)
  })

  it('duplicates a saved session under a fresh unclaimed id', () => {
    const local = storageMock(encode({
      [LOCAL_STICKY_SNAPSHOTS]: {
        a: {
          updatedAt: 100,
          workspaceKeys: ['ws1'],
          workspaces: {
            ws1: { openKeys: ['k'], minimizedKeys: [] }
          }
        }
      }
    }))

    const newId = duplicateStickySession({
      localStorageArea: local,
      snapshotId: 'a',
      now: 200,
      newSnapshotId: 'copy'
    })

    assert.equal(newId, 'copy')
    const snapshots = JSON.parse(local.getItem(LOCAL_STICKY_SNAPSHOTS))
    assert.deepEqual(snapshots.copy.workspaces, snapshots.a.workspaces)
    assert.deepEqual(snapshots.copy.workspaceKeys, ['ws1'])
    assert.equal(snapshots.copy.updatedAt, 200)
    assert.equal(snapshots.a.updatedAt, 100)
    assert.equal(local.getItem(LOCAL_STICKY_CLAIMS), null)
    assert.equal(duplicateStickySession({ localStorageArea: local, snapshotId: 'missing' }), null)
  })

  it('requestStickySessionDelete leaves a tombstone for claimed sessions', () => {
    const local = storageMock(encode({
      [LOCAL_STICKY_SNAPSHOTS]: {
        a: { updatedAt: Date.now(), workspaceKeys: [], workspaces: {} }
      },
      [LOCAL_STICKY_CLAIMS]: {
        a: { tabId: 'tab-a', claimedAt: Date.now() }
      },
      [LOCAL_STICKY_SEEN_IDS]: ['a']
    }))

    assert.equal(requestStickySessionDelete({ localStorageArea: local, snapshotId: 'a' }), true)
    assert.equal(local.getItem(LOCAL_STICKY_SNAPSHOTS), null)
    assert.equal(local.getItem(LOCAL_STICKY_CLAIMS), null)
    assert.equal(local.getItem(LOCAL_STICKY_SEEN_IDS), null)
    assert.ok(JSON.parse(local.getItem(LOCAL_STICKY_DELETIONS)).a)

    assert.equal(ackStickySessionDeletion({ localStorageArea: local, snapshotId: 'a' }), true)
    assert.equal(local.getItem(LOCAL_STICKY_DELETIONS), null)
    assert.equal(requestStickySessionDelete({ localStorageArea: local, snapshotId: 'missing' }), false)
  })

  it('requestStickySessionDelete removes unclaimed sessions without a tombstone', () => {
    const local = storageMock(encode({
      [LOCAL_STICKY_SNAPSHOTS]: {
        a: { updatedAt: Date.now(), workspaceKeys: [], workspaces: {} }
      }
    }))

    assert.equal(requestStickySessionDelete({ localStorageArea: local, snapshotId: 'a' }), true)
    assert.equal(local.getItem(LOCAL_STICKY_SNAPSHOTS), null)
    assert.equal(local.getItem(LOCAL_STICKY_DELETIONS), null)
  })

  it('gc prunes expired deletion tombstones and purge clears everything', () => {
    const local = storageMock(encode({
      [LOCAL_STICKY_DELETIONS]: {
        fresh: Date.now(),
        stale: Date.now() - 25 * 60 * 60 * 1000
      }
    }))

    const result = gcStickySessions({ localStorageArea: local, now: Date.now() })
    assert.deepEqual(result.removedDeletions, ['stale'])
    assert.deepEqual(Object.keys(JSON.parse(local.getItem(LOCAL_STICKY_DELETIONS))), ['fresh'])

    purgeStickySessions({ localStorageArea: local })
    assert.equal(local.getItem(LOCAL_STICKY_DELETIONS), null)
  })
})
