import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createInstanceMetadataService, readInstanceCatalog } from '../../src/services/instance-metadata/index.js'

const record = (instanceKey, extra = {}) => ({ instanceKey, appId: 'app', wsKey: 'ws', userPk: 'user', personaId: null, isWidget: false, ...extra })
const tick = () => new Promise(resolve => queueMicrotask(resolve))

test('visual pins notify self and peers and remain subject to loading, page geometry and tab visibility', async () => {
  const service = createInstanceMetadataService()
  const window = record('window', { isPinned: true }) // toolbar pin must not leak
  const widget = record('widget', { isWidget: true })
  const seen = []
  const peers = []
  service.setCatalog([window, widget])
  service.connect(window, value => peers.push(value))
  const document = service.connect(widget, value => seen.push(value))
  service.setPresentation(new Map([
    ['window', { isWidget: false, isDisplayed: true, contentVisible: true }],
    ['widget', { isWidget: true, isDisplayed: true, contentVisible: true }]
  ]))
  service.setEnvironment({ systemRoute: true })
  await tick()
  assert.equal(service.getMetadata('widget').isVisible, false)
  assert.equal(service.getMetadata('window').isPinned, false)
  widget.isPinned = true
  service.setCatalog([window, widget])
  await tick()
  assert.equal(seen.at(-1).isPinned, true)
  assert.equal(seen.at(-1).isVisible, true)
  assert.equal(peers.at(-1).otherInstances[0].isPinned, true)
  service.setEnvironment({ tabVisible: false })
  assert.equal(service.getMetadata('widget').isVisible, false)
  service.setEnvironment({ tabVisible: true })
  service.setPresentation(new Map([['widget', { isWidget: true, isDisplayed: false, contentVisible: true }]]))
  assert.equal(service.getMetadata('widget').isVisible, false)
  service.setPresentation(new Map([['widget', { isWidget: true, isDisplayed: true, contentVisible: true }]]))
  document.disconnect()
  assert.equal(service.getMetadata('widget').isVisible, false)
  assert.equal(service.getMetadata('widget').isPinned, true, 'unloaded retains its persisted preference')
})

test('catalog treats legacy and window pins as false and reads shared widget pins', () => {
  const data = {
    session_workspaceKeys: ['ws'],
    session_workspaceByKey_ws_pinnedAppIds: ['app'],
    session_workspaceByKey_ws_appById_app_appKeys: ['window'],
    local_widgets: {
      legacy: { wsKey: 'ws', appId: 'app' },
      pinned: { wsKey: 'ws', appId: 'app', isPinned: true }
    }
  }
  assert.deepEqual(readInstanceCatalog(key => data[key]).map(({ instanceKey, isPinned }) => ({ instanceKey, isPinned })), [
    { instanceKey: 'window', isPinned: false }, { instanceKey: 'legacy', isPinned: false }, { instanceKey: 'pinned', isPinned: true }
  ])
})

test('catalog includes closed windows and widgets across workspaces using their existing keys', () => {
  const data = {
    session_workspaceKeys: ['ws', 'other'],
    session_workspaceByKey_ws_userPk: 'user',
    session_workspaceByKey_other_userPk: 'other-user',
    session_workspaceByKey_ws_pinnedAppIds: ['app'],
    session_workspaceByKey_ws_unpinnedAppIds: ['second-app'],
    session_workspaceByKey_ws_appById_app_appKeys: ['closed', 'open'],
    'session_workspaceByKey_ws_appById_second-app_appKeys': ['second'],
    session_workspaceByKey_other_unpinnedCoreAppIdsObj: { app: true },
    session_workspaceByKey_other_appById_app_appKeys: ['persona-window'],
    local_appPersonaSelections: { other: { app: 'persona' } },
    local_widgets: { widget: { wsKey: 'ws', appId: 'app' }, orphan: { wsKey: 'missing', appId: 'app' } }
  }
  const catalog = readInstanceCatalog(key => data[key])
  assert.deepEqual(catalog.map(r => r.instanceKey), ['closed', 'open', 'second', 'widget', 'persona-window'])
  assert.equal(catalog.find(r => r.instanceKey === 'widget').isWidget, true)
  assert.equal(catalog.at(-1).personaId, 'persona')
  assert.equal(catalog.at(-1).userPk, 'other-user')
})

test('peers require the same app and active identity, exclude self and are sorted', () => {
  const service = createInstanceMetadataService()
  service.setCatalog([
    record('self'), record('z'), record('a', { wsKey: 'other', isWidget: true }),
    record('different-app', { appId: 'different' }), record('different-user', { userPk: 'different' }),
    record('persona-a', { personaId: 'persona', userPk: 'user' }),
    record('persona-b', { personaId: 'persona', userPk: 'different' }),
    record('other-persona', { personaId: 'other-persona' })
  ])
  assert.deepEqual(service.getMetadata('self').otherInstances, [
    { instanceKey: 'a', isWidget: true, isPinned: false, isLoaded: false, isVisible: false },
    { instanceKey: 'z', isWidget: false, isPinned: false, isLoaded: false, isVisible: false }
  ])
  assert.deepEqual(service.getMetadata('persona-a').otherInstances.map(r => r.instanceKey), ['persona-b'])
})

