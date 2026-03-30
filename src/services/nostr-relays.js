import { Relay } from '#helpers/relay.js'
import { maybeUnref } from '#helpers/timer.js'

export const seedRelays = [
  'wss://purplepag.es',
  'wss://user.kindpag.es',
  'wss://relay.nos.social',
  'wss://nostr.land',
  'wss://indexer.coracle.social'
]
export const freeRelays = [
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.damus.io'
]
export const nappRelays = [
  'wss://relay.44billion.net'
]

// Interacts with Nostr relays
export class NostrRelays {
  #relays = new Map()
  #relayTimeouts = new Map()
  #liveSubCounts = new Map() // url -> number of active live subscriptions
  #timeout = 30000 // 30 seconds

  // Get a relay connection, creating one if it doesn't exist
  async #getRelay (url) {
    if (this.#relays.has(url)) {
      // Only reset idle timeout when no live subscriptions are holding this relay open
      if (!this.#liveSubCounts.get(url)) {
        clearTimeout(this.#relayTimeouts.get(url))
        this.#relayTimeouts.set(url, maybeUnref(setTimeout(() => this.disconnect(url), this.#timeout)))
      }
      const relay = this.#relays.get(url)
      // Reconnect if needed to avoid SendingOnClosedConnection errors
      await relay.connect()
      return relay
    }

    const relay = new Relay(url)
    this.#relays.set(url, relay)

    await relay.connect()

    if (!this.#liveSubCounts.get(url)) {
      this.#relayTimeouts.set(url, maybeUnref(setTimeout(() => this.disconnect(url), this.#timeout)))
    }

    return relay
  }

  #incrementLiveSub (url) {
    this.#liveSubCounts.set(url, (this.#liveSubCounts.get(url) ?? 0) + 1)
    // Cancel any pending idle timeout — this relay must stay open
    clearTimeout(this.#relayTimeouts.get(url))
    this.#relayTimeouts.delete(url)
  }

  #decrementLiveSub (url) {
    const next = (this.#liveSubCounts.get(url) ?? 1) - 1
    if (next <= 0) {
      this.#liveSubCounts.delete(url)
      // No more live subscriptions — start the idle timer if the relay is still pooled
      if (this.#relays.has(url)) {
        this.#relayTimeouts.set(url, maybeUnref(setTimeout(() => this.disconnect(url), this.#timeout)))
      }
    } else {
      this.#liveSubCounts.set(url, next)
    }
  }

