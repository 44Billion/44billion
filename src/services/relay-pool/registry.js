import { normalizeRelayUrl } from 'libp2r2p/url'

function normalizeKey (url) {
  if (typeof url !== 'string' || url.length === 0) return null
  try {
    return normalizeRelayUrl(url)
  } catch {
    return null
  }
}

function insecureTwin (url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'wss:') parsed.protocol = 'ws:'
    else if (parsed.protocol === 'ws:') parsed.protocol = 'wss:'
    else return null
    return normalizeKey(parsed.href)
  } catch {
    return null
  }
}

// Session-scoped relay URL registry. The launcher owns the authoritative copy
// and broadcasts it to app pages, so a URL classified once is recognized by
// every later connection without another round trip.
export class RelayRegistry {
  #relays = new Set()
  #nonRelays = new Map()
  #listeners = new Set()

  constructor (relays = []) {
    for (const relay of relays) this.addRelay(relay)
  }

  addRelay (url) {
    const key = normalizeKey(url)
    if (!key || this.#relays.has(key)) return false
    this.#relays.add(key)
    this.#nonRelays.delete(key)
    this.#emit()
    return true
  }

  hasRelay (url) {
    const key = normalizeKey(url)
    if (!key) return false
    if (this.#relays.has(key)) return true
    const twin = insecureTwin(key)
    return twin !== null && this.#relays.has(twin)
  }

  addNonRelay (url, ttlMs) {
    const key = normalizeKey(url)
    if (!key) return false
    this.#nonRelays.set(key, Date.now() + ttlMs)
    return true
  }

  isNonRelay (url) {
    const key = normalizeKey(url)
    if (!key) return false
    const expiresAt = this.#nonRelays.get(key)
    if (expiresAt === undefined) return false
    if (expiresAt <= Date.now()) {
      this.#nonRelays.delete(key)
      return false
    }
    return true
  }

  urls () {
    return [...this.#relays]
  }

  subscribe (listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit () {
    const urls = this.urls()
    for (const listener of this.#listeners) {
      try {
        listener(urls)
      } catch {}
    }
  }
}
