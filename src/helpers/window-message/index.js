import { reviveError } from '#helpers/error.js'
const isDev = !!IS_DEVELOPMENT
const protocol = isDev ? 'http://' : 'https://'
const browserDomain = isDev ? 'localhost:10000' : '44billion.net'
export const browserOrigin = `${protocol}${browserDomain}`
export function getAppOrigin (appSubdomain) {
  return `${protocol}${appSubdomain}.${browserDomain}`
}
export function getAppSwOrigin (...args) { return getAppOrigin(...args) }

const resrejByReqId = {}
function getReqId () { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) }
function initReqPromise (reqId, code, timeoutMs = 5000) {
  if (!reqId || !code) throw new Error('Missing request id or code')
  const { promise, resolve, reject } = Promise.withResolvers()
  resrejByReqId[reqId] = {
    resolve,
    reject
  }
  let timeout
  if (timeoutMs != null) { // null or undefined = no timeout
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        resrejByReqId[reqId]?.reject?.(`Timeout for ${code} reqId: ${reqId}`)
      }, timeoutMs)
    } else resrejByReqId[reqId]?.reject?.(`Timeout for ${code} reqId: ${reqId}`)
  }
  return promise.finally(() => {
    clearTimeout(timeout)
    delete resrejByReqId[reqId]
  })
}
export function handleMessageReply (e) {
  const resrej = resrejByReqId[e.data.reqId]
  // Unhandled response for reqId undefined (may have timed out)
  if (!resrej) {
    console.log(`Unhandled response for reqId ${e.data.reqId} (may have timed out)`, JSON.stringify(e.data))
    return
  }

  if (e.data.error) resrej.reject(reviveError(e.data.error))
  else resrej.resolve({ payload: e.data.payload, isLast: e.data.isLast ?? true, ports: e.ports, origin: e.origin })
}
export const initReplyListener = ((
  hasRunKey,
  hasRunByKey = new WeakMap(),
  listenerRegistry = new FinalizationRegistry(controller => controller.abort())
) => maybePort => {
  const isPort = maybePort instanceof MessagePort
  hasRunKey = isPort ? maybePort : globalThis // (window or sw's self)
  if (hasRunByKey.has(hasRunKey)) return

  const controller = new AbortController()
  hasRunByKey.set(hasRunKey, controller)
  hasRunKey.addEventListener('message', async e => {
    if (e.data.code === 'REPLY') return handleMessageReply(e)
  }, { signal: controller.signal })
  if (isPort) hasRunKey.start()
  listenerRegistry.register(hasRunKey, controller)
})()
export async function ask (to, message, options, transfer) {
  if (!message.code && !('payload' in message)) throw new Error('Missing args')
  if (!options || typeof options !== 'object') options = { targetOrigin: options, transfer }

  initReplyListener(to)
  const reqId = getReqId()
  const promise = initReqPromise(reqId, message.code, options.timeout)
  to.postMessage({
    ...message,
    reqId
  }, options)
  return promise
    .then(({ payload, ports, origin }) => ({
      code: message.code,
      payload,
      ports,
      origin
    }))
    .catch(error => ({
      code: message.code,
      payload: null,
      error
    }))
}
export function reply (originalMsgEvent, message, options, transfer) {
  if ((!('payload' in message) && !('error' in message))) throw new Error('Missing args')
  if (!options || typeof options !== 'object') options = { targetOrigin: options, transfer }
  options.targetOrigin ??= originalMsgEvent.origin
  if (!options.to && !originalMsgEvent.source) throw new Error('Set port to options.to')
  options.to ??= originalMsgEvent.source
  options.to.postMessage({
    ...message,
    reqId: originalMsgEvent.data.reqId,
    code: 'REPLY'
  }, options)
}
export function tell (to, message, options, transfer) {
  if (!message.code || (!('payload' in message) && !('error' in message))) throw new Error('Missing args')
  if (!options || typeof options !== 'object') options = { targetOrigin: options, transfer }
  to.postMessage(message, options)
}

export async function * askStream (to, message, options, transfer) {
  if (!message.code && !('payload' in message)) throw new Error('Missing args')
  if (!options || typeof options !== 'object') options = { targetOrigin: options, transfer }

  initReplyListener(to)
  const reqId = getReqId()
  const messageQueue = []
  let resolvePromise
  let firstResponseReceived = false
  let firstReplyTimer = null
  let idleTimer = null

  const waitForNextMessage = () => {
    return new Promise(resolve => {
      resolvePromise = resolve
    })
  }

  const streamTimeoutError = error => Object.assign(
    new Error(error?.message || 'Message stream timed out'),
    { code: 'STREAM_TIMEOUT' }
  )

  const clearTimers = () => {
    if (firstReplyTimer) clearTimeout(firstReplyTimer)
    firstReplyTimer = null
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }

  const scheduleIdleTimer = () => {
    if (!firstResponseReceived) return
    if (idleTimer) clearTimeout(idleTimer)
    const idleTimeoutMs = options.idleTimeoutMs
    if (typeof idleTimeoutMs === 'number' && idleTimeoutMs > 0) {
      idleTimer = setTimeout(() => pushError(new Error('Message stream idle timed out')), idleTimeoutMs)
    }
  }

  const pushError = error => {
    clearTimers()
    const entry = { error: streamTimeoutError(error), isLast: true }
    messageQueue.push(entry)
    resolvePromise?.()
  }

  resrejByReqId[reqId] = {
    resolve: ({ payload, isLast = true }) => {
      if (!firstResponseReceived) {
        firstResponseReceived = true
        if (firstReplyTimer) clearTimeout(firstReplyTimer)
        firstReplyTimer = null
        scheduleIdleTimer()
      } else {
        scheduleIdleTimer()
      }
      messageQueue.push({ payload, isLast })
      if (resolvePromise) resolvePromise()
    },
    reject: error => {
      clearTimers()
      messageQueue.push({ error })
      if (resolvePromise) resolvePromise()
    }
  }

  const timeoutMs = options.timeoutMs
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    firstReplyTimer = setTimeout(() => pushError(new Error('Message stream timed out')), timeoutMs)
  }
  const onAbort = () => pushError(new Error('Message stream aborted'))
  options.signal?.addEventListener('abort', onAbort, { once: true })

  to.postMessage({
    ...message,
    reqId
  }, options)

  let payload, error
  let isLast = false
  try {
    while (!isLast) {
      if (messageQueue.length === 0) await waitForNextMessage()
      while (messageQueue.length > 0) {
        ({ payload, error, isLast } = messageQueue.shift())
        if (error) yield { code: message.code, payload: null, error }
        else yield { code: message.code, payload }
      }
    }
  } finally {
    clearTimers()
    options.signal?.removeEventListener('abort', onAbort)
    delete resrejByReqId[reqId]
  }
}
