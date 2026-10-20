import { isPriorityPublication, parsePriorityFrame } from './priority.js'

// Correlation is attachment-local and bounded. It carries no filters/payloads.
// Losing an old hint only removes preference, never delivery or ordering.
export function createControlPriority () {
  const publications = new Map()
  const subscriptions = new Map()
  const counts = new Map()
  const negs = new Map()
  const remember = (map, id, value = true) => {
    map.delete(id)
    map.set(id, value)
    while (map.size > 256) map.delete(map.keys().next().value)
  }
  return {
    note (raw) {
      const frame = parsePriorityFrame(raw)
      if (!frame) return
      const [op, id, value] = frame
      if (['EVENT', 'AUTH'].includes(op) && frame.length === 2 && typeof id?.id === 'string' && typeof id.sig === 'string' && Array.isArray(id.tags)) {
        remember(publications, id.id, isPriorityPublication(frame) ? 2 : 1)
      } else if (typeof id === 'string') {
        if (['REQ', 'COUNT', 'NEG-OPEN'].includes(op) && frame.length >= 3 && value && typeof value === 'object') {
          remember(op === 'REQ' ? subscriptions : op === 'COUNT' ? counts : negs, id)
        } else if (op === 'CLOSE' && frame.length === 2) subscriptions.delete(id)
        else if (op === 'NEG-CLOSE' && frame.length === 2) negs.delete(id)
      }
    },
    take (raw) {
      const frame = parsePriorityFrame(raw)
      if (!frame) return { priority: 0 }
      const [op, id, value] = frame
      let priority = 0
      let stream
      if (op === 'AUTH' && frame.length === 2 && typeof id === 'string') priority = 2
      if (typeof id === 'string') {
        if (op === 'OK' && [4, 5].includes(frame.length) && typeof value === 'boolean' && typeof frame[3] === 'string') {
          priority = publications.get(id) ?? 0
          publications.delete(id)
        } else if (['EVENT', 'EOSE', 'CLOSED', 'COUNT'].includes(op)) {
          // Keep a stable stream across reused IDs/generations, conservatively
          // retaining the order of already queued results from earlier REQs.
          stream = `sub:${id}`
          if (op === 'EOSE' && frame.length === 2 && subscriptions.has(id)) priority = 1
          if (op === 'CLOSED' && [3, 4].includes(frame.length) && typeof value === 'string') {
            const subscription = subscriptions.delete(id)
            const count = counts.delete(id)
            if (subscription || count) priority = 1
          }
          if (op === 'COUNT' && frame.length === 3 && value && typeof value === 'object' && counts.delete(id)) priority = 1
        } else if (['NEG-MSG', 'NEG-ERR'].includes(op)) {
          stream = `neg:${id}`
          if (frame.length === 3 && typeof value === 'string' && negs.has(id)) {
            priority = 1
            if (op === 'NEG-ERR') negs.delete(id)
          }
        }
      }
      return { priority, stream }
    },
    clear () { publications.clear(); subscriptions.clear(); counts.clear(); negs.clear() }
  }
}

// A blocked control must not hold up unrelated controls. Events themselves
// remain FIFO in the normal lane; no history is promoted with its terminator.
export function receiveCandidates (queue) {
  const streams = new Set()
  let high; let control; let normal; let normalSeen = false
  for (const item of queue) {
    const blocked = item.stream && streams.has(item.stream)
    if (item.priority === 2 && !high && !blocked) high = item
    if (item.priority === 1 && !control && !blocked) control = item
    if (item.priority === 0 && !normalSeen) {
      normalSeen = true
      if (!blocked) normal = item
    }
    if (item.stream) streams.add(item.stream)
  }
  return { high, control, normal }
}
