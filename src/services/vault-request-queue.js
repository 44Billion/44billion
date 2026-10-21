import { normalizeMethodName } from '#helpers/window-message/browser/nip07-permission-context.js'

const priorityKinds = new Set([9, 1063, 3560, 26300, 26400, 34601])
const cryptoMethods = new Set(['nip44v3Encrypt', 'nip44v3Decrypt', 'nip44v3EncryptDoubleDH', 'nip44v3DecryptDoubleDH'])
const kindNumber = value => (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) ? Number(value) : null

export function classifyVaultRequest (message) {
  const { method, params = [] } = message?.payload ?? {}
  if (message?.code !== 'NIP07') return { priority: false, chunk: false, archive: false }
  const name = normalizeMethodName(method)
  const args = Array.isArray(params) ? params : []
  let kind; let chunk = false
  if (name === 'signEvent' || name === 'doubleSignEvent') {
    const event = args[0]
    const tags = Array.isArray(event?.tags) ? event.tags.filter(Array.isArray) : []
    kind = kindNumber(event?.kind)
    if (kind === 1006) kind = tags.filter(tag => tag[0] === 'k').map(tag => kindNumber(tag[1])).find(value => priorityKinds.has(value)) ?? kind
    chunk = kind === 34601 || ([26300, 26400, 3560].includes(kind) && tags.some(tag => tag[0] === 'i' && /^\d+$/.test(tag[1])))
  } else if (cryptoMethods.has(name) || name === 'obfuscate') {
    kind = kindNumber(args[1])
    chunk = kind === 34601
  }
  return { priority: priorityKinds.has(kind) || (name === 'obfuscate' && kind === 1006), chunk: Boolean(chunk), archive: false }
}

// The inherited classification is launcher-owned and never read from app payloads.
export function createVaultRequestQueue ({ send, beforeSend = () => {}, onDebug, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const waiting = [[], []]
  const running = new Set()
  let port; let closed = false; let draining = false; let preferred = 0
  const failure = (msg, error) => ({ code: msg.code, payload: null, error })
  const snapshot = () => ({ waiting: waiting[0].length + waiting[1].length, running: running.size })
  const debug = (job, stage) => {
    try { onDebug?.({ stage, requestId: job.msg.diagnostics?.requestId, parentId: job.msg.diagnostics?.parentId, eventId: job.msg.diagnostics?.eventId, seedRecordId: job.msg.diagnostics?.seedRecordId, priority: job.priority, chunk: job.chunk, archive: job.archive, elapsedMs: now() - job.queuedAt, ...snapshot() }) } catch {}
  }
  function finish (job, result) {
    if (job.done) return
    job.done = true
    clearTimer(job.timer)
    running.delete(job)
    const queue = waiting[Number(job.priority)]
    const index = queue.indexOf(job)
    if (index !== -1) queue.splice(index, 1)
    if (job.startedAt != null) {
      try { onDebug?.({ stage: 'vault-execution', requestId: job.msg.diagnostics?.requestId, parentId: job.msg.diagnostics?.parentId, eventId: job.msg.diagnostics?.eventId, seedRecordId: job.msg.diagnostics?.seedRecordId, archive: job.archive, elapsedMs: now() - job.startedAt, ...(Number.isFinite(result?.diagnostics?.vaultDurationMs) ? { durationMs: result.diagnostics.vaultDurationMs } : {}) }) } catch {}
    }
    debug(job, 'vault-complete')
    job.resolve(result)
    drain()
  }
  function drain () {
    if (draining || closed || !port) return
    draining = true
    try {
      while (running.size < 5) {
        const active = [...running]
        const chunks = active.filter(job => job.chunk).length
        const archives = active.filter(job => job.archive).length
        const eligible = job => (!job.chunk || chunks < 2) && (!job.archive || archives < 2)
        const normal = active.filter(job => !job.priority).length < 4 ? waiting[0].find(eligible) : undefined
        const priority = waiting[1].find(eligible)
        const job = normal && (!priority || preferred >= 3) ? normal : priority || normal
        if (!job) break
        if (job.deadline !== null && job.deadline <= now()) {
          finish(job, failure(job.msg, new Error('Vault request timed out')))
          continue
        }
        waiting[Number(job.priority)].splice(waiting[Number(job.priority)].indexOf(job), 1)
        running.add(job)
        if (job.priority) preferred = Math.min(3, preferred + 1)
        else preferred = 0
        try {
          const early = beforeSend(job.msg)
          if (early) { finish(job, early); continue }
          job.startedAt = now()
          debug(job, 'vault-dispatch')
          Promise.resolve(send(port, job.msg, { timeout: job.deadline === null ? null : job.deadline - now() }))
            .then(result => finish(job, result), error => finish(job, failure(job.msg, error)))
        } catch (error) { finish(job, failure(job.msg, error)) }
      }
    } finally { draining = false }
  }
  function cancel (error = new Error('Canceled')) {
    // Snapshot first: completion can wake another job.
    const previous = port
    port = null
    for (const job of [...running, ...waiting[0], ...waiting[1]]) finish(job, failure(job.msg, error))
    port = previous
  }
  return {
    ask (msg, { timeout = 5000, instant = false, scheduling } = {}) {
      if (closed) return Promise.resolve(failure(msg, new Error('Vault queue closed')))
      if (instant) {
        if (!port) return Promise.reject(new Error('Vault not connected'))
        return send(port, msg, { timeout })
      }
      const queuedAt = now()
      const classification = scheduling ?? classifyVaultRequest(msg)
      return new Promise(resolve => {
        const job = { msg, resolve, ...classification, archive: Boolean(classification.archive), queuedAt, deadline: timeout == null ? null : queuedAt + timeout }
        waiting[Number(Boolean(job.priority))].push(job)
        if (job.deadline !== null) {
          job.timer = setTimer(() => finish(job, failure(msg, new Error('Vault request timed out'))), Math.max(0, timeout))
          job.timer?.unref?.()
        }
        debug(job, 'vault-queued')
        drain()
      })
    },
    setPort (next) {
      if (next === port || closed) return
      if (port) cancel(new Error('Vault connection changed'))
      port = next
      drain()
    },
    cancel,
    close () { closed = true; cancel(new Error('Vault queue closed')); port = null },
    snapshot
  }
}
