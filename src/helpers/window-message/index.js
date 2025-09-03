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
  const timeout = setTimeout(() => {
    resrejByReqId[reqId]?.reject?.(`Timeout for ${code} reqId: ${reqId}`)
  }, timeoutMs)
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

  if (e.data.error) resrej.reject(e.data.error)
  else resrej.resolve({ payload: e.data.payload, isLast: e.data.isLast ?? true, ports: e.ports })
}
export const initReplyListener = ((
  isPort,
  hasRunKey,
  hasRunByKey = new WeakMap(),
  listenerRegistry = new FinalizationRegistry(controller => controller.abort())
) => maybePort => {
  isPort = maybePort instanceof MessagePort
  hasRunKey = maybePort instanceof MessagePort ? maybePort : globalThis // (window or sw's self)
  if (hasRunByKey.has(hasRunKey)) return

  const controller = new AbortController()
  hasRunByKey.set(hasRunKey, controller)
  hasRunKey.addEventListener('message', async e => {
    if (e.data.code === 'REPLY') return handleMessageReply(e)
  }, { signal: controller.signal })
  if (isPort) hasRunKey.start()
  listenerRegistry.register(hasRunKey, controller)
})()
export async function requestMessage (to, message, options, transfer) {
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
    .then(({ payload, ports }) => ({
      code: message.code,
      payload,
      ports
    }))
    .catch(error => ({
      code: message.code,
      payload: null,
      error
    }))
}
export function replyWithMessage (originalMsgEvent, message, options, transfer) {
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
export function postMessage (to, message, options, transfer) {
  if (!message.code || (!('payload' in message) && !('error' in message))) throw new Error('Missing args')
  if (!options || typeof options !== 'object') options = { targetOrigin: options, transfer }
  to.postMessage(message, options)
}

export async function * requestMultipleMessages (to, message, options, transfer) {
  if (!message.code && !('payload' in message)) throw new Error('Missing args')
  if (!options || typeof options !== 'object') options = { targetOrigin: options, transfer }

  initReplyListener(to)
  const reqId = getReqId()
  const messageQueue = []
  let resolvePromise

  const waitForNextMessage = () => {
    return new Promise(resolve => {
      resolvePromise = resolve
    })
  }

  resrejByReqId[reqId] = {
    resolve: ({ payload, isLast = true }) => {
      messageQueue.push({ payload, isLast })
      if (resolvePromise) resolvePromise()
    },
    reject: error => {
      messageQueue.push({ error })
      if (resolvePromise) resolvePromise()
    }
  }

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
    delete resrejByReqId[reqId]
  }
}
