import { Relay } from 'nostr-tools/relay'
import { maybeUnref } from '#helpers/timer.js'

export const seedRelays = [
  'wss://purplepag.es',
  'wss://user.kindpag.es',
  'wss://relay.nos.social',
  'wss://relay.nostr.band',
  'wss://nostr.land',
  'wss://indexer.coracle.social'
]
export const freeRelays = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.primal.net'
]

// Interacts with Nostr relays
export class NostrRelays {
  #relays = new Map()
  #relayTimeouts = new Map()
  #timeout = 30000 // 30 seconds

  // Get a relay connection, creating one if it doesn't exist
  async #getRelay (url) {
    if (this.#relays.has(url)) {
      clearTimeout(this.#relayTimeouts.get(url))
      this.#relayTimeouts.set(url, maybeUnref(setTimeout(() => this.disconnect(url), this.#timeout)))
      return this.#relays.get(url)
    }

    const relay = new Relay(url)
    this.#relays.set(url, relay)

    await relay.connect()

    this.#relayTimeouts.set(url, maybeUnref(setTimeout(() => this.disconnect(url), this.#timeout)))

    return relay
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
  async getEvents (filter, relays, timeout = 5000) {
    const events = []
    const promises = relays.map(async (url) => {
      try {
        const relay = await this.#getRelay(url)
        return new Promise((resolve) => {
          const sub = relay.subscribe([filter], {
            onevent: (event) => {
              events.push(event)
            },
            onclose: () => {
              clearTimeout(timer)
              resolve()
            },
            oneose: () => {
              clearTimeout(timer)
              resolve()
            }
          })
          const timer = maybeUnref(setTimeout(() => {
            sub.close()
            resolve()
          }, timeout))
        })
      } catch (error) {
        console.error(`Failed to get events from ${url}`, error)
      }
    })

    const results = await Promise.allSettled(promises)
    if (results.some(v => v.status === 'rejected')) throw new Error(results[0].reason)
    return events
  }

  // Considering write relays should be synced, first to reply
  // should be picked and the rest unsubscribed
  async getEventsAsap (filter, relays, timeout = 5000) {
    return new Promise((resolve) => {
      const subs = new Map()
      let winner = null

      const timer = maybeUnref(setTimeout(() => {
        subs.forEach(sub => sub.close())
        resolve([])
      }, timeout))

      let closedRelaySubs = 0
      for (const url of relays) {
        this.#getRelay(url).then(relay => {
          if (winner) return

          const events = []
          const sub = relay.subscribe([filter], {
            onevent: (event) => {
              if (!winner) {
                winner = sub
                // Close other subs
                subs.forEach(s => { if (s !== winner) s.close() })
                clearTimeout(timer)
              }

              if (sub === winner) {
                events.push(event)
              }
            },
            onclose: () => {
              if ((++closedRelaySubs).length < relays.length) return

              clearTimeout(timer)
              resolve(events)
            },
            oneose: () => {
              if (sub === winner) {
                clearTimeout(timer)
                resolve(events)
              }
              sub.close()
            }
          })
          subs.set(url, sub)
        }).catch(error => {
          console.error(`Nostr relay error at ${url}: ${error}`)
        })
      }
    })
  }

  // Send an event to a list of relays
  async sendEvent (event, relays, timeout = 3000) {
    const promises = relays.map(async (url) => {
      try {
        const relay = await this.#getRelay(url)
        const timer = maybeUnref(setTimeout(() => {
          throw new Error(`Timeout sending event to ${url}`)
        }, timeout))
        await relay.publish(event)
        clearTimeout(timer)
      } catch (error) {
        console.error(`Failed to send event to ${url}`, error)
      }
    })

    const results = await Promise.allSettled(promises)
    if (results.some(v => v.status === 'rejected')) throw new Error(results[0].reason)
  }
}

// Share same connection
// Connections aren't authenticated, thus no need to split by authed user
export default new NostrRelays()
