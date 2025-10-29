import { useTask, useGlobalSignal } from '#f'
import useWebStorage from '#hooks/use-web-storage.js'
import { appDecode, npubEncode } from '#helpers/nip19.js'
import { generateB62SecretKey as getB62PublicKeyStub } from '#helpers/nip01.js'
import { addressObjToAppId } from '#helpers/app.js'
import { base16ToBase62, base62ToBase16 } from '#helpers/base62.js'

// the screen has
// 1 active (active as in last clicked) user (pk) at all times (defaultUserPk is the default user pk)
// 0-1 active workspace (ws key) at all times that
// itself has 0-1 active app (key) at all times
//
// each user may have 0-* workspaces (ws, for now up to one)
// 0 if once logged in but currenly not but just listed
// user1 => 1 avatar (no?)
// user1, ws1  => 1 avatar
// user1, ws1 and ws2 => 2 avatars side to side or dropdown
//
// each ws has
// 0-* unpinned apps (unpinnedAppIdsObj)
// 0-* pinned apps (pinnedAppIdsObj)
//
// Multi-window mode shows
// 1-* wss (even if no open app)
// each with 0-*

const coreAppIds = [
  '+333qLLdnYbXaUOQZSyn7fS8ieqFMzyMnq9o6PsZ57Wt8zNSE1FE0jb8x'
].map(appDecode).map(addressObjToAppId) // ['44b', 'minimoon', 'nappstore']

export default function useInitOrResetScreen () {
  const storage = useWebStorage(localStorage)
  useGlobalSignal('hardcoded_newAppIdsObj', {}) // { [+...]: true }) <- minimoon

  // init
  useTask(() => {
    if (storage.session_workspaceKeys$()) return

    const defaultUserPk = getB62PublicKeyStub()
    storage.session_defaultUserPk$(defaultUserPk)
    addUser({ userPk: defaultUserPk, storage, isFirstTimeUser: true })
  })
  // first run only
  useTask(() => {
    if (!storage.session_workspaceKeys$()) return

    // Loop through all workspaces and set each user's account to locked status
    const workspaceKeys = storage.session_workspaceKeys$() || []
    const defaultUserPk = storage.session_defaultUserPk$()
    workspaceKeys.forEach(wsKey => {
      const userPk = storage[`session_workspaceByKey_${wsKey}_userPk$`]()
      if (
        userPk !== undefined &&
        userPk !== null &&
        userPk !== defaultUserPk &&
        !(storage[`session_accountByUserPk_${userPk}_isReadOnly$`]() ?? false)
      ) {
        storage[`session_accountByUserPk_${userPk}_isLocked$`](true)
      }
    })
  })

  // reset during app use when all users are logged out
  useTask(({ track }) => {
    if (track(() => storage.session_workspaceKeys$().length > 0)) return

    const defaultUserPk = getB62PublicKeyStub()
    storage.session_defaultUserPk$(defaultUserPk)
    addUser({ userPk: defaultUserPk, storage, isFirstTimeUser: true }) // false })
  })

  // do we need a signal that watches for online status?
  // fetch and set app metadata if online for those without icon
  // elsewhere think on best way to keep'em updated
  // useTask(({ track }) => {
  //   add to `appById_${appId}_icon` etc
  //   storage[`appById_${app.key}_icon$`](...)
  // })

  return storage
}

// what happens when app crashed before this finishes? we should add a task that is removed
// from stack only when finished and re-run if app restarts and it's still on the stack
function addUser ({ userPk, storage, isFirstTimeUser: _ }) {
  const defaultPinnedApps = coreAppIds.map((id, _i) => ({
    id,
    // many apps with same id within same ws may be open at once
    key: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
    // visibility: i === 0 ? 'open' : 'closed', // open|minimized|closed
    visibility: 'closed',
    isNew: false // when announcing a new core app
  }))

  const wsKey = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  if (storage.config_isSingleWindow$() === undefined) storage.config_isSingleWindow$(false)

  // de-normalized from `session_appByKey_${app.key}_visibility$` (open or minimized)
  // const openAppKeys = isFirstTimeUser ? [defaultPinnedApps[0].key] : []
  const openAppKeys = []

  // order of iframes on DOM must be stable or else they reload their content
  // dom order is now calculated at runtime, we only store css order (visual order)
  storage[`session_workspaceByKey_${wsKey}_openAppKeys$`](openAppKeys) // order of windows
  storage[`session_workspaceByKey_${wsKey}_userPk$`](userPk) // base62
  defaultPinnedApps.forEach(app => {
    storage[`session_workspaceByKey_${wsKey}_appById_${app.id}_appKeys$`]([app.key])
    // storage[`session_appById_${app.id}_icon$`](...) add from local asset? no, load from idb chunks
    // also, the +<appname> on path upon app selection if from us or
    // +<appname>.<host>.<example>? hmm better naddr1
    storage[`session_appByKey_${app.key}_id$`](app.id)
    storage[`session_appByKey_${app.key}_visibility$`](app.visibility) // open|minimized|closed
    storage[`session_appByKey_${app.key}_route$`]('')
  })

  // unpinned is better than pinned because new core apps would be automatically pinned
  storage[`session_workspaceByKey_${wsKey}_unpinnedCoreAppIdsObj$`]({ /* napp1...: true */ })
  storage[`session_workspaceByKey_${wsKey}_pinnedAppIds$`](defaultPinnedApps.map(({ id }) => id))
  // recent last; same app's open count is the number of its appKeys
  storage[`session_workspaceByKey_${wsKey}_unpinnedAppIds$`]([])

  // default user is readonly because there is no signer associated with it
  // but we won't add an account entry for it
  // storage[`session_accountByUserPk_${userPk}_isLocked$`](true)
  // storage.session_accountUserPks$([userPk])
  storage[`session_accountByUserPk_${userPk}_isReadOnly$`](true)
  storage[`session_accountByUserPk_${userPk}_isLocked$`](false)
  storage[`session_accountByUserPk_${userPk}_profile$`]({ npub: npubEncode(base62ToBase16(userPk)), meta: { events: [] } })
  storage[`session_accountByUserPk_${userPk}_relays$`]({ meta: { events: [] } })

  storage.session_accountUserPks$([userPk])
  storage.session_workspaceKeys$([wsKey])
  storage.session_openWorkspaceKeys$([wsKey]) // order of group of windows
}

