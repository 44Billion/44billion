import { useTask, useGlobalSignal } from '#f'
import useWebStorage from '#hooks/use-web-storage.js'
import { appDecode } from '#helpers/nip19.js'
import { generateB62SecretKey } from '#helpers/nip01.js'
import { addressObjToAppId } from '#helpers/app.js'

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
  storage[`session_workspaceByKey_${wsKey}_userPk$`](userPk)
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
}