  // Disconnect from a relay
  async disconnect (url) {
    if (this.#relays.has(url)) {
      const relay = this.#relays.get(url)
      if (relay.ws.readyState < 2) await relay.close()?.catch(console.log)
      this.#relays.delete(url)
      clearTimeout(this.#relayTimeouts.get(url))
      this.#relayTimeouts.delete(url)
    }
  }

  // Disconnect from all relays
  async disconnectAll () {
    for (const url of this.#relays.keys()) {
      await this.disconnect(url)
    }
  }

  // Get events from a list of relays
  async getEvents (filter, relays, { timeout = 5000, callback, signal } = {}) {
    const events = []
    const promises = relays.map(async (url) => {
      let sub
      let isClosed = false
      const p = Promise.withResolvers()

      // Handle abort signal
      if (signal?.aborted) return Promise.reject(new Error('Aborted'))
      const onAbort = () => {
        isClosed = true
        sub?.close()
        p.reject(new Error('Aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      const timer = maybeUnref(setTimeout(() => {
        isClosed = true
        sub?.close()
        p.reject(new Error(`timeout: ${url}`))
      }, timeout))
      try {
        const relay = await this.#getRelay(url)
        if (isClosed || signal?.aborted) { // Double check in case of race
          clearTimeout(timer)
          return p.promise
        }

        sub = relay.subscribe([filter], {
          onevent: (event) => {
            event.meta = { relay: url }
            events.push(event)
            if (callback) callback({ type: 'event', event, relay: url })
          },
          onclose: err => {
            clearTimeout(timer)
            if (isClosed) return
            let reason
            if (err !== undefined) {
              reason = err instanceof Error ? err : new Error(String(err))
              if (callback) callback({ type: 'error', error: reason, relay: url })
            }
            // May have closed normally, without error
            reason ? p.reject(reason) : p.resolve()
          },
          oneose: () => {
            clearTimeout(timer)
            isClosed = true
            sub.close()
            p.resolve()
          }
        })
      } catch (err) {
        clearTimeout(timer)
        if (callback) callback({ type: 'error', error: err, relay: url })
        p.reject(err)
      }

      return p.promise.finally(() => {
        signal?.removeEventListener('abort', onAbort)
      })
    })

    const results = await Promise.allSettled(promises)
    const rejectedResults = results.filter(v => v.status === 'rejected')

    return {
      result: events,
      errors: rejectedResults.map(v => ({ reason: v.reason, relay: relays[results.indexOf(v)] })),
      success: events.length > 0 || results.length !== rejectedResults.length
    }
  }

  // First to reply with EOSE and events should trigger a short timeout for the rest
  async getEventsAsap (filter, relays, { timeout = 5000, timeoutAfterFirstEose = 500, callback, signal } = {}) {
    const subs = new Map()
    const errors = []
    const events = []
    let closedRelaySubs = 0
    let isResolved = false
    let eoseTimer = null
    const p = Promise.withResolvers()

    const finalize = () => {
      if (isResolved) return
      isResolved = true
      clearTimeout(timer)
      if (eoseTimer) clearTimeout(eoseTimer)
      signal?.removeEventListener('abort', onAbort)
      subs.forEach(sub => sub.close())
      p.resolve({
        result: events,
        errors,
        success: events.length > 0 || relays.length !== errors.length
      })
    }

    // Handle abort
    const onAbort = () => {
      if (isResolved) return
      isResolved = true
      clearTimeout(timer)
      if (eoseTimer) clearTimeout(eoseTimer)
      subs.forEach(sub => sub.close())
      p.reject(new Error('Aborted'))
    }

    if (signal?.aborted) return Promise.reject(new Error('Aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })

    const timer = maybeUnref(setTimeout(() => {
      finalize()
    }, timeout))

    const markClosedAndMaybeFinish = () => {
      closedRelaySubs += 1
      if (!isResolved && closedRelaySubs >= relays.length) {
        finalize()
      }
    }

    for (const url of relays) {
      this.#getRelay(url).then(relay => {
        if (isResolved) return
        let hasEvents = false

        const sub = relay.subscribe([filter], {
          onevent: (event) => {
            if (isResolved) return
            hasEvents = true
            event.meta = { relay: url }
            events.push(event)
            if (callback) callback({ type: 'event', event, relay: url })
          },
          onclose: (err) => {
            subs.delete(url)
            if (err !== undefined) {
              const reason = err instanceof Error ? err : new Error(String(err))
              errors.push({ reason, relay: url })
              if (callback) callback({ type: 'error', error: reason, relay: url })
            }
            markClosedAndMaybeFinish()
          },
          oneose: () => {
            sub.close()
            if (hasEvents && !eoseTimer && !isResolved) {
              eoseTimer = maybeUnref(setTimeout(() => {
                finalize()
              }, timeoutAfterFirstEose))
            }
          }
        })
        subs.set(url, sub)
      }).catch(error => {
        errors.push({ reason: error, relay: url })
        if (callback) callback({ type: 'error', error, relay: url })
        console.error(`Nostr relay error at ${url}: ${error}`)
        markClosedAndMaybeFinish()
      })
    }

    return p.promise
  }

  async * getEventsGenerator (filter, relays, options = {}) {
    const queue = []
    let p = Promise.withResolvers()
    let isDone = false

    const userCallback = options.callback
    const callback = item => {
      queue.push(item)
      if (userCallback) userCallback(item)
      p.resolve()
      p = Promise.withResolvers()
    }

    const methodPromise = this.getEvents(filter, relays, { ...options, callback })
      .catch(err => { if (err?.message !== 'Aborted') console.error('Error in getEvents:', err) })
      .finally(() => {
        isDone = true
        p.resolve()
      })

    // eslint-disable-next-line no-unmodified-loop-condition
    while (!isDone || queue.length > 0) {
      if (queue.length > 0) yield queue.shift()
      else await p.promise
    }

    return await methodPromise
  }

  async * getEventsAsapGenerator (filter, relays, options = {}) {
    const queue = []
    let p = Promise.withResolvers()
    let isDone = false

    const userCallback = options.callback
    const callback = item => {
      queue.push(item)
      if (userCallback) userCallback(item)
      p.resolve()
      p = Promise.withResolvers()
    }

    const methodPromise = this.getEventsAsap(filter, relays, { ...options, callback })
      .catch(err => { if (err?.message !== 'Aborted') console.error('Error in getEventsAsap:', err) })
      .finally(() => {
        isDone = true
        p.resolve()
      })

    // eslint-disable-next-line no-unmodified-loop-condition
    while (!isDone || queue.length > 0) {
      if (queue.length > 0) yield queue.shift()
      else await p.promise
    }

    return await methodPromise
  }

  // Yields nostr events from the given relays indefinitely until the signal is aborted
  // or the caller exits the for-await loop. Handles three concerns internally:
  //
  // 1. Initial gap fill: if filter.since is a positive timestamp, fetches stored events
  //    from that point up to now before the live stream starts (dual-sub pattern).
  // 2. Live stream: a limit:0 sub keeps the relay connection open after EOSE so future
  //    events are delivered in real time.
  // 3. Reconnect gap fill: on each reconnect, fetches events missed since the last
  //    event seen, with exponential backoff (1s → 5 min cap).
  //
  // Events that could overlap between the gap-fill and live subs are deduplicated.
  async * getLiveEventsGenerator (filter, relays, { signal, timeoutAfterFirstEose = 500 } = {}) {
    const queue = []
    let p = Promise.withResolvers()
    let isDone = false
    const subs = new Map()
    const activeGapSubs = new Set()
    let gapEoseTimer = null

    // Strip time-range fields — we manage them internally
    const baseFilter = { ...filter }
    delete baseFilter.since
    delete baseFilter.until

    // lastSeenAt: the highest created_at received so far; used as gapSince on reconnect
    let lastSeenAt = (filter.since > 0) ? filter.since : null

    // Bounded dedup set to handle events that could arrive from both gap-fill and live subs
    const seenIds = new Set()

    const closeAllGapSubs = () => {
      clearTimeout(gapEoseTimer)
      gapEoseTimer = null
      activeGapSubs.forEach(sub => sub.close())
      activeGapSubs.clear()
    }

    const teardown = () => {
      isDone = true
      closeAllGapSubs()
      subs.forEach(sub => sub.close())
      subs.clear()
      p.resolve()
    }

    const pushEvent = (event, url) => {
      if (isDone || seenIds.has(event.id)) return
      if (seenIds.size >= 500) seenIds.delete(seenIds.values().next().value) // evict oldest
      seenIds.add(event.id)
      if (event.created_at > (lastSeenAt ?? 0)) lastSeenAt = event.created_at
      event.meta = { relay: url }
      queue.push(event)
      p.resolve()
      p = Promise.withResolvers()
    }

    if (signal?.aborted) return
    signal?.addEventListener('abort', teardown, { once: true })

    const subscribeToRelay = (url, gapSince, reconnectDelay = 1000) => {
      const now = Math.floor(Date.now() / 1000)
      this.#getRelay(url).then(relay => {
        if (isDone) return

        // Open the live sub first so the relay starts buffering future events
        // before we ask it to scan its database for the gap fill
        const liveSub = relay.subscribe([{ ...baseFilter, since: now, limit: 0 }], {
          onevent: (event) => pushEvent(event, url),
          onclose: () => {
            subs.delete(url)
            if (isDone) return
            const delay = reconnectDelay
            setTimeout(
              () => subscribeToRelay(url, lastSeenAt, Math.min(reconnectDelay * 2, 5 * 60_000)),
              delay
            )
          },
          oneose: () => { /* keep open for live events */ }
        })
        if (isDone) { liveSub.close(); return }
        subs.set(url, liveSub)

        // Gap-fill sub: fetches stored events in [gapSince, now], closes after EOSE.
        // If timeoutAfterFirstEose is set, the first relay to EOSE with events starts a
        // short timer that closes all still-open gap subs (asap behaviour); null waits
        // for every relay to EOSE naturally.
        if (gapSince !== null && gapSince > 0) {
          let gapHadEvents = false
          const gapSub = relay.subscribe([{ ...baseFilter, since: gapSince, until: now }], {
            onevent: (event) => {
              gapHadEvents = true
              pushEvent(event, url)
            },
            oneose: () => {
              activeGapSubs.delete(gapSub)
              gapSub.close()
              if (gapHadEvents && timeoutAfterFirstEose !== null && !gapEoseTimer && activeGapSubs.size > 0) {
                gapEoseTimer = setTimeout(closeAllGapSubs, timeoutAfterFirstEose)
              } else if (activeGapSubs.size === 0) {
                clearTimeout(gapEoseTimer)
                gapEoseTimer = null
              }
            },
            onclose: () => { activeGapSubs.delete(gapSub) }
          })
          activeGapSubs.add(gapSub)
        }
      }).catch(err => {
        if (isDone) return
        console.error(`Live subscription error at ${url}:`, err)
        const delay = reconnectDelay
        setTimeout(
          () => subscribeToRelay(url, lastSeenAt, Math.min(reconnectDelay * 2, 5 * 60_000)),
          delay
        )
      })
    }

