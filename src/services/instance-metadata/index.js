const array = value => Array.isArray(value) ? value : []

// Accept a reader so the launcher can track these same persisted fields through
// useWebStorage. There is no separate persisted instance registry.
export function readInstanceCatalog (read) {
  const records = []
  const workspaces = array(read('session_workspaceKeys'))
  const selections = read('local_appPersonaSelections') ?? {}
  const widgets = read('local_widgets') ?? {}
  for (const wsKey of workspaces) {
    const userPk = read(`session_workspaceByKey_${wsKey}_userPk`)
    const appIds = new Set([
      ...array(read(`session_workspaceByKey_${wsKey}_pinnedAppIds`)),
      ...array(read(`session_workspaceByKey_${wsKey}_unpinnedAppIds`)),
      ...Object.keys(read(`session_workspaceByKey_${wsKey}_unpinnedCoreAppIdsObj`) ?? {})
    ])
    const add = (instanceKey, appId, isWidget) => {
      const selection = selections[wsKey]?.[appId]
      records.push({
        instanceKey, appId, wsKey, userPk, isWidget,
        personaId: typeof selection === 'string' && selection ? selection : null
      })
    }
    for (const appId of appIds) {
      for (const key of array(read(`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys`))) {
        add(key, appId, false)
      }
    }
    for (const [key, widget] of Object.entries(widgets)) {
      if (widget?.wsKey === wsKey && appIds.has(widget.appId)) add(key, widget.appId, true)
    }
  }
  return records
}

function sameIdentity (a, b) {
  if (a.personaId || b.personaId) return !!a.personaId && a.personaId === b.personaId
  return a.userPk === b.userPk
}

export function createInstanceMetadataService ({ reportError = console.error } = {}) {
  let catalog = new Map()
  let presentation = new Map()
  let hasDisplayedWindow = false
  let environment = { tabVisible: true, systemRoute: false, revealWidgets: false }
  const documents = new Map()
  let queued = false

  const describe = record => {
    const isLoaded = documents.has(record.instanceKey)
    const surface = presentation.get(record.instanceKey)
    const windowsCoverWidgets = !environment.revealWidgets && hasDisplayedWindow
    const allowed = environment.tabVisible && !environment.systemRoute &&
      (record.isWidget ? !windowsCoverWidgets : !environment.revealWidgets)
    return {
      instanceKey: record.instanceKey,
      isWidget: record.isWidget === true,
      isLoaded,
      isVisible: !!(isLoaded && allowed && surface?.isDisplayed && surface.contentVisible)
    }
  }
  const getMetadata = instanceKey => {
    // Standalone single-napp documents have a runtime key, not a persisted
    // launcher instance. They still get their own metadata through this bridge.
    const record = catalog.get(instanceKey) ?? documents.get(instanceKey)?.record
    if (!record) return null
    return {
      ...describe(record),
      otherInstances: [...catalog.values()]
        .filter(other => other.instanceKey !== instanceKey && other.appId === record.appId && sameIdentity(record, other))
        .sort((a, b) => a.instanceKey < b.instanceKey ? -1 : a.instanceKey > b.instanceKey ? 1 : 0)
        .map(describe)
    }
  }
  const invalidate = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      for (const [key, entry] of documents) {
        const metadata = getMetadata(key)
        const serialized = JSON.stringify(metadata)
        if (serialized === entry.lastSent) continue
        entry.lastSent = serialized
        try { entry.notify(metadata) } catch (error) { reportError(error) }
      }
    })
  }
  return {
    setCatalog (records) {
      catalog = new Map(records.map(record => [record.instanceKey, record]))
      invalidate()
    },
    setPresentation (next) {
      presentation = next
      hasDisplayedWindow = [...presentation.values()].some(surface => !surface.isWidget && surface.isDisplayed)
      invalidate()
    },
    setEnvironment (next) {
      environment = { ...environment, ...next }
      invalidate()
    },
    getMetadata,
    connect (record, notify) {
      const key = record.instanceKey
      const entry = { record, notify, lastSent: null }
      documents.set(key, entry)
      const initialMetadata = getMetadata(key)
      entry.lastSent = JSON.stringify(initialMetadata)
      invalidate()
      return {
        initialMetadata,
        disconnect () {
          // An old document's late cleanup must not unregister its replacement.
          if (documents.get(key) !== entry) return
          documents.delete(key)
          invalidate()
        }
      }
    }
  }
}

export const instanceMetadata = createInstanceMetadataService()
