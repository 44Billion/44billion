import { getRandomId } from '#helpers/misc.js'
import { setWebStorageItem } from '#f'

export const LOCAL_WIDGETS = 'local_widgets'
export const SESSION_WIDGET_PREFIX = 'session_widgetByKey_'
export const WIDGET_DEFAULT_DESIRED = { w: 4, h: 6 }
export const WIDGET_MINIMIZED_TTL_MS = 5 * 60 * 1000
export const WIDGET_AUTO_FIT_MIN_WIDTH = 360
export const BASE_CELL = 40
export const BASE_GAP = 20
export const WIDGET_MARGIN = BASE_GAP

// Fluid grid geometry: cells scale to fill the available content
// width exactly; gap and corner margins stay fixed. The horizontal area
// dictates the scale; vertical leftover space stays empty.
export function computeEffectiveGrid (viewportWidth, viewportHeight) {
  const w = Number(viewportWidth) || 0
  const h = Number(viewportHeight) || 0
  const contentWidth = Math.max(0, w - 2 * WIDGET_MARGIN)
  const cols = Math.max(1, Math.floor((contentWidth + BASE_GAP) / (BASE_CELL + BASE_GAP)))
  // With a fixed gap, the cell scale that fills the content width exactly is
  // derived from the remaining width after the (cols-1) fixed gaps.
  const scale = Math.max(
    1,
    (contentWidth - (cols - 1) * BASE_GAP) / (cols * BASE_CELL)
  )
  const cell = BASE_CELL * scale
  const gap = BASE_GAP
  const margin = WIDGET_MARGIN
  const contentHeight = Math.max(0, h - margin)
  const rows = Math.max(1, Math.floor((contentHeight + gap) / (cell + gap)))
  return {
    cols,
    rows,
    cell,
    gap,
    margin,
    scale,
    pageWidth: cols * cell + (cols - 1) * gap,
    pageHeight: rows * cell + (rows - 1) * gap,
    viewportWidth: w,
    viewportHeight: h
  }
}

// Virtual-width decision shared by widgets and regular windows: the launcher
// emulates `minWidth` (iframe resize + scale) only when the real area is
// narrower and the app asked for a positive minimum.
export function shouldApplyVirtualWidth (realWidth, minWidth) {
  return Number.isFinite(realWidth) &&
    Number.isFinite(minWidth) &&
    minWidth > 0 &&
    realWidth < minWidth
}

