import { useTask, useGlobalSignal } from '#f'
import useWebStorage from '#hooks/use-web-storage.js'
import { appDecode } from '#helpers/nip19.js'
import { generateB62SecretKey } from '#helpers/nip01.js'
import { addressObjToAppId } from '#helpers/app.js'
import { base16ToBase62 } from '#helpers/base62.js'

// the screen has
// 1 active (active as in last clicked) user (pk) at all times ('' is the anon user pk)
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
  useGlobalSignal('hardcoded_newAppIdsObj', {}) // { [app-...]: true }) <- minimoon

  // init
  useTask(() => {
    if (storage.session_workspaceKeys$()) return

    const anonUserPk = ''
    storage.session_anonPk$(generateB62SecretKey())
    addUser({ userPk: anonUserPk, storage, isFirstTimeUser: true })
  })
  // first run only
  useTask(() => {
    if (!storage.session_workspaceKeys$()) return

    // Loop through all workspaces and set each user's account to locked status
    const workspaceKeys = storage.session_workspaceKeys$() || []
    workspaceKeys.forEach(wsKey => {
      const userPk = storage[`session_workspaceByKey_${wsKey}_userPk$`]()
      if (userPk !== undefined && userPk !== null) {
        storage[`session_accountsByUserPk_${userPk}_isLocked$`](true)
      }
    })
  })

  // reset during app use when all users are logged out
  useTask(({ track }) => {
    if (track(() => storage.session_workspaceKeys$().length > 0)) return

    const anonUserPk = ''
    addUser({ userPk: anonUserPk, storage, isFirstTimeUser: false })
  })

  // we need a signal that whatches for online status?
  // fetch and set app metadata if online for those without icon
  // elsewhere think on best way to keep'em updated
  // useTask(({ track }) => {
  //   add to `appById_${appId}_icon` etc
  //   storage[`appById_${app.key}_icon$`](...)
  // })

  return storage
}

// todo: if adding a non-anon user, if its the first user to be added,
// copy apps and open apps from current anon then delete anon
// function copyUser()?

