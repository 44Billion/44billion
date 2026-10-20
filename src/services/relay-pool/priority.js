// Scheduling hints only: authorization and full event validation stay at admission.
export function parsePriorityFrame (raw) {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string') return null
  try { const value = JSON.parse(raw); return Array.isArray(value) ? value : null } catch { return null }
}
export function isNostrSchedulingFrame (raw) {
  const frame = parsePriorityFrame(raw)
  if (!frame) return false
  if (frame[0] === 'EVENT') return (frame.length === 2 && typeof frame[1] === 'object') || (frame.length === 3 && typeof frame[1] === 'string' && typeof frame[2] === 'object')
  if (frame[0] === 'OK') return (frame.length === 4 || frame.length === 5) && typeof frame[1] === 'string' && typeof frame[2] === 'boolean' && typeof frame[3] === 'string'
  if (frame[0] === 'AUTH') return frame.length === 2 && (typeof frame[1] === 'string' || typeof frame[1] === 'object')
  if (['REQ', 'COUNT', 'NEG-OPEN'].includes(frame[0])) return frame.length >= 3 && typeof frame[1] === 'string' && !!frame[2] && typeof frame[2] === 'object'
  if (['EOSE', 'CLOSE', 'NEG-CLOSE'].includes(frame[0])) return frame.length === 2 && typeof frame[1] === 'string'
  if (['CLOSED', 'NEG-MSG', 'NEG-ERR'].includes(frame[0])) return frame.length >= 3 && typeof frame[1] === 'string' && typeof frame[2] === 'string'
  return frame[0] === 'NOTICE' && typeof frame[1] === 'string'
}
export function isPriorityPublication (raw) {
  const frame = parsePriorityFrame(raw)
  const event = frame?.[1]
  if (!event || typeof event !== 'object' || !Array.isArray(event.tags) || typeof event.id !== 'string' || typeof event.sig !== 'string') return false
  if (frame[0] === 'AUTH') return frame.length === 2 && event.kind === 22242
  return frame[0] === 'EVENT' && frame.length === 2 && event.kind === 3560
}
export function priorityIndex (queue, streak, eligible = () => true) {
  let high = queue.findIndex(item => item.priority)
  let normal = queue.findIndex(item => !item.priority)
  if (high >= 0 && !eligible(queue[high])) high = -1
  if (normal >= 0 && !eligible(queue[normal])) normal = -1
  return high >= 0 && (streak < 3 || normal < 0) ? high : normal
}
export function canUseSendCredit (item, credit, limits, reservedTurn = false) {
  if (credit.frames < 1) return false
  if (credit.frames === limits.bridgeCreditFrames && credit.bytes === limits.bridgeCreditBytes && isNostrSchedulingFrame(item.data) && item.size <= (limits.maxQueuedBytesPerMember ?? 1048576)) return true
  if (credit.bytes < item.size) return false
  if (item.priority || reservedTurn || !isNostrSchedulingFrame(item.data)) return true
  // A frame larger than the normal lane may travel alone with the full window.
  if (credit.frames === limits.bridgeCreditFrames && credit.bytes === limits.bridgeCreditBytes) return true
  return credit.frames > Math.min(4, limits.bridgeCreditFrames - 1) && credit.bytes - item.size >= Math.min(32768, Math.max(0, limits.bridgeCreditBytes - 1))
}
export function sendQueueIndex (queue, streak, credit, limits) {
  const high = queue.find(item => item.priority)
  const normal = queue.find(item => !item.priority)
  // Once normal service is due, let outstanding credit return so an oversized
  // normal frame can travel alone instead of starving under priority traffic.
  const full = credit.frames === limits.bridgeCreditFrames && credit.bytes === limits.bridgeCreditBytes
  if (streak >= 3 && normal && normal.size > limits.bridgeCreditBytes && isNostrSchedulingFrame(normal.data) && !full) return -1
  const reservedTurn = Boolean(streak >= 3 && high && canUseSendCredit(high, credit, limits))
  return priorityIndex(queue, streak, item => canUseSendCredit(item, credit, limits, reservedTurn))
}
