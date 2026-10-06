import { frameSize } from './bridge-protocol.js'

// Only launcher-to-consumer traffic participates in these shared budgets.
// Payloads stay in the pending queue; the credit ledger holds sizes/times only.
const receivers = new Set()
const totals = items => {
  let frames = 0
  let bytes = 0
  for (const item of items) { frames += item.heldFrames; bytes += item.heldBytes }
  return { frames, bytes }
}
const metric = () => ({ count: 0, lastMs: null, maxMs: null })
const sample = (stat, value) => {
  if (!Number.isFinite(value) || value < 0) return
  stat.count++
  stat.lastMs = value
  stat.maxMs = Math.max(stat.maxMs ?? 0, value)
}

export function createBridgeReceiveQueue ({ endpointId, virtualId, owner, relay, limits, now = () => performance.now(), epochNow = () => performance.timeOrigin + performance.now(), onFrame, onClose, onOverflow }) {
  const queue = []
  const pending = []
  const latency = { roundTrip: metric(), delivery: metric(), consumer: metric(), return: metric() }
  let queuedBytes = 0
  let pendingBytes = 0
  let peakQueuedFrames = 0
  let peakQueuedBytes = 0
  let sequence = 0
  let closed = false

  const snapshot = () => ({
    endpointId, virtualId, owner, relay,
    queuedFrames: queue.length, queuedBytes,
    oldestQueuedMs: queue.length ? Math.max(0, now() - queue[0].queuedAt) : 0,
    headFrameBytes: queue[0]?.size ?? 0,
    peakQueuedFrames, peakQueuedBytes,
    pendingFrames: pending.length, pendingBytes,
    oldestPendingMs: pending.length ? Math.max(0, now() - pending[0].sentAt) : 0,
    credit: { frames: limits.bridgeReceiveCreditFrames - pending.length, bytes: limits.bridgeReceiveCreditBytes - pendingBytes },
    latency: Object.fromEntries(Object.entries(latency).map(([key, value]) => [key, { ...value }]))
  })
  const close = () => {
    if (closed) return
    closed = true
    receivers.delete(receiver)
    queue.length = 0
    pending.length = 0
    queuedBytes = pendingBytes = 0
  }
  const fail = (reason, scope, budget, exceeded, detail = {}) => {
    if (closed) return
    const record = { ...snapshot(), ...detail, scope, limits: budget, exceeded }
    close()
    try { onOverflow(record) } finally { onClose(1013, reason, scope === 'frame' ? 'RELAY_BRIDGE_FRAME_TOO_LARGE' : 'RELAY_BRIDGE_RECEIVE_QUEUE_OVERFLOW') }
  }
  const enforceBudget = (items, budget, scope) => {
    const usage = totals(items)
    while (usage.frames > budget.frames || usage.bytes > budget.bytes) {
      const byBytes = usage.bytes > budget.bytes
      const victim = [...items].filter(item => item.heldFrames > 0)
        .sort((a, b) => (byBytes ? b.heldBytes - a.heldBytes : b.heldFrames - a.heldFrames))[0]
      if (!victim) return
      const exceeded = [usage.frames > budget.frames && 'frames', usage.bytes > budget.bytes && 'bytes'].filter(Boolean)
      const frames = victim.heldFrames
      const bytes = victim.heldBytes
      victim.fail('relay endpoint queue overflow', scope, budget, exceeded, { aggregateFrames: usage.frames, aggregateBytes: usage.bytes })
      usage.frames -= frames
      usage.bytes -= bytes
    }
  }
  const flush = () => {
    while (queue.length) {
      if (closed) return
      const item = queue[0]
      // A larger, bounded frame may travel alone, repaying its full volume on ACK.
      if (pending.length && (pending.length >= limits.bridgeReceiveCreditFrames || pendingBytes + item.size > limits.bridgeReceiveCreditBytes)) return
      queue.shift()
      queuedBytes -= item.size
      const through = ++sequence
      pending.push({ size: item.size, through, sentAt: now(), sentEpoch: epochNow() })
      pendingBytes += item.size
      onFrame(item.data, through)
    }
  }
  const receiver = {
    endpointId,
    get heldFrames () { return queue.length + pending.length },
    get heldBytes () { return queuedBytes + pendingBytes },
    snapshot, close, fail,
    push (data) {
      if (closed) return
      const size = frameSize(data)
      const budget = { frames: limits.bridgeReceiveQueueFrames, bytes: limits.bridgeReceiveQueueBytes }
      if (size > budget.bytes) {
        fail('relay bridge frame too large', 'frame', budget, ['bytes'], { frameBytes: size })
        return
      }
      queue.push({ data, size, queuedAt: now() })
      queuedBytes += size
      // An immediately sendable frame is not a pending backlog.
      const canFlush = queue.length === 1 && (!pending.length || (pending.length < limits.bridgeReceiveCreditFrames && pendingBytes + size <= limits.bridgeReceiveCreditBytes))
      if (!canFlush) {
        peakQueuedFrames = Math.max(peakQueuedFrames, queue.length)
        peakQueuedBytes = Math.max(peakQueuedBytes, queuedBytes)
        if (queue.length > budget.frames || queuedBytes > budget.bytes) {
          fail('relay endpoint queue overflow', 'connection', budget, [queue.length > budget.frames && 'frames', queuedBytes > budget.bytes && 'bytes'].filter(Boolean))
          return
        }
      }
      enforceBudget([...receivers].filter(item => item.endpointId === endpointId), { frames: limits.bridgeEndpointFrames, bytes: limits.bridgeEndpointBytes }, 'endpoint')
      enforceBudget(receivers, { frames: limits.bridgeTotalFrames, bytes: limits.bridgeTotalBytes }, 'tab')
      flush()
    },
    grant ({ frames = 0, bytes = 0, through, receivedAt, returnedAt }) {
      if (closed) return
      if (frames === 0 && bytes === 0 && through === undefined) return
      const expected = Number.isSafeInteger(frames) && frames > 0 && frames <= pending.length
        ? pending.slice(0, frames).reduce((sum, item) => sum + item.size, 0)
        : -1
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes !== expected || (through !== undefined && through !== pending[frames - 1]?.through)) {
        close()
        onClose(1013, 'invalid relay bridge credit', 'RELAY_BRIDGE_INVALID_CREDIT')
        return
      }
      const first = pending[0]
      const receivedEpoch = epochNow()
      sample(latency.roundTrip, now() - first.sentAt)
      // Cross-context times are estimates. Ignore inconsistent/sleep-skewed data.
      if (Number.isFinite(receivedAt) && Number.isFinite(returnedAt) && first.sentEpoch <= receivedAt && receivedAt <= returnedAt && returnedAt <= receivedEpoch) {
        sample(latency.delivery, receivedAt - first.sentEpoch)
        sample(latency.consumer, returnedAt - receivedAt)
        sample(latency.return, receivedEpoch - returnedAt)
      }
      pending.splice(0, frames)
      pendingBytes -= bytes
      flush()
    }
  }
  receivers.add(receiver)
  return receiver
}
