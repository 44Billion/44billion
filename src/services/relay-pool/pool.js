import { isValidEvent } from 'libp2r2p/event'
import { normalizeRelayUrl } from 'libp2r2p/url'

import { parseNostrFrame } from './classify.js'
import { RELAY_POOL_LIMITS } from './constants.js'
import { RelayRegistry } from './registry.js'

class LruSet {
  #limit
  #ttlMs
  #entries = new Map()

  constructor (limit, ttlMs) {
    this.#limit = limit
    this.#ttlMs = ttlMs
  }

  has (key) {
    const seenAt = this.#entries.get(key)
    if (seenAt === undefined) return false
    if (Date.now() - seenAt > this.#ttlMs) {
      this.#entries.delete(key)
      return false
    }
    return true
  }

  add (key) {
    this.#entries.delete(key)
    this.#entries.set(key, Date.now())
    while (this.#entries.size > this.#limit) this.#entries.delete(this.#entries.keys().next().value)
  }
}

function bucketKey (url, identity) {
  return `${url}\u0000${identity ?? ''}`
}

// Launcher-owned relay multiplexer. One physical WebSocket per bucket is
// shared by many virtual sockets; subscription ids are namespaced per virtual
// socket and rewritten on the way back.
export class UnifiedRelayPool {
  #createSocket
  #registry
  #limits
  #log
  #members = new Map()
  #buckets = new Map()
  #bucketsByUrl = new Map()
  #pendingMembers = []
  #connectionQueue = []
  #connectionTimesByHost = new Map()
  #connectionTimer = null
  #quarantined = new Map()
  #consolidating = new Set()
  #anonymousConsolidationAt = new Map()
  #serial = 0
  #counters = {
    physicalOpened: 0,
    physicalClosed: 0,
    bucketsCreated: 0,
    membersAttached: 0,
    framesIn: 0,
    framesOut: 0,
    migrations: 0,
    detaches: 0,
    quarantines: 0,
    droppedFrames: 0,
    droppedByOp: {},
    capacityRejections: 0,
    consolidations: 0,
    authSwaps: 0,
    authMerges: 0,
    authReconnects: 0,
    authRejected: 0
  }

  constructor ({
    createSocket,
    registry = new RelayRegistry(),
    limits = RELAY_POOL_LIMITS,
    log = () => {}
  } = {}) {
    if (typeof createSocket !== 'function') throw new Error('RELAY_POOL_SOCKET_FACTORY_REQUIRED')
    this.#createSocket = createSocket
    this.#registry = registry
    this.#limits = limits
    this.#log = log
  }

  get registry () {
    return this.#registry
  }

  isQuarantined (url) {
    const key = this.#normalize(url)
    if (!key) return false
    const until = this.#quarantined.get(key)
    if (until === undefined) return false
    if (until <= Date.now()) {
      this.#quarantined.delete(key)
      return false
    }
    return true
  }

