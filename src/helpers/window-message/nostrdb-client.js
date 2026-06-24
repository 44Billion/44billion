import { ask, askStream, tell } from './index.js'
import {
  isNostrDbStreamDonePayload,
  NOSTRDB_ONE_SHOT_METHODS
} from './nostrdb-protocol.js'

const DEFAULT_TIMEOUT = 5 * 60 * 1000

function defaultSubscriptionId () {
  return `${Date.now()}:${Math.random().toString(36).slice(2)}`
}

function createNostrDbMethod (browserPortPromise, method, { ask: askFn, timeout }) {
  return async (...params) => {
    const browserPort = await browserPortPromise
    const { payload, error } = await askFn(
      browserPort,
      { code: 'NOSTRDB', payload: { method, params } },
      { timeout }
    )
    if (error) throw error
    return payload
  }
}

function createNostrDbSubscription (browserPortPromise, params, {
  askStream: askStreamFn,
  tell: tellFn,
  subscriptionId
}) {
  let browserPort
  let streamIterator
  let started = false

  async function start () {
    if (started) return
    started = true
    browserPort = await browserPortPromise
    streamIterator = askStreamFn(
      browserPort,
      { code: 'NOSTRDB', payload: { method: 'subscribe', params, subscriptionId } },
      { timeout: null }
    )[Symbol.asyncIterator]()
  }

  return {
    [Symbol.asyncIterator] () {
      return this
    },
    async next () {
      await start()
      const next = await streamIterator.next()
      if (next.done) return { done: true }
      const { payload, error } = next.value
      if (error) throw error
      if (isNostrDbStreamDonePayload(payload, subscriptionId)) return { done: true }
      return { value: payload, done: false }
    },
    async return () {
      if (started && browserPort) {
        tellFn(browserPort, { code: 'NOSTRDB_CANCEL', payload: { subscriptionId } })
        await streamIterator?.return?.()
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
  timeout = DEFAULT_TIMEOUT
} = {}) {
  const nostrdb = {}
  for (const method of NOSTRDB_ONE_SHOT_METHODS) {
    nostrdb[method] = createNostrDbMethod(browserPortPromise, method, { ask: askFn, timeout })
  }
  nostrdb.subscribe = (...params) => createNostrDbSubscription(browserPortPromise, params, {
    askStream: askStreamFn,
    tell: tellFn,
    subscriptionId: makeSubscriptionId()
  })
  return nostrdb
}
