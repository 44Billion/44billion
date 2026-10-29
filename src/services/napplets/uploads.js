import { createHttpUploader } from '@kehto/services'
import { isValidPublicBlossomServerUrl } from 'libp2r2p/url'

export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024
const MAX_JOBS = 64

export function normalizeUploadServers (values) {
  return [...new Set(values.flatMap(value => {
    try {
      const url = new URL(value)
      if (!isValidPublicBlossomServerUrl(url.href) || url.username || url.password || url.search || url.hash) return []
      return [url.href.replace(/\/$/, '')]
    } catch { return [] }
  }))].slice(0, 10)
}

// Jobs are ephemeral and belong exclusively to one mounted napplet instance.
export function createNappletUploadService ({ account, signal, latest, confirm, fetchUpload = fetch, present = () => {}, generateId = () => crypto.randomUUID() }) {
  const jobs = new Map()
  let destroyed = false
  const guard = pubkey => {
    signal.throwIfAborted()
    account.guard()
    if (destroyed || !pubkey || account.getPublicKey() !== pubkey) throw new Error('ACCOUNT_ACCESS_REVOKED')
  }
  const cancel = job => { job.controller.abort(); job.cancel?.() }
  const close = () => { destroyed = true; for (const job of jobs.values()) cancel(job); jobs.clear() }
  signal.addEventListener('abort', close, { once: true })
  const run = async (job, request, pubkey, send) => {
    const lifetime = AbortSignal.any([signal, job.controller.signal, AbortSignal.timeout(10 * 60 * 1000)])
    const check = () => { lifetime.throwIfAborted(); guard(pubkey) }
    const update = value => {
      job.status = { ...job.status, ...value, updatedAt: Date.now() }
      if (!destroyed) { send({ type: 'upload.status.changed', status: job.status }); present(job.status, () => cancel(job)) }
    }
    try {
      check()
      const list = await latest(10063, pubkey)
      check()
      const servers = normalizeUploadServers((list?.tags || []).filter(tag => tag[0] === 'server').map(tag => tag[1]))
      const selected = await confirm({ uploadId: job.status.uploadId, filename: request.filename, size: request.data.size, pubkey, servers, signal: lifetime, cancel: () => cancel(job) })
      check()
      if (!selected) { job.controller.abort(); check() }
      const destinations = normalizeUploadServers(selected)
      if (!destinations.length) throw new Error('NO_BLOSSOM_SERVERS')
      update({ status: 'uploading' })
      const completed = []
      let failure
      for (const server of destinations) {
        check()
        const uploader = createHttpUploader({
          rails: { blossom: { servers: [server] } }, defaultRail: 'blossom',
          signEvent: async template => { check(); const event = await account.signEvent(template); check(); return event },
          fetch: async (url, init) => {
            check()
            const response = await fetchUpload(url, { ...init, signal: lifetime, credentials: 'omit', redirect: 'error' })
            check()
            // Descriptors are small JSON, never unbounded server response bodies.
            if (!response.ok) { await response.body?.cancel(); throw new Error(`UPLOAD_HTTP_${response.status}`) }
            const reader = response.body.getReader()
            const chunks = []
            let size = 0
            try {
              while (true) {
                const { value, done } = await reader.read()
                if (done) break
                size += value.length
                if (size > 65536) throw new Error('INVALID_UPLOAD_RESPONSE')
                chunks.push(value)
              }
            } finally { await reader.cancel() }
            check()
            return new Response(new Blob(chunks), { headers: { 'content-type': 'application/json' } })
          }
        })
        job.cancel = () => uploader.cancel(job.status.uploadId)
        try {
          const result = await uploader.upload(request, { uploadId: job.status.uploadId, windowId: '', onStatus: () => {} })
          check()
          if (result.ok) {
            const url = new URL(result.url)
            if (!isValidPublicBlossomServerUrl(url.origin) || url.username || url.password) throw new Error('INVALID_UPLOAD_URL')
            completed.push(result)
          } else failure = result.error
        } catch (error) { check(); failure = error.message }
      }
      if (!completed.length) throw new Error(failure || 'UPLOAD_FAILED')
      check()
      update({ ...completed[0], fallbackUrls: completed.slice(1).map(result => result.url), status: 'complete', ok: true })
    } catch (error) {
      update({ ok: false, status: lifetime.aborted && lifetime.reason?.name !== 'TimeoutError' ? 'cancelled' : 'failed', error: lifetime.reason?.name === 'TimeoutError' ? 'UPLOAD_TIMEOUT' : error.message })
    } finally { job.cancel = undefined }
  }
  return {
    descriptor: { name: 'upload', version: '1.0.0', description: 'Blossom uploads with launcher consent and status updates' },
    handleMessage (_windowId, message, send) {
      if (destroyed || !['upload.info', 'upload.upload', 'upload.status'].includes(message.type)) return
      const reply = value => send({ type: `${message.type}.result`, id: message.id, ...value })
      try {
        account.guard()
        signal.throwIfAborted()
        if (message.type === 'upload.info') { reply({ info: { rails: [{ rail: 'blossom', enabled: true, returns: ['url', 'sha256', 'size', 'mimeType', 'nip94', 'fallbackUrls'] }], maxBytes: MAX_UPLOAD_BYTES } }); return }
        if (message.type === 'upload.status') {
          const status = jobs.get(message.uploadId)?.status
          reply(status ? { status } : { error: 'UNKNOWN_UPLOAD' }); return
        }
        const pubkey = account.getPublicKey()
        guard(pubkey)
        const input = message.request
        if (input?.rail && input.rail !== 'blossom') throw new Error('UNSUPPORTED_UPLOAD_RAIL')
        if (!(input?.data instanceof Blob) && !(input?.data instanceof ArrayBuffer)) throw new Error('INVALID_UPLOAD_DATA')
        const size = input.data instanceof Blob ? input.data.size : input.data.byteLength
        if (size > MAX_UPLOAD_BYTES) throw new Error('UPLOAD_TOO_LARGE')
        if ([...jobs.values()].filter(job => ['pending', 'uploading'].includes(job.status.status)).length >= 2) throw new Error('UPLOAD_BUSY')
        if (jobs.size >= MAX_JOBS) jobs.delete([...jobs].find(([, job]) => !['pending', 'uploading'].includes(job.status.status))[0])
        const mimeType = typeof input.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType) ? input.mimeType : input.data.type || 'application/octet-stream'
        const request = { data: new Blob([input.data], { type: mimeType }), mimeType, filename: typeof input.filename === 'string' ? Array.from(input.filename).filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('').slice(0, 255) : 'file' }
        const uploadId = generateId()
        const job = { controller: new AbortController(), status: { uploadId, rail: 'blossom', status: 'pending', ok: true, bytesTotal: size, updatedAt: Date.now() } }
        jobs.set(uploadId, job)
        reply({ result: job.status })
        present(job.status, () => cancel(job))
        run(job, request, pubkey, send).catch(() => {})
      } catch (error) { reply({ error: error.message }) }
    },
    onWindowDestroyed: close,
    onUnregistered () { close(); signal.removeEventListener('abort', close) }
  }
}