  quarantine (url, reason) {
    const key = this.#normalize(url)
    if (!key) return
    if (!this.#quarantined.has(key)) this.#counters.quarantines++
    this.#quarantined.set(key, Date.now() + this.#limits.quarantineMs)
    this.#log('[relay-pool] quarantined', key, reason ?? '')
  }

  attach (url, handlers = {}) {
    const key = this.#normalize(url)
    if (!key) throw new Error('INVALID_RELAY_URL')
    const member = {
      id: `m${++this.#serial}`,
      url: key,
      nsPrefix: `rp${this.#serial}:`,
      handlers,
      bucket: null,
      subscriptions: new Map(), // nsId -> { rawId, message }
      rawSubscriptions: new Map(), // rawId -> nsId
      counts: new Map(), // nsId -> { rawId, message }
      negs: new Map(), // nsId -> { rawId, message, timer }
      negExchanged: new Set(), // NEG sessions that already exchanged NEG-MSG
      negTombstones: new Map(), // rawId -> timer after a session was closed by the pool
      pendingPublishes: new Map(), // eventId -> raw message
      seenEvents: new LruSet(this.#limits.dedupeEntries, this.#limits.dedupeTtlMs),
      seenOks: new LruSet(this.#limits.dedupeEntries, this.#limits.dedupeTtlMs),
      queuedFrames: 0,
      queuedBytes: 0,
      closed: false
    }
    this.#members.set(member.id, member)
    this.#counters.membersAttached++
    const bucket = this.#selectBucket(key, null, true)
    if (bucket) this.#addMember(member, bucket)
    else {
      this.#pendingMembers.push(member)
      this.#log('[relay-pool] member pending (no bucket capacity)', key)
    }
    return {
      id: member.id,
      send: data => this.#handleClientData(member, data),
      close: (code, reason) => this.#closeMember(member, code ?? 1000, reason ?? '', true),
      get bufferedAmount () {
        return member.queuedBytes
      }
    }
  }

  closeAll () {
    for (const member of [...this.#members.values()]) this.#closeMember(member, 1000, '', true)
    for (const bucket of [...this.#buckets.values()]) this.#destroyBucket(bucket, 1000, '', true)
  }

  snapshot () {
    const bucketsByHost = {}
    let subscriptions = 0
    for (const bucket of this.#buckets.values()) {
      const host = this.#hostFor(bucket.url)
      bucketsByHost[host] = (bucketsByHost[host] ?? 0) + 1
      subscriptions += bucket.subscriptions.size
    }
    return {
      ...this.#counters,
      droppedByOp: { ...this.#counters.droppedByOp },
      buckets: this.#buckets.size,
      bucketsByHost,
      subscriptions,
      members: this.#members.size,
      pendingMembers: this.#pendingMembers.length,
      quarantined: this.#quarantined.size
    }
  }

  #normalize (url) {
    try {
      return normalizeRelayUrl(url)
    } catch {
      return null
    }
  }

  #membersForUrl (url) {
    let set = this.#bucketsByUrl.get(url)
    if (!set) {
      set = new Set()
      this.#bucketsByUrl.set(url, set)
    }
    return set
  }

  #bucketCanAcceptAnonymous (bucket) {
    return bucket.identity === null && !bucket.unverified && bucket.pendingAuths.size === 0 && this.#hasBucketRoom(bucket)
  }

  #memberHasPendingAuth (member) {
    const bucket = member.bucket
    if (!bucket || bucket.pendingAuths.size === 0) return false
    for (const entry of bucket.pendingAuths.values()) {
      if (entry.member === member) return true
    }
    return false
  }

  #selectBucket (url, identity, create, { exclude = null } = {}) {
    const buckets = [...this.#membersForUrl(url)].filter(bucket => bucket.state !== 'closed' && bucket !== exclude)
    const exact = buckets.find(bucket => bucket.identity === identity && this.#hasBucketRoom(bucket) &&
      (identity !== null || (bucket.pendingAuths.size === 0 && !bucket.unverified)))
    if (exact) return exact
    if (identity === null) {
      const anonymous = buckets.find(bucket => this.#bucketCanAcceptAnonymous(bucket))
      if (anonymous) return anonymous
    }
    if (!create || buckets.length >= this.#limits.maxBucketsPerRelay) return null
    return this.#createBucket(url, identity)
  }

  #hasBucketRoom (bucket) {
    return bucket.subscriptions.size < this.#limits.maxSubscriptionsPerBucket
  }

  #createBucket (url, identity) {
    const bucket = {
      id: `b${++this.#serial}`,
      key: bucketKey(url, identity),
      url,
      identity,
      unverified: false,
      state: 'queued',
      socket: null,
      challenge: null,
      members: new Set(),
      subscriptions: new Map(), // nsId -> member
      counts: new Map(),
      negs: new Map(),
      publishes: new Map(), // eventId -> Set<member>
      pendingAuths: new Map(), // auth eventId -> { member, pubkey, timer }
      queues: new Map(), // memberId -> [{ raw, bytes }]
      roundRobin: [],
      roundRobinIndex: 0,
      tokens: this.#limits.messageBudgetPerBucket,
      lastRefill: Date.now(),
      idleTimer: null,
      drainScheduled: false,
      closed: false
    }
    this.#buckets.set(bucket.id, bucket)
    this.#membersForUrl(url).add(bucket)
    this.#counters.bucketsCreated++
    this.#scheduleBucketConnection(bucket)
    return bucket
  }

  #scheduleBucketConnection (bucket) {
    this.#connectionQueue.push(bucket)
    this.#pumpConnections()
  }

  #hostFor (url) {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  }

  // Connection budgets are per host: the 44b-relay limits are per IP, and
  // unrelated relays must never wait behind each other's budget.
  #pumpConnections () {
    if (this.#connectionTimer !== null || this.#connectionQueue.length === 0) return
    const now = Date.now()
    let selected = -1
    let retryDelay = null
    for (let index = 0; index < this.#connectionQueue.length; index++) {
      const bucket = this.#connectionQueue[index]
      if (bucket.closed) {
        this.#connectionQueue.splice(index, 1)
        index--
        continue
      }
      const host = this.#hostFor(bucket.url)
      const times = (this.#connectionTimesByHost.get(host) ?? []).filter(at => now - at < this.#limits.connectionWindowMs)
      this.#connectionTimesByHost.set(host, times)
      const inBurst = times.filter(at => now - at < this.#limits.connectionBurstWindowMs)
      if (inBurst.length < this.#limits.maxNewConnectionsPerSecond && times.length < this.#limits.maxNewConnectionsPerWindow) {
        selected = index
        break
      }
      const delay = inBurst.length >= this.#limits.maxNewConnectionsPerSecond
        ? Math.max(20, inBurst[0] + this.#limits.connectionBurstWindowMs - now)
        : Math.max(20, times[0] + this.#limits.connectionWindowMs - now)
      if (retryDelay === null || delay < retryDelay) retryDelay = delay
    }
    if (selected < 0) {
      if (retryDelay !== null) {
        this.#connectionTimer = setTimeout(() => {
          this.#connectionTimer = null
          this.#pumpConnections()
        }, retryDelay)
      }
      return
    }
    const [bucket] = this.#connectionQueue.splice(selected, 1)
    const host = this.#hostFor(bucket.url)
    const times = this.#connectionTimesByHost.get(host) ?? []
    times.push(now)
    this.#connectionTimesByHost.set(host, times)
    this.#openBucket(bucket)
    if (this.#connectionQueue.length > 0) queueMicrotask(() => this.#pumpConnections())
  }

  #openBucket (bucket) {
    let socket
    try {
      socket = this.#createSocket(bucket.url)
    } catch (error) {
      this.#log('[relay-pool] socket creation failed', bucket.url, error?.message ?? error)
      this.#failBucket(bucket, 1006, 'socket creation failed')
      return
    }
    bucket.socket = socket
    bucket.state = 'connecting'
    socket.onopen = () => {
      if (bucket.closed) return
      bucket.state = 'open'
      this.#counters.physicalOpened++
      for (const member of bucket.members) this.#memberOpened(member)
      this.#drainBucket(bucket)
    }
    socket.onmessage = event => this.#handleServerData(bucket, event.data)
    socket.onerror = () => {}
    socket.onclose = event => {
      if (bucket.closed) return
      this.#counters.physicalClosed++
      this.#failBucket(bucket, event?.code ?? 1006, event?.reason ?? '')
    }
  }

  #failBucket (bucket, code, reason) {
    const members = [...bucket.members]
    this.#destroyBucket(bucket, code, reason, code === 1000)
    for (const member of members) this.#closeMember(member, code, reason, code === 1000)
  }

  // Buckets are indexed by a unique id, never by (url, identity): a relay
  // can legitimately hold more than one bucket per identity, and a bucket's
  // identity changes when an anonymous connection authenticates.
  #setBucketIdentity (bucket, identity) {
    if (bucket.identity === identity) return
    bucket.identity = identity
    bucket.key = bucketKey(bucket.url, identity)
  }

  #destroyBucket (bucket, code = 1000, reason = '') {
    if (bucket.closed) return
    bucket.closed = true
    bucket.state = 'closed'
    if (bucket.idleTimer) clearTimeout(bucket.idleTimer)
    for (const entry of bucket.pendingAuths.values()) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    bucket.pendingAuths.clear()
    this.#buckets.delete(bucket.id)
    this.#membersForUrl(bucket.url).delete(bucket)
    const socket = bucket.socket
    bucket.socket = null
    if (socket) {
      if (socket.readyState < 2) this.#counters.physicalClosed++
      socket.onclose = null
      socket.onerror = null
      socket.onmessage = null
      try { socket.close(code, reason) } catch {}
    }
    bucket.members.clear()
    this.#drainPendingMembers()
  }

  #addMember (member, bucket) {
    member.bucket = bucket
    bucket.members.add(member)
    if (bucket.idleTimer) {
      clearTimeout(bucket.idleTimer)
      bucket.idleTimer = null
    }
    if (bucket.state === 'open') queueMicrotask(() => this.#memberOpened(member))
  }

  #memberOpened (member) {
    if (member.closed || member.bucket?.state !== 'open') return
    member.handlers.onOpen?.({ extensions: member.bucket.socket?.extensions ?? '' })
    if (member.bucket.challenge) this.#deliverMember(member, JSON.stringify(['AUTH', member.bucket.challenge]))
  }

  #removeMemberFromBucket (member) {
    const bucket = member.bucket
    if (!bucket) return
    bucket.members.delete(member)
    for (const [nsId, subscription] of member.subscriptions) {
      bucket.subscriptions.delete(nsId)
      this.#removeQueued(bucket, member, subscription.message)
      this.#sendControl(bucket, ['CLOSE', nsId])
    }
    for (const [nsId] of member.counts) {
      bucket.counts.delete(nsId)
      this.#sendControl(bucket, ['CLOSE', nsId])
    }
    for (const [nsId, entry] of member.negs) {
      if (entry?.timer) clearTimeout(entry.timer)
      bucket.negs.delete(nsId)
      this.#sendControl(bucket, ['NEG-CLOSE', nsId])
    }
    for (const timer of member.negTombstones.values()) clearTimeout(timer)
    member.negTombstones.clear()
    for (const [eventId, publishers] of bucket.publishes) {
      publishers.delete(member)
      if (publishers.size === 0) bucket.publishes.delete(eventId)
    }
    bucket.queues.delete(member.id)
    member.queuedFrames = 0
    member.queuedBytes = 0
    member.bucket = null
    if (bucket.members.size === 0 && !bucket.closed) {
      bucket.idleTimer = setTimeout(() => {
        if (bucket.members.size === 0) this.#destroyBucket(bucket, 1000, 'idle', true)
      }, this.#limits.bucketIdleMs)
    }
  }

  #removeQueued (bucket, member, message) {
    const queue = bucket.queues.get(member.id)
    if (!queue || !message) return
    const raw = JSON.stringify(message)
    const index = queue.findIndex(item => item.raw === raw)
    if (index < 0) return
    const [removed] = queue.splice(index, 1)
    member.queuedFrames = Math.max(0, member.queuedFrames - 1)
    member.queuedBytes = Math.max(0, member.queuedBytes - removed.bytes)
  }

