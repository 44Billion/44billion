import { RelayPool } from 'libp2r2p/relay'

export function accountRelayFixture ({ events = [], beforeRead = async () => {}, autoLive = true } = {}) {
  const calls = []
  const subscriptions = []
  let peak = 0
  const matches = (event, filter) => filter.authors.includes(event.pubkey) && filter.kinds.includes(event.kind) && event.created_at >= (filter.since ?? 0) && event.created_at <= (filter.until ?? Infinity)
  const pool = new RelayPool({
    _createRelay: relay => ({
      ws: { readyState: 1 },
      async connect () {},
      async close () { this.ws.readyState = 3 },
      subscribe ([filter], handlers) {
        const sub = { relay, filter, handlers, closed: false, close () { if (!this.closed) { this.closed = true; handlers.onclose() } } }
        subscriptions.push(sub)
        peak = Math.max(peak, subscriptions.filter(sub => !sub.closed).length)
        if (filter.limit === 0) {
          if (autoLive) queueMicrotask(() => { if (!sub.closed) handlers.oneose() })
        } else {
          calls.push({ relay, filter })
          Promise.resolve().then(() => beforeRead(filter, relay)).then(() => {
            if (sub.closed) return
            for (const event of events.filter(event => matches(event, filter)).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)).slice(0, filter.limit)) {
              if (sub.closed) break
              handlers.onevent(event)
            }
            if (!sub.closed) handlers.oneose()
          }).catch(error => { if (!sub.closed) { sub.closed = true; handlers.onclose(error) } })
        }
        return sub
      }
    })
  })
  return {
    pool, calls, subscriptions, get peak () { return peak },
    emit (event) {
      events.push(event)
      for (const sub of subscriptions) if (!sub.closed && sub.filter.limit === 0 && matches(event, sub.filter)) sub.handlers.onevent(event)
    }
  }
}