test('creation, removal and identity changes notify once; order alone does not notify', async () => {
  const service = createInstanceMetadataService()
  const updates = []
  const self = record('self')
  service.setCatalog([self])
  service.connect(self, value => updates.push(value))
  await tick()
  assert.equal(updates.length, 0)
  service.setCatalog([self, record('other')])
  service.setCatalog([record('other'), self])
  await tick()
  assert.equal(updates.length, 1)
  assert.equal(updates[0].otherInstances[0].isLoaded, false)
  service.setCatalog([self, record('other')])
  await tick()
  assert.equal(updates.length, 1)
  service.setCatalog([self, record('other', { personaId: 'different' })])
  await tick()
  assert.deepEqual(updates.at(-1).otherInstances, [])
  service.setCatalog([self, record('new')])
  await tick()
  assert.equal(updates.at(-1).otherInstances[0].instanceKey, 'new')
  service.setCatalog([self])
  await tick()
  assert.deepEqual(updates.at(-1).otherInstances, [])
})

test('document replacement ignores old cleanup; closing preserves the registered identity', async () => {
  const service = createInstanceMetadataService()
  const self = record('self')
  service.setCatalog([self, record('peer')])
  const seen = []
  let oldNotifications = 0
  const old = service.connect(self, () => { oldNotifications++ })
  const replacement = service.connect(self, value => seen.push(value))
  old.disconnect()
  service.connect(record('peer'), () => {})
  await tick()
  assert.equal(service.getMetadata('self').isLoaded, true)
  assert.equal(seen.length, 1)
  assert.equal(oldNotifications, 0)
  replacement.disconnect()
  replacement.disconnect()
  assert.equal(service.getMetadata('self').isLoaded, false)
  const reopened = service.connect(self, () => {})
  assert.equal(reopened.initialMetadata.instanceKey, 'self')
})

test('loaded state is local to each launcher realm even with a shared updated catalog', async () => {
  const firstTab = createInstanceMetadataService()
  const secondTab = createInstanceMetadataService()
  const records = [record('self'), record('peer')]
  firstTab.setCatalog(records)
  secondTab.setCatalog(records)
  firstTab.connect(records[0], () => {})
  secondTab.connect(records[1], () => {})
  assert.equal(firstTab.getMetadata('self').otherInstances[0].isLoaded, false)
  assert.equal(secondTab.getMetadata('peer').otherInstances[0].isLoaded, false)
  const updated = [...records, record('new-widget', { isWidget: true })]
  firstTab.setCatalog(updated)
  secondTab.setCatalog(updated)
  await tick()
  assert.equal(firstTab.getMetadata('self').otherInstances.length, 2)
  assert.equal(secondTab.getMetadata('peer').otherInstances.length, 2)
})

test('visibility distinguishes page/layout placement, loading, coverage and reveal mode', () => {
  const service = createInstanceMetadataService()
  const records = [record('window'), record('widget', { isWidget: true }), record('off-page', { isWidget: true })]
  service.setCatalog(records)
  service.connect(records[1], () => {})
  service.connect(records[2], () => {})
  service.setPresentation(new Map([
    ['window', { isWidget: false, isDisplayed: true, contentVisible: false }],
    ['widget', { isWidget: true, isDisplayed: true, contentVisible: true }],
    ['off-page', { isWidget: true, isDisplayed: false, contentVisible: true }]
  ]))
  assert.equal(service.getMetadata('widget').isVisible, false, 'loading window still covers widget')
  assert.equal(service.getMetadata('off-page').isVisible, false)
  service.setEnvironment({ revealWidgets: true })
  assert.equal(service.getMetadata('widget').isVisible, true)
  service.connect(records[0], () => {})
  assert.equal(service.getMetadata('window').isVisible, false)
  service.setEnvironment({ systemRoute: true })
  assert.equal(service.getMetadata('widget').isVisible, false)
  service.setEnvironment({ systemRoute: false, tabVisible: false })
  assert.equal(service.getMetadata('widget').isVisible, false)
  service.setEnvironment({ tabVisible: true, revealWidgets: false })
  service.setPresentation(new Map([
    ['window', { isWidget: false, isDisplayed: false, contentVisible: true }],
    ['widget', { isWidget: true, isDisplayed: true, contentVisible: true }]
  ]))
  assert.equal(service.getMetadata('widget').isVisible, true)
  assert.equal(service.getMetadata('window').isLoaded, true)
  assert.equal(service.getMetadata('window').isVisible, false, 'minimized or omitted by layout')
  service.setPresentation(new Map([['window', { isWidget: false, isDisplayed: true, contentVisible: true }]]))
  assert.equal(service.getMetadata('window').isVisible, true)
})
