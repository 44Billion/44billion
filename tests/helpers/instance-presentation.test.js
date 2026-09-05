import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isInstanceSurfaceDisplayed, createInstancePresentationObserver } from '../../src/helpers/instance-presentation.js'
import { createInstanceMetadataService } from '../../src/services/instance-metadata/index.js'

function element (overrides = {}) {
  return Object.assign(new EventTarget(), {
    isConnected: true,
    parentElement: null,
    rect: { left: 0, top: 0, right: 300, bottom: 200 },
    style: { visibility: 'visible', display: 'block', opacity: '1', overflowX: 'visible', overflowY: 'visible' },
    getBoundingClientRect () { return this.rect },
    ...overrides
  })
}
const viewport = () => Object.assign(new EventTarget(), {
  innerWidth: 600,
  innerHeight: 400,
  getComputedStyle: el => el.style
})

test('uses effective CSS visibility and geometry, including clipping and transparent ancestors', () => {
  const window = viewport()
  const root = element()
  assert.equal(isInstanceSurfaceDisplayed(root, window), true)
  root.style.visibility = 'hidden'
  assert.equal(isInstanceSurfaceDisplayed(root, window), false)
  root.style.visibility = 'visible'
  root.rect.left = 600
  root.rect.right = 900
  assert.equal(isInstanceSurfaceDisplayed(root, window), false)
  root.rect.left = 590
  assert.equal(isInstanceSurfaceDisplayed(root, window), true)
  const parent = element()
  root.parentElement = parent
  parent.style.overflowX = 'hidden'
  assert.equal(isInstanceSurfaceDisplayed(root, window), false)
  parent.style.overflowX = 'visible'
  parent.style.opacity = '0'
  assert.equal(isInstanceSurfaceDisplayed(root, window), false)
  parent.style.opacity = '1'
  parent.style.display = 'none'
  assert.equal(isInstanceSurfaceDisplayed(root, window), false)
  parent.style.display = 'contents'
  parent.style.overflowX = 'hidden'
  assert.equal(isInstanceSurfaceDisplayed(root, window), true)
  root.isConnected = false
  assert.equal(isInstanceSurfaceDisplayed(root, window), false)
})

test('observes rendered layout, resize, scroll, hidden tabs and cleanup without polling', async () => {
  const window = viewport()
  const document = new EventTarget()
  document.visibilityState = 'visible'
  let nextFrame
  let mutation
  let resize
  let disconnected = 0
  window.requestAnimationFrame = callback => { nextFrame = callback; return 1 }
  window.cancelAnimationFrame = () => { nextFrame = null }
  window.MutationObserver = class {
    constructor (callback) { mutation = callback }
    observe () {}
    disconnect () { disconnected++ }
  }
  window.ResizeObserver = class {
    constructor (callback) { resize = callback }
    observe () {}
    disconnect () { disconnected++ }
  }
  const frame = () => { const callback = nextFrame; nextFrame = null; callback?.() }
  const service = createInstanceMetadataService()
  const record = { instanceKey: 'window', appId: 'app', userPk: 'user', isWidget: false }
  service.setCatalog([record])
  service.connect(record, () => {})
  const observer = createInstancePresentationObserver(service)
  const root = element()
  const unregister = observer.register('window', { element: root, eligible: true, isWidget: false, contentVisible: true })
  const stop = observer.start(window, document, element())
  frame()
  assert.equal(service.getMetadata('window').isVisible, true)
  // Single/multi-window and MRU changes alter the effective CSS.
  root.style.visibility = 'hidden'
  mutation()
  frame()
  assert.equal(service.getMetadata('window').isVisible, false)
  root.style.visibility = 'visible'
  resize()
  frame()
  assert.equal(service.getMetadata('window').isVisible, true)
  window.innerWidth = 0
  window.dispatchEvent(new Event('resize'))
  frame()
  assert.equal(service.getMetadata('window').isVisible, false)
  window.innerWidth = 600
  window.dispatchEvent(new Event('scroll'))
  frame()
  assert.equal(service.getMetadata('window').isVisible, true)
  document.visibilityState = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(service.getMetadata('window').isVisible, false, 'does not wait for a frame in a hidden tab')
  document.visibilityState = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  frame()
  assert.equal(service.getMetadata('window').isVisible, true)
  unregister()
  frame()
  assert.equal(service.getMetadata('window').isVisible, false)
  stop()
  assert.equal(disconnected, 2)
  assert.equal(nextFrame, null)
})
