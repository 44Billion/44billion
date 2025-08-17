const isDev = !!window.IS_DEVELOPMENT
const protocol = isDev ? 'http://' : 'https://'
const browserDomain = isDev ? 'localhost:10000' : '44billion.net'
export const browserOrigin = `${protocol}${browserDomain}`
export function getAppOrigin (appSubdomain) {
  return `${protocol}${appSubdomain}.${browserDomain}`
}
export function getUserPageOrigin (userPk) {
  return `${protocol}u${userPk}.${browserDomain}`
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
  if (!resrej) return console.log(`Unhandled response for reqId ${e.data.reqId} (may have timed out)`)

  if (e.data.error) resrej.reject(e.data.error)
  else resrej.resolve({ payload: e.data.payload, isLast: e.data.isLast ?? true })
}
export const initReplyListener = (hasRun => () => {
  if (hasRun) return
  (hasRun = true) && globalThis.addEventListener('message', async e => {
    if (e.data.code === 'REPLY') return handleMessageReply(e)
  })
})()
export async function requestMessage (to, message, options, transfer) {
  initReplyListener()
  if (!message.code && !('payload' in message)) throw new Error('Missing args')
  if (options && typeof options !== 'object') options = { targetOrigin: options, transfer }

  const reqId = getReqId()
  const promise = initReqPromise(reqId, message.code, options.timeout)
  to.postMessage({
    ...message,
    reqId
  }, options)
  return promise
    .then(({ payload }) => ({
      code: message.code,
      payload
    }))
    .catch(error => ({
      code: message.code,
      payload: null,
      error
    }))
}
export async function replyWithMessage (originalMsgEvent, message, options, transfer) {
  if ((!('payload' in message) && !('error' in message))) throw new Error('Missing args')
  if (options && typeof options !== 'object') options = { targetOrigin: options, transfer }
  options.targetOrigin ??= originalMsgEvent.origin
  options.to ??= originalMsgEvent.source
  options.to.postMessage({
    ...message,
    reqId: originalMsgEvent.data?.payload?.reqId,
    code: 'REPLY'
  }, options)
}
export async function postMessage (to, message, options, transfer) {
  if (!message.code || (!('payload' in message) && !('error' in message))) throw new Error('Missing args')
  if (options && typeof options !== 'object') options = { targetOrigin: options, transfer }
  to.postMessage(message, options)
}

export async function * requestMultipleMessages (to, message, options, transfer) {
  initReplyListener()
  if (!message.code && !('payload' in message)) throw new Error('Missing args')
  if (options && typeof options !== 'object') options = { targetOrigin: options, transfer }

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
      while (messageQueue.length > 0) {
        ({ payload, error, isLast } = messageQueue.shift())
        if (error) yield { code: message.code, payload: null, error }
        else yield { code: message.code, payload }
      }
      await waitForNextMessage()
    }
  } finally {
    delete resrejByReqId[reqId]
  }
}
