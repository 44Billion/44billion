import { ask, askStream, tell } from './index.js'
import {
  isNostrDbStreamDonePayload,
  NOSTRDB_ONE_SHOT_METHODS,
  NOSTRDB_ONESHOT_TIMEOUT_MS,
  NOSTRDB_REQUEST_TIMEOUT,
  NOSTRDB_SUPPORTS_TIMEOUT_MS
} from './nostrdb-protocol.js'

function defaultSubscriptionId () {
  return `${Date.now()}:${Math.random().toString(36).slice(2)}`
}

function createNostrDbMethod (browserPortPromise, method, { ask: askFn, tell: tellFn, timeout, context }) {
  return async (...params) => {
    const browserPort = await browserPortPromise
    const methodTimeout = method === 'supports'
      ? Math.min(timeout, NOSTRDB_SUPPORTS_TIMEOUT_MS)
      : timeout
    const { payload, error } = await askFn(
      browserPort,
      {
        code: 'NOSTRDB',
        payload: { ...context, method, params, deadlineAt: Date.now() + methodTimeout }
      },
      {
        timeout: methodTimeout,
        onCancel: requestId => {
          try { tellFn(browserPort, { code: 'NOSTRDB_CANCEL', payload: { requestId } }) } catch {}
        }
      }
    )
    if (error) {
      if (typeof error === 'string' && error.startsWith('Timeout for NOSTRDB')) {
        throw Object.assign(new Error(NOSTRDB_REQUEST_TIMEOUT), { code: NOSTRDB_REQUEST_TIMEOUT })
      }
      throw error
    }
    return payload
  }
}

function createNostrDbSubscription (browserPortPromise, params, {
  askStream: askStreamFn,
  tell: tellFn,
  subscriptionId,
  context
}) {
  let browserPort
  let streamIterator
  let startPromise
  let closed = false

  // Cancelling before the handshake must not create a remote subscription later.
  function start () {
    startPromise ??= (async () => {
      browserPort = await browserPortPromise
      if (closed) return
      streamIterator = askStreamFn(
        browserPort,
        { code: 'NOSTRDB', payload: { ...context, method: 'subscribe', params, subscriptionId } },
        { timeout: null }
      )[Symbol.asyncIterator]()
    })()
    return startPromise
  }

  return {
    [Symbol.asyncIterator] () {
      return this
    },
    async next () {
      if (closed) return { done: true }
      try {
        await start()
        if (closed) return { done: true }
        const next = await streamIterator.next()
        if (closed) return { done: true }
        if (!next.done) {
          const { payload, error } = next.value
          if (error) throw error
          if (!isNostrDbStreamDonePayload(payload, subscriptionId)) return { value: payload, done: false }
        }
        closed = true
        await streamIterator.return?.()
        return { done: true }
      } catch (error) {
        closed = true
        await streamIterator?.return?.()
        throw error
      }
    },
    async return () {
      if (closed) return { done: true }
      closed = true
      if (streamIterator) {
        tellFn(browserPort, { code: 'NOSTRDB_CANCEL', payload: { subscriptionId } })
        await streamIterator.return?.()
      }
      return { done: true }
    }
  }
}

export function createNostrDb (browserPortPromise, {
  ask: askFn = ask,
  askStream: askStreamFn = askStream,
  tell: tellFn = tell,
  makeSubscriptionId = defaultSubscriptionId,
  timeout = NOSTRDB_ONESHOT_TIMEOUT_MS,
  context = {}
} = {}) {
  const nostrdb = {}
  for (const method of NOSTRDB_ONE_SHOT_METHODS) {
    nostrdb[method] = createNostrDbMethod(browserPortPromise, method, {
      ask: askFn, tell: tellFn, timeout, context
    })
  }
  nostrdb.subscribe = (...params) => createNostrDbSubscription(browserPortPromise, params, {
    askStream: askStreamFn,
    tell: tellFn,
    subscriptionId: makeSubscriptionId(),
    context
  })
  return nostrdb
}

export function injectEventStore (target, browserPortPromise, options) {
  const eventStore = createNostrDb(browserPortPromise, options)
  Object.assign(target.napp, {
    eventStore,
    // Membership is checked by the launcher on each call, not when creating the object.
    getWindowNappEventStoreFor: pubkey => createNostrDb(browserPortPromise, {
      ...options,
      context: { userPk: pubkey }
    })
  })
  return eventStore
}