export function readJson (storage, key, fallback = undefined) {
  const raw = storage?.getItem?.(key)
  if (raw == null) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function writeJson (storage, key, value) {
  setWebStorageItem(storage, key, value === null ? undefined : value)
}

export function readWidgets (localStorageArea) {
  const widgets = readJson(localStorageArea, LOCAL_WIDGETS, {})
  return widgets && typeof widgets === 'object' ? widgets : {}
}

export function writeWidgets (localStorageArea, widgets) {
  writeJson(localStorageArea, LOCAL_WIDGETS, widgets)
}

export function widgetSessionKey (widgetKey, suffix) {
  return `${SESSION_WIDGET_PREFIX}${widgetKey}_${suffix}`
}

export function readWidgetSessionValue (sessionStorageArea, widgetKey, suffix, fallback = undefined) {
  return readJson(sessionStorageArea, widgetSessionKey(widgetKey, suffix), fallback)
}

export function writeWidgetSessionValue (sessionStorageArea, widgetKey, suffix, value) {
  writeJson(sessionStorageArea, widgetSessionKey(widgetKey, suffix), value)
}

export function normalizeDesired (desired) {
  const w = Math.max(1, Math.floor(Number(desired?.w) || 1))
  const h = Math.max(1, Math.floor(Number(desired?.h) || 1))
  return { w, h }
}

export function createWidgetRecord ({
  appId,
  wsKey,
  row = 0,
  col = 0,
  desired = WIDGET_DEFAULT_DESIRED,
  pinnedRoute = '',
  now = Date.now()
}) {
  if (typeof appId !== 'string' || !appId) throw new Error('Widget requires an appId')
  if (typeof wsKey !== 'string' || !wsKey) throw new Error('Widget requires a wsKey')
  const safeDesired = normalizeDesired(desired)
  return {
    appId,
    wsKey,
    row: Math.max(0, Math.floor(Number(row) || 0)),
    col: Math.max(0, Math.floor(Number(col) || 0)),
    desired: safeDesired,
    pinnedRoute: typeof pinnedRoute === 'string' ? pinnedRoute : '',
    createdAt: now,
    updatedAt: now
  }
}

export function addWidget ({
  localStorageArea,
  appId,
  wsKey,
  row = 0,
  col = 0,
  desired = WIDGET_DEFAULT_DESIRED,
  pinnedRoute = '',
  widgetKey = getRandomId(),
  now = Date.now()
}) {
  const widgets = readWidgets(localStorageArea)
  widgets[widgetKey] = createWidgetRecord({
    appId,
    wsKey,
    row,
    col,
    desired,
    pinnedRoute,
    now
  })
  writeWidgets(localStorageArea, widgets)
  return widgetKey
}

export function updateWidgetPosition ({
  localStorageArea,
  widgetKey,
  row,
  col,
  now = Date.now()
}) {
  const widgets = readWidgets(localStorageArea)
  const widget = widgets[widgetKey]
  if (!widget) throw new Error(`Widget not found: ${widgetKey}`)
  widget.row = Math.max(0, Math.floor(Number(row) || 0))
  widget.col = Math.max(0, Math.floor(Number(col) || 0))
  widget.updatedAt = now
  writeWidgets(localStorageArea, widgets)
  return widget
}

export function setWidgetPinnedRoute ({
  localStorageArea,
  widgetKey,
  pinnedRoute,
  now = Date.now()
}) {
  const widgets = readWidgets(localStorageArea)
  const widget = widgets[widgetKey]
  if (!widget) throw new Error(`Widget not found: ${widgetKey}`)
  widget.pinnedRoute = typeof pinnedRoute === 'string' ? pinnedRoute : ''
  widget.updatedAt = now
  writeWidgets(localStorageArea, widgets)
  return widget
}

export function removeWidget ({ localStorageArea, sessionStorageArea, widgetKey }) {
  const widgets = readWidgets(localStorageArea)
  delete widgets[widgetKey]
  writeWidgets(localStorageArea, widgets)
  if (sessionStorageArea) {
    sessionStorageArea.removeItem(widgetSessionKey(widgetKey, 'route'))
    sessionStorageArea.removeItem(widgetSessionKey(widgetKey, 'visibility'))
  }
}

export function removeWidgetsForWorkspace ({ localStorageArea, sessionStorageArea, wsKey }) {
  const widgets = readWidgets(localStorageArea)
  let removed = 0
  for (const [widgetKey, widget] of Object.entries(widgets)) {
    if (widget?.wsKey === wsKey) {
      delete widgets[widgetKey]
      removed++
      if (sessionStorageArea) {
        sessionStorageArea.removeItem(widgetSessionKey(widgetKey, 'route'))
        sessionStorageArea.removeItem(widgetSessionKey(widgetKey, 'visibility'))
      }
    }
  }
  if (removed > 0) writeWidgets(localStorageArea, widgets)
  return removed
}

export function removeWidgetsForAppInWorkspace ({
  localStorageArea,
  sessionStorageArea,
  wsKey,
  appId
}) {
  const widgets = readWidgets(localStorageArea)
  let removed = 0
  for (const [widgetKey, widget] of Object.entries(widgets)) {
    if (widget?.wsKey === wsKey && widget?.appId === appId) {
      delete widgets[widgetKey]
      removed++
      if (sessionStorageArea) {
        sessionStorageArea.removeItem(widgetSessionKey(widgetKey, 'route'))
        sessionStorageArea.removeItem(widgetSessionKey(widgetKey, 'visibility'))
      }
    }
  }
  if (removed > 0) writeWidgets(localStorageArea, widgets)
  return removed
}

// Removes invalid records and records whose app is no longer installed in the
// widget's workspace. Returns the list of removed widgetKeys.
export function normalizeWidgets ({
  localStorageArea,
  sessionStorageArea,
  workspaceKeys,
  isAppInstalledInWorkspace
}) {
  const widgets = readWidgets(localStorageArea)
  const removed = []
  const workspaceSet = new Set(Array.isArray(workspaceKeys) ? workspaceKeys : [])
  for (const [widgetKey, widget] of Object.entries(widgets)) {
    const valid =
      widget &&
      typeof widget.appId === 'string' &&
      typeof widget.wsKey === 'string' &&
      workspaceSet.has(widget.wsKey) &&
      typeof widget.row === 'number' &&
      widget.row >= 0 &&
      typeof widget.col === 'number' &&
      widget.col >= 0 &&
      normalizeDesired(widget.desired).w === widget.desired?.w &&
      normalizeDesired(widget.desired).h === widget.desired?.h &&
      typeof widget.pinnedRoute === 'string' &&
      (!isAppInstalledInWorkspace || isAppInstalledInWorkspace(widget.appId, widget.wsKey))
    if (!valid) {
      delete widgets[widgetKey]
      removed.push(widgetKey)
      if (sessionStorageArea) {
        sessionStorageArea.removeItem(widgetSessionKey(widgetKey, 'route'))
        sessionStorageArea.removeItem(widgetSessionKey(widgetKey, 'visibility'))
      }
    }
  }
  if (removed.length > 0) writeWidgets(localStorageArea, widgets)
  return removed
}

// Keeps the widget's aspect ratio when the viewport is smaller than desired,
// with a hard minimum of 1x1 cells.
export function fitSize (desired, maxCols, maxRows) {
  const cols = Math.max(1, Math.floor(Number(maxCols) || 1))
  const rows = Math.max(1, Math.floor(Number(maxRows) || 1))
  const dw = Math.max(1, Math.floor(Number(desired?.w) || 1))
  const dh = Math.max(1, Math.floor(Number(desired?.h) || 1))
  if (dw <= cols && dh <= rows) return { w: dw, h: dh }
  const scale = Math.min(cols / dw, rows / dh)
  const w = Math.max(1, Math.min(cols, Math.round(dw * scale)))
  const h = Math.max(1, Math.min(rows, Math.round(dh * scale)))
  return { w, h }
}

export function derivePage (col, viewportCols) {
  const cols = Math.max(1, Math.floor(Number(viewportCols) || 1))
  return Math.max(0, Math.floor((Number(col) || 0) / cols))
}

// Deterministic layout: preserves each widget's desired position/size as much
// as the viewport allows, then resolves collisions row-major and grows pages
// only when needed. When `anchorKey` is provided, that widget is fixed at its
// (clamped) target position first and the remaining widgets reorganize around
// it — used for live drag previews.
export function fitWidgets (widgets, {
  viewportCols,
  viewportRows,
  initialPages = 1,
  anchorKey = null
} = {}) {
  const cols = Math.max(1, Math.floor(Number(viewportCols) || 1))
  const rows = Math.max(1, Math.floor(Number(viewportRows) || 1))
  const entries = (Array.isArray(widgets) ? widgets : []).map((widget, index) => ({
    widgetKey: widget.widgetKey ?? widget.key ?? `widget-${index}`,
    row: Math.max(0, Math.floor(Number(widget.row) || 0)),
    col: Math.max(0, Math.floor(Number(widget.col) || 0)),
    desired: widget.desired ?? {},
    createdAt: Number(widget.createdAt) || 0,
    order: index
  }))
  const sized = entries.map(entry => ({
    ...entry,
    ...fitSize(entry.desired, cols, rows)
  }))
  const pageOf = entry => derivePage(entry.col, cols)
  const maxPage = sized.reduce((max, entry) => Math.max(max, pageOf(entry)), -1)
  let pageCount = Math.max(1, initialPages, maxPage + 1)
  const occupied = new Set()
  const placements = []
  const cellKey = (page, row, col) => `${page}:${row}:${col}`
  const clamp = (value, max) => Math.max(0, Math.min(value, max))

  const fitsAt = (entry, page, row, col) => {
    if (row + entry.h > rows || col + entry.w > cols) return false
    for (let r = row; r < row + entry.h; r++) {
      for (let c = col; c < col + entry.w; c++) {
        if (occupied.has(cellKey(page, r, c))) return false
      }
    }
    return true
  }

  const occupy = (entry, page, row, col) => {
    for (let r = row; r < row + entry.h; r++) {
      for (let c = col; c < col + entry.w; c++) occupied.add(cellKey(page, r, c))
    }
    if (page + 1 > pageCount) pageCount = page + 1
    placements.push({
      widgetKey: entry.widgetKey,
      row,
      col: page * cols + col,
      w: entry.w,
      h: entry.h,
      page
    })
  }

  const sorted = [...sized].sort((a, b) =>
    pageOf(a) - pageOf(b) ||
    a.row - b.row ||
    a.col - b.col ||
    a.createdAt - b.createdAt ||
    a.order - b.order
  )

  if (anchorKey != null) {
    const anchorIndex = sorted.findIndex(entry => entry.widgetKey === anchorKey)
    if (anchorIndex !== -1) {
      const [anchor] = sorted.splice(anchorIndex, 1)
      occupy(
        anchor,
        pageOf(anchor),
        clamp(anchor.row, rows - anchor.h),
        clamp(anchor.col % cols, cols - anchor.w)
      )
    }
  }

  for (const entry of sorted) {
    const startPage = pageOf(entry)
    const startRow = clamp(entry.row, rows - entry.h)
    const startCol = clamp(entry.col % cols, cols - entry.w)
    let placed = false
    if (fitsAt(entry, startPage, startRow, startCol)) {
      occupy(entry, startPage, startRow, startCol)
      placed = true
    }
    for (let page = startPage; page < pageCount && !placed; page++) {
      for (let row = 0; row <= rows - entry.h && !placed; row++) {
        for (let col = 0; col <= cols - entry.w && !placed; col++) {
          if (fitsAt(entry, page, row, col)) {
            occupy(entry, page, row, col)
            placed = true
          }
        }
      }
    }
    while (!placed) {
      for (let row = 0; row <= rows - entry.h && !placed; row++) {
        for (let col = 0; col <= cols - entry.w && !placed; col++) {
          if (fitsAt(entry, pageCount, row, col)) {
            occupy(entry, pageCount, row, col)
            placed = true
          }
        }
      }
      if (!placed) pageCount++
    }
  }

  return { placements, pageCount }
}

// Applies fitted positions to multiple widgets in a single write. Positions
// are [{ widgetKey, row, col }]; unknown keys are ignored.
export function applyWidgetPositions ({ localStorageArea, positions, now = Date.now() }) {
  const widgets = readWidgets(localStorageArea)
  let changed = false
  for (const position of Array.isArray(positions) ? positions : []) {
    const widget = widgets[position?.widgetKey]
    if (!widget) continue
    widget.row = Math.max(0, Math.floor(Number(position.row) || 0))
    widget.col = Math.max(0, Math.floor(Number(position.col) || 0))
    widget.updatedAt = now
    changed = true
  }
  if (changed) writeWidgets(localStorageArea, widgets)
}

// Resize math for the four edge nodes. `deltaCols`/`deltaRows` are pointer
// deltas in cells (positive = right/down). Left/top nodes extend the widget in
// the opposite direction and adjust row/col so the opposite edge stays fixed.
// Minimum is 1 cell; maximum is the remaining space on the widget's page.
export function resizeWidgetFromNode ({
  widget,
  node,
  deltaCols = 0,
  deltaRows = 0,
  viewportCols,
  viewportRows
}) {
  const cols = Math.max(1, Math.floor(Number(viewportCols) || 1))
  const rows = Math.max(1, Math.floor(Number(viewportRows) || 1))
  const row = Math.max(0, Math.floor(Number(widget.row) || 0))
  const col = Math.max(0, Math.floor(Number(widget.col) || 0))
  const startW = Math.max(1, Math.floor(Number(widget.desired?.w) || 1))
  const startH = Math.max(1, Math.floor(Number(widget.desired?.h) || 1))
  const pageCol = col % cols
  const page = Math.floor(col / cols)
  const maxW = Math.max(1, cols - pageCol)
  const maxH = Math.max(1, rows - row)
  const clamp = (value, min, max) => Math.max(min, Math.min(value, max))
  const deltaW = Math.round(deltaCols)
  const deltaH = Math.round(deltaRows)
  let nextRow = row
  let nextCol = col
  let w = startW
  let h = startH

  if (node === 'right') {
    w = clamp(startW + deltaW, 1, maxW)
  } else if (node === 'left') {
    w = clamp(startW - deltaW, 1, Math.min(maxW, pageCol + startW))
    nextCol = page * cols + pageCol + startW - w
  } else if (node === 'bottom') {
    h = clamp(startH + deltaH, 1, maxH)
  } else if (node === 'top') {
    h = clamp(startH - deltaH, 1, Math.min(maxH, row + startH))
    nextRow = row + startH - h
  }

  return { row: nextRow, col: nextCol, desired: { w, h } }
}

export function applyWidgetResize ({
  localStorageArea,
  widgetKey,
  row,
  col,
  desired,
  now = Date.now()
}) {
  const widgets = readWidgets(localStorageArea)
  const widget = widgets[widgetKey]
  if (!widget) return
  widget.row = Math.max(0, Math.floor(Number(row) || 0))
  widget.col = Math.max(0, Math.floor(Number(col) || 0))
  widget.desired = normalizeDesired(desired)
  widget.updatedAt = now
  writeWidgets(localStorageArea, widgets)
}