    for (const url of relays) {
      this.#incrementLiveSub(url)
      subscribeToRelay(url, (filter.since > 0) ? filter.since : null)
    }

    try {
      // eslint-disable-next-line no-unmodified-loop-condition
      while (!isDone || queue.length > 0) {
        if (queue.length > 0) yield queue.shift()
        else await p.promise
      }
    } finally {
      signal?.removeEventListener('abort', teardown)
      for (const url of relays) this.#decrementLiveSub(url)
      teardown()
    }
  }

  // Send an event to a list of relays
  async sendEvent (event, relays, timeout = 3000) {
    const eventToSend = event.meta ? { ...event } : event
    if (eventToSend.meta) delete eventToSend.meta

    const promises = relays.map(async (url) => {
      let timer
      const p = Promise.withResolvers()
      try {
        timer = maybeUnref(setTimeout(() => {
          p.reject(new Error(`timeout: ${url}`))
        }, timeout))

        const relay = await this.#getRelay(url)
        await relay.publish(eventToSend)
        p.resolve()
      } catch (err) {
        const reason = err instanceof Error ? err : new Error(String(err))
        if (reason.message.startsWith('duplicate:')) return p.resolve()
        if (reason.message.startsWith('mute:')) {
          console.info([url, reason.message].filter(Boolean).join(' - '))
          return p.resolve()
        }
        p.reject(reason)
      } finally {
        clearTimeout(timer)
      }
      return p.promise
    })

    const results = await Promise.allSettled(promises)
    const rejectedResults = results.filter(v => v.status === 'rejected')

    return {
      result: null,
      errors: rejectedResults.map(v => ({ reason: v.reason, relay: relays[results.indexOf(v)] })),
      success: results.length !== rejectedResults.length
    }
  }
}

// Share same connection
// Connections aren't authenticated, thus no need to split by authed user
export default new NostrRelays()