  #drainPendingMembers () {
    if (this.#pendingMembers.length === 0) return
    const pending = this.#pendingMembers
    this.#pendingMembers = []
    for (const member of pending) {
      if (member.closed) continue
      const bucket = this.#selectBucket(member.url, null, true)
      if (bucket) this.#addMember(member, bucket)
      else this.#pendingMembers.push(member)
    }
  }

  #handleClientData (member, data) {
    if (member.closed) return
    const bucket = member.bucket
    if (!bucket || bucket.state === 'closed') return
    if (typeof data !== 'string') return this.#evictMember(member, 'binary-frame')
    const message = parseNostrFrame(data)
    if (!message) return this.#evictMember(member, 'invalid-frame')
    const op = message[0]
    if (op === 'AUTH') return this.#handleClientAuth(member, bucket, data, message)
    if (op === 'EVENT') return this.#handleClientEvent(member, bucket, data, message)
    if (op === 'REQ') return this.#handleClientRequest(member, bucket, message)
    if (op === 'CLOSE') return this.#handleClientClose(member, bucket, message)
    if (op === 'COUNT') return this.#handleClientCount(member, bucket, message)
    if (op === 'NEG-OPEN') return this.#handleClientNegOpen(member, bucket, message)
    if (op === 'NEG-MSG' || op === 'NEG-CLOSE') return this.#handleClientNeg(member, bucket, message)
    this.#enqueue(bucket, member, message)
  }

  #nextNamespacedId (member, rawId, kind) {
    let nsId = `${member.nsPrefix}${kind}:${rawId}`
    let suffix = 0
    while (member.bucket?.subscriptions.has(nsId) || member.bucket?.counts.has(nsId) || member.bucket?.negs.has(nsId)) {
      nsId = `${member.nsPrefix}${kind}:${rawId}:${++suffix}`
    }
    return nsId
  }

  #handleClientRequest (member, bucket, message) {
    const rawId = message[1]
    const existingNsId = member.rawSubscriptions.get(rawId)
    if (existingNsId !== undefined) {
      const replacement = [message[0], existingNsId, ...message.slice(2)]
      member.subscriptions.set(existingNsId, { rawId, message: replacement })
      bucket.subscriptions.set(existingNsId, member)
      this.#enqueue(bucket, member, replacement)
      return
    }
    if (bucket.subscriptions.size >= this.#limits.maxSubscriptionsPerBucket) {
      const target = this.#selectSpillBucket(bucket, member)
      if (!target) {
        this.#counters.capacityRejections++
        this.#log('[relay-pool] bucket capacity exhausted', bucket.url, bucket.identity ?? 'anonymous')
        return bucket.identity === null
          ? this.#closeMember(member, 1013, 'relay pool capacity', false)
          : this.#reconnectMember(member, 'relay pool rehome')
      }
      if (!this.#moveMember(member, target)) return
      bucket = member.bucket
    }
    const nsId = this.#nextNamespacedId(member, rawId, 'sub')
    const outgoing = [message[0], nsId, ...message.slice(2)]
    member.subscriptions.set(nsId, { rawId, message: outgoing })
    member.rawSubscriptions.set(rawId, nsId)
    bucket.subscriptions.set(nsId, member)
    this.#enqueue(bucket, member, outgoing)
  }

  #handleClientClose (member, bucket, message) {
    const nsId = member.rawSubscriptions.get(message[1])
    if (nsId === undefined) return
    member.subscriptions.delete(nsId)
    member.rawSubscriptions.delete(message[1])
    bucket.subscriptions.delete(nsId)
    this.#enqueue(bucket, member, ['CLOSE', nsId])
    this.#drainPendingMembers()
    this.#consolidateBuckets(bucket.url, bucket.identity)
  }

  #handleClientCount (member, bucket, message) {
    const rawId = message[1]
    const nsId = this.#nextNamespacedId(member, rawId, 'count')
    const outgoing = [message[0], nsId, ...message.slice(2)]
    member.counts.set(nsId, { rawId, message: outgoing })
    bucket.counts.set(nsId, member)
    this.#enqueue(bucket, member, outgoing)
  }

  #handleClientNegOpen (member, bucket, message) {
    const rawId = message[1]
    const existingNsId = this.#findNamespaced(member.negs, rawId)
    const nsId = existingNsId ?? this.#nextNamespacedId(member, rawId, 'neg')
    const outgoing = [message[0], nsId, ...message.slice(2)]
    // A new NEG-OPEN for an open subscription id closes the previous
    // session first (NIP-77), so the new session starts unpinned.
    member.negExchanged.delete(nsId)
    member.negs.set(nsId, { rawId, message: outgoing, timer: null })
    bucket.negs.set(nsId, member)
    this.#clearNegTombstone(member, rawId)
    this.#touchNegSession(member, nsId)
    this.#enqueue(bucket, member, outgoing)
    if (existingNsId !== undefined) this.#consolidateBuckets(bucket.url, bucket.identity)
  }

  #handleClientNeg (member, bucket, message) {
    const rawId = message[1]
    if (member.negTombstones.has(rawId)) {
      if (message[0] === 'NEG-CLOSE') this.#clearNegTombstone(member, rawId)
      else this.#deliverMember(member, JSON.stringify(['NEG-ERR', rawId, 'closed: NEG session closed']))
      return
    }
    const nsId = this.#findNamespaced(member.negs, rawId)
    if (nsId === undefined) return
    const outgoing = [message[0], nsId, ...message.slice(2)]
    if (message[0] === 'NEG-MSG') {
      member.negExchanged.add(nsId)
      this.#touchNegSession(member, nsId)
    }
    if (message[0] === 'NEG-CLOSE') {
      this.#clearNegSession(member, nsId)
      this.#consolidateBuckets(bucket.url, bucket.identity)
    }
    this.#enqueue(bucket, member, outgoing)
  }

  #clearNegSession (member, nsId) {
    const entry = member.negs.get(nsId)
    if (entry?.timer) clearTimeout(entry.timer)
    member.negs.delete(nsId)
    member.negExchanged.delete(nsId)
    member.bucket?.negs.delete(nsId)
  }

  #clearNegTombstone (member, rawId) {
    const timer = member.negTombstones.get(rawId)
    if (timer) clearTimeout(timer)
    member.negTombstones.delete(rawId)
  }

  #addNegTombstone (member, rawId) {
    this.#clearNegTombstone(member, rawId)
    const timer = setTimeout(() => member.negTombstones.delete(rawId), this.#limits.negTombstoneMs)
    timer.unref?.()
    member.negTombstones.set(rawId, timer)
  }

  #touchNegSession (member, nsId) {
    const entry = member.negs.get(nsId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => this.#failNegSession(member, nsId), this.#limits.negSessionIdleMs)
    entry.timer.unref?.()
  }

  #failNegSession (member, nsId) {
    const entry = member.negs.get(nsId)
    if (!entry) return
    const bucket = member.bucket
    const rawId = entry.rawId
    this.#clearNegSession(member, nsId)
    this.#addNegTombstone(member, rawId)
    this.#deliverMember(member, JSON.stringify(['NEG-ERR', rawId, 'closed: NEG session idle']))
    if (bucket) this.#consolidateBuckets(bucket.url, bucket.identity)
  }

  #findNamespaced (map, rawId) {
    for (const [nsId, value] of map) {
      if ((value?.rawId ?? value) === rawId) return nsId
    }
    return undefined
  }

  #handleClientEvent (member, bucket, raw, message) {
    const event = message[1]
    if (event?.id) {
      member.pendingPublishes.set(event.id, raw)
      let publishers = bucket.publishes.get(event.id)
      if (!publishers) {
        publishers = new Set()
        bucket.publishes.set(event.id, publishers)
      }
      publishers.add(member)
    }
    this.#enqueue(bucket, member, message)
  }

  #handleClientAuth (member, bucket, raw, message) {
    const event = message[1]
    const authEventId = event?.id
    if (typeof authEventId !== 'string') {
      this.#dropFrame('AUTH')
      return
    }
    if (bucket.pendingAuths.has(authEventId)) return
    const validation = this.#validateAuthEvent(bucket, event)
    if (!validation.ok) {
      this.#counters.authRejected++
      this.#deliverMember(member, JSON.stringify(['OK', authEventId, false, validation.reason]))
      return
    }
    const identity = event.pubkey
    if (bucket.identity === identity) {
      this.#setPendingAuth(bucket, authEventId, member, identity)
      this.#enqueue(bucket, member, message)
      return
    }
    const confirmedBucket = this.#findConfirmedBucket(bucket.url, identity)
    if (confirmedBucket && this.#canMergeIntoBucket(confirmedBucket, member)) {
      if (!this.#moveMember(member, confirmedBucket)) return
      this.#deliverMember(member, JSON.stringify(['OK', authEventId, true, 'relay pool: connection already authenticated']))
      this.#counters.authMerges++
      return
    }
    if (bucket.identity !== null) {
      // Never switch an authenticated connection to another pubkey: the
      // relay would drop the previous identity and its subscriptions.
      // Reconnect and let the next AUTH create or join a fresh bucket.
      this.#reconnectMember(member, 'relay pool rehome')
      return
    }
    // Anonymous bucket: migrate other members off if it is shared, then let
    // this connection authenticate in place. A second authenticated bucket
    // for the same pubkey is allowed and stays a future merge candidate.
    if (bucket.members.size > 1) {
      const target = this.#selectBucket(bucket.url, null, true, { exclude: bucket })
      if (!target) return this.#reconnectMember(member, 'relay pool rehome')
      for (const other of [...bucket.members]) {
        if (other !== member) this.#moveMember(other, target)
      }
      this.#counters.authSwaps++
    }
    this.#setPendingAuth(bucket, authEventId, member, identity)
    this.#enqueue(bucket, member, message)
  }

  #setPendingAuth (bucket, authEventId, member, pubkey) {
    const entry = { member, pubkey, timer: null }
    entry.timer = setTimeout(() => this.#failPendingAuth(bucket, authEventId), this.#limits.authPendingTimeoutMs)
    entry.timer.unref?.()
    bucket.pendingAuths.set(authEventId, entry)
  }

  #failPendingAuth (bucket, authEventId) {
    const entry = bucket.pendingAuths.get(authEventId)
    if (!entry) return
    bucket.pendingAuths.delete(authEventId)
    // The relay never answered. Whether it processed the AUTH is unknown,
    // so keep the bucket out of anonymous placement/consolidation targets.
    bucket.unverified = true
    this.#deliverMember(entry.member, JSON.stringify(['OK', authEventId, false, 'error: AUTH timeout']))
    this.#consolidateBuckets(bucket.url, bucket.identity)
    this.#drainPendingMembers()
  }

  #canMergeIntoBucket (bucket, member) {
    return member.negExchanged.size === 0 &&
      bucket.subscriptions.size + member.subscriptions.size <= this.#limits.maxSubscriptionsPerBucket
  }

  // Opportunistic consolidation: multiple confirmed buckets for the same
  // (relay, pubkey) are temporary. Move merge-safe members into the largest
  // open bucket with room whenever a slot frees or a NEG session closes.
  #consolidateAuthenticatedBuckets (url, identity) {
    if (identity === null || identity === undefined) return
    const key = `${url}\u0000${identity}`
    if (this.#consolidating.has(key)) return
    const buckets = [...this.#membersForUrl(url)].filter(bucket => !bucket.closed && bucket.identity === identity)
    if (buckets.length < 2) return
    this.#consolidating.add(key)
    let moved = 0
    try {
      const ordered = [...buckets].sort((a, b) => {
        const aOpen = a.state === 'open' ? 1 : 0
        const bOpen = b.state === 'open' ? 1 : 0
        if (aOpen !== bOpen) return bOpen - aOpen
        if (a.members.size !== b.members.size) return b.members.size - a.members.size
        return a.id.localeCompare(b.id)
      })
      for (const target of ordered) {
        if (target.closed || target.unverified || target.members.size === 0) continue
        for (const source of ordered) {
          if (source === target || source.closed) continue
          for (const member of [...source.members]) {
            if (member.closed || member.bucket !== source) continue
            if (this.#memberHasPendingAuth(member)) continue
            if (!this.#canMergeIntoBucket(target, member)) continue
            if (this.#moveMember(member, target)) moved++
          }
        }
      }
    } finally {
      this.#consolidating.delete(key)
    }
    if (moved > 0) {
      this.#counters.consolidations += moved
      this.#log('[relay-pool] consolidated', moved, 'member(s) on', url, identity)
    }
  }

  // Anonymous buckets are the overflow mechanism for subscription capacity;
  // consolidate whole small buckets when possible and fall back to throttled
  // partial moves when a source cannot be emptied at once.
  #consolidateAnonymousBuckets (url) {
    const key = `${url}\u0000`
    if (this.#consolidating.has(key)) return
    const buckets = [...this.#membersForUrl(url)].filter(bucket => !bucket.closed && bucket.identity === null)
    if (buckets.length < 2) return
    this.#consolidating.add(key)
    let moved = 0
    try {
      const targets = [...buckets]
        .filter(bucket => !bucket.unverified && bucket.pendingAuths.size === 0)
        .sort((a, b) => {
          const aOpen = a.state === 'open' ? 1 : 0
          const bOpen = b.state === 'open' ? 1 : 0
          if (aOpen !== bOpen) return bOpen - aOpen
          if (a.members.size !== b.members.size) return b.members.size - a.members.size
          return a.id.localeCompare(b.id)
        })
      for (const target of targets) {
        if (target.closed || target.members.size === 0) continue
        for (const source of buckets) {
          if (source === target || source.closed || source.members.size === 0) continue
          if (source.pendingAuths.size > 0) continue
          const members = [...source.members]
          if (members.some(member => member.closed || member.negExchanged.size > 0 || this.#memberHasPendingAuth(member))) continue
          const needed = members.reduce((total, member) => total + member.subscriptions.size, 0)
          if (target.subscriptions.size + needed > this.#limits.maxSubscriptionsPerBucket) continue
          for (const member of members) {
            if (this.#moveMember(member, target)) moved++
          }
        }
      }
      if (moved === 0) {
        const now = Date.now()
        const last = this.#anonymousConsolidationAt.get(url) ?? 0
        if (now - last >= this.#limits.consolidationThrottleMs) {
          this.#anonymousConsolidationAt.set(url, now)
          for (const target of targets) {
            if (target.closed || target.members.size === 0) continue
            for (const source of buckets) {
              if (source === target || source.closed) continue
              for (const member of [...source.members]) {
                if (member.closed || member.bucket !== source) continue
                if (member.negExchanged.size > 0 || this.#memberHasPendingAuth(member)) continue
                if (!this.#canMergeIntoBucket(target, member)) continue
                if (this.#moveMember(member, target)) moved++
              }
            }
          }
        }
      }
    } finally {
      this.#consolidating.delete(key)
    }
    if (moved > 0) {
      this.#counters.consolidations += moved
      this.#log('[relay-pool] consolidated', moved, 'anonymous member(s) on', url)
    }
  }

  #consolidateBuckets (url, identity) {
    if (identity === null || identity === undefined) this.#consolidateAnonymousBuckets(url)
    else this.#consolidateAuthenticatedBuckets(url, identity)
    this.#drainPendingMembers()
  }

  #validateAuthEvent (bucket, event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return { ok: false, reason: 'invalid: malformed auth event' }
    if (event.kind !== 22242) return { ok: false, reason: 'invalid: not an AUTH event' }
    if (typeof bucket.challenge !== 'string' || bucket.challenge.length === 0) return { ok: false, reason: 'invalid: missing AUTH challenge' }
    if (!Number.isSafeInteger(event.created_at) || Math.abs(Math.floor(Date.now() / 1000) - event.created_at) > 600) {
      return { ok: false, reason: 'invalid: AUTH timestamp' }
    }
    if (typeof event.pubkey !== 'string' || !isValidEvent(event)) return { ok: false, reason: 'invalid: AUTH signature' }
    const tags = new Map()
    for (const tag of Array.isArray(event.tags) ? event.tags : []) {
      if (Array.isArray(tag) && tag.length >= 2 && typeof tag[0] === 'string') tags.set(tag[0], tag[1])
    }
    if (tags.get('challenge') !== bucket.challenge) return { ok: false, reason: 'invalid: AUTH challenge' }
    const relayTag = tags.get('relay')
    if (typeof relayTag !== 'string' || this.#normalize(relayTag) !== bucket.url) return { ok: false, reason: 'invalid: AUTH relay' }
    return { ok: true }
  }

  #findConfirmedBucket (url, identity) {
    for (const candidate of this.#membersForUrl(url)) {
      if (candidate.state !== 'closed' && !candidate.unverified && candidate.identity === identity) return candidate
    }
    return null
  }

  #reconnectMember (member, reason) {
    this.#counters.authReconnects++
    this.#closeMember(member, 1006, reason, false)
  }

  #replayMemberOperations (member, bucket) {
    for (const [nsId, subscription] of member.subscriptions) {
      bucket.subscriptions.set(nsId, member)
      this.#enqueue(bucket, member, subscription.message)
    }
    for (const [nsId, count] of member.counts) {
      bucket.counts.set(nsId, member)
      this.#enqueue(bucket, member, count.message)
    }
    for (const [nsId, neg] of member.negs) {
      bucket.negs.set(nsId, member)
      this.#enqueue(bucket, member, neg.message)
    }
  }

  #moveMember (member, target) {
    const source = member.bucket
    if (!source || source === target) return false
    if (member.negExchanged.size > 0) {
      this.#reconnectMember(member, 'relay pool rehome')
      return false
    }
    this.#removeMemberFromBucket(member)
    this.#addMember(member, target)
    if (target.challenge) this.#deliverMember(member, JSON.stringify(['AUTH', target.challenge]))
    this.#replayMemberOperations(member, target)
    for (const [eventId, raw] of member.pendingPublishes) {
      let publishers = target.publishes.get(eventId)
      if (!publishers) {
        publishers = new Set()
        target.publishes.set(eventId, publishers)
      }
      publishers.add(member)
      this.#enqueue(target, member, parseNostrFrame(raw))
    }
    this.#counters.migrations++
    return true
  }

  #enqueue (bucket, member, message) {
    if (!bucket || bucket.closed || member.closed) return
    const raw = JSON.stringify(message)
    const bytes = raw.length
    if (member.queuedFrames + 1 > this.#limits.maxQueuedFramesPerMember ||
        member.queuedBytes + bytes > this.#limits.maxQueuedBytesPerMember) {
      this.#closeMember(member, 1013, 'relay pool queue overflow', false)
      return
    }
    member.queuedFrames++
    member.queuedBytes += bytes
    let queue = bucket.queues.get(member.id)
    if (!queue) {
      queue = []
      bucket.queues.set(member.id, queue)
      bucket.roundRobin.push(member.id)
    }
    queue.push({ raw, bytes })
    this.#drainBucket(bucket)
  }

  #selectSpillBucket (bucket, member) {
    const needed = 1 + member.subscriptions.size
    const candidates = [...this.#membersForUrl(bucket.url)].filter(candidate => candidate.state !== 'closed' && candidate !== bucket)
    if (bucket.identity !== null) {
      return candidates.find(candidate => candidate.identity === bucket.identity &&
        candidate.subscriptions.size + needed <= this.#limits.maxSubscriptionsPerBucket) ?? null
    }
    const anonymous = candidates.find(candidate => candidate.identity === null &&
      !candidate.unverified && candidate.pendingAuths.size === 0 &&
      candidate.subscriptions.size + needed <= this.#limits.maxSubscriptionsPerBucket)
    if (anonymous) return anonymous
    if (candidates.length + 1 < this.#limits.maxBucketsPerRelay) return this.#createBucket(bucket.url, null)
    return null
  }

  #dropFrame (op) {
    this.#counters.droppedFrames++
    const key = typeof op === 'string' ? op : 'invalid'
    this.#counters.droppedByOp[key] = (this.#counters.droppedByOp[key] ?? 0) + 1
  }

  #sendControl (bucket, message) {
    if (!bucket || bucket.closed || bucket.state !== 'open') return
    let queue = bucket.queues.get('__control__')
    if (!queue) {
      queue = []
      bucket.queues.set('__control__', queue)
      bucket.roundRobin.push('__control__')
    }
    if (queue.length >= 1024) return
    queue.push({ raw: JSON.stringify(message), bytes: 0 })
    this.#drainBucket(bucket)
  }

  #drainBucket (bucket) {
    if (bucket.closed || bucket.drainScheduled) return
    bucket.drainScheduled = true
    queueMicrotask(() => {
      bucket.drainScheduled = false
      if (bucket.closed || bucket.state !== 'open') return
      const now = Date.now()
      const elapsed = now - bucket.lastRefill
      if (elapsed > 0) {
        bucket.tokens = Math.min(
          this.#limits.messageBudgetPerBucket,
          bucket.tokens + (elapsed / this.#limits.messageWindowMs) * this.#limits.messageBudgetPerBucket
        )
        bucket.lastRefill = now
      }
      while (bucket.tokens >= 1 && this.#sendNext(bucket)) bucket.tokens--
      if (this.#hasQueuedMessages(bucket) && bucket.tokens < 1) {
        const wait = Math.max(20, (1 - bucket.tokens) * this.#limits.messageWindowMs / this.#limits.messageBudgetPerBucket)
        const bucketRef = bucket
        setTimeout(() => this.#drainBucket(bucketRef), wait)
      }
    })
  }

  #hasQueuedMessages (bucket) {
    for (const queue of bucket.queues.values()) if (queue.length > 0) return true
    return false
  }

  #sendNext (bucket) {
    if (bucket.roundRobin.length === 0) return false
    for (let attempt = 0; attempt < bucket.roundRobin.length; attempt++) {
      const index = (bucket.roundRobinIndex + attempt) % bucket.roundRobin.length
      const memberId = bucket.roundRobin[index]
      const queue = bucket.queues.get(memberId)
      if (!queue?.length) continue
      const item = queue.shift()
      bucket.roundRobinIndex = (index + 1) % bucket.roundRobin.length
      const member = this.#members.get(memberId)
      if (member) {
        member.queuedFrames = Math.max(0, member.queuedFrames - 1)
        member.queuedBytes = Math.max(0, member.queuedBytes - item.bytes)
      }
      try {
        bucket.socket?.send(item.raw)
        this.#counters.framesOut++
      } catch (error) {
        this.#log('[relay-pool] send failed', bucket.url, error?.message ?? error)
        this.#failBucket(bucket, 1006, 'send failed')
        return false
      }
      return true
    }
    return false
  }

  #handleServerData (bucket, data) {
    if (bucket.closed) return
    const message = parseNostrFrame(data)
    if (!message) {
      this.#dropFrame('invalid-server-frame')
      this.quarantine(bucket.url, 'invalid server frame')
      const members = [...bucket.members]
      this.#destroyBucket(bucket, 1006, 'invalid server frame', false)
      for (const member of members) this.#evictMember(member, 'invalid-server-frame', { alreadyRemoved: true })
      return
    }
    this.#counters.framesIn++
    const op = message[0]
    if (op === 'EVENT') return this.#routeEvent(bucket, message)
    if (op === 'EOSE') return this.#routeSimple(bucket, message, 'sub')
    if (op === 'CLOSED') return this.#routeClosed(bucket, message)
    if (op === 'OK') return this.#routeOk(bucket, message)
    if (op === 'COUNT') return this.#routeSimple(bucket, message, 'count')
    if (op === 'NEG-MSG' || op === 'NEG-ERR') return this.#routeSimple(bucket, message, 'neg')
    if (op === 'AUTH') {
      bucket.challenge = message[1]
      this.#broadcast(bucket, data)
      return
    }
    if (op === 'NOTICE') {
      this.#broadcast(bucket, data)
      return
    }
    if (typeof message[1] === 'string') {
      const routed = bucket.subscriptions.get(message[1]) ?? bucket.counts.get(message[1]) ?? bucket.negs.get(message[1])
      if (routed) return this.#deliverMember(routed, this.#rewriteId(message, routed))
    }
    this.#dropFrame(message[0])
  }

  #routeEvent (bucket, message) {
    const member = bucket.subscriptions.get(message[1])
    if (!member) {
      this.#dropFrame('EVENT')
      return
    }
    const eventId = message[2]?.id
    if (eventId && member.seenEvents.has(eventId)) return
    if (eventId) member.seenEvents.add(eventId)
    const subscription = member.subscriptions.get(message[1])
    if (!subscription) return
    this.#deliverMember(member, JSON.stringify(['EVENT', subscription.rawId, message[2]]))
  }

  #routeClosed (bucket, message) {
    const nsId = message[1]
    const member = bucket.subscriptions.get(nsId) ?? bucket.counts.get(nsId) ?? bucket.negs.get(nsId)
    if (!member) {
      this.#dropFrame('CLOSED')
      return
    }
    const subscription = member.subscriptions.get(nsId)
    if (subscription) {
      member.subscriptions.delete(nsId)
      member.rawSubscriptions.delete(subscription.rawId)
      bucket.subscriptions.delete(nsId)
      this.#drainPendingMembers()
      this.#consolidateBuckets(bucket.url, bucket.identity)
    }
    const countEntry = member.counts.get(nsId)
    if (countEntry !== undefined) {
      member.counts.delete(nsId)
      bucket.counts.delete(nsId)
    }
    this.#deliverMember(member, JSON.stringify(['CLOSED', subscription?.rawId ?? countEntry?.rawId ?? message[1], message[2]]))
  }

  #routeSimple (bucket, message, kind) {
    const map = kind === 'sub' ? bucket.subscriptions : kind === 'count' ? bucket.counts : bucket.negs
    const member = map.get(message[1])
    if (!member) {
      this.#dropFrame(message[0])
      return
    }
    const rawId = kind === 'sub'
      ? member.subscriptions.get(message[1])?.rawId
      : kind === 'count' ? member.counts.get(message[1])?.rawId : member.negs.get(message[1])?.rawId
    if (rawId === undefined) return
    if (kind === 'neg') {
      if (message[0] === 'NEG-ERR') {
        this.#clearNegSession(member, message[1])
        this.#deliverMember(member, JSON.stringify(['NEG-ERR', rawId, message[2]]))
        this.#consolidateBuckets(bucket.url, bucket.identity)
        return
      }
      member.negExchanged.add(message[1])
      this.#touchNegSession(member, message[1])
    }
    if (kind === 'count') {
      member.counts.delete(message[1])
      bucket.counts.delete(message[1])
    }
    this.#deliverMember(member, JSON.stringify([message[0], rawId, ...message.slice(2)]))
  }

  #routeOk (bucket, message) {
    const pendingAuth = bucket.pendingAuths.get(message[1])
    if (pendingAuth) {
      if (pendingAuth.timer) clearTimeout(pendingAuth.timer)
      bucket.pendingAuths.delete(message[1])
      const confirmed = message[2] === true
      this.#setBucketIdentity(bucket, confirmed ? pendingAuth.pubkey : null)
      this.#deliverMember(pendingAuth.member, JSON.stringify(message))
      if (confirmed) this.#consolidateBuckets(bucket.url, pendingAuth.pubkey)
      return
    }
    const publishers = bucket.publishes.get(message[1])
    if (!publishers) {
      this.#dropFrame('OK')
      return
    }
    bucket.publishes.delete(message[1])
    const raw = JSON.stringify(message)
    for (const member of publishers) {
      member.pendingPublishes.delete(message[1])
      if (member.seenOks.has(message[1])) continue
      member.seenOks.add(message[1])
      this.#deliverMember(member, raw)
    }
  }

  #rewriteId (message, member) {
    const nsId = message[1]
    const rawId = member.subscriptions.get(nsId)?.rawId ?? member.counts.get(nsId)?.rawId ?? member.negs.get(nsId)?.rawId
    const outgoing = rawId === undefined ? message : [message[0], rawId, ...message.slice(2)]
    return JSON.stringify(outgoing)
  }

  #broadcast (bucket, raw) {
    for (const member of bucket.members) this.#deliverMember(member, raw)
  }

  #deliverMember (member, raw) {
    if (member.closed || !member.bucket || member.bucket.state !== 'open') return
    member.handlers.onMessage?.(raw)
  }

  #evictMember (member, reason, { alreadyRemoved = false } = {}) {
    if (member.closed) return
    const bucket = member.bucket
    this.#counters.detaches++
    this.#removeMemberFromBucket(member)
    member.closed = true
    this.#members.delete(member.id)
    member.handlers.onDetach?.(reason)
    if (!alreadyRemoved) this.#drainPendingMembers()
    if (bucket && !bucket.closed) this.#consolidateBuckets(bucket.url, bucket.identity)
  }

  #closeMember (member, code, reason, wasClean) {
    if (member.closed) return
    const bucket = member.bucket
    this.#removeMemberFromBucket(member)
    member.closed = true
    this.#members.delete(member.id)
    member.handlers.onClose?.({ code, reason, wasClean })
    this.#drainPendingMembers()
    if (bucket && !bucket.closed) this.#consolidateBuckets(bucket.url, bucket.identity)
  }
}
