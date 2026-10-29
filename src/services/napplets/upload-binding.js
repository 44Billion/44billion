// Serialized into the sandbox after Kehto's prelude and before authored scripts.
// Optional launcher convenience; standard upload() keeps its initial-result semantics.
export function installUploadBinding () {
  const api = window.napplet?.upload
  if (!api) return
  const start = api.upload.bind(api)
  api.uploadAndWait = request => new Promise((resolve, reject) => {
    let uploadId
    let finished = false
    const early = new Map()
    const finish = (result, error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      subscription.close()
      window.removeEventListener('pagehide', teardown)
      if (error) reject(error)
      else resolve(result)
    }
    const terminal = result => {
      if (['complete', 'failed', 'cancelled'].includes(result.status)) finish(result)
    }
    const subscription = api.onStatus(result => {
      if (uploadId) { if (result.uploadId === uploadId) terminal(result) } else {
        early.set(result.uploadId, result)
        if (early.size > 64) early.delete(early.keys().next().value)
      }
    })
    const teardown = () => finish(null, new Error('UPLOAD_CONTEXT_CLOSED'))
    window.addEventListener('pagehide', teardown, { once: true })
    const timer = setTimeout(() => finish(null, new Error('UPLOAD_TIMEOUT')), 11 * 60 * 1000)
    Promise.resolve().then(() => start(request)).then(result => {
      uploadId = result.uploadId
      if (!['pending', 'uploading'].includes(result.status)) finish(result)
      else if (early.has(uploadId)) terminal(early.get(uploadId))
      early.clear()
    }).catch(error => finish(null, error))
  })
}
