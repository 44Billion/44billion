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
  addWidget,
  applyWidgetPositions,
  applyWidgetResize,
  computeEffectiveGrid,
  derivePage,
  fitSize,
  fitWidgets,
  normalizeWidgets,
  removeWidget,
  removeWidgetsForAppInWorkspace,
  removeWidgetsForWorkspace,
  resizeWidgetFromNode,
  shouldApplyVirtualWidth,
  setWidgetPinnedRoute,
  updateWidgetPosition,
  widgetSessionKey
} = await import('#services/widgets/index.js')

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

function widgetState (overrides = {}) {
  const local = storageMock(encode({
    local_widgets: {
      w1: {
        appId: 'app1',
        wsKey: 'ws1',
        row: 0,
        col: 0,
        desired: { w: 4, h: 6 },
        pinnedRoute: '/pinned',
        createdAt: 1,
        updatedAt: 1
      }
    },
    ...overrides.local
  }))
  const session = storageMock(encode({
    session_widgetByKey_w1_route: '/live',
    session_widgetByKey_w1_visibility: 'open',
    ...overrides.session
  }))
  return { local, session }
}

describe('widgets service', () => {
  it('adds a widget record with defaults', () => {
    const local = storageMock()
    const key = addWidget({
      localStorageArea: local,
      appId: 'app1',
      wsKey: 'ws1',
      row: 1,
      col: 2,
      pinnedRoute: '/x',
      widgetKey: 'w1',
      now: 100
    })
    assert.equal(key, 'w1')
    const record = JSON.parse(local.getItem('local_widgets')).w1
    assert.deepEqual(record, {
      appId: 'app1',
      wsKey: 'ws1',
      row: 1,
      col: 2,
      desired: { w: 4, h: 6 },
      pinnedRoute: '/x',
      createdAt: 100,
      updatedAt: 100
    })
  })

  it('updates position and pinned route', () => {
    const { local } = widgetState()
    updateWidgetPosition({ localStorageArea: local, widgetKey: 'w1', row: 3, col: 4, now: 200 })
    setWidgetPinnedRoute({ localStorageArea: local, widgetKey: 'w1', pinnedRoute: '/new', now: 300 })
    const record = JSON.parse(local.getItem('local_widgets')).w1
    assert.equal(record.row, 3)
    assert.equal(record.col, 4)
    assert.equal(record.pinnedRoute, '/new')
    assert.equal(record.updatedAt, 300)
  })

  it('removes a widget and its session keys', () => {
    const { local, session } = widgetState()
    removeWidget({ localStorageArea: local, sessionStorageArea: session, widgetKey: 'w1' })
    assert.deepEqual(JSON.parse(local.getItem('local_widgets')), {})
    assert.equal(session.getItem('session_widgetByKey_w1_route'), null)
    assert.equal(session.getItem('session_widgetByKey_w1_visibility'), null)
  })

  it('removes widgets per workspace', () => {
    const { local, session } = widgetState({
      local: {
        local_widgets: {
          w1: { appId: 'app1', wsKey: 'ws1', row: 0, col: 0, desired: { w: 1, h: 1 }, pinnedRoute: '', createdAt: 1, updatedAt: 1 },
          w2: { appId: 'app1', wsKey: 'ws2', row: 0, col: 0, desired: { w: 1, h: 1 }, pinnedRoute: '', createdAt: 1, updatedAt: 1 }
        }
      }
    })
    assert.equal(removeWidgetsForWorkspace({ localStorageArea: local, sessionStorageArea: session, wsKey: 'ws1' }), 1)
    assert.deepEqual(Object.keys(JSON.parse(local.getItem('local_widgets'))), ['w2'])
  })

  it('removes widgets per app and workspace', () => {
    const { local, session } = widgetState({
      local: {
        local_widgets: {
          w1: { appId: 'app1', wsKey: 'ws1', row: 0, col: 0, desired: { w: 1, h: 1 }, pinnedRoute: '', createdAt: 1, updatedAt: 1 },
          w2: { appId: 'app2', wsKey: 'ws1', row: 0, col: 0, desired: { w: 1, h: 1 }, pinnedRoute: '', createdAt: 1, updatedAt: 1 }
        }
      }
    })
    assert.equal(removeWidgetsForAppInWorkspace({ localStorageArea: local, sessionStorageArea: session, wsKey: 'ws1', appId: 'app1' }), 1)
    assert.deepEqual(Object.keys(JSON.parse(local.getItem('local_widgets'))), ['w2'])
  })

  it('normalizes invalid and uninstalled widgets', () => {
    const { local, session } = widgetState({
      local: {
        local_widgets: {
          good: { appId: 'app1', wsKey: 'ws1', row: 0, col: 0, desired: { w: 1, h: 1 }, pinnedRoute: '', createdAt: 1, updatedAt: 1 },
          badRow: { appId: 'app1', wsKey: 'ws1', row: -1, col: 0, desired: { w: 1, h: 1 }, pinnedRoute: '', createdAt: 1, updatedAt: 1 },
          ghostWs: { appId: 'app1', wsKey: 'ghost', row: 0, col: 0, desired: { w: 1, h: 1 }, pinnedRoute: '', createdAt: 1, updatedAt: 1 },
          notInstalled: { appId: 'appX', wsKey: 'ws1', row: 0, col: 0, desired: { w: 1, h: 1 }, pinnedRoute: '', createdAt: 1, updatedAt: 1 }
        }
      },
      session: {
        session_widgetByKey_badRow_route: '/x',
        session_widgetByKey_badRow_visibility: 'open'
      }
    })
    const removed = normalizeWidgets({
      localStorageArea: local,
      sessionStorageArea: session,
      workspaceKeys: ['ws1'],
      isAppInstalledInWorkspace: (appId, wsKey) => appId === 'app1' && wsKey === 'ws1'
    })
    assert.deepEqual(removed.sort(), ['badRow', 'ghostWs', 'notInstalled'])
    assert.deepEqual(Object.keys(JSON.parse(local.getItem('local_widgets'))), ['good'])
    assert.equal(session.getItem(widgetSessionKey('badRow', 'route')), null)
  })

  it('fitSize preserves desired size and clamps small viewports', () => {
    assert.deepEqual(fitSize({ w: 2, h: 3 }, 10, 10), { w: 2, h: 3 })
    assert.deepEqual(fitSize({ w: 2, h: 3 }, 1, 1), { w: 1, h: 1 })
    const scaled = fitSize({ w: 2, h: 3 }, 1, 2)
    assert.equal(scaled.w, 1)
    assert.ok(scaled.h >= 1 && scaled.h <= 2)
  })

  it('derivePage computes the horizontal page from col', () => {
    assert.equal(derivePage(0, 5), 0)
    assert.equal(derivePage(4, 5), 0)
    assert.equal(derivePage(5, 5), 1)
    assert.equal(derivePage(12, 5), 2)
  })

  it('fitWidgets preserves free positions and resolves collisions', () => {
    const { placements, pageCount } = fitWidgets([
      { widgetKey: 'a', row: 0, col: 0, desired: { w: 2, h: 3 }, createdAt: 1 },
      { widgetKey: 'b', row: 0, col: 0, desired: { w: 1, h: 1 }, createdAt: 2 }
    ], { viewportCols: 5, viewportRows: 5 })
    assert.equal(pageCount, 1)
    const a = placements.find(p => p.widgetKey === 'a')
    const b = placements.find(p => p.widgetKey === 'b')
    assert.deepEqual([a.row, a.col], [0, 0])
    assert.deepEqual([a.w, a.h], [2, 3])
    assert.deepEqual([b.row, b.col], [0, 2])
  })

  it('fitWidgets grows pages when a widget cannot fit on existing pages', () => {
    const { placements, pageCount } = fitWidgets([
      { widgetKey: 'a', row: 0, col: 0, desired: { w: 3, h: 3 }, createdAt: 1 },
      { widgetKey: 'b', row: 0, col: 0, desired: { w: 3, h: 3 }, createdAt: 2 }
    ], { viewportCols: 3, viewportRows: 3 })
    assert.equal(pageCount, 2)
    assert.deepEqual(
      placements.map(p => [p.widgetKey, p.page]),
      [['a', 0], ['b', 1]]
    )
  })

  it('fitWidgets moves overflow to a later page keeping page math consistent', () => {
    const { placements } = fitWidgets([
      { widgetKey: 'a', row: 0, col: 8, desired: { w: 2, h: 2 }, createdAt: 1 }
    ], { viewportCols: 4, viewportRows: 4 })
    const a = placements.find(p => p.widgetKey === 'a')
    assert.equal(a.page, 2)
    assert.equal(a.col, 8)
  })

  it('shouldApplyVirtualWidth only applies for positive minWidth below the real width', () => {
    assert.equal(shouldApplyVirtualWidth(200, 360), true)
    assert.equal(shouldApplyVirtualWidth(400, 360), false)
    assert.equal(shouldApplyVirtualWidth(200, 0), false)
    assert.equal(shouldApplyVirtualWidth(200, -10), false)
    assert.equal(shouldApplyVirtualWidth(200, '360'), false)
  })

  it('computeEffectiveGrid fills the content width exactly with fixed gaps', () => {
    const one = computeEffectiveGrid(100, 100)
    assert.equal(one.cols, 1)
    assert.equal(one.cell, 60)
    assert.equal(one.gap, 20)
    assert.equal(one.margin, 20)
    assert.equal(one.pageWidth, 60)

    const exact = computeEffectiveGrid(140, 100)
    assert.equal(exact.cols, 2)
    assert.equal(exact.scale, 1)
    assert.equal(exact.cell, 40)
    assert.equal(exact.pageWidth, 100)

    const grown = computeEffectiveGrid(150, 100)
    assert.equal(grown.cols, 2)
    assert.equal(grown.cell, 45)
    assert.equal(grown.pageWidth, 110)
  })

  it('computeEffectiveGrid keeps rows >= 1 and leaves vertical leftover empty', () => {
    const grid = computeEffectiveGrid(1000, 120)
    assert.ok(grid.rows >= 1)
    assert.ok(grid.pageHeight <= grid.viewportHeight - grid.margin)
    const tiny = computeEffectiveGrid(1000, 40)
    assert.ok(tiny.rows >= 1)
  })

  it('fitWidgets anchors the dragged widget and reorganizes others around it', () => {
    const { placements, pageCount } = fitWidgets([
      { widgetKey: 'dragged', row: 0, col: 0, desired: { w: 2, h: 2 }, createdAt: 1 },
      { widgetKey: 'other', row: 0, col: 0, desired: { w: 1, h: 1 }, createdAt: 2 }
    ], {
      viewportCols: 5,
      viewportRows: 5,
      anchorKey: 'dragged'
    })
    assert.equal(pageCount, 1)
    const dragged = placements.find(p => p.widgetKey === 'dragged')
    const other = placements.find(p => p.widgetKey === 'other')
    assert.deepEqual([dragged.row, dragged.col], [0, 0])
    assert.deepEqual([other.row, other.col], [0, 2])
  })

  it('fitWidgets anchor keeps its page and grows pageCount when needed', () => {
    const { placements, pageCount } = fitWidgets([
      { widgetKey: 'dragged', row: 0, col: 6, desired: { w: 1, h: 1 }, createdAt: 1 },
      { widgetKey: 'other', row: 0, col: 0, desired: { w: 1, h: 1 }, createdAt: 2 }
    ], {
      viewportCols: 3,
      viewportRows: 3,
      anchorKey: 'dragged'
    })
    const dragged = placements.find(p => p.widgetKey === 'dragged')
    assert.equal(dragged.page, 2)
    assert.equal(pageCount, 3)
  })

  it('applyWidgetPositions updates multiple widgets in a single write', () => {
    const { local } = widgetState({
      local: {
        local_widgets: {
          w1: { appId: 'app1', wsKey: 'ws1', row: 0, col: 0, desired: { w: 1, h: 1 }, pinnedRoute: '', createdAt: 1, updatedAt: 1 },
          w2: { appId: 'app1', wsKey: 'ws1', row: 1, col: 1, desired: { w: 1, h: 1 }, pinnedRoute: '', createdAt: 1, updatedAt: 1 }
        }
      }
    })
    applyWidgetPositions({
      localStorageArea: local,
      positions: [
        { widgetKey: 'w1', row: 2, col: 3 },
        { widgetKey: 'w2', row: 4, col: 5 },
        { widgetKey: 'missing', row: 9, col: 9 }
      ],
      now: 500
    })
    const widgets = JSON.parse(local.getItem('local_widgets'))
    assert.deepEqual([widgets.w1.row, widgets.w1.col], [2, 3])
    assert.deepEqual([widgets.w2.row, widgets.w2.col], [4, 5])
    assert.equal(widgets.w1.updatedAt, 500)
    assert.equal(widgets.missing, undefined)
  })

  it('resizeWidgetFromNode handles the four nodes with min 1 cell and page clamps', () => {
    const base = { row: 1, col: 4, desired: { w: 2, h: 3 } }
    // col 4 with 4 cols/page => page 1, pageCol 0, maxW = 4
    assert.deepEqual(
      resizeWidgetFromNode({ widget: base, node: 'right', deltaCols: 2, viewportCols: 4, viewportRows: 6 }),
      { row: 1, col: 4, desired: { w: 4, h: 3 } }
    )
    assert.deepEqual(
      resizeWidgetFromNode({ widget: base, node: 'right', deltaCols: 99, viewportCols: 4, viewportRows: 6 }),
      { row: 1, col: 4, desired: { w: 4, h: 3 } }
    )
    assert.deepEqual(
      resizeWidgetFromNode({ widget: base, node: 'right', deltaCols: -2, viewportCols: 4, viewportRows: 6 }),
      { row: 1, col: 4, desired: { w: 1, h: 3 } }
    )
  })

  it('resizeWidgetFromNode adjusts col/row for left and top nodes', () => {
    const base = { row: 2, col: 5, desired: { w: 2, h: 2 } }
    // col 5 => page 1, pageCol 1; extending left keeps the right edge at col 7
    assert.deepEqual(
      resizeWidgetFromNode({ widget: base, node: 'left', deltaCols: -1, viewportCols: 4, viewportRows: 6 }),
      { row: 2, col: 4, desired: { w: 3, h: 2 } }
    )
    assert.deepEqual(
      resizeWidgetFromNode({ widget: base, node: 'top', deltaRows: -1, viewportCols: 4, viewportRows: 6 }),
      { row: 1, col: 5, desired: { w: 2, h: 3 } }
    )
    assert.deepEqual(
      resizeWidgetFromNode({ widget: base, node: 'bottom', deltaRows: 9, viewportCols: 4, viewportRows: 6 }),
      { row: 2, col: 5, desired: { w: 2, h: 4 } }
    )
  })

  it('applyWidgetResize writes row, col and desired in one update', () => {
    const { local } = widgetState()
    applyWidgetResize({
      localStorageArea: local,
      widgetKey: 'w1',
      row: 3,
      col: 7,
      desired: { w: 3, h: 4 },
      now: 900
    })
    const record = JSON.parse(local.getItem('local_widgets')).w1
    assert.equal(record.row, 3)
    assert.equal(record.col, 7)
    assert.deepEqual(record.desired, { w: 3, h: 4 })
    assert.equal(record.updatedAt, 900)
  })
})