// nextAccountState: [
//   {
//     pubkey, // base16
//     profile: {
//       name: 'John Doe',
//       about: 'Example text abou me',
//       picture: 'https://example.com/avatar.jpg',
//       npub: 'npub1...',
//       meta: { events: [{ kind: 0, ... }] }
//     },
//     relays: {
//       read: freeRelays.slice(0, 2),
//       write: freeRelays.slice(0, 2),
//       meta: { events: [{ kind: 10002, ... }] }
//     }
//   }
// ]
export async function setAccountsState (nextAccountState, storage) {
  const currentWorkspaceKeys = storage.session_workspaceKeys$() || []
  const defaultUserPk = storage.session_defaultUserPk$()

  // Check if we only have the default user currently
  const hasOnlyDefaultUser = currentWorkspaceKeys.length === 1 &&
    currentWorkspaceKeys.every(wsKey => {
      const userPk = storage[`session_workspaceByKey_${wsKey}_userPk$`]()
      return userPk === defaultUserPk
    })

  // No change needed
  if (nextAccountState.length === 0 && hasOnlyDefaultUser) return

  const currentAccountUserPks = storage.session_accountUserPks$() || []
  const nextUserPks = nextAccountState.map(account => base16ToBase62(account.pubkey))

  let isReadOnly // true when vault has just the pk, without the sk pair
  // Add/update account data for all users in nextAccountState
  nextAccountState.forEach(account => {
    const userPk = base16ToBase62(account.pubkey)
    storage[`session_accountByUserPk_${userPk}_isReadOnly$`]((isReadOnly = account.isReadOnly ?? false))
    storage[`session_accountByUserPk_${userPk}_isLocked$`](isReadOnly ? false : (account.isLocked ?? true))
    storage[`session_accountByUserPk_${userPk}_profile$`](account.profile)
    storage[`session_accountByUserPk_${userPk}_relays$`](account.relays)
  })

  // Special case: moving from default-only to single user
  if (hasOnlyDefaultUser && nextUserPks.length === 1) {
    const defaultWorkspaceKey = currentWorkspaceKeys[0]
    const newUserPk = nextUserPks[0]

    // Close all open apps and schedule opening the first pinned app
    const openAppKeys = storage[`session_workspaceByKey_${defaultWorkspaceKey}_openAppKeys$`]() || []

    // Close all currently open apps
    openAppKeys.forEach(appKey => {
      storage[`session_appByKey_${appKey}_visibility$`]('closed')
    })

    // Clear open apps list
    storage[`session_workspaceByKey_${defaultWorkspaceKey}_openAppKeys$`]([])

    // Transfer ownership of the workspace to the new user
    storage[`session_workspaceByKey_${defaultWorkspaceKey}_userPk$`](newUserPk)

    // Schedule opening the first (pinned or unpinned) app on next tick
    await new Promise(resolve => window.requestIdleCallback(() => window.requestIdleCallback(resolve)))
    const pinnedAppIds = storage[`session_workspaceByKey_${defaultWorkspaceKey}_pinnedAppIds$`]() || []
    const unpinnedAppIds = storage[`session_workspaceByKey_${defaultWorkspaceKey}_unpinnedAppIds$`]() || []

    let appToOpen = null

    if (pinnedAppIds.length > 0) {
      // Find first pinned app
      const appKeys = storage[`session_workspaceByKey_${defaultWorkspaceKey}_appById_${pinnedAppIds[0]}_appKeys$`]() || []
      if (appKeys.length > 0) appToOpen = appKeys[0]
    } else if (unpinnedAppIds.length > 0) {
      // Find first unpinned app
      const appKeys = storage[`session_workspaceByKey_${defaultWorkspaceKey}_appById_${unpinnedAppIds[0]}_appKeys$`]() || []
      if (appKeys.length > 0) appToOpen = appKeys[0]
    }

    if (appToOpen) {
      storage[`session_appByKey_${appToOpen}_visibility$`]('open')
      storage[`session_workspaceByKey_${defaultWorkspaceKey}_openAppKeys$`]((v, eqKey) => {
        const i = v.indexOf(appToOpen)
        if (i !== -1) v.splice(i, 1) // remove
        v.unshift(appToOpen) // place at beginning
        v[eqKey] = Math.random()
        return v
      })
    }

    storage.session_defaultUserPk$(undefined)
  } else {
    // Regular case: handle multiple users or complex transitions

    // Identify users to add and remove
    const usersToAdd = nextUserPks.filter(userPk => !currentAccountUserPks.includes(userPk))
    const usersToRemove = currentAccountUserPks.filter(userPk => !nextUserPks.includes(userPk))

    // Always remove default user if adding users
    if (usersToAdd.length > 0 && defaultUserPk) {
      storage.session_defaultUserPk$(undefined)
    }

    let workspacesToRemove = []
    for (const userPk of usersToRemove) {
      workspacesToRemove = workspacesToRemove.concat(currentWorkspaceKeys.filter(wsKey => {
        const wsUserPk = storage[`session_workspaceByKey_${wsKey}_userPk$`]()
        return wsUserPk === userPk
      }))
    }

    const newWorkspaceKeys = []
    // Add new users
    for (const userPk of usersToAdd) {
      const defaultPinnedApps = coreAppIds.map((id) => ({
        id,
        key: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
        visibility: 'closed', // All apps start closed for new users
        isNew: false
      }))

      const wsKey = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
      newWorkspaceKeys.push(wsKey)

      // Setup workspace with no open apps
      storage[`session_workspaceByKey_${wsKey}_openAppKeys$`]([])
      storage[`session_workspaceByKey_${wsKey}_userPk$`](userPk)

      // Setup pinned apps (all closed)
      defaultPinnedApps.forEach(app => {
        storage[`session_workspaceByKey_${wsKey}_appById_${app.id}_appKeys$`]([app.key])
        storage[`session_appByKey_${app.key}_id$`](app.id)
        storage[`session_appByKey_${app.key}_visibility$`](app.visibility)
        storage[`session_appByKey_${app.key}_route$`]('')
      })

      // Setup app lists
      storage[`session_workspaceByKey_${wsKey}_unpinnedCoreAppIdsObj$`]({})
      storage[`session_workspaceByKey_${wsKey}_pinnedAppIds$`](defaultPinnedApps.map(({ id }) => id))
      storage[`session_workspaceByKey_${wsKey}_unpinnedAppIds$`]([])
    }

    const nextWorkspaceKeys = currentWorkspaceKeys
      .filter(wsKey => !workspacesToRemove.includes(wsKey))
      .concat(newWorkspaceKeys)

    // Update workspace lists
    storage.session_openWorkspaceKeys$(nextWorkspaceKeys)
    // This one is after storage.session_openWorkspaceKeys$(nextWorkspaceKeys)
    // because it will trigger useTask above that may
    // add a default user if empty, changing both arrays
    //
    // Note this can't be emptied then set because of above useTask
    // that watches for empty storage.session_workspaceKeys$()
    // to add a default user
    storage.session_workspaceKeys$(nextWorkspaceKeys)

    // Remove all apps and workspace data for unused workspaces
    for (const wsKey of workspacesToRemove) {
      const pinnedAppIds = storage[`session_workspaceByKey_${wsKey}_pinnedAppIds$`]() || []
      const unpinnedAppIds = storage[`session_workspaceByKey_${wsKey}_unpinnedAppIds$`]() || []
      const allAppIds = [...new Set([...pinnedAppIds, ...unpinnedAppIds])]

      storage[`session_workspaceByKey_${wsKey}_unpinnedCoreAppIdsObj$`](undefined)
      storage[`session_workspaceByKey_${wsKey}_pinnedAppIds$`](undefined)
      storage[`session_workspaceByKey_${wsKey}_unpinnedAppIds$`](undefined)
      storage[`session_workspaceByKey_${wsKey}_userPk$`](undefined)
      storage[`session_workspaceByKey_${wsKey}_openAppKeys$`](undefined)

      // Remove all apps
      allAppIds.forEach(appId => {
        const appKeys = storage[`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys$`]() || []
        appKeys.forEach(appKey => {
          storage[`session_appByKey_${appKey}_id$`](undefined)
          storage[`session_appByKey_${appKey}_visibility$`](undefined)
          storage[`session_appByKey_${appKey}_route$`](undefined)
        })
        storage[`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys$`](undefined)
      })
    }
  }

  // Update the list of account user pubkeys
  storage.session_accountUserPks$(nextUserPks)

  // Clean up old account data
  currentAccountUserPks
    .filter(userPk => !nextUserPks.includes(userPk))
    .forEach(userPk => {
      storage[`session_accountByUserPk_${userPk}_isReadOnly$`](undefined)
      storage[`session_accountByUserPk_${userPk}_isLocked$`](undefined)
      storage[`session_accountByUserPk_${userPk}_profile$`](undefined)
      storage[`session_accountByUserPk_${userPk}_relays$`](undefined)
    })
}