// what happens when app crashed before this finishes? we should add a task that is removed
// from stack only when finished and re-run if app restarts and it's still on the stack
function addUser ({ userPk, storage, isFirstTimeUser }) {
  const defaultPinnedApps = coreAppIds.map((id, i) => ({
    id,
    // many apps with same id within same ws may be open at once
    key: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
    visibility: i === 0 ? 'open' : 'closed', // open|minimized|closed
    isNew: false // when announcing a new core app
  }))

  const wsKey = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  if (storage.config_isSingleWindow$() === undefined) storage.config_isSingleWindow$(false)
  storage.session_workspaceKeys$([wsKey])
  storage.session_openWorkspaceKeys$([wsKey]) // order of group of windows
  // de-normalized from `session_appByKey_${app.key}_visibility$` (open or minimized)
  const openAppKeys = isFirstTimeUser ? [defaultPinnedApps[0].key] : []
  // order of iframes on DOM must be stable or esle they reload their content
  storage[`session_workspaceByKey_${wsKey}_openAppKeys$`]({ domOrder: openAppKeys, cssOrder: openAppKeys }) // order of windows
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

  // anon user is readonly because there is no signer associate with it
  storage[`session_accountsByUserPk_${userPk}_isLocked$`](true)
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
export function setAccountsState (nextAccountState, storage) {
  // Convert pubkeys from hex to base62
  const nextUserPks = nextAccountState.map(account => base16ToBase62(account.pubkey))

  // Get current state
  const anonPk = storage.session_anonPk$()
  const currentWorkspaceKeys = storage.session_workspaceKeys$() || []
  const currentAccountUserPks = storage.session_accountUserPks$() || []

  // Check if we only have the anonymous user currently
  const hasOnlyAnonUser = currentWorkspaceKeys.length === 1 &&
    currentWorkspaceKeys.every(wsKey => {
      const userPk = storage[`session_workspaceByKey_${wsKey}_userPk$`]()
      return userPk === '' || userPk === anonPk
    })

  // Special case: moving from anon-only to single user
  if (hasOnlyAnonUser && nextUserPks.length === 1) {
    const anonWorkspaceKey = currentWorkspaceKeys[0]
    const newUserPk = nextUserPks[0]

    // Transfer ownership of the workspace to the new user
    storage[`session_workspaceByKey_${anonWorkspaceKey}_userPk$`](newUserPk)

    // Close all open apps and schedule opening the first pinned app
    const { domOrder } = storage[`session_workspaceByKey_${anonWorkspaceKey}_openAppKeys$`]() || { domOrder: [], cssOrder: [] }

    // Close all currently open apps
    domOrder.forEach(appKey => {
      storage[`session_appByKey_${appKey}_visibility$`]('closed')
    })

    // Clear open apps list
    storage[`session_workspaceByKey_${anonWorkspaceKey}_openAppKeys$`]({ domOrder: [], cssOrder: [] })

    // Schedule opening the first pinned app on next tick
    window.requestIdleCallback(() => {
      window.requestIdleCallback(() => {
        const pinnedAppIds = storage[`session_workspaceByKey_${anonWorkspaceKey}_pinnedAppIds$`]() || []
        const unpinnedAppIds = storage[`session_workspaceByKey_${anonWorkspaceKey}_unpinnedAppIds$`]() || []

        let appToOpen = null

        if (pinnedAppIds.length > 0) {
          // Find first pinned app
          const appKeys = storage[`session_workspaceByKey_${anonWorkspaceKey}_appById_${pinnedAppIds[0]}_appKeys$`]() || []
          if (appKeys.length > 0) appToOpen = appKeys[0]
        } else if (unpinnedAppIds.length > 0) {
          // Find first unpinned app
          const appKeys = storage[`session_workspaceByKey_${anonWorkspaceKey}_appById_${unpinnedAppIds[0]}_appKeys$`]() || []
          if (appKeys.length > 0) appToOpen = appKeys[0]
        }

        if (appToOpen) {
          storage[`session_appByKey_${appToOpen}_visibility$`]('open')
          storage[`session_workspaceByKey_${anonWorkspaceKey}_openAppKeys$`]((v, eqKey) => {
            v.domOrder.push(appToOpen)
            v.cssOrder.unshift(appToOpen)
            v[eqKey] = Math.random()
            return v
          })
        }
      })
    })
  } else {
    // Regular case: handle multiple users or complex transitions

    // Identify users to add and remove
    const usersToAdd = nextUserPks.filter(userPk => !currentAccountUserPks.includes(userPk))
    const usersToRemove = currentAccountUserPks.filter(userPk => !nextUserPks.includes(userPk))

    // Remove users that are no longer needed
    usersToRemove.forEach(userPk => {
      // Find all workspaces for this user
      const workspacesToRemove = currentWorkspaceKeys.filter(wsKey => {
        const wsUserPk = storage[`session_workspaceByKey_${wsKey}_userPk$`]()
        return wsUserPk === userPk
      })

      // Update workspace keys list
      const newWorkspaceKeys = currentWorkspaceKeys.filter(wsKey => !workspacesToRemove.includes(wsKey))
      storage.session_openWorkspaceKeys$(newWorkspaceKeys)
      storage.session_workspaceKeys$(newWorkspaceKeys)

      // Remove all apps and workspace data for each workspace
      workspacesToRemove.forEach(wsKey => {
        const pinnedAppIds = storage[`session_workspaceByKey_${wsKey}_pinnedAppIds$`]() || []
        const unpinnedAppIds = storage[`session_workspaceByKey_${wsKey}_unpinnedAppIds$`]() || []
        const allAppIds = [...new Set([...pinnedAppIds, ...unpinnedAppIds])]

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

        // Remove workspace data
        storage[`session_workspaceByKey_${wsKey}_openAppKeys$`](undefined)
        storage[`session_workspaceByKey_${wsKey}_userPk$`](undefined)
        storage[`session_workspaceByKey_${wsKey}_unpinnedCoreAppIdsObj$`](undefined)
        storage[`session_workspaceByKey_${wsKey}_pinnedAppIds$`](undefined)
        storage[`session_workspaceByKey_${wsKey}_unpinnedAppIds$`](undefined)
      })
    })

    // Add new users
    usersToAdd.forEach(userPk => {
      const defaultPinnedApps = coreAppIds.map((id) => ({
        id,
        key: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
        visibility: 'closed', // All apps start closed for new users
        isNew: false
      }))

      const wsKey = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)

      // Setup workspace with no open apps
      storage[`session_workspaceByKey_${wsKey}_openAppKeys$`]({ domOrder: [], cssOrder: [] })
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

      // Add workspace to lists
      storage.session_workspaceKeys$(v => [...(v || []), wsKey])
      storage.session_openWorkspaceKeys$(v => [...(v || []), wsKey])
    })
  }

  // Clean up old account data
  currentAccountUserPks.forEach(userPk => {
    if (!nextUserPks.includes(userPk)) {
      storage[`session_accountsByUserPk_${userPk}_isLocked$`](undefined)
      storage[`session_accountsByUserPk_${userPk}_profile$`](undefined)
      storage[`session_accountsByUserPk_${userPk}_relays$`](undefined)
    }
  })

  // Add/update account data for all users in nextAccountState
  nextAccountState.forEach(account => {
    const userPk = base16ToBase62(account.pubkey)
    storage[`session_accountsByUserPk_${userPk}_isLocked$`](account.isLocked ?? true)
    storage[`session_accountsByUserPk_${userPk}_profile$`](account.profile)
    storage[`session_accountsByUserPk_${userPk}_relays$`](account.relays)
  })

  // Update the list of account user pubkeys
  storage.session_accountUserPks$(nextUserPks)
}
