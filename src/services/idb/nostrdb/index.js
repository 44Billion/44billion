import { sha256 } from '@noble/hashes/sha2.js'
import { encode as base93Encode } from 'libp2r2p/base93'
import { base16ToBytes, bytesToBase16 } from 'libp2r2p/base16'
import { base64UrlToBytes, bytesToBase64Url } from 'libp2r2p/base64'

import { eventKinds } from '#constants/event.js'
import { appIdToDbAppRef } from '#helpers/app.js'
import {
  PERSONAL_COPY_KIND,
  isPersonalCopyEvent,
  personalCopyContextValue,
  personalCopyEncryptionKind,
  personalCopyProvenanceValue
} from '#helpers/personal-copy.js'
import { run } from '#services/idb/browser/index.js'
import {
  ChunkQuotaError,
  abortChunkPayloadStage,
  clearOwnerChunkCache,
  commitChunkCopy,
  getChunkPayload,
  getChunkPayloadForEvent,
  getOwnerChunkCopy,
  getOwnerChunkRoot,
  listChunkRootPurgeCandidates,
  listChunkCacheOwners,
  listOwnerChunkCopiesPage,
  listOwnerChunkRootsPage,
  markChunkReconciled,
  reconcileStaleChunkPayloadStages,
  removeChunkCopy,
  removeOwnerRootCopies,
  setOwnerRootReferenceCount,
  stageChunkPayload
} from '#services/idb/browser/queries/chunk-cache.js'
import {
  SEARCH_BATCH_SIZE,
  SEARCH_MATCH_MULTIPLIER,
  SEARCH_MAX_BATCHES,
  SEARCH_MAX_CANDIDATES,
  SEARCH_MAX_MATCHES,
  SEARCH_MIN_BATCHES,
  SEARCH_MIN_MATCHES,
  eventMatchesSearch,
  getSearchableText,
  getSearchableTextForEvent,
  matchSearchCandidates,
  parseSearch,
  rankSearchCandidates
} from './search.js'
import {
  createScheduledDelivery
} from './scheduled.js'
import { buildCrdtMergeTemplate } from './crdt.js'
import {
  extractPersonalCopyChunkForAdd,
  normalizePersonalCopyForAdd,
  validatePersonalCopyForStorage
} from './personal-copy.js'
import {
  blobReferencesFromTags,
  normalizeChunkEventForOwner,
  validateCanonicalOwnerChunkEvent,
  verifyNostrEventWithoutCache
} from './chunk-event.js'

export const NOSTRDB_VERSION = 1
export const NOSTRDB_PREFIX = '44billion_nostrdb:'
export const EVENTS_STORE = 'events'
export const DELETIONS_STORE = 'deletions'
export const KIND_REGISTRY_STORE = 'kindRegistry'

/*
IndexedDB schema, scoped per owner DB name:

events, keyPath "i"
  i     base64url event id bytes, primary key
  a     optional address key: [kind, pubkeyKey, dTagKey]
  p     base64url pubkey bytes
  k     event kind
  ca    created_at timestamp
  sa    sync anchor in milliseconds, monotonic local score for device-to-device DB sync
  ra    received/stored-at time in milliseconds, local-only cleanup grace anchor
  ex    optional NIP-40 expiration timestamp
  ap    optional multiEntry app refs for custom/unknown app-data ownership
  t     multiEntry tag index keys: [tagName, sha256(tagValue), created_at]
  cr/ci/ct/ch/cb optional externalized chunk root/index/total/content hash/byte length
  br    optional multiEntry roots referenced by public or decrypted personal r tags
  event original Nostr event; chunk events omit content and are rehydrated on reads

events indexes
  byAddress   a, unique, sparse
  byApp       ap, multiEntry
  byCreatedAt ca
  bySyncAnchor sa
  byExpiration ex
  byPubkey    [p, ca]
  byKind      [k, ca]
  byPubkeyKind [p, k, ca]
  byTag       t, multiEntry
  byChunk     [cr, ci], unique, sparse
  byBlobRef   br, multiEntry, sparse

deletions, keyPath "ref"
  ref   "e:<base64url-id>:<base64url-pubkey>" or "a:<base64url-sha256-coordinate>"
  tag   deletion target tag to preserve when compacting: ["e", id] or ["a", address]
        e-tag requests may be stored as canonical a-tag tombstones when the
        referenced stored event has an address
  ca    max created_at among stored deletion requests contributing this tombstone
  c     multiEntry contributors: [requestIdKey, requestCreatedAt]

deletions indexes
  byRequest c, multiEntry

kindRegistry, keyPath "key"
  key   registry record name, currently "appNeutralKinds"
  kinds sorted app-neutral event kinds
*/
export const INDEX = {
  address: 'byAddress',
  app: 'byApp',
  createdAt: 'byCreatedAt',
  syncAnchor: 'bySyncAnchor',
  expiration: 'byExpiration',
  pubkey: 'byPubkey',
  kind: 'byKind',
  pubkeyKind: 'byPubkeyKind',
  tag: 'byTag',
  chunk: 'byChunk',
  blobRef: 'byBlobRef'
}

export const DELETION_INDEX = {
  request: 'byRequest'
}

const HEX64_RE = /^[0-9a-f]{64}$/i
const SIG_RE = /^[0-9a-f]{128}$/i
const HONORARY_EXPIRATION_SKEW = 60
const SYNC_ANCHOR_FUTURE_SKEW_MS = 5000
const REGULAR_CUSTOM_APP_DATA_KIND = eventKinds.REGULAR_CUSTOM_APP_DATA ?? 78
const CUSTOM_APP_DATA_KIND = eventKinds.CUSTOM_APP_DATA ?? 30078
const APP_NEUTRAL_KINDS_KEY = 'appNeutralKinds'
const APP_CLAIM_DEBOUNCE_MS = 250
const APP_CLAIM_BATCH_SIZE = 100
const UNCLAIMED_APP_DATA_GRACE_MS = 30 * 24 * 60 * 60 * 1000
const UNCLAIMED_APP_DATA_BATCH_SIZE = 100
const UNCLAIMED_APP_DATA_MAX_SCANNED = 1000
const UNCLAIMED_APP_DATA_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000
const CHUNK_ROOT_GRACE_MS = 10 * 60 * 1000
const CHUNK_MAINTENANCE_INTERVAL_MS = 60 * 1000
const CHUNK_PURGE_BATCH_SIZE = 256
const textEncoder = new TextEncoder()
const dbCache = new Map()
const storeCache = new Map()
let globalChunkMaintenance

const ADD_FAILURE_CODES = new Set(['invalid', 'invalid_app', 'expired', 'blocked', 'quota', 'unavailable', 'error'])
const QUERY_SCORES = Symbol('nostrdb.queryScores')
const STORED_RECORD = Symbol('nostrdb.storedRecord')
const PERSONAL_COPY_PROVENANCE_STALE = Symbol('nostrdb.personalCopyProvenanceStale')
const PERSONAL_COPY_PROVENANCE_ATTEMPTS = 2
const ADD_MESSAGES = {
  stored: 'Event was stored.',
  replaced: 'Event replaced an older stored coordinate event.',
  duplicate: 'Event is already stored.',
  superseded: 'A newer or tie-winning coordinate event is already stored.',
  published: 'Event was published to subscribers without being stored.',
  invalid: 'Event shape is invalid.',
  invalid_app: 'App id is invalid.',
  expired: 'Event is expired.',
  blocked: 'Event is blocked by a deletion request.',
  quota: 'Global unreferenced chunk quota exceeded.',
  unavailable: 'IndexedDB is unavailable.',
  error: 'IndexedDB transaction failed.'
}

// add() only reports ok: false for invalid, expired, tombstone-blocked,
// unavailable, or transaction/write-error cases.
function addResult (code, {
  stored = false,
  published = false,
  message = ADD_MESSAGES[code],
  storedRecord,
  ...metadata
} = {}) {
  const result = {
    ok: !ADD_FAILURE_CODES.has(code),
    code,
    message,
    stored,
    published,
    ...metadata
  }

  if (storedRecord) Object.defineProperty(result, STORED_RECORD, { value: storedRecord })
  return result
}

function publishResult (result) {
  const published = { ...result, published: true }
  if (Object.hasOwn(result, 'storedEvent')) {
    Object.defineProperty(published, 'storedEvent', { value: result.storedEvent })
  }
  return published
}

function logNostrDbIssue (method, details, error) {
  const level = details.code === 'unavailable' || details.code === 'error' || error
    ? 'error'
    : 'warn'
  const logger = console[level]
  if (typeof logger !== 'function') return

  if (error) {
    logger.call(console, '[nostrdb]', { method, ...details }, error)
  } else {
    logger.call(console, '[nostrdb]', { method, ...details })
  }
}

function eventLogSummary (event) {
  if (!event || typeof event !== 'object') return null

  const summary = {}
  if (typeof event.id === 'string') summary.id = event.id
  if (typeof event.pubkey === 'string') summary.pubkey = event.pubkey
  if (Number.isInteger(event.kind)) summary.kind = event.kind
  if (Number.isInteger(event.created_at)) summary.created_at = event.created_at

  return Object.keys(summary).length > 0 ? summary : null
}

export function getNostrDb (ownerPubkey, {
  maintenance = true,
  maintenanceOptions = {},
  personalCopyDecrypt,
  personalCopyObfuscate
} = {}) {
  if (!storeCache.has(ownerPubkey)) {
    storeCache.set(ownerPubkey, new NostrDb(ownerPubkey))
  }
  const db = storeCache.get(ownerPubkey)
  if (typeof personalCopyDecrypt === 'function') db.personalCopyDecrypt = personalCopyDecrypt
  if (typeof personalCopyObfuscate === 'function') db.personalCopyObfuscate = personalCopyObfuscate
  if (maintenance) startNostrDbMaintenance(db, maintenanceOptions)
  return db
}

/*
Usage:

  const db = getNostrDb(ownerPubkey)

  await db.add(event)
  const { results: events } = await db.query({ authors: [pubkey], kinds: [1], limit: 20 })
  const { results: ids } = await db.query({ since, until }, { ids_only: true, search: 'algo:sync sort:asc' })
  const total = await db.count([{ kinds: [1] }, { kinds: [30023] }])

  const sub = db.subscribe({ '#t': ['nostr'], search: 'relay' })
  for await (const { result: event } of sub) {
    // receives future matching events added through this module or another tab
  }

Filters follow NIP-01 shape plus local extensions: search, ids_only, !ids,
&<tag> AND filters, and top-level filter arrays as OR clauses.
*/
export class NostrDb {
  constructor (ownerPubkey) {
    this.ownerPubkey = ownerPubkey
    this.sender = `${Date.now()}:${Math.random()}`
    this.subscriptions = new Set()
    this.appClaimQueues = new Map()
    this.appClaimTimer = null
    this.appClaimRunning = false
    this.appClaimFlushAgain = false
    this.maintenanceStops = new Map()
    this.deletionRequestMaintenanceSignEvent = null
    this.personalCopyDecrypt = null
    this.personalCopyObfuscate = null
    this.bc = null

    if (typeof BroadcastChannel === 'function') {
      this.bc = new BroadcastChannel(channelName(ownerPubkey))
      this.bc.unref?.()
      this.bc.onmessage = ({ data }) => {
        if (data?.type !== 'event' || data.sender === this.sender) return
        this.publish(
          data.event,
          false,
          Number.isFinite(data.syncAnchor) ? { event: data.event, sa: data.syncAnchor } : undefined
        )
      }
    }
  }

  // Public ingest path. Valid transient events reach live subscribers, and
  // durable events may first be CRDT-merged/signed for local owner-authored
  // coordinates before addEvent() persists them and add() publishes them. Pass
  // mergeSource: 'sync' when merging versions received from another local DB so
  // the CRDT layer uses deterministic ordering instead of authoring-time order.
  async add (event, {
    appId,
    signEvent,
    mergeReplaceable,
    mergeSource,
    tagIdentity,
    tombstoneGraceSeconds,
    maxTombstoneTags,
    tombstoneTagName
  } = {}) {
    const inputEvent = event
    let chunkData = null
    let normalized

    try {
      const claimedPersonalChunk = isPersonalCopyEvent(event) &&
        personalCopyEncryptionKind(event) === 34601
      if (claimedPersonalChunk) {
        if (!isValidEventShape(event) || !verifyNostrEventWithoutCache(event)) throw new Error('Invalid personal-copy wrapper')
        const inner = await extractPersonalCopyChunkForAdd(event, {
          decrypt: this.personalCopyDecrypt,
          obfuscate: this.personalCopyObfuscate,
          ownerPubkey: this.ownerPubkey
        })
        if (!inner) throw new Error('Invalid personal-copy chunk')
        const chunk = await normalizeChunkEventForOwner(inner, {
          ownerPubkey: this.ownerPubkey,
          signEvent,
          allowUnsigned: true
        })
        normalized = { event: chunk.event, personalCopy: null }
        chunkData = chunk.data
      } else if (event?.kind === 34601) {
        const chunk = await normalizeChunkEventForOwner(event, {
          ownerPubkey: this.ownerPubkey,
          signEvent
        })
        normalized = { event: chunk.event, personalCopy: null }
        chunkData = chunk.data
      } else {
        normalized = await normalizePersonalCopyForAdd(event, {
          decrypt: this.personalCopyDecrypt,
          obfuscate: this.personalCopyObfuscate,
          signEvent,
          ownerPubkey: this.ownerPubkey
        })
      }
    } catch (error) {
      return this.reportAddResult('add', event, addResult('invalid'), { error })
    }
    if (normalized === null) {
      return this.reportAddResult('add', event, addResult('invalid'))
    }
    event = normalized.event
    const personalCopy = normalized.personalCopy
    const blobRefs = blobReferencesFromTags(personalCopy?.inner?.tags ?? event.tags)

    if (!isValidEventShape(event)) {
      return this.reportAddResult('add', event, addResult('invalid'))
    }

    const appRef = normalizeOptionalAppRef(appId)
    if (appRef === false) return this.reportAddResult('add', event, addResult('invalid_app'))

    const now = currentUnixTime()

    if (isExpiredForIngest(event, now)) {
      return this.reportAddResult('add', event, addResult('expired'))
    }

    if (isNonDurableEvent(event)) {
      this.publish(event, true)
      return addResult('published', { published: true })
    }

    const crdtMergeSource = normalizeCrdtMergeSource(mergeSource)

    for (let attempt = 0; attempt < PERSONAL_COPY_PROVENANCE_ATTEMPTS; attempt++) {
      const resolution = personalCopy
        ? await this.preparePersonalCopyProvenance(event, personalCopy)
        : null
      if (personalCopy && resolution === null) {
        return this.reportAddResult('add', event, addResult('invalid'))
      }

      let eventToStore = event
      const shouldMergeReplaceable = event.kind === 34601
        ? false
        : mergeReplaceable ?? (typeof signEvent === 'function' && event.pubkey === this.ownerPubkey)
      const mergedEvent = shouldMergeReplaceable
        ? await this.signMergedReplaceableEvent(event, {
          signEvent,
          mergeSource: crdtMergeSource,
          tagIdentity,
          tombstoneGraceSeconds,
          maxTombstoneTags,
          tombstoneTagName,
          now
        })
        : null

      if (mergedEvent) eventToStore = mergedEvent

      const result = await this.addEvent(eventToStore, {
        now,
        appRef,
        forceCoordinateReplace: !!mergedEvent && crdtMergeSource === 'sync',
        personalCopy: mergedEvent ? null : personalCopy,
        personalCopyResolution: resolution,
        chunkData,
        blobRefs,
        log: false
      })
      if (result[PERSONAL_COPY_PROVENANCE_STALE] && attempt + 1 < PERSONAL_COPY_PROVENANCE_ATTEMPTS) continue

      if (mergedEvent && result.stored && (result.code === 'stored' || result.code === 'replaced')) {
        result.merged = true
        result.inputId = event.id
        result.storedId = mergedEvent.id
      }
      if (result.stored && (result.code === 'stored' || result.code === 'replaced')) {
        if (eventToStore !== inputEvent) Object.defineProperty(result, 'storedEvent', { value: eventToStore })
        this.publish(eventToStore, true, result[STORED_RECORD])
        return publishResult(result)
      }
      return this.reportAddResult('add', event, result)
    }

    return this.reportAddResult('add', event, addResult('error'))
  }

  async signMergedReplaceableEvent (event, {
    signEvent,
    mergeSource,
    tagIdentity,
    tombstoneGraceSeconds,
    maxTombstoneTags,
    tombstoneTagName,
    now
  }) {
    if (typeof signEvent !== 'function') return null
    if (event.pubkey !== this.ownerPubkey) return null
    if (isPersonalCopyEvent(event)) return null

    const coordinate = getCoordinate(event)
    if (coordinate === null) return null

    const expectedAddress = addressKey(event.kind, event.pubkey, coordinate)
    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return null

    let base = await getStoredRecordByAddress(db, expectedAddress)

    for (let attempt = 0; attempt < 2; attempt++) {
      const mergeOptions = {
        tagIdentity,
        tombstoneGraceSeconds,
        maxTombstoneTags,
        tombstoneTagName,
        mergeSource,
        now
      }
      const template = buildCrdtMergeTemplate(event, base?.event, mergeOptions)
      if (!template) return null

      const signed = await signCrdtTemplate(signEvent, template)
      if (!isValidCrdtSignedEvent(signed, template, expectedAddress, this.ownerPubkey)) return null

      const latest = await getStoredRecordByAddress(db, expectedAddress)
      if (sameStoredVersion(base, latest)) return signed

      base = latest
    }

    return null
  }

  async preparePersonalCopyProvenance (event, personalCopy) {
    if (!personalCopy) return null

    const filter = {
      authors: [this.ownerPubkey],
      kinds: [PERSONAL_COPY_KIND],
      '#c': [personalCopy.context],
      '#o': [personalCopy.sourceMirror]
    }
    const db = await openNostrDb(this.ownerPubkey)
    if (!db) {
      return {
        incomingWins: true,
        loserIds: [],
        snapshot: null,
        winnerId: event.id
      }
    }

    let storedEvents
    try {
      storedEvents = await queryRecords(db, filter, {
        countOnly: false,
        ignoreLimit: true
      })
    } catch {
      return null
    }

    const candidates = storedEvents
      .filter(candidate => candidate.pubkey === this.ownerPubkey)
      .filter(candidate => personalCopyCandidateMatches(candidate, personalCopy))
      .map(candidate => ({
        event: candidate,
        provenance: personalCopyProvenanceValue(candidate)
      }))
    const incoming = { event, provenance: personalCopy.provenance, incoming: true }
    const winner = [incoming, ...candidates].reduce(preferredPersonalCopy)

    return {
      incomingWins: winner.incoming === true || winner.event.id === event.id,
      loserIds: candidates
        .filter(candidate => candidate.event.id !== winner.event.id)
        .map(candidate => candidate.event.id),
      snapshot: personalCopyProvenanceSnapshot(filter, storedEvents),
      winnerId: winner.event.id
    }
  }

  // Durable write path used internally by add() and compaction; it updates
  // IndexedDB/tombstones but does not publish events by itself.
  async addEvent (event, {
    appId,
    appRef = normalizeOptionalAppRef(appId),
    consumeDeletionRequestIds = [],
    now = currentUnixTime(),
    forceCoordinateReplace = false,
    personalCopy,
    personalCopyResolution,
    chunkData,
    blobRefs,
    log = true
  } = {}) {
    if (!isValidEventShape(event)) {
      return this.reportAddResult('addEvent', event, addResult('invalid'), { log })
    }

    if (isPersonalCopyEvent(event)) {
      if (
        !personalCopy ||
        personalCopy.eventId !== event.id ||
        personalCopy.eventJson !== JSON.stringify(event)
      ) {
        personalCopy = await validatePersonalCopyForStorage(event, {
          decrypt: this.personalCopyDecrypt,
          obfuscate: this.personalCopyObfuscate,
          ownerPubkey: this.ownerPubkey
        })
      }
      if (!personalCopy) {
        return this.reportAddResult('addEvent', event, addResult('invalid'), { log })
      }
      if (!personalCopyResolution) {
        personalCopyResolution = await this.preparePersonalCopyProvenance(event, personalCopy)
      }
      if (!personalCopyResolution) {
        return this.reportAddResult('addEvent', event, addResult('invalid'), { log })
      }
      forceCoordinateReplace = false
    } else {
      personalCopy = null
      personalCopyResolution = null
    }

    if (event.kind === 34601) {
      try {
        chunkData ??= validateCanonicalOwnerChunkEvent(event, this.ownerPubkey)
      } catch {
        return this.reportAddResult('addEvent', event, addResult('invalid'), { log })
      }
    } else {
      chunkData = null
    }
    blobRefs ??= blobReferencesFromTags(personalCopy?.inner?.tags ?? event.tags)

    if (appRef === false) {
      return this.reportAddResult('addEvent', event, addResult('invalid_app'), { log })
    }

    if (isExpiredForIngest(event, now)) {
      return this.reportAddResult('addEvent', event, addResult('expired'), { log })
    }
    if (isNonDurableEvent(event)) {
      return addResult('published', {
        message: 'Event is valid but non-durable; addEvent() does not store or publish it.'
      })
    }

    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return this.reportAddResult('addEvent', event, addResult('unavailable'), { log })

    let chunkStage = null
    if (chunkData) {
      try {
        chunkStage = await stageChunkPayloadWithPressure(this, db, chunkData)
      } catch (error) {
        const code = error instanceof ChunkQuotaError ? 'quota' : 'error'
        return this.reportAddResult('addEvent', event, addResult(code), { log })
      }
    }

    const record = toStoredRecord(event, { now, appRef, chunkData, blobRefs })
    let replaced = false
    let tx
    let done

    try {
      tx = db.transaction([EVENTS_STORE, DELETIONS_STORE], 'readwrite')
      done = txDone(tx)

      await validatePersonalCopyProvenanceSnapshot(db, tx, personalCopyResolution?.snapshot)

      if (personalCopyResolution && !personalCopyResolution.incomingWins) {
        const changed = await retainExistingPersonalCopyWinner(
          db,
          tx,
          personalCopyResolution,
          appRef
        )
        await done
        return addResult(
          personalCopyResolution.winnerId === event.id ? 'duplicate' : 'superseded',
          { stored: changed }
        )
      }

      const existingById = await run('get', [record.i], EVENTS_STORE, null, { db, tx })
        .then(v => v.result)

      if (existingById) {
        let changed = mergeAppRef(existingById, appRef)
        changed = await removePersonalCopyLosers(
          db,
          tx,
          personalCopyResolution?.loserIds,
          existingById
        ) || changed
        if (changed) await run('put', [existingById], EVENTS_STORE, null, { db, tx })
        await done
        await finishChunkStage(chunkStage, {
          owner: this.ownerPubkey,
          event,
          chunkData,
          protectedRoot: chunkStage?.protectedRoot
        })
        scheduleBlobReferenceReconciliation(this.ownerPubkey, record.br)
        return addResult('duplicate', { stored: changed })
      }

      if (await isBlockedByDeletion(db, tx, event)) {
        await done
        await abortChunkPayloadStage(chunkStage)
        return this.reportAddResult('addEvent', event, addResult('blocked'), { log })
      }

      if (record.a) {
        const existingByAddress = await run('get', [record.a], EVENTS_STORE, INDEX.address, { db, tx })
          .then(v => v.result)
        const existingIsPersonalCopyLoser = personalCopyResolution?.loserIds.includes(existingByAddress?.event.id)

        if (
          existingByAddress &&
          !existingIsPersonalCopyLoser &&
          !forceCoordinateReplace &&
          !isNewer(event, existingByAddress.event)
        ) {
          const changed = mergeAppRef(existingByAddress, appRef)
          if (changed) await run('put', [existingByAddress], EVENTS_STORE, null, { db, tx })
          await done
          await abortChunkPayloadStage(chunkStage)
          return addResult('superseded', { stored: changed })
        }

        if (existingByAddress) {
          mergeAppRefs(record, existingByAddress.ap)
          if (!existingIsPersonalCopyLoser) {
            record.sa = await nextSyncAnchor(db, tx, event, now)
            await deleteStoredEvent(db, tx, existingByAddress)
          }
          replaced = true
        }
      }

      await removePersonalCopyLosers(
        db,
        tx,
        personalCopyResolution?.loserIds,
        record
      )

      if (record.sa === undefined) {
        record.sa = await nextSyncAnchor(db, tx, event, now)
      }

      if (event.kind === 5) {
        // Keep this chain IDB-only; unrelated awaits can let the transaction auto-commit.
        await applyDeletionRequest(db, tx, event)
      }

      for (const id of consumeDeletionRequestIds) {
        await deleteStoredDeletionRequestById(db, tx, id, event.pubkey)
      }

      await run('put', [record], EVENTS_STORE, null, { db, tx })
      await done
    } catch (error) {
      try {
        tx?.abort()
      } catch {
      }
      await done?.catch(() => {})
      await abortChunkPayloadStage(chunkStage).catch(() => {})
      const result = addResult('error')
      if (error instanceof StalePersonalCopyProvenanceError) {
        Object.defineProperty(result, PERSONAL_COPY_PROVENANCE_STALE, { value: true })
      }
      return this.reportAddResult('addEvent', event, result, { log })
    }

    await finishChunkStage(chunkStage, {
      owner: this.ownerPubkey,
      event,
      chunkData,
      protectedRoot: chunkStage?.protectedRoot
    })
    scheduleBlobReferenceReconciliation(this.ownerPubkey, record.br)

    return addResult(replaced ? 'replaced' : 'stored', {
      stored: true,
      storedRecord: record
    })
  }

  reportAddResult (method, event, result, { log = true } = {}) {
    if (log && !result.ok) {
      logNostrDbIssue(method, {
        ownerPubkey: this.ownerPubkey,
        code: result.code,
        message: result.message,
        event: eventLogSummary(event)
      })
    }
    return result
  }

  async compactDeletionRequests ({
    signEvent,
    author = this.ownerPubkey,
    maxTargetRefs = DELETION_COMPACTION_MAX_TAGS,
    createdAt,
    signal
  } = {}) {
    if (typeof signEvent !== 'function') throw new TypeError('compactDeletionRequests requires a sign function')
    if (!HEX64_RE.test(author)) return compactResult()

    throwIfAborted(signal)

    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return compactResult()

    const maxRefs = Number.isInteger(maxTargetRefs) && maxTargetRefs > 0 ? maxTargetRefs : DELETION_COMPACTION_MAX_TAGS
    let requests
    let infos

    try {
      requests = await queryRecords(db, { authors: [author], kinds: [5] }, {
        countOnly: false,
        ignoreLimit: true
      })
      requests.sort(compareOldest)

      if (requests.length < 2) return compactResult()

      const tx = db.transaction([DELETIONS_STORE], 'readonly')
      const done = txDone(tx)
      infos = []

      for (const request of requests) {
        throwIfAborted(signal)

        const rows = await getDeletionRowsForRequest(db, tx, eventIdIndexKey(request.id))
        const targets = uniqueDeletionRows(rows)
        if (targets.length > 0) infos.push({ event: request, targets })
      }

      await done
    } catch {
      throwIfAborted(signal)
      return compactResult()
    }

    const selection = selectDeletionCompaction(infos, maxRefs)
    if (!selection) return compactResult()

    const consumed = selection.selected.map(info => info.event.id)
    const maxConsumedCreatedAt = Math.max(...selection.selected.map(info => info.event.created_at))
    const templateCreatedAt = selection.createdAt ?? Math.max(
      normalizeTimestamp(createdAt, Math.floor(Date.now() / 1000)),
      maxConsumedCreatedAt
    )
    const tags = [...selection.targets.values()].map(row => [...row.tag])
    const template = {
      kind: 5,
      created_at: templateCreatedAt,
      tags: tags.map(tag => [...tag]),
      content: ''
    }

    throwIfAborted(signal)
    const signed = await signEvent(template)
    throwIfAborted(signal)

    if (
      !isValidEventShape(signed) ||
      signed.kind !== 5 ||
      signed.pubkey !== author ||
      (selection.createdAt === null ? signed.created_at < maxConsumedCreatedAt : signed.created_at !== templateCreatedAt) ||
      signed.content !== '' ||
      !sameTags(signed.tags, tags)
    ) {
      return compactResult()
    }

    const saved = await this.addEvent(signed, { consumeDeletionRequestIds: consumed })
    if (!saved.stored) return compactResult()

    this.publish(signed, true)
    return compactResult({ compacted: true, created: signed, consumed, targets: tags })
  }

  async maintainDeletionRequests ({
    signEvent,
    author = this.ownerPubkey,
    maxTargetRefs = DELETION_COMPACTION_MAX_TAGS,
    maxDeletionRequests = DELETION_REQUEST_MAINTENANCE_MAX_REQUESTS,
    pruneGraceMs = DELETION_REQUEST_PRUNE_GRACE_MS,
    pruneBatchSize = DELETION_REQUEST_PRUNE_DELETE_BATCH_SIZE,
    createdAt,
    now,
    signal
  } = {}) {
    const compaction = await this.compactDeletionRequests({
      signEvent,
      author,
      maxTargetRefs,
      createdAt,
      signal
    })
    const pruning = await this.pruneDeletionRequests({
      author,
      maxDeletionRequests,
      pruneGraceMs,
      pruneBatchSize,
      now,
      signal
    })
    return { ...compaction, ...pruning }
  }

  startDeletionCompaction ({
    intervalMs = 3600000,
    runImmediately = true,
    ...options
  } = {}) {
    const delay = Number.isInteger(intervalMs) && intervalMs > 0 ? intervalMs : 3600000
    let stopped = false
    let running = false
    let timer = null

    const schedule = ms => {
      if (stopped) return
      timer = setTimeout(tick, ms)
      timer.unref?.()
    }

    const tick = async () => {
      if (stopped) return
      if (running) {
        schedule(delay)
        return
      }

      running = true
      try {
        await this.compactDeletionRequests(options)
      } catch {
      } finally {
        running = false
        schedule(delay)
      }
    }

    schedule(runImmediately ? 0 : delay)

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }

  startDeletionRequestMaintenance ({
    intervalMs = 3600000,
    runImmediately = true,
    ...options
  } = {}) {
    const delay = Number.isInteger(intervalMs) && intervalMs > 0 ? intervalMs : 3600000
    let stopped = false
    let running = false
    let timer = null

    const schedule = ms => {
      if (stopped) return
      timer = setTimeout(tick, ms)
      timer.unref?.()
    }

    const tick = async () => {
      if (stopped) return
      if (running) {
        schedule(delay)
        return
      }

      running = true
      try {
        await this.maintainDeletionRequests(options)
      } catch {
      } finally {
        running = false
        schedule(delay)
      }
    }

    schedule(runImmediately ? 0 : delay)

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }

  async pruneDeletionRequests ({
    author = this.ownerPubkey,
    maxDeletionRequests = DELETION_REQUEST_MAINTENANCE_MAX_REQUESTS,
    pruneGraceMs = DELETION_REQUEST_PRUNE_GRACE_MS,
    pruneBatchSize = DELETION_REQUEST_PRUNE_DELETE_BATCH_SIZE,
    now,
    signal
  } = {}) {
    if (!HEX64_RE.test(author)) return deletionPruneResult()

    throwIfAborted(signal)

    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return deletionPruneResult()

    const maxRequests = normalizeNonNegativeInteger(maxDeletionRequests, DELETION_REQUEST_MAINTENANCE_MAX_REQUESTS)
    const cutoffMs = (Number.isFinite(now) ? now * 1000 : currentUnixTime() * 1000) -
      normalizeDurationMs(pruneGraceMs, DELETION_REQUEST_PRUNE_GRACE_MS)
    const deleteLimit = normalizePositiveInteger(pruneBatchSize, DELETION_REQUEST_PRUNE_DELETE_BATCH_SIZE)
    let total

    try {
      total = await countDeletionRequestKeys(db, author, signal)
    } catch {
      throwIfAborted(signal)
      return deletionPruneResult()
    }

    if (total <= maxRequests) return deletionPruneResult()

    const deleteCount = Math.min(total - maxRequests, deleteLimit)
    if (deleteCount <= 0) return deletionPruneResult()

    let ids

    try {
      ids = await selectDeletionRequestPruneIds(db, author, {
        cutoffMs,
        limit: deleteCount,
        signal
      })
    } catch {
      throwIfAborted(signal)
      return deletionPruneResult()
    }
    if (ids.length === 0) return deletionPruneResult()

    const deleted = []

    try {
      await deleteDeletionRequestIdsInBatches(db, ids, author, {
        batchSize: DELETION_REQUEST_PRUNE_DELETE_BATCH_SIZE,
        deleted,
        signal
      })
    } catch {
      throwIfAborted(signal)
      return deletionPruneResult({ deleted })
    }

    return deletionPruneResult({ deleted })
  }

  async purgeExpired ({ now } = {}) {
    const cutoff = normalizeTimestamp(now, currentUnixTime())
    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return 0

    try {
      const expiredIdKeys = await getExpiredIdKeys(db, cutoff)
      let removed = 0

      if (expiredIdKeys.length === 0) return 0

      const tx = db.transaction([EVENTS_STORE, DELETIONS_STORE], 'readwrite')
      const done = txDone(tx)

      for (const idKey of expiredIdKeys) {
        const stored = await run('get', [idKey], EVENTS_STORE, null, { db, tx })
          .then(v => v.result)
        if (!stored || isStoredRecordLive(stored, cutoff)) continue

        await deleteStoredEvent(db, tx, stored)
        removed++
      }

      await done
      return removed
    } catch {
      return 0
    }
  }

  async purgeChunkRoot (root, { force = false, now = Date.now() } = {}) {
    if (!/^[0-9a-f]{64}$/.test(root || '')) return 0
    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return 0

    const references = await countBlobReferences(db, root)
    await setOwnerRootReferenceCount(this.ownerPubkey, root, references)
    if (references > 0) return 0

    if (!force) {
      const candidates = await listChunkRootPurgeCandidates({
        before: now - CHUNK_ROOT_GRACE_MS,
        limit: CHUNK_PURGE_BATCH_SIZE
      })
      if (!candidates.some(candidate => candidate.owner === this.ownerPubkey && candidate.root === root)) return 0
    }

    let removed = 0
    let failed = false
    while (true) {
      const records = await getChunkRecordBatch(db, root, CHUNK_PURGE_BATCH_SIZE)
      if (records.length === 0) break
      const transaction = db.transaction([EVENTS_STORE, DELETIONS_STORE], 'readwrite')
      const done = txDone(transaction)
      try {
        for (const stored of records) {
          const current = await run('get', [stored.i], EVENTS_STORE, null, { db, tx: transaction })
            .then(value => value.result)
          if (!current || current.cr !== root) continue
          await deleteStoredEvent(db, transaction, current)
          removed++
        }
        await done
      } catch {
        try { transaction.abort() } catch {}
        await done.catch(() => {})
        failed = true
        break
      }
    }
    if (!failed) await removeOwnerRootCopies(this.ownerPubkey, root)
    return removed
  }

  async maintainChunks () {
    await reconcileOwnerChunks(this)
    const candidates = await listChunkRootPurgeCandidates({
      before: Date.now() - CHUNK_ROOT_GRACE_MS,
      limit: CHUNK_PURGE_BATCH_SIZE
    })
    let removed = 0
    for (const candidate of candidates) {
      if (candidate.owner !== this.ownerPubkey) continue
      removed += await this.purgeChunkRoot(candidate.root)
    }
    return removed
  }

  startChunkMaintenance ({ intervalMs = CHUNK_MAINTENANCE_INTERVAL_MS, runImmediately = true } = {}) {
    const delay = Number.isInteger(intervalMs) && intervalMs > 0
      ? intervalMs
      : CHUNK_MAINTENANCE_INTERVAL_MS
    let stopped = false
    let running = false
    let timer

    const schedule = milliseconds => {
      if (stopped) return
      timer = setTimeout(tick, milliseconds)
      timer.unref?.()
    }
    const tick = async () => {
      if (stopped) return
      if (!running) {
        running = true
        try { await this.maintainChunks() } catch {}
        running = false
      }
      schedule(delay)
    }
    schedule(runImmediately ? 0 : delay)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }

  async purgeUnclaimedAppData ({
    graceMs = UNCLAIMED_APP_DATA_GRACE_MS,
    batchSize = UNCLAIMED_APP_DATA_BATCH_SIZE,
    maxScanned = UNCLAIMED_APP_DATA_MAX_SCANNED,
    now
  } = {}) {
    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return 0

    const cutoffMs = (Number.isFinite(now) ? now * 1000 : currentUnixTime() * 1000) -
      normalizeDurationMs(graceMs, UNCLAIMED_APP_DATA_GRACE_MS)
    const scanLimit = normalizePositiveInteger(maxScanned, UNCLAIMED_APP_DATA_MAX_SCANNED)
    const deleteLimit = normalizePositiveInteger(batchSize, UNCLAIMED_APP_DATA_BATCH_SIZE)
    const idKeys = []
    let scanned = 0

    try {
      await scanCursor(db, EVENTS_STORE, null, null, {
        onItem: stored => {
          scanned++
          if (isUnclaimedAppDataCleanupCandidate(stored, cutoffMs)) idKeys.push(stored.i)
          return scanned < scanLimit && idKeys.length < deleteLimit
        }
      })

      if (idKeys.length === 0) return 0
      return deleteUnclaimedAppDataBatch(db, idKeys, cutoffMs)
    } catch {
      return 0
    }
  }

  startUnclaimedAppDataPurge ({
    intervalMs = UNCLAIMED_APP_DATA_PURGE_INTERVAL_MS,
    runImmediately = true,
    ...options
  } = {}) {
    const delay = Number.isInteger(intervalMs) && intervalMs > 0 ? intervalMs : UNCLAIMED_APP_DATA_PURGE_INTERVAL_MS
    let stopped = false
    let running = false
    let timer = null

    const schedule = ms => {
      if (stopped) return
      timer = setTimeout(tick, ms)
      timer.unref?.()
    }

    const tick = async () => {
      if (stopped) return
      if (running) {
        schedule(delay)
        return
      }

      running = true
      try {
        await this.purgeUnclaimedAppData(options)
      } catch {
      } finally {
        running = false
        schedule(delay)
      }
    }

    schedule(runImmediately ? 0 : delay)

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }

  startExpirationPurge ({
    intervalMs = 3600000,
    runImmediately = true,
    ...options
  } = {}) {
    const delay = Number.isInteger(intervalMs) && intervalMs > 0 ? intervalMs : 3600000
    let stopped = false
    let running = false
    let timer = null

    const schedule = ms => {
      if (stopped) return
      timer = setTimeout(tick, ms)
      timer.unref?.()
    }

    const tick = async () => {
      if (stopped) return
      if (running) {
        schedule(delay)
        return
      }

      running = true
      try {
        await this.purgeExpired(options)
      } catch {
      } finally {
        running = false
        schedule(delay)
      }
    }

    schedule(runImmediately ? 0 : delay)

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }

  async query (filterOrFilters, options = {}) {
    const appRef = normalizeReadAppRef(options)
    let filters
    try {
      filters = parseFilterInput(filterOrFilters, options)
    } catch (error) {
      logNostrDbIssue('query', { ownerPubkey: this.ownerPubkey }, error)
      return queryResult([], undefined)
    }

    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return queryResult([], filters[0])

    try {
      const results = await queryParsedFilters(db, filters, {
        countOnly: false,
        ignoreLimit: false,
        decryptPersonalCopyContent: this.personalCopyDecrypt
      })
      await hydrateChunkResults(this.ownerPubkey, results)
      this.queueAppClaimsFromResults(results, appRef)
      return queryResult(results, filters[0])
    } catch (error) {
      logNostrDbIssue('query', { ownerPubkey: this.ownerPubkey }, error)
      return queryResult([], filters[0])
    }
  }

  async count (filterOrFilters, options = {}) {
    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return 0

    try {
      const filters = parseFilterInput(filterOrFilters, options)
      return await queryParsedFilters(db, filters, {
        countOnly: true,
        ignoreLimit: false,
        decryptPersonalCopyContent: this.personalCopyDecrypt
      })
    } catch (error) {
      logNostrDbIssue('count', { ownerPubkey: this.ownerPubkey }, error)
      return 0
    }
  }

  async supports () {
    return [
      'search',
      'search:sort:asc',
      'search:sort:desc',
      // Note: it could instead be an `algo: "sync"` filter field
      // but we decided to use search extensions for any custom
      // behavior we come up with
      'search:algo:sync',
      'search:autocomplete:true',
      'ids_only',
      '!ids',
      '&tags',
      'multi_filters',
      'subscribe:scheduled',
      'app_export'
    ]
  }

  async deleteDb () {
    this.stopMaintenance()
    this.bc?.close()
    this.bc = null
    return deleteNostrDb(this.ownerPubkey)
  }

  stopMaintenance () {
    stopNostrDbMaintenance(this)
  }

  // App reinstall backfill flow: a device that still has app-scoped rows can
  // stream them to another device, which re-imports each event with add(event, { appId }).
  // Resume interrupted transfers with either skip: receivedCount or after: lastReceivedEventId
  async * exportEventsByApp (appId, { batchSize = APP_EXPORT_BATCH_SIZE, skip = 0, after } = {}) {
    const appRef = normalizeOptionalAppRef(appId)
    if (!appRef) return

    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return

    const size = normalizeBatchSize(batchSize, APP_EXPORT_BATCH_SIZE, APP_EXPORT_MAX_BATCH_SIZE)
    let remainingSkip = normalizeSkip(skip)
    let afterIdKey = typeof after === 'string' && HEX64_RE.test(after) ? eventIdIndexKey(after) : null

    try {
      while (true) {
        const { idKeys, skipped, afterMatched } = await collectAppEventIdKeyBatch(db, appRef, {
          batchSize: size,
          skip: remainingSkip,
          afterIdKey
        })
        remainingSkip -= skipped
        if (afterIdKey && !afterMatched) return
        if (idKeys.length === 0) return

        afterIdKey = idKeys[idKeys.length - 1]
        const records = await getStoredRecordsByIdKeys(db, idKeys)
        const events = idKeys
          .map(idKey => records.get(idKey))
          .filter(stored => stored?.event && hasAppRef(stored.ap, appRef))
          .map(stored => stored.event)

        await hydrateChunkResults(this.ownerPubkey, events)

        if (events.length > 0) yield events
        if (idKeys.length < size) return
      }
    } catch (error) {
      logNostrDbIssue('exportEventsByApp', { ownerPubkey: this.ownerPubkey }, error)
    }
  }

  // Used by the app uninstall flow. Exclusive app-owned rows are physically
  // deleted; shared rows only lose this app's ownership ref.
  async deleteEventsByApp (appId) {
    const appRef = normalizeOptionalAppRef(appId)
    if (!appRef) return 0

    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return 0

    try {
      let deleted = 0

      while (true) {
        const { idKeys } = await collectAppEventIdKeyBatch(db, appRef, {
          batchSize: APP_DELETE_BATCH_SIZE
        })
        if (idKeys.length === 0) return deleted

        deleted += await deleteAppEventBatch(db, appRef, idKeys)
      }
    } catch {
      return 0
    }
  }

  // Normal subscriptions stream matching added events immediately. With
  // { scheduled: true }, durable future events wait until created_at <= now + 2;
  // regular and honorary ephemeral events are still streamed immediately.
  subscribe (filterOrFilters, options = {}) {
    const filters = parseFilterInput(filterOrFilters, options)
    const idsOnly = filters[0]?.idsOnly === true
    const appRef = idsOnly ? undefined : normalizeReadAppRef(options)
    const subscription = createSubscription(filters, {
      idsOnly,
      limit: filters[0]?.limit ?? Infinity,
      ownerPubkey: this.ownerPubkey,
      scheduled: options?.scheduled === true,
      claimEvent: appRef ? event => this.queueAppClaim(event, appRef) : null
    })
    this.subscriptions.add(subscription)

    const iterator = subscription.iterator(() => {
      this.subscriptions.delete(subscription)
    })
    return hydrateChunkSubscription(this.ownerPubkey, iterator)
  }

  queueAppClaimsFromResults (results, appRef) {
    if (!appRef || !Array.isArray(results)) return
    for (const result of results) this.queueAppClaim(result, appRef)
  }

  queueAppClaim (event, appRef) {
    if (!appRef || !event || typeof event !== 'object') return
    if (!HEX64_RE.test(event.id) || !isAppTrackableKind(event.kind)) return

    const key = appClaimQueueKey(appRef)
    let queue = this.appClaimQueues.get(key)
    if (!queue) {
      queue = { appRef, idKeys: new Set() }
      this.appClaimQueues.set(key, queue)
    }
    queue.idKeys.add(eventIdIndexKey(event.id))

    if (appClaimQueueSize(this.appClaimQueues) >= APP_CLAIM_BATCH_SIZE) {
      this.flushAppClaims().catch(() => {})
    } else {
      this.scheduleAppClaimFlush()
    }
  }

  scheduleAppClaimFlush (delay = APP_CLAIM_DEBOUNCE_MS) {
    if (this.appClaimTimer || this.appClaimQueues.size === 0) return
    this.appClaimTimer = setTimeout(() => {
      this.appClaimTimer = null
      this.flushAppClaims().catch(() => {})
    }, delay)
    this.appClaimTimer.unref?.()
  }

  async flushAppClaims () {
    if (this.appClaimTimer) {
      clearTimeout(this.appClaimTimer)
      this.appClaimTimer = null
    }

    if (this.appClaimRunning) {
      this.appClaimFlushAgain = true
      return 0
    }
    if (this.appClaimQueues.size === 0) return 0

    const queues = this.appClaimQueues
    this.appClaimQueues = new Map()
    this.appClaimRunning = true
    let changed = 0

    try {
      changed = await writeAppClaimQueues(this.ownerPubkey, queues)
    } catch {
      changed = 0
    } finally {
      this.appClaimRunning = false
      if (this.appClaimQueues.size > 0 || this.appClaimFlushAgain) {
        this.appClaimFlushAgain = false
        this.scheduleAppClaimFlush(0)
      }
    }

    return changed
  }

  publish (event, shouldBroadcast, storedRecord) {
    for (const subscription of this.subscriptions) {
      subscription.push(event, storedRecord)
    }

    if (shouldBroadcast) {
      this.bc?.postMessage({
        type: 'event',
        sender: this.sender,
        event,
        syncAnchor: storedRecord?.sa
      })
    }
  }
}

async function countBlobReferences (db, root) {
  try {
    return await run('count', [IDBKeyRange.only(root)], EVENTS_STORE, INDEX.blobRef, { db })
      .then(value => value.result)
  } catch {
    return 0
  }
}

async function getChunkRecordBatch (db, root, limit) {
  const records = []
  await scanCursor(
    db,
    EVENTS_STORE,
    INDEX.chunk,
    IDBKeyRange.bound([root, 0], [root, Number.MAX_SAFE_INTEGER]),
    {
      onItem: stored => {
        records.push(stored)
        return records.length < limit
      }
    }
  )
  return records
}

async function getAllChunkRecordBatch (db, after, limit) {
  const records = []
  const range = after
    ? IDBKeyRange.lowerBound(after, true)
    : null
  await scanCursor(db, EVENTS_STORE, INDEX.chunk, range, {
    onItem: stored => {
      records.push(stored)
      return records.length < limit
    }
  })
  return records
}

async function stageChunkPayloadWithPressure (nostrDb, db, chunkData) {
  const referenceCount = await countBlobReferences(db, chunkData.root)
  const protectedRoot = referenceCount > 0
  await setOwnerRootReferenceCount(nostrDb.ownerPubkey, chunkData.root, referenceCount)

  while (true) {
    try {
      return await stageChunkPayload({
        contentHash: chunkData.contentHash,
        contentBytes: chunkData.contentBytes,
        owner: nostrDb.ownerPubkey,
        protectedRoot
      })
    } catch (error) {
      if (!(error instanceof ChunkQuotaError)) throw error
      if (!await purgeOneChunkRootForCapacity()) throw error
    }
  }
}

async function purgeOneChunkRootForCapacity () {
  const candidates = await listChunkRootPurgeCandidates({ limit: CHUNK_PURGE_BATCH_SIZE })
  for (const candidate of candidates) {
    const db = getNostrDb(candidate.owner, { maintenance: false })
    const removed = await db.purgeChunkRoot(candidate.root, { force: true })
    if (removed > 0) return true
    if (!await getOwnerChunkRoot(candidate.owner, candidate.root)) return true
  }
  return false
}

async function finishChunkStage (stage, { owner, event, chunkData, protectedRoot }) {
  if (!stage || !chunkData) return
  try {
    await commitChunkCopy({
      owner,
      root: chunkData.root,
      index: chunkData.index,
      total: chunkData.total,
      eventId: event.id,
      contentHash: chunkData.contentHash,
      byteLength: chunkData.byteLength,
      protectedRoot
    })
  } catch (error) {
    await abortChunkPayloadStage(stage).catch(() => {})
    logNostrDbIssue('chunkCommit', {
      ownerPubkey: owner,
      code: 'error',
      message: 'Chunk event was stored but its shared payload link needs reconciliation.',
      event: eventLogSummary(event)
    }, error)
  }
}

const blobReferenceReconciliation = new Map()

function scheduleBlobReferenceReconciliation (owner, roots) {
  if (!owner || !Array.isArray(roots) || roots.length === 0) return
  let pending = blobReferenceReconciliation.get(owner)
  if (!pending) {
    pending = { roots: new Set(), timer: null }
    blobReferenceReconciliation.set(owner, pending)
  }
  for (const root of roots) pending.roots.add(root)
  if (pending.timer) return
  pending.timer = setTimeout(async () => {
    blobReferenceReconciliation.delete(owner)
    const db = await openNostrDb(owner)
    if (!db) return
    for (const root of pending.roots) {
      const count = await countBlobReferences(db, root)
      await setOwnerRootReferenceCount(owner, root, count).catch(() => {})
    }
  }, 0)
  pending.timer.unref?.()
}

async function getReferencedRootBatch (db, after, limit) {
  const roots = []
  const range = after ? IDBKeyRange.lowerBound(after, true) : null
  await scanKeyCursor(db, EVENTS_STORE, INDEX.blobRef, range, {
    direction: 'nextunique',
    onItem: ({ key }) => {
      roots.push(key)
      return roots.length < limit
    }
  })
  return roots
}

async function deleteInvalidChunkRecord (db, stored) {
  const transaction = db.transaction([EVENTS_STORE, DELETIONS_STORE], 'readwrite')
  const done = txDone(transaction)
  try {
    const current = await run('get', [stored.i], EVENTS_STORE, null, { db, tx: transaction })
      .then(value => value.result)
    if (current?.k === 34601) await deleteStoredEvent(db, transaction, current)
    await done
  } catch {
    try { transaction.abort() } catch {}
    await done.catch(() => {})
  }
  await removeChunkCopy(stored.event?.pubkey, stored.cr, stored.ci).catch(() => {})
}

async function reconcileOwnerChunks (nostrDb) {
  const db = await openNostrDb(nostrDb.ownerPubkey)
  if (!db) return

  let centralAfter
  while (true) {
    const centralCopies = await listOwnerChunkCopiesPage(nostrDb.ownerPubkey, {
      after: centralAfter,
      limit: CHUNK_PURGE_BATCH_SIZE
    })
    if (centralCopies.length === 0) break
    for (const copy of centralCopies) {
      const stored = await run('get', [eventIdIndexKey(copy.eventId)], EVENTS_STORE, null, { db })
        .then(value => value.result)
      if (
        !stored ||
        stored.k !== 34601 ||
        stored.cr !== copy.root ||
        stored.ci !== copy.index ||
        stored.ch !== copy.contentHash
      ) {
        await removeChunkCopy(nostrDb.ownerPubkey, copy.root, copy.index).catch(() => {})
      }
    }
    const last = centralCopies[centralCopies.length - 1]
    centralAfter = { root: last.root, index: last.index }
    if (centralCopies.length < CHUNK_PURGE_BATCH_SIZE) break
  }

  let after = null
  while (true) {
    const records = await getAllChunkRecordBatch(db, after, CHUNK_PURGE_BATCH_SIZE)
    if (records.length === 0) break
    for (const stored of records) {
      const contentBytes = await getChunkPayload(stored.ch, { touch: false })
      if (!contentBytes) {
        await deleteInvalidChunkRecord(db, stored)
        continue
      }

      let data
      try {
        const fullEvent = { ...stored.event, content: base93Encode(contentBytes) }
        data = validateCanonicalOwnerChunkEvent(fullEvent, nostrDb.ownerPubkey)
        if (
          data.root !== stored.cr ||
          data.index !== stored.ci ||
          data.total !== stored.ct ||
          data.contentHash !== stored.ch ||
          data.byteLength !== stored.cb
        ) throw new Error('Chunk metadata mismatch')
      } catch {
        await deleteInvalidChunkRecord(db, stored)
        continue
      }

      const copy = await getOwnerChunkCopy(nostrDb.ownerPubkey, data.root, data.index)
      if (!copy || copy.eventId !== stored.event.id || copy.contentHash !== data.contentHash) {
        const referenceCount = await countBlobReferences(db, data.root)
        await commitChunkCopy({
          owner: nostrDb.ownerPubkey,
          root: data.root,
          index: data.index,
          total: data.total,
          eventId: stored.event.id,
          contentHash: data.contentHash,
          byteLength: data.byteLength,
          protectedRoot: referenceCount > 0
        }).catch(error => {
          logNostrDbIssue('chunkReconcileCommit', {
            ownerPubkey: nostrDb.ownerPubkey,
            code: 'error',
            message: 'Could not repair a shared chunk payload link.',
            event: eventLogSummary(stored.event)
          }, error)
        })
      }
    }
    const last = records[records.length - 1]
    after = [last.cr, last.ci]
    if (records.length < CHUNK_PURGE_BATCH_SIZE) break
  }

  let referenceAfter
  while (true) {
    const roots = await getReferencedRootBatch(db, referenceAfter, CHUNK_PURGE_BATCH_SIZE)
    if (roots.length === 0) break
    for (const root of roots) {
      await setOwnerRootReferenceCount(
        nostrDb.ownerPubkey,
        root,
        await countBlobReferences(db, root)
      )
    }
    referenceAfter = roots[roots.length - 1]
    if (roots.length < CHUNK_PURGE_BATCH_SIZE) break
  }

  let rootAfter
  while (true) {
    const roots = await listOwnerChunkRootsPage(nostrDb.ownerPubkey, {
      after: rootAfter,
      limit: CHUNK_PURGE_BATCH_SIZE
    })
    if (roots.length === 0) break
    for (const { root } of roots) {
      await setOwnerRootReferenceCount(
        nostrDb.ownerPubkey,
        root,
        await countBlobReferences(db, root)
      )
    }
    rootAfter = roots[roots.length - 1].root
    if (roots.length < CHUNK_PURGE_BATCH_SIZE) break
  }
  await markChunkReconciled()
}

export async function maintainAllChunkCaches ({ fullPayloadSweep = false } = {}) {
  if (typeof indexedDB === 'undefined') return { owners: 0 }
  const owners = new Set(await listChunkCacheOwners().catch(() => []))
  if (typeof indexedDB.databases === 'function') {
    try {
      for (const { name } of await indexedDB.databases()) {
        if (!name?.startsWith(NOSTRDB_PREFIX)) continue
        const owner = name.slice(NOSTRDB_PREFIX.length)
        if (HEX64_RE.test(owner)) owners.add(owner.toLowerCase())
      }
    } catch {}
  }

  for (const owner of [...owners].sort()) {
    await getNostrDb(owner, { maintenance: false }).maintainChunks().catch(() => {})
  }
  if (fullPayloadSweep) {
    let restart = true
    while (true) {
      const result = await reconcileStaleChunkPayloadStages({ restart }).catch(() => null)
      if (!result || result.reachedEnd) break
      restart = false
    }
  } else {
    await reconcileStaleChunkPayloadStages().catch(() => {})
  }
  return { owners: owners.size }
}

export function startGlobalChunkMaintenance ({
  intervalMs = CHUNK_MAINTENANCE_INTERVAL_MS,
  runImmediately = true
} = {}) {
  if (globalChunkMaintenance) return globalChunkMaintenance.stop
  const delay = Number.isSafeInteger(intervalMs) && intervalMs > 0
    ? intervalMs
    : CHUNK_MAINTENANCE_INTERVAL_MS
  let stopped = false
  let running = false
  let firstRun = true
  let timer
  const schedule = milliseconds => {
    if (stopped) return
    timer = setTimeout(tick, milliseconds)
    timer.unref?.()
  }
  const tick = async () => {
    if (stopped) return
    if (!running) {
      running = true
      await maintainAllChunkCaches({ fullPayloadSweep: firstRun }).catch(() => {})
      firstRun = false
      running = false
    }
    schedule(delay)
  }
  const stop = () => {
    stopped = true
    if (timer) clearTimeout(timer)
    if (globalChunkMaintenance?.stop === stop) globalChunkMaintenance = null
  }
  globalChunkMaintenance = { stop }
  schedule(runImmediately ? 0 : delay)
  return stop
}

function startNostrDbMaintenance (db, { signEvent } = {}) {
  startMaintenanceTask(db, 'chunks', () => db.startChunkMaintenance())
  startMaintenanceTask(db, 'unclaimedAppData', () => db.startUnclaimedAppDataPurge({
    intervalMs: UNCLAIMED_APP_DATA_PURGE_INTERVAL_MS,
    runImmediately: false
  }))
  startMaintenanceTask(db, 'expiration', () => db.startExpirationPurge())
  if (typeof signEvent === 'function') {
    db.deletionRequestMaintenanceSignEvent = signEvent
    startMaintenanceTask(db, 'deletionRequests', () => db.startDeletionRequestMaintenance({
      signEvent: event => {
        if (typeof db.deletionRequestMaintenanceSignEvent !== 'function') throw new TypeError('compactDeletionRequests requires a sign function')
        return db.deletionRequestMaintenanceSignEvent(event)
      }
    }))
  }
}

function startMaintenanceTask (db, key, start) {
  if (db.maintenanceStops.has(key)) return
  const stop = start()
  if (typeof stop === 'function') db.maintenanceStops.set(key, stop)
}

function stopNostrDbMaintenance (db) {
  if (!db?.maintenanceStops) return
  for (const stop of db.maintenanceStops.values()) {
    try { stop() } catch {}
  }
  db.maintenanceStops.clear()
  db.deletionRequestMaintenanceSignEvent = null
}

export async function openNostrDb (ownerPubkey) {
  if (typeof indexedDB === 'undefined') return null

  const dbName = `${NOSTRDB_PREFIX}${ownerPubkey}`
  if (!dbCache.has(dbName)) {
    dbCache.set(dbName, initNostrDb(dbName).catch(() => null))
  }
  return dbCache.get(dbName)
}

export async function deleteNostrDb (ownerPubkey) {
  if (typeof indexedDB === 'undefined') return false

  const dbName = `${NOSTRDB_PREFIX}${ownerPubkey}`
  const store = storeCache.get(ownerPubkey)
  store?.stopMaintenance?.()
  store?.bc?.close()
  if (store) store.bc = null
  storeCache.delete(ownerPubkey)

  const cached = dbCache.get(dbName)
  dbCache.delete(dbName)

  try {
    const db = await cached
    db?.close()
  } catch {}

  return new Promise(resolve => {
    let req

    try {
      req = indexedDB.deleteDatabase(dbName)
    } catch {
      resolve(false)
      return
    }

    req.onsuccess = () => {
      clearOwnerChunkCache(ownerPubkey)
        .then(() => resolve(true), () => resolve(true))
    }
    req.onerror = () => resolve(false)
    req.onblocked = () => resolve(false)
  })
}

function initNostrDb (dbName) {
  const p = Promise.withResolvers()
  let req

  try {
    req = indexedDB.open(dbName, NOSTRDB_VERSION)
  } catch {
    return Promise.resolve(null)
  }

  req.onerror = () => p.resolve(null)
  req.onblocked = () => p.resolve(null)
  req.onsuccess = () => {
    const db = req.result
    db.onversionchange = () => {
      db.close()
      dbCache.delete(dbName)
    }
    syncAppNeutralKindRegistry(db).finally(() => p.resolve(db))
  }
  req.onupgradeneeded = e => {
    const db = e.target.result
    const tx = e.target.transaction
    let store

    store = createObjectStoreIfMissing(db, tx, EVENTS_STORE, { keyPath: 'i' })
    createIndexIfMissing(store, INDEX.address, 'a', { unique: true })
    createIndexIfMissing(store, INDEX.app, 'ap', { multiEntry: true })
    createIndexIfMissing(store, INDEX.createdAt, 'ca')
    createIndexIfMissing(store, INDEX.syncAnchor, 'sa')
    createIndexIfMissing(store, INDEX.expiration, 'ex')
    createIndexIfMissing(store, INDEX.pubkey, ['p', 'ca'])
    createIndexIfMissing(store, INDEX.kind, ['k', 'ca'])
    createIndexIfMissing(store, INDEX.pubkeyKind, ['p', 'k', 'ca'])
    createIndexIfMissing(store, INDEX.tag, 't', { multiEntry: true })
    createIndexIfMissing(store, INDEX.chunk, ['cr', 'ci'], { unique: true })
    createIndexIfMissing(store, INDEX.blobRef, 'br', { multiEntry: true })

    store = createObjectStoreIfMissing(db, tx, DELETIONS_STORE, { keyPath: 'ref' })
    createIndexIfMissing(store, DELETION_INDEX.request, 'c', { multiEntry: true })

    createObjectStoreIfMissing(db, tx, KIND_REGISTRY_STORE, { keyPath: 'key' })
  }

  return p.promise
}

function createObjectStoreIfMissing (db, tx, name, options) {
  return db.objectStoreNames.contains(name)
    ? tx.objectStore(name)
    : db.createObjectStore(name, options)
}

function createIndexIfMissing (store, name, keyPath, options) {
  if (!store.indexNames.contains(name)) {
    store.createIndex(name, keyPath, options)
  }
}

async function syncAppNeutralKindRegistry (db) {
  try {
    const currentKinds = appNeutralKindList()
    const current = kindRegistryRecord(currentKinds)
    const tx = db.transaction([KIND_REGISTRY_STORE], 'readonly')
    const done = txDone(tx)
    const previous = await run('get', [APP_NEUTRAL_KINDS_KEY], KIND_REGISTRY_STORE, null, { db, tx })
      .then(v => v.result)

    await done

    if (Array.isArray(previous?.kinds) && !sameKindList(previous.kinds, currentKinds)) {
      const previousKinds = new Set(previous.kinds)
      const newlyKnownKinds = currentKinds
        .filter(kind => !previousKinds.has(kind))

      if (newlyKnownKinds.length > 0) {
        await removeAppRefsFromKinds(db, newlyKnownKinds)
      }
    }

    const writeTx = db.transaction([KIND_REGISTRY_STORE], 'readwrite')
    const writeDone = txDone(writeTx)
    await run('put', [current], KIND_REGISTRY_STORE, null, { db, tx: writeTx })
    await writeDone
  } catch {
  }
}

async function removeAppRefsFromKinds (db, kinds) {
  const idKeys = []

  for (const kind of kinds) {
    const range = IDBKeyRange.bound([kind, 0], [kind, Infinity])
    await scanKeyCursor(db, EVENTS_STORE, INDEX.kind, range, {
      onItem: cursor => {
        if (!idKeys.some(idKey => compareKeys(idKey, cursor.primaryKey) === 0)) {
          idKeys.push(cursor.primaryKey)
        }
        return true
      }
    })
  }

  if (idKeys.length === 0) return

  const tx = db.transaction([EVENTS_STORE], 'readwrite')
  const done = txDone(tx)
  const cleanupKinds = new Set(kinds)

  for (const idKey of idKeys) {
    const stored = await run('get', [idKey], EVENTS_STORE, null, { db, tx })
      .then(v => v.result)
    if (!stored?.ap || !cleanupKinds.has(stored.k) || isCustomAppDataKind(stored.k)) continue

    delete stored.ap
    await run('put', [stored], EVENTS_STORE, null, { db, tx })
  }

  await done
}

async function collectAppEventIdKeyBatch (db, appRef, {
  batchSize,
  skip = 0,
  afterIdKey = null
} = {}) {
  const idKeys = []
  let skipped = 0
  let afterMatched = afterIdKey === null

  await scanKeyCursor(db, EVENTS_STORE, INDEX.app, IDBKeyRange.only(appRef), {
    onItem: cursor => {
      if (!afterMatched) {
        afterMatched = compareKeys(cursor.primaryKey, afterIdKey) === 0
        return true
      }
      if (skipped < skip) {
        skipped++
        return true
      }
      if (!idKeys.some(idKey => compareKeys(idKey, cursor.primaryKey) === 0)) {
        idKeys.push(cursor.primaryKey)
      }
      return idKeys.length < batchSize
    }
  })

  return { idKeys, skipped, afterMatched }
}

function appClaimQueueKey (appRef) {
  return JSON.stringify(appRef)
}

function appClaimQueueSize (queues) {
  let size = 0
  for (const queue of queues.values()) size += queue.idKeys.size
  return size
}

async function writeAppClaimQueues (ownerPubkey, queues) {
  const db = await openNostrDb(ownerPubkey)
  if (!db || queues.size === 0) return 0

  const tx = db.transaction([EVENTS_STORE], 'readwrite')
  const done = txDone(tx)
  let changedCount = 0

  for (const { appRef, idKeys } of queues.values()) {
    for (const idKey of idKeys) {
      const stored = await run('get', [idKey], EVENTS_STORE, null, { db, tx })
        .then(v => v.result)
      if (!stored) continue

      const beforeSa = stored.sa
      const beforeRa = stored.ra
      const changed = mergeAppRef(stored, appRef)
      if (!changed) continue

      stored.sa = beforeSa
      stored.ra = beforeRa
      await run('put', [stored], EVENTS_STORE, null, { db, tx })
      changedCount++
    }
  }

  await done
  return changedCount
}

function isUnclaimedAppDataCleanupCandidate (stored, cutoffMs) {
  if (!stored?.event || !isAppTrackableKind(stored.k)) return false
  if (normalizeAppRefs(stored.ap).length > 0) return false
  const receivedAt = Number.isFinite(stored.ra) ? stored.ra : -Infinity
  return receivedAt <= cutoffMs
}

async function deleteUnclaimedAppDataBatch (db, idKeys, cutoffMs) {
  const tx = db.transaction([EVENTS_STORE, DELETIONS_STORE], 'readwrite')
  const done = txDone(tx)
  let deleted = 0

  for (const idKey of idKeys) {
    const stored = await run('get', [idKey], EVENTS_STORE, null, { db, tx })
      .then(v => v.result)
    if (!isUnclaimedAppDataCleanupCandidate(stored, cutoffMs)) continue

    await deleteStoredEvent(db, tx, stored)
    deleted++
  }

  await done
  return deleted
}

async function deleteAppEventBatch (db, appRef, idKeys) {
  const tx = db.transaction([EVENTS_STORE, DELETIONS_STORE], 'readwrite')
  const done = txDone(tx)
  let deleted = 0

  for (const idKey of idKeys) {
    const stored = await run('get', [idKey], EVENTS_STORE, null, { db, tx })
      .then(v => v.result)
    if (!stored) continue

    const refs = removeAppRef(stored.ap, appRef)
    if (refs.length === 0) {
      await deleteStoredEvent(db, tx, stored)
      deleted++
    } else {
      stored.ap = refs
      await run('put', [stored], EVENTS_STORE, null, { db, tx })
    }
  }

  await done
  return deleted
}

function kindRegistryRecord (kinds = appNeutralKindList()) {
  return {
    key: APP_NEUTRAL_KINDS_KEY,
    kinds
  }
}

function sameKindList (a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((kind, index) => kind === b[index])
}

const MAX_LIMIT = 200
const KEY_GATED_EXCLUDE_THRESHOLD = 128
const KEY_GATED_GET_BATCH_SIZE = 64
const APP_DELETE_BATCH_SIZE = 64
const APP_EXPORT_BATCH_SIZE = 64
const APP_EXPORT_MAX_BATCH_SIZE = 1000
// Keep compacted kind 5 events publishable to relays with a 100-tag cap.
const DELETION_COMPACTION_MAX_TAGS = 100
const DELETION_REQUEST_MAINTENANCE_MAX_REQUESTS = 1000
const DELETION_REQUEST_PRUNE_GRACE_MS = 30 * 24 * 60 * 60 * 1000
const DELETION_REQUEST_ADDRESS_TARGET_WEIGHT = 4
const DELETION_REQUEST_PRUNE_SCAN_BATCH_SIZE = 500
const DELETION_REQUEST_PRUNE_DELETE_BATCH_SIZE = 100

function parseFilterInput (filterOrFilters, options = {}) {
  const rawFilters = normalizeFilterList(filterOrFilters)
  if (rawFilters.length === 0) return []

  const controls = resolveFilterControls(rawFilters, normalizeOptions(options), {
    multi: Array.isArray(filterOrFilters)
  })

  return rawFilters.map(filter => new ParsedFilter(filter, controls))
}

function normalizeFilterList (filterOrFilters) {
  return Array.isArray(filterOrFilters) ? filterOrFilters : [filterOrFilters]
}

function normalizeOptions (options) {
  return options && typeof options === 'object' && !Array.isArray(options) ? options : {}
}

function resolveFilterControls (rawFilters, options, { multi }) {
  const first = rawFilters[0] && typeof rawFilters[0] === 'object' && !Array.isArray(rawFilters[0])
    ? rawFilters[0]
    : {}
  const controls = { ignoreFields: new Set() }
  const optionLimit = normalizeOptionalLimit(options.limit)

  if (multi || optionLimit !== undefined) {
    controls.hasLimit = true
    controls.limit = optionLimit ?? normalizeLimit(first.limit)
    controls.ignoreFields.add('limit')
  }

  if (multi || typeof options.ids_only === 'boolean') {
    controls.hasIdsOnly = true
    controls.idsOnly = typeof options.ids_only === 'boolean' ? options.ids_only : first.ids_only === true
    controls.ignoreFields.add('ids_only')
  }

  if (multi || typeof options.search === 'string') {
    controls.hasSearch = true
    controls.search = typeof options.search === 'string' ? options.search : first.search
    controls.ignoreFields.add('search')
  }

  return controls
}

function normalizeOptionalLimit (value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

async function queryRecords (db, rawFilter, { countOnly, ignoreLimit, tx } = {}) {
  const filters = parseFilterInput(rawFilter)
  if (tx && filters.length === 1) {
    return queryParsedFilterRecords(db, filters[0], { countOnly, ignoreLimit, tx })
  }
  return queryParsedFilters(db, filters, { countOnly, ignoreLimit })
}

async function queryParsedFilters (db, filters, { countOnly, ignoreLimit, decryptPersonalCopyContent } = {}) {
  const liveFilters = filters.filter(filter => !filter.neverMatch)
  if (liveFilters.length === 0) return countOnly ? 0 : []
  if (liveFilters.length === 1) {
    return queryParsedFilterRecords(db, liveFilters[0], { countOnly, ignoreLimit, decryptPersonalCopyContent })
  }

  return queryMultipleParsedFilters(db, liveFilters, { countOnly, ignoreLimit, decryptPersonalCopyContent })
}

async function queryParsedFilterRecords (db, filter, { countOnly, ignoreLimit, decryptPersonalCopyContent, tx }) {
  if (filter.neverMatch) return countOnly ? 0 : []

  const limit = ignoreLimit ? Infinity : Math.min(countOnly ? Infinity : MAX_LIMIT, filter.limit)
  if (limit <= 0) return countOnly ? 0 : []

  const plan = planQuery(filter)
  const direction = queryDirection(filter)
  const now = currentUnixTime()

  if (filter.searchText) {
    const candidates = await collectSearchCandidates(db, plan, filter, direction, {
      countOnly,
      limit,
      now,
      decryptPersonalCopyContent
    })

    if (countOnly) return Number.isFinite(limit) ? Math.min(candidates.length, limit) : candidates.length

    const ranked = rankSearchCandidates(candidates, filter, compareSearchTime)
    const results = ranked
      .slice(0, Number.isFinite(limit) ? limit : ranked.length)
      .map(candidate => candidate.event)
    return projectQueryResults(results, filter, scoreByCandidateId(ranked))
  }

  if (!tx && !countOnly && canUseKeyOnlyCursor(plan, filter)) {
    if (filter.idsOnly) {
      return queryIdsWithKeyCursor(db, plan, filter, direction, { limit, now })
    }

    // Key-gated fetching pays off during local DB sync when the other device
    // instance already has many IDs:
    // below this rough cutoff, one value cursor is usually cheaper than key cursor + per-row gets.
    if (filter.excludeIdKeySet?.size >= KEY_GATED_EXCLUDE_THRESHOLD) {
      return queryFullEventsWithKeyGate(db, plan, filter, direction, { limit, now })
    }
  }

  const seen = new Set()
  const results = []
  const scoreById = new Map()
  let count = 0

  const matches = stored => stored && isStoredRecordLive(stored, now) && filter.matchesStored(stored)
  const emit = stored => {
    if (!matches(stored) || seen.has(stored.event.id)) return false
    seen.add(stored.event.id)
    scoreById.set(stored.event.id, storedScore(stored, filter))
    count++
    if (!countOnly) results.push(stored.event)
    return true
  }

  if (plan.type === 'direct') {
    for (const cursor of plan.cursors) {
      const stored = await run('get', [cursor.key], EVENTS_STORE, cursor.indexName, { db, tx })
        .then(v => v.result)
      if (emit(stored) && countOnly && count >= limit) break
    }
  } else {
    for (const cursor of plan.cursors) {
      let matchedInCursor = 0

      await scanCursor(db, EVENTS_STORE, cursor.indexName, cursor.range, {
        tx,
        direction,
        onItem: stored => {
          if (!matches(stored)) return true
          matchedInCursor++
          emit(stored)
          if (countOnly && count >= limit) return false
          if (!countOnly && matchedInCursor >= limit) return false
          return true
        }
      })
      if (countOnly && count >= limit) break
    }
  }

  if (countOnly) return count

  results.sort(compareEventsForFilter(filter, scoreById))
  return projectQueryResults(Number.isFinite(limit) ? results.slice(0, limit) : results, filter, scoreById)
}

async function queryMultipleParsedFilters (db, filters, { countOnly, ignoreLimit, decryptPersonalCopyContent }) {
  const limit = ignoreLimit ? Infinity : Math.min(countOnly ? Infinity : MAX_LIMIT, filters[0].limit)
  if (limit <= 0) return countOnly ? 0 : []

  if (filters[0].searchText) {
    return queryMultipleSearchFilters(db, filters, { countOnly, limit, decryptPersonalCopyContent })
  }

  if (!countOnly && filters[0].idsOnly && filters.every(filter => canUseKeyOnlyCursor(planQuery(filter), filter))) {
    return queryMultipleIdsWithKeyCursor(db, filters, { limit })
  }

  const now = currentUnixTime()
  const seen = new Set()
  const results = []
  const scoreById = new Map()
  const compare = compareEventsForFilter(filters[0], scoreById)

  const emit = (event, score) => {
    if (seen.has(event.id)) return true

    seen.add(event.id)
    scoreById.set(event.id, score)
    if (countOnly) return !Number.isFinite(limit) || seen.size < limit

    results.push(event)
    if (Number.isFinite(limit) && results.length > limit) {
      results.sort(compare)
      results.length = limit
    }
    return true
  }

  for (const filter of filters) {
    const keepGoing = await scanParsedFilterEvents(db, filter, { now, limit, countOnly, onEvent: emit, decryptPersonalCopyContent })
    if (!keepGoing || (countOnly && seen.size >= limit)) break
  }

  if (countOnly) return Number.isFinite(limit) ? Math.min(seen.size, limit) : seen.size

  results.sort(compare)
  return projectQueryResults(Number.isFinite(limit) ? results.slice(0, limit) : results, filters[0], scoreById)
}

async function queryMultipleIdsWithKeyCursor (db, filters, { limit }) {
  const now = currentUnixTime()
  const seen = new Set()
  const results = []
  const compare = compareScoredResults(filters[0])

  for (const filter of filters) {
    const plan = planQuery(filter)
    const direction = queryDirection(filter)
    const candidates = await collectKeyGateCandidates(db, plan, filter, direction, { limit, now })

    for (const candidate of candidates) {
      if (seen.has(candidate.id)) continue

      seen.add(candidate.id)
      results.push(candidate)
      if (Number.isFinite(limit) && results.length > limit) {
        results.sort(compare)
        results.length = limit
      }
    }
  }

  results.sort(compare)
  const selected = Number.isFinite(limit) ? results.slice(0, limit) : results
  return withQueryScores(selected.map(result => result.id), selected.map(result => result.score))
}

async function queryMultipleSearchFilters (db, filters, { countOnly, limit, decryptPersonalCopyContent }) {
  const now = currentUnixTime()
  const candidatesById = new Map()

  for (const filter of filters) {
    const plan = planQuery(filter)
    const direction = queryDirection(filter)
    const candidates = await collectSearchCandidates(db, plan, filter, direction, {
      countOnly,
      limit,
      now,
      decryptPersonalCopyContent
    })

    for (const candidate of candidates) {
      if (!candidatesById.has(candidate.event.id)) candidatesById.set(candidate.event.id, candidate)
      if (countOnly && Number.isFinite(limit) && candidatesById.size >= limit) {
        return limit
      }
    }
  }

  if (countOnly) return Number.isFinite(limit) ? Math.min(candidatesById.size, limit) : candidatesById.size

  const ranked = rankSearchCandidates([...candidatesById.values()], filters[0], compareSearchTime)
  const events = ranked
    .slice(0, Number.isFinite(limit) ? limit : ranked.length)
    .map(candidate => candidate.event)
  return projectQueryResults(events, filters[0], scoreByCandidateId(ranked))
}

async function scanParsedFilterEvents (db, filter, { now, limit, countOnly, onEvent, decryptPersonalCopyContent }) {
  const plan = planQuery(filter)
  const direction = queryDirection(filter)
  const seen = new Set()

  const emit = stored => {
    if (!stored || !isStoredRecordLive(stored, now) || !filter.matchesStored(stored)) return true
    if (seen.has(stored.event.id)) return true

    seen.add(stored.event.id)
    return onEvent(stored.event, storedScore(stored, filter)) !== false
  }

  if (filter.searchText) {
    const candidates = await collectSearchCandidates(db, plan, filter, direction, {
      countOnly,
      limit,
      now,
      decryptPersonalCopyContent
    })
    const events = countOnly
      ? candidates.map(candidate => candidate.event)
      : rankSearchCandidates(candidates, filter, compareSearchTime).map(candidate => candidate.event)

    for (const event of events) {
      if (seen.has(event.id)) continue
      seen.add(event.id)
      const candidate = candidates.find(candidate => candidate.event.id === event.id)
      if (onEvent(event, candidate?.score ?? queryScore(event, null, filter)) === false) return false
    }
    return true
  }

  if (plan.type === 'direct') {
    for (const cursor of plan.cursors) {
      const stored = await run('get', [cursor.key], EVENTS_STORE, cursor.indexName, { db })
        .then(v => v.result)
      if (emit(stored) === false) return false
    }
    return true
  }

  for (const cursor of plan.cursors) {
    let stopped = false

    await scanCursor(db, EVENTS_STORE, cursor.indexName, cursor.range, {
      direction,
      onItem: stored => {
        if (emit(stored) === false) {
          stopped = true
          return false
        }
        return true
      }
    })

    if (stopped) return false
  }

  return true
}

function projectQueryResults (events, filter, scoreById) {
  const results = filter.idsOnly ? events.map(event => event.id) : events
  const scores = events.map(event => scoreById?.get(event.id) ?? queryScore(event, null, filter))
  return withQueryScores(results, scores)
}

function withQueryScores (results, scores) {
  Object.defineProperty(results, QUERY_SCORES, {
    value: scores,
    configurable: true
  })
  return results
}

function queryResult (results, filter) {
  const scores = Array.isArray(results)
    ? results[QUERY_SCORES] ?? results.map(result => queryScoreFromResult(result, filter))
    : []
  return {
    results,
    meta: {
      algorithm: queryAlgorithm(filter),
      sort: querySort(filter),
      scores,
      firstScore: scores.length > 0 ? scores[0] : null,
      lastScore: scores.length > 0 ? scores[scores.length - 1] : null
    }
  }
}

async function hydrateChunkEvent (ownerPubkey, event) {
  if (!event || event.kind !== 34601 || typeof event.content === 'string') return event
  const payload = await getChunkPayloadForEvent(ownerPubkey, event.id)
  if (!payload) return null
  return { ...event, content: base93Encode(payload.contentBytes) }
}

async function hydrateChunkResults (ownerPubkey, results) {
  if (!Array.isArray(results)) return results
  const scores = results[QUERY_SCORES]
  for (let index = results.length - 1; index >= 0; index--) {
    if (typeof results[index] === 'string') continue
    const hydrated = await hydrateChunkEvent(ownerPubkey, results[index])
    if (hydrated) {
      results[index] = hydrated
    } else {
      results.splice(index, 1)
      scores?.splice(index, 1)
    }
  }
  return results
}

function hydrateChunkSubscription (ownerPubkey, iterator) {
  return {
    [Symbol.asyncIterator] () { return this },
    async next () {
      while (true) {
        const item = await iterator.next()
        if (item.done || typeof item.value?.result === 'string') return item
        const event = await hydrateChunkEvent(ownerPubkey, item.value?.result)
        if (event) return { ...item, value: { ...item.value, result: event } }
      }
    },
    return (value) {
      return iterator.return?.(value) ?? Promise.resolve({ done: true, value })
    },
    throw (error) {
      return iterator.throw?.(error) ?? Promise.reject(error)
    }
  }
}

function queryAlgorithm (filter) {
  return filter?.algorithm === 'sync' ? 'sync' : 'created_at'
}

function querySort (filter) {
  return filter?.sort === 'asc' ? 'asc' : 'desc'
}

function queryDirection (filter) {
  return querySort(filter) === 'asc' ? 'next' : 'prev'
}

function queryScoreFromResult (result, filter) {
  if (typeof result === 'string') return null
  return queryScore(result, null, filter)
}

function queryScore (event, stored, filter) {
  if (queryAlgorithm(filter) === 'sync') {
    return Number.isFinite(stored?.sa) ? stored.sa : event.created_at
  }
  return event.created_at
}

function storedScore (stored, filter) {
  return queryScore(stored.event, stored, filter)
}

function compareEventsForFilter (filter, scoreById) {
  const direction = querySort(filter)
  return (a, b) => {
    const aScore = scoreById?.get(a.id) ?? queryScore(a, null, filter)
    const bScore = scoreById?.get(b.id) ?? queryScore(b, null, filter)
    if (aScore !== bScore) return direction === 'asc' ? aScore - bScore : bScore - aScore
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }
}

function compareScoredResults (filter) {
  const direction = querySort(filter)
  return (a, b) => {
    if (a.score !== b.score) return direction === 'asc' ? a.score - b.score : b.score - a.score
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }
}

function scoreByCandidateId (candidates) {
  const scores = new Map()
  for (const candidate of candidates) scores.set(candidate.event.id, candidate.score)
  return scores
}

async function queryIdsWithKeyCursor (db, plan, filter, direction, { limit, now }) {
  const expiredIdKeySet = await getExpiredIdKeySet(db, now)
  const seen = new Set()
  const results = []

  for (const cursor of plan.cursors) {
    let matchedInCursor = 0

    await scanKeyCursor(db, EVENTS_STORE, cursor.indexName, cursor.range, {
      direction,
      onItem: item => {
        const idKey = item.primaryKey
        if (seen.has(idKey)) return true
        if (filter.excludeIdKeySet?.has(idKey)) return true
        if (expiredIdKeySet.has(idKey)) return true

        seen.add(idKey)
        matchedInCursor++
        results.push({
          id: idKeyToEventId(idKey),
          score: scoreFromIndexKey(item.key, cursor.indexName)
        })

        return matchedInCursor < limit
      }
    })
  }

  results.sort(compareScoredResults(filter))
  const selected = Number.isFinite(limit) ? results.slice(0, limit) : results
  return withQueryScores(selected.map(result => result.id), selected.map(result => result.score))
}

// Unlike the normal value cursor, this scans index keys first and fetches full
// rows only for IDs that are not already known by the other local DB instance.
async function queryFullEventsWithKeyGate (db, plan, filter, direction, { limit, now }) {
  const candidates = await collectKeyGateCandidates(db, plan, filter, direction, { limit, now })
  const results = []
  const scoreById = new Map()
  const matches = stored => stored && isStoredRecordLive(stored, now) && filter.matchesStored(stored)

  for (let i = 0; i < candidates.length; i += KEY_GATED_GET_BATCH_SIZE) {
    const batch = candidates.slice(i, i + KEY_GATED_GET_BATCH_SIZE)
    const records = await getStoredRecordsByIdKeys(db, batch.map(candidate => candidate.idKey))

    for (const candidate of batch) {
      const stored = records.get(candidate.idKey)
      if (!matches(stored)) continue

      results.push(stored.event)
      scoreById.set(stored.event.id, candidate.score)
    }
  }

  results.sort(compareEventsForFilter(filter, scoreById))
  return projectQueryResults(Number.isFinite(limit) ? results.slice(0, limit) : results, filter, scoreById)
}

async function collectKeyGateCandidates (db, plan, filter, direction, { limit, now }) {
  const expiredIdKeySet = await getExpiredIdKeySet(db, now)
  const seen = new Set()
  const candidates = []

  for (const cursor of plan.cursors) {
    let matchedInCursor = 0

    await scanKeyCursor(db, EVENTS_STORE, cursor.indexName, cursor.range, {
      direction,
      onItem: item => {
        const idKey = item.primaryKey
        if (seen.has(idKey)) return true
        if (filter.excludeIdKeySet?.has(idKey)) return true
        if (expiredIdKeySet.has(idKey)) return true

        seen.add(idKey)
        matchedInCursor++
        candidates.push({
          id: idKeyToEventId(idKey),
          idKey,
          score: scoreFromIndexKey(item.key, cursor.indexName)
        })

        return matchedInCursor < limit
      }
    })
  }

  candidates.sort(compareScoredResults(filter))
  return Number.isFinite(limit) ? candidates.slice(0, limit) : candidates
}

async function getStoredRecordsByIdKeys (db, idKeys) {
  const tx = db.transaction([EVENTS_STORE], 'readonly')
  const store = tx.objectStore(EVENTS_STORE)
  const records = new Map()

  // Queue the whole batch synchronously so one readonly transaction owns all gets.
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(records)
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'))
    tx.onerror = () => reject(tx.error || new Error('transaction failed'))

    for (const idKey of idKeys) {
      const req = store.get(idKey)
      req.onsuccess = () => {
        if (req.result) records.set(idKey, req.result)
      }
      req.onerror = () => {
        reject(req.error)
        tx.abort()
      }
    }
  })
}

function scanCursor (db, storeName, indexName, range, { tx, direction = 'next', onItem }) {
  return scanIdbCursor(db, storeName, indexName, range, { tx, direction, onItem, keyOnly: false })
}

function scanKeyCursor (db, storeName, indexName, range, { tx, direction = 'next', onItem }) {
  return scanIdbCursor(db, storeName, indexName, range, { tx, direction, onItem, keyOnly: true })
}

// Keep cursor continuation inside the IDB success callback. Yielding a live
// cursor across unrelated awaits can let the transaction auto-commit first.
function scanIdbCursor (db, storeName, indexName, range, { tx, direction, onItem, keyOnly }) {
  return new Promise((resolve, reject) => {
    let storeOrIndex

    try {
      tx ??= db.transaction([storeName], 'readonly')
      const store = tx.objectStore(storeName)
      storeOrIndex = indexName ? store.index(indexName) : store
      const req = storeOrIndex[keyOnly ? 'openKeyCursor' : 'openCursor'](range, direction)

      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) {
          resolve()
          return
        }

        try {
          const item = keyOnly
            ? { key: cursor.key, primaryKey: cursor.primaryKey }
            : cursor.value
          if (onItem(item) === false) {
            resolve()
            return
          }
        } catch (error) {
          reject(error)
          tx.abort()
          return
        }

        cursor.continue()
      }
      req.onerror = () => {
        reject(req.error)
        tx.abort()
      }
    } catch (error) {
      reject(error)
    }
  })
}

async function getExpiredIdKeySet (db, now) {
  return new Set(await getExpiredIdKeys(db, now))
}

async function getExpiredIdKeys (db, now) {
  const expired = []
  const range = IDBKeyRange.upperBound(now)

  await scanKeyCursor(db, EVENTS_STORE, INDEX.expiration, range, {
    onItem: ({ primaryKey }) => {
      expired.push(primaryKey)
      return true
    }
  })

  return expired
}

function canUseKeyOnlyCursor (plan, filter) {
  // Covers sync inventory queries like:
  //   local device DB A: query({ since, until, ids_only: true, search: 'algo:sync sort:asc' })
  //   local device DB B: query({ since, until, "!ids": localDbAIds, search: 'algo:sync sort:asc' })
  // Also covers author/kind variants such as:
  //   query({ authors: [pubkey], kinds: [1], ids_only: true })
  // Search and mixed post-filter cases still need full event rows, so they stay on value cursors.
  if (filter.searchText || plan.type !== 'cursor') return false
  if (filter.andTags.length > 0) return false
  if (plan.cursors.length === 0) return false

  if (queryAlgorithm(filter) === 'sync') {
    return (
      !filter.ids &&
      !filter.authors &&
      !filter.kinds &&
      filter.tags.length === 0 &&
      plan.cursors.every(cursor => cursor.indexName === INDEX.syncAnchor)
    )
  }

  return plan.cursors.every(cursor => {
    if (cursor.indexName === INDEX.createdAt) return true
    if (cursor.indexName === INDEX.pubkey) return true
    if (cursor.indexName === INDEX.kind) return true
    if (cursor.indexName === INDEX.pubkeyKind) return true
    return (
      cursor.indexName === INDEX.tag &&
      filter.tags.length === 1 &&
      filter.tags[0].name.length === 1 &&
      !filter.authors &&
      !filter.kinds
    )
  })
}

function scoreFromIndexKey (key, indexName) {
  if (indexName === INDEX.createdAt) return key
  if (indexName === INDEX.syncAnchor) return key
  if (indexName === INDEX.pubkey || indexName === INDEX.kind) return key[1]
  if (indexName === INDEX.pubkeyKind || indexName === INDEX.tag) return key[2]
  return 0
}

function canUseAsyncSearchText (filter, decryptPersonalCopyContent) {
  return typeof decryptPersonalCopyContent === 'function' &&
    (!filter.kinds || filter.kinds.includes(PERSONAL_COPY_KIND))
}

async function collectAsyncSearchCandidates (db, plan, filter, direction, { countOnly, limit, now, decryptPersonalCopyContent }) {
  const rawCandidates = []
  const seen = new Set()
  const matchTarget = searchMatchTarget(countOnly, limit)

  const collect = stored => {
    const score = stored ? storedScore(stored, filter) : 0
    if (
      !stored ||
      !isStoredRecordLive(stored, now) ||
      seen.has(stored.event.id) ||
      !filter.matchesStructured(stored.event, score)
    ) return true

    seen.add(stored.event.id)
    rawCandidates.push({ event: stored.event, score })
    return rawCandidates.length < SEARCH_MAX_CANDIDATES
  }

  if (plan.type === 'direct') {
    for (const cursor of plan.cursors) {
      if (rawCandidates.length >= SEARCH_MAX_CANDIDATES) break
      const stored = await run('get', [cursor.key], EVENTS_STORE, cursor.indexName, { db })
        .then(v => v.result)
      collect(stored)
    }
  } else {
    for (const cursor of plan.cursors) {
      await scanCursor(db, EVENTS_STORE, cursor.indexName, cursor.range, {
        direction,
        onItem: stored => collect(stored)
      })
      if (rawCandidates.length >= SEARCH_MAX_CANDIDATES) break
    }
  }

  const matches = []
  let batchCount = 0

  for (let i = 0; i < rawCandidates.length && batchCount < SEARCH_MAX_BATCHES; i += SEARCH_BATCH_SIZE) {
    const batchCandidates = []
    for (const candidate of rawCandidates.slice(i, i + SEARCH_BATCH_SIZE)) {
      const text = await getSearchableTextForEvent(candidate.event, { decryptPersonalCopyContent })
      if (text) batchCandidates.push({ ...candidate, text })
    }

    matches.push(...matchSearchCandidates(batchCandidates, filter))
    batchCount++
    if (shouldStopSearch(countOnly, batchCount, matches.length, matchTarget)) break
  }

  return matches
}

// IDB scanning stays here because it knows about plans, stores, cursors, and caps.
async function collectSearchCandidates (db, plan, filter, direction, { countOnly, limit, now, decryptPersonalCopyContent }) {
  if (canUseAsyncSearchText(filter, decryptPersonalCopyContent)) {
    return collectAsyncSearchCandidates(db, plan, filter, direction, {
      countOnly,
      limit,
      now,
      decryptPersonalCopyContent
    })
  }

  const matches = []
  const seen = new Set()
  const matchTarget = searchMatchTarget(countOnly, limit)

  const toCandidate = stored => {
    const score = stored ? storedScore(stored, filter) : 0
    if (
      !stored ||
      !isStoredRecordLive(stored, now) ||
      seen.has(stored.event.id) ||
      !filter.matchesStructured(stored.event, score)
    ) return null
    seen.add(stored.event.id)

    const text = getSearchableText(stored.event)
    return text ? { event: stored.event, text, score } : null
  }

  if (plan.type === 'direct') {
    const candidates = []
    let scanned = 0

    for (const cursor of plan.cursors) {
      if (scanned >= SEARCH_MAX_CANDIDATES) break

      const stored = await run('get', [cursor.key], EVENTS_STORE, cursor.indexName, { db })
        .then(v => v.result)
      scanned++
      const candidate = toCandidate(stored)
      if (candidate) candidates.push(candidate)
    }

    return matchSearchCandidates(candidates, filter)
  }

  let scanned = 0
  let batchCount = 0
  let batchScanned = 0
  let batchCandidates = []
  let stop = false

  const flushBatch = () => {
    if (batchScanned === 0) return
    matches.push(...matchSearchCandidates(batchCandidates, filter))
    batchCandidates = []
    batchScanned = 0
    batchCount++
    stop = shouldStopSearch(countOnly, batchCount, matches.length, matchTarget)
  }

  for (const cursor of plan.cursors) {
    await scanCursor(db, EVENTS_STORE, cursor.indexName, cursor.range, {
      direction,
      onItem: stored => {
        if (stop || scanned >= SEARCH_MAX_CANDIDATES || batchCount >= SEARCH_MAX_BATCHES) return false

        scanned++
        batchScanned++
        const candidate = toCandidate(stored)
        if (candidate) batchCandidates.push(candidate)

        if (batchScanned >= SEARCH_BATCH_SIZE || scanned >= SEARCH_MAX_CANDIDATES) flushBatch()
        return !stop && scanned < SEARCH_MAX_CANDIDATES && batchCount < SEARCH_MAX_BATCHES
      }
    })

    flushBatch()
    if (stop || scanned >= SEARCH_MAX_CANDIDATES || batchCount >= SEARCH_MAX_BATCHES) break
  }

  return matches
}

function compareSearchTime (a, b, filter) {
  const aScore = Number.isFinite(a?.score) ? a.score : queryScore(a.event ?? a, null, filter)
  const bScore = Number.isFinite(b?.score) ? b.score : queryScore(b.event ?? b, null, filter)
  if (aScore !== bScore) return querySort(filter) === 'asc' ? aScore - bScore : bScore - aScore

  const aId = a.event?.id ?? a.id
  const bId = b.event?.id ?? b.id
  return aId < bId ? -1 : aId > bId ? 1 : 0
}

function searchMatchTarget (countOnly, limit) {
  if (countOnly) return Number.isFinite(limit) ? limit : Infinity

  return Math.min(
    SEARCH_MAX_MATCHES,
    Math.max(SEARCH_MIN_MATCHES, limit * SEARCH_MATCH_MULTIPLIER)
  )
}

function shouldStopSearch (countOnly, batchCount, matchCount, matchTarget) {
  if (!Number.isFinite(matchTarget)) return false
  if (countOnly) return matchCount >= matchTarget

  return batchCount >= SEARCH_MIN_BATCHES && matchCount >= matchTarget
}

export function planQuery (filter) {
  if (filter.ids) {
    return {
      type: 'direct',
      cursors: filter.ids.map(id => ({ key: eventIdIndexKey(id) }))
    }
  }

  const coordinateCursors = getCoordinateCursors(filter)
  if (coordinateCursors) {
    return { type: 'direct', cursors: coordinateCursors }
  }

  const replaceableCursors = getReplaceableCursors(filter)
  if (replaceableCursors) {
    return { type: 'direct', cursors: replaceableCursors }
  }

  if (queryAlgorithm(filter) === 'sync') {
    return {
      type: 'cursor',
      cursors: [{
        indexName: INDEX.syncAnchor,
        range: IDBKeyRange.bound(filter.since, filter.until)
      }]
    }
  }

  if (filter.tags.length > 0 || filter.andTags.length > 0) {
    const tag = [...filter.tags, ...filter.andTags]
      .reduce((a, b) => (b.values.length < a.values.length ? b : a))
    return {
      type: 'cursor',
      cursors: tag.values.map(value => ({
        indexName: INDEX.tag,
        range: IDBKeyRange.bound(
          [tag.name, tagValueIndexKey(value), filter.since],
          [tag.name, tagValueIndexKey(value), filter.until]
        )
      }))
    }
  }

  if (filter.authors && filter.kinds) {
    const cursors = []
    for (const author of filter.authors) {
      for (const kind of filter.kinds) {
        cursors.push({
          indexName: INDEX.pubkeyKind,
          range: IDBKeyRange.bound(
            [pubkeyIndexKey(author), kind, filter.since],
            [pubkeyIndexKey(author), kind, filter.until]
          )
        })
      }
    }
    return { type: 'cursor', cursors }
  }

  if (filter.authors) {
    return {
      type: 'cursor',
      cursors: filter.authors.map(author => ({
        indexName: INDEX.pubkey,
        range: IDBKeyRange.bound(
          [pubkeyIndexKey(author), filter.since],
          [pubkeyIndexKey(author), filter.until]
        )
      }))
    }
  }

  if (filter.kinds) {
    return {
      type: 'cursor',
      cursors: filter.kinds.map(kind => ({
        indexName: INDEX.kind,
        range: IDBKeyRange.bound([kind, filter.since], [kind, filter.until])
      }))
    }
  }

  return {
    type: 'cursor',
    cursors: [{
      indexName: INDEX.createdAt,
      range: IDBKeyRange.bound(filter.since, filter.until)
    }]
  }
}

function getCoordinateCursors (filter) {
  if (!filter.authors || !filter.kinds || !filter.dtags) return null
  if (!filter.kinds.every(kindUsesDCoordinate)) return null

  const cursors = []
  for (const author of filter.authors) {
    for (const kind of filter.kinds) {
      for (const dtag of filter.dtags) {
        cursors.push({ indexName: INDEX.address, key: addressKey(kind, author, dtag) })
      }
    }
  }
  return cursors
}

function getReplaceableCursors (filter) {
  if (!filter.authors || !filter.kinds || filter.dtags) return null
  if (!filter.kinds.every(isRegularReplaceableKind)) return null

  const cursors = []
  for (const author of filter.authors) {
    for (const kind of filter.kinds) {
      cursors.push({ indexName: INDEX.address, key: addressKey(kind, author, '') })
    }
  }
  return cursors
}

function createSubscription (filters, {
  idsOnly = false,
  limit = Infinity,
  ownerPubkey,
  scheduled = true,
  claimEvent = null
} = {}) {
  const queue = []
  const waiters = []
  let closed = false
  let yielded = 0
  let onClose

  const close = () => {
    if (closed) return
    closed = true
    scheduler?.close()
    onClose?.()
    while (waiters.length > 0) {
      waiters.shift().resolve({ done: true })
    }
  }

  const matchingFilter = (event, storedRecord) => filters.find(filter => filter.matches(event, storedRecord))
  const logScheduledError = (message, error) => {
    logNostrDbIssue('subscribe', { ownerPubkey, code: 'error', message }, error)
  }

  const emit = (filter, event, storedRecord) => {
    const score = queryScore(event, storedRecord, filter)
    const value = idsOnly ? event.id : event
    const wrapped = {
      result: value,
      meta: {
        algorithm: queryAlgorithm(filter),
        sort: querySort(filter),
        score
      }
    }

    if (!idsOnly) claimEvent?.(event)
    yielded++
    if (waiters.length > 0) {
      waiters.shift().resolve({ value: wrapped, done: false })
    } else {
      queue.push(wrapped)
    }
    if (yielded >= limit) close()
  }

  const scheduler = scheduled
    ? createScheduledDelivery({
      openDb: () => ownerPubkey ? openNostrDb(ownerPubkey) : null,
      scanCreatedAt: (db, range, options) => scanCursor(db, EVENTS_STORE, INDEX.createdAt, range, options),
      now: currentUnixTime,
      isClosed: () => closed || filters.length === 0 || limit <= 0,
      isNonDurableEvent,
      isStoredRecordLive,
      matchStored: stored => matchingFilter(stored.event, stored),
      emitStored: (filter, stored) => emit(filter, stored.event, stored),
      logError: logScheduledError
    })
    : null

  const subscription = {
    push (event, storedRecord) {
      if (closed) return
      const filter = matchingFilter(event, storedRecord)
      if (!filter) return

      if (scheduler?.shouldDelay(event)) {
        scheduler.arm(event.created_at)
        return
      }

      emit(filter, event, storedRecord)
    },
    iterator (closeSubscription) {
      onClose = closeSubscription
      if (limit <= 0 || filters.length === 0) close()
      scheduler?.start()
      return {
        [Symbol.asyncIterator] () {
          return this
        },
        next () {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false })
          }
          if (closed) return Promise.resolve({ done: true })

          const p = Promise.withResolvers()
          waiters.push(p)
          return p.promise
        },
        return () {
          close()
          return Promise.resolve({ done: true })
        }
      }
    }
  }
  return subscription
}

export class ParsedFilter {
  constructor (filter, controls = {}) {
    this.ids = undefined
    this.authors = undefined
    this.kinds = undefined
    this.dtags = undefined
    this.excludeIds = undefined
    this.excludeIdSet = undefined
    this.excludeIdKeySet = undefined
    this.tags = []
    this.andTags = []
    this.since = 0
    this.until = Infinity
    this.limit = Infinity
    this.idsOnly = false
    this.neverMatch = false
    this.algorithm = 'created_at'
    this.sort = 'desc'
    this.sortOld = false
    this.autocomplete = false
    this.searchText = ''

    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      this.neverMatch = true
      return
    }

    for (const [key, value] of Object.entries(filter)) {
      if (controls.ignoreFields?.has(key)) continue
      if ((key.startsWith('#') || key.startsWith('&')) && key.length !== 2) continue

      if (Array.isArray(value) && value.length === 0 && key !== '!ids') {
        this.neverMatch = true
        continue
      }

      if (key === 'ids') {
        this.ids = normalizeStringArray(value, HEX64_RE)
      } else if (key === '!ids') {
        const excludeIds = normalizeStringArray(value, HEX64_RE)
        if (excludeIds.length > 0) {
          this.excludeIds = excludeIds
          this.excludeIdSet = new Set(excludeIds)
          this.excludeIdKeySet = new Set(excludeIds.map(eventIdIndexKey))
        }
      } else if (key === 'authors') {
        this.authors = normalizeStringArray(value, HEX64_RE)
      } else if (key === 'kinds') {
        this.kinds = normalizeNumberArray(value)
      } else if (key === 'since') {
        this.since = normalizeTimestamp(value, 0)
      } else if (key === 'until') {
        this.until = normalizeTimestamp(value, Infinity)
      } else if (key === 'limit') {
        this.limit = normalizeLimit(value)
      } else if (key === 'ids_only') {
        this.idsOnly = value === true
      } else if (key === 'search') {
        const search = parseSearch(value)
        this.algorithm = search.algorithm
        this.sort = search.sort
        this.sortOld = search.sortOld
        this.autocomplete = search.autocomplete
        this.searchText = search.text
      } else if (key.startsWith('#')) {
        const values = normalizeTagValues(value)
        const tag = { name: key.slice(1), values }
        this.tags.push(tag)
        if (key === '#d') this.dtags = values
      } else if (key.startsWith('&')) {
        this.andTags.push({ name: key.slice(1), values: normalizeTagValues(value) })
      }
    }

    if (controls.hasLimit) this.limit = controls.limit
    if (controls.hasIdsOnly) this.idsOnly = controls.idsOnly
    if (controls.hasSearch) {
      const search = parseSearch(controls.search)
      this.algorithm = search.algorithm
      this.sort = search.sort
      this.sortOld = search.sortOld
      this.autocomplete = search.autocomplete
      this.searchText = search.text
    }

    this.tags = pruneOrTagsCoveredByAndTags(this.tags, this.andTags)
    this.dtags = this.tags.find(tag => tag.name === 'd')?.values

    if (this.ids && this.excludeIdSet) {
      this.ids = this.ids.filter(id => !this.excludeIdSet.has(id))
    }

    if (
      this.ids?.length === 0 ||
      this.authors?.length === 0 ||
      this.kinds?.length === 0 ||
      this.dtags?.length === 0 ||
      this.tags.some(tag => tag.values.length === 0) ||
      this.andTags.some(tag => tag.values.length === 0)
    ) {
      this.neverMatch = true
    }
  }

  matches (event, stored) {
    const score = queryScore(event, stored, this)
    if (!this.matchesStructured(event, score)) return false
    if (this.searchText && !eventMatchesSearch(event, this, compareSearchTime)) return false

    return true
  }

  matchesStored (stored) {
    if (!stored?.event) return false
    return this.matches(stored.event, stored)
  }

  matchesStructured (event, score = event.created_at) {
    if (this.neverMatch) return false
    if (score < this.since || score > this.until) return false
    if (this.ids && !this.ids.includes(event.id)) return false
    if (this.excludeIdSet?.has(event.id)) return false
    if (this.authors && !this.authors.includes(event.pubkey)) return false
    if (this.kinds && !this.kinds.includes(event.kind)) return false

    for (const { name, values } of this.tags) {
      if (!event.tags.some(tag => tag[0] === name && values.includes(tag[1]))) return false
    }

    for (const { name, values } of this.andTags) {
      for (const value of values) {
        if (!event.tags.some(tag => tag[0] === name && tag[1] === value)) return false
      }
    }

    return true
  }
}

export function toStoredRecord (event, {
  now = currentUnixTime(),
  appRef,
  chunkData,
  blobRefs = blobReferencesFromTags(event?.tags)
} = {}) {
  const coordinate = getCoordinate(event)
  const storedEvent = chunkData ? { ...event } : event
  if (chunkData) delete storedEvent.content
  const record = {
    i: eventIdIndexKey(event.id),
    p: pubkeyIndexKey(event.pubkey),
    k: event.kind,
    ca: event.created_at,
    ra: now * 1000,
    t: tagIndexKeys(event),
    event: storedEvent
  }
  const expiration = getExpiration(event)

  if (coordinate !== null) record.a = addressKey(event.kind, event.pubkey, coordinate)
  if (expiration !== null && expiration > now) record.ex = expiration
  if (appRef && isAppTrackableKind(event.kind)) record.ap = [appRef]
  if (blobRefs.length > 0) record.br = [...blobRefs]
  if (chunkData) {
    record.cr = chunkData.root
    record.ci = chunkData.index
    record.ct = chunkData.total
    record.ch = chunkData.contentHash
    record.cb = chunkData.byteLength
  }

  return record
}

async function getStoredRecordByAddress (db, address) {
  return run('get', [address], EVENTS_STORE, INDEX.address, { db })
    .then(value => value.result)
}

class StalePersonalCopyProvenanceError extends Error {}

function personalCopyCandidateMatches (candidate, incoming) {
  if (personalCopyContextValue(candidate) !== incoming.context) return false
  if (personalCopyProvenanceValue(candidate) === null) return false
  if (candidate.tags.some(tag => Array.isArray(tag) && tag[0] === 'hearsay')) return false

  const sourceTags = candidate.tags.filter(tag =>
    Array.isArray(tag) &&
    tag.length === 2 &&
    tag[0] === 'o' &&
    tag[1] === incoming.sourceMirror
  )
  return sourceTags.length === 1
}

function preferredPersonalCopy (selected, candidate) {
  const selectedPriority = Number(selected.provenance)
  const candidatePriority = Number(candidate.provenance)
  if (candidatePriority < selectedPriority) return candidate
  if (candidatePriority > selectedPriority) return selected
  return isNewer(candidate.event, selected.event) ? candidate : selected
}

function personalCopyProvenanceSnapshot (filter, events) {
  return {
    filter,
    ids: sortedUniqueEventIds(events)
  }
}

async function validatePersonalCopyProvenanceSnapshot (db, tx, snapshot) {
  if (!snapshot) return

  // The candidate read happens before the transaction; verify it again before
  // deleting losers so concurrent adds cannot make the decision stale.
  const events = await queryRecords(db, snapshot.filter, {
    countOnly: false,
    ignoreLimit: true,
    tx
  })
  if (!sameStringArrays(sortedUniqueEventIds(events), snapshot.ids)) {
    throw new StalePersonalCopyProvenanceError()
  }
}

function sortedUniqueEventIds (events) {
  return [...new Set((Array.isArray(events) ? events : [])
    .map(event => event?.id)
    .filter(id => typeof id === 'string'))]
    .sort()
}

function sameStringArrays (a, b) {
  return Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, index) => value === b[index])
}

async function retainExistingPersonalCopyWinner (db, tx, resolution, appRef) {
  const winner = await run(
    'get',
    [eventIdIndexKey(resolution.winnerId)],
    EVENTS_STORE,
    null,
    { db, tx }
  ).then(value => value.result)
  if (!winner || !isPersonalCopyEvent(winner.event)) {
    throw new StalePersonalCopyProvenanceError()
  }

  let changed = mergeAppRef(winner, appRef)
  changed = await removePersonalCopyLosers(db, tx, resolution.loserIds, winner) || changed
  if (changed) await run('put', [winner], EVENTS_STORE, null, { db, tx })
  return changed
}

async function removePersonalCopyLosers (db, tx, loserIds, winner) {
  if (!Array.isArray(loserIds) || loserIds.length === 0) return false

  let changed = false
  for (const id of new Set(loserIds)) {
    if (id === winner.event.id) continue

    const loser = await run('get', [eventIdIndexKey(id)], EVENTS_STORE, null, { db, tx })
      .then(value => value.result)
    if (!loser || !isPersonalCopyEvent(loser.event)) {
      throw new StalePersonalCopyProvenanceError()
    }

    mergeAppRefs(winner, loser.ap)
    await deleteStoredEvent(db, tx, loser)
    changed = true
  }
  return changed
}

async function signCrdtTemplate (signEvent, template) {
  const before = JSON.stringify(template)
  let signed

  try {
    signed = await signEvent(template)
  } catch {
    return null
  }

  // The signer may fill id/sig in the returned event, but must not mutate the
  // merge template we later validate against.
  return JSON.stringify(template) === before ? signed : null
}

function isValidCrdtSignedEvent (signed, template, expectedAddress, ownerPubkey) {
  if (!isValidEventShape(signed)) return false
  if (signed.pubkey !== ownerPubkey) return false
  if (signed.kind !== template.kind) return false
  if (signed.created_at !== template.created_at) return false
  if (signed.content !== template.content) return false
  if (!sameTags(signed.tags, template.tags) && !sameTagsAllowingImkcRewrite(signed.tags, template.tags)) return false

  const coordinate = getCoordinate(signed)
  if (coordinate === null) return false

  return compareKeys(addressKey(signed.kind, signed.pubkey, coordinate), expectedAddress) === 0
}

function sameStoredVersion (a, b) {
  return (a?.i ?? null) === (b?.i ?? null)
}

function normalizeCrdtMergeSource (mergeSource) {
  return mergeSource === 'sync' ? 'sync' : 'local'
}

// Assign a monotonic millisecond sync anchor for local DB sync: prefer the
// event's capped created_at time, otherwise advance one tick past the newest row.
async function nextSyncAnchor (db, tx, event, now = currentUnixTime()) {
  const newest = await getNewestSyncAnchor(db, tx)
  const candidate = Math.min(event.created_at * 1000, (now * 1000) + SYNC_ANCHOR_FUTURE_SKEW_MS)
  return candidate > newest ? candidate : newest + 1
}

async function getNewestSyncAnchor (db, tx) {
  let newest = -1

  await scanKeyCursor(db, EVENTS_STORE, INDEX.syncAnchor, null, {
    tx,
    direction: 'prev',
    onItem: ({ key }) => {
      if (Number.isFinite(key)) newest = key
      return false
    }
  })

  return newest
}

function normalizeOptionalAppRef (appId) {
  if (appId === undefined) return undefined

  try {
    return appIdToDbAppRef(appId)
  } catch {
    return false
  }
}

function normalizeReadAppRef (options) {
  const appRef = normalizeOptionalAppRef(normalizeOptions(options).appId)
  return appRef === false ? undefined : appRef
}

function mergeAppRef (stored, appRef) {
  if (!stored?.event || !appRef || !isAppTrackableKind(stored.event.kind)) return false

  const refs = normalizeAppRefs(stored.ap)
  if (refs.some(ref => sameAppRef(ref, appRef))) return false

  refs.push(appRef)
  stored.ap = sortAppRefs(refs)
  return true
}

function mergeAppRefs (stored, refs) {
  let changed = false

  for (const ref of normalizeAppRefs(refs)) {
    changed = mergeAppRef(stored, ref) || changed
  }

  return changed
}

function removeAppRef (refs, appRef) {
  return normalizeAppRefs(refs)
    .filter(ref => !sameAppRef(ref, appRef))
}

function hasAppRef (refs, appRef) {
  return normalizeAppRefs(refs).some(ref => sameAppRef(ref, appRef))
}

function normalizeAppRefs (refs) {
  if (!Array.isArray(refs)) return []

  const unique = []
  for (const ref of refs) {
    if (!isAppRef(ref)) continue
    if (!unique.some(existing => sameAppRef(existing, ref))) unique.push(ref)
  }
  return sortAppRefs(unique)
}

function sortAppRefs (refs) {
  return refs.sort(compareKeys)
}

function sameAppRef (a, b) {
  return compareKeys(a, b) === 0
}

function isAppRef (ref) {
  return (
    Array.isArray(ref) &&
    ref.length === 3 &&
    typeof ref[0] === 'string' &&
    isBinaryKey(ref[1]) &&
    typeof ref[2] === 'string'
  )
}

function isAppTrackableKind (kind) {
  return isCustomAppDataKind(kind) || !appNeutralKindSet().has(kind)
}

function isCustomAppDataKind (kind) {
  return kind === REGULAR_CUSTOM_APP_DATA_KIND || kind === CUSTOM_APP_DATA_KIND
}

function normalizeBatchSize (value, fallback, max) {
  return Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback
}

function normalizePositiveInteger (value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function normalizeNonNegativeInteger (value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function normalizeDurationMs (value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function normalizeSkip (value) {
  return Number.isInteger(value) && value > 0 ? value : 0
}

let appNeutralKindsCache
let appNeutralKindSetCache

function appNeutralKindList () {
  return (appNeutralKindsCache ??= [...new Set(Object.values(eventKinds))]
    .filter(Number.isInteger)
    .filter(kind => !isCustomAppDataKind(kind))
    .sort((a, b) => a - b))
}

function appNeutralKindSet () {
  return (appNeutralKindSetCache ??= new Set(appNeutralKindList()))
}

export function getCoordinate (event) {
  if (isRegularReplaceableKind(event.kind)) return ''
  if (isAddressableKind(event.kind)) return getDTag(event) ?? ''
  return getDTag(event)
}

export function eventRef (id) {
  return eventIdIndexKey(id)
}

export function coordinateRef (kind, pubkey, dtag) {
  return addressKey(kind, pubkey, dtag)
}

export function addressKey (kind, pubkey, dtag) {
  return [kind, pubkeyIndexKey(pubkey), dtag === '' ? '' : tagValueIndexKey(dtag)]
}

export function deletionEventRef (id, pubkey) {
  return `e:${eventIdIndexKey(id)}:${pubkeyIndexKey(pubkey)}`
}

export function deletionCoordinateRef (kind, pubkey, dtag) {
  return `a:${kind}:${pubkeyIndexKey(pubkey)}:${dtag === '' ? '' : tagValueIndexKey(dtag)}`
}

export function eventIdIndexKey (id) {
  return bytesToBase64Url(base16ToBytes(id))
}

export function idKeyToEventId (idKey) {
  return bytesToBase16(base64UrlToBytes(idKey))
}

export function pubkeyIndexKey (pubkey) {
  return bytesToBase64Url(base16ToBytes(pubkey))
}

export function tagValueIndexKey (value) {
  return bytesToBase64Url(sha256(textEncoder.encode(value)))
}

export function tagIndexKeys (event) {
  const seen = new Set()
  const keys = []

  for (const tag of event.tags) {
    if (!Array.isArray(tag) || typeof tag[0] !== 'string' || typeof tag[1] !== 'string') continue
    if (tag[0].length !== 1) continue

    const dedupeKey = `${tag[0]}\u0000${tag[1]}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    keys.push([tag[0], tagValueIndexKey(tag[1]), event.created_at])
  }

  return keys
}

export function isNewer (event, other) {
  if (event.created_at > other.created_at) return true
  if (event.created_at < other.created_at) return false
  return event.id < other.id
}

export function currentUnixTime () {
  return Math.floor(Date.now() / 1000)
}

export function getExpiration (event) {
  if (!Array.isArray(event?.tags)) return null

  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag[0] !== 'expiration') continue

    const timestamp = parseExpirationTimestamp(tag[1])
    if (timestamp !== null) return timestamp
  }

  return null
}

export function isEphemeralKind (kind) {
  return kind >= 20000 && kind < 30000
}

export function isHonoraryEphemeralEvent (event) {
  const expiration = getExpiration(event)
  return expiration !== null && expiration === event.created_at
}

export function isExpiredEvent (event, now = currentUnixTime(), { honorarySkew = 0 } = {}) {
  const expiration = getExpiration(event)
  if (expiration === null) return false

  const expiresAt = isHonoraryEphemeralEvent(event)
    ? expiration + honorarySkew
    : expiration

  return expiresAt <= now
}

export function isExpiredForIngest (event, now = currentUnixTime()) {
  return isExpiredEvent(event, now, { honorarySkew: HONORARY_EXPIRATION_SKEW })
}

export function isNonDurableEvent (event) {
  return isEphemeralKind(event.kind) || isHonoraryEphemeralEvent(event)
}

export function shouldSkipStorage (event, now = currentUnixTime()) {
  return (
    isNonDurableEvent(event) ||
    isExpiredEvent(event, now)
  )
}

function isStoredRecordLive (stored, now) {
  return !!stored?.event && !shouldSkipStorage(stored.event, now)
}

export function isValidEventShape (event) {
  if (!event || typeof event !== 'object') return false
  if (!HEX64_RE.test(event.id)) return false
  if (!HEX64_RE.test(event.pubkey)) return false
  if (!SIG_RE.test(event.sig)) return false
  if (!Number.isInteger(event.kind) || event.kind < 0 || event.kind > 0xffff) return false
  if (!Number.isInteger(event.created_at) || event.created_at < 0 || event.created_at > 0xffffffff) return false
  if (!Array.isArray(event.tags)) return false
  if (typeof event.content !== 'string') return false

  return event.tags.every(tag => Array.isArray(tag) && tag.every(value => typeof value === 'string'))
}

function parseExpirationTimestamp (value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null

  const timestamp = Number(value)
  return Number.isInteger(timestamp) && timestamp >= 0 && timestamp <= 0xffffffff
    ? timestamp
    : null
}

async function isBlockedByDeletion (db, tx, event) {
  const eventDeletion = await run(
    'get',
    [deletionEventRef(event.id, event.pubkey)],
    DELETIONS_STORE,
    null,
    { db, tx }
  ).then(v => v.result)

  if (eventDeletion) return true

  const coordinate = getCoordinate(event)
  if (coordinate === null) return false

  const coordinateDeletion = await run(
    'get',
    [deletionCoordinateRef(event.kind, event.pubkey, coordinate)],
    DELETIONS_STORE,
    null,
    { db, tx }
  ).then(v => v.result)

  return !!coordinateDeletion && event.created_at <= coordinateDeletion.ca
}

async function applyDeletionRequest (db, tx, request) {
  const targets = await deletionTargetsFromRequest(db, tx, request)
  for (const target of targets) {
    await addDeletionContribution(db, tx, target, request)
    await deleteDeletionTarget(db, tx, request, target)
  }
}

// Address tags are canonical when present. Event tags may be promoted to the
// stored target's address so compaction can preserve coordinate cutoffs.
async function deletionTargetsFromRequest (db, tx, request) {
  const targets = new Map()
  const eventIds = new Set()

  for (const tag of request.tags) {
    const target = deletionTargetFromAddressTag(request, tag)
    if (target) targets.set(target.ref, target)
  }

  for (const tag of request.tags) {
    if (tag[0] === 'e') {
      if (eventIds.has(tag[1])) continue
      eventIds.add(tag[1])
    }
    const target = await deletionTargetFromEventTag(db, tx, request, tag)
    if (target && !targets.has(target.ref)) targets.set(target.ref, target)
  }

  return [...targets.values()]
}

async function deletionTargetFromEventTag (db, tx, request, tag) {
  if (tag[0] !== 'e') return null

  const id = tag[1]
  if (!HEX64_RE.test(id)) return null
  if (id === request.id) return null

  const stored = await run('get', [eventIdIndexKey(id)], EVENTS_STORE, null, { db, tx })
    .then(v => v.result)
  const addressTarget = deletionTargetFromStoredAddress(request, stored)
  if (addressTarget) return addressTarget

  return {
    ref: deletionEventRef(id, request.pubkey),
    tag: ['e', id],
    type: 'e',
    id,
    upToCreatedAt: Infinity
  }
}

function deletionTargetFromAddressTag (request, tag) {
  if (tag[0] !== 'a') return null

  const parsed = parseAddress(tag[1])
  if (!parsed || parsed.pubkey !== request.pubkey) return null

  return deletionTargetFromAddress(request, parsed.kind, parsed.pubkey, parsed.dtag)
}

function deletionTargetFromStoredAddress (request, stored) {
  if (!stored || stored.i === eventIdIndexKey(request.id)) return null
  if (stored.event.pubkey !== request.pubkey) return null

  const dtag = getCoordinate(stored.event)
  if (dtag === null) return null

  return deletionTargetFromAddress(request, stored.event.kind, stored.event.pubkey, dtag)
}

function deletionTargetFromAddress (request, kind, pubkey, dtag) {
  const requestAddress = getCoordinate(request)
  if (
    requestAddress !== null &&
    compareKeys(addressKey(kind, pubkey, dtag), addressKey(request.kind, request.pubkey, requestAddress)) === 0
  ) return null

  const address = `${kind}:${pubkey}:${dtag}`
  return {
    ref: deletionCoordinateRef(kind, pubkey, dtag),
    tag: ['a', address],
    type: 'a',
    kind,
    pubkey,
    dtag,
    upToCreatedAt: request.created_at
  }
}

async function addDeletionContribution (db, tx, target, request) {
  const requestIdKey = eventIdIndexKey(request.id)
  const existing = await run('get', [target.ref], DELETIONS_STORE, null, { db, tx })
    .then(v => v.result)
  const contributors = validContributors(existing?.c)
    .filter(contributor => contributor[0] !== requestIdKey)

  contributors.push([requestIdKey, request.created_at])
  contributors.sort(compareKeys)

  await run('put', [{
    ref: target.ref,
    tag: target.tag,
    ca: maxContributorCreatedAt(contributors),
    c: contributors
  }], DELETIONS_STORE, null, { db, tx })
}

async function deleteDeletionTarget (db, tx, request, target) {
  let stored

  if (target.type === 'e') {
    stored = await run('get', [eventIdIndexKey(target.id)], EVENTS_STORE, null, { db, tx })
      .then(v => v.result)
  } else {
    stored = await run(
      'get',
      [addressKey(target.kind, target.pubkey, target.dtag)],
      EVENTS_STORE,
      INDEX.address,
      { db, tx }
    ).then(v => v.result)
  }

  await deleteMatchingTarget(db, tx, request, stored, {
    upToCreatedAt: target.upToCreatedAt
  })
}

async function deleteMatchingTarget (db, tx, request, target, { upToCreatedAt = Infinity } = {}) {
  if (!target || target.i === eventIdIndexKey(request.id)) return
  if (target.event.pubkey !== request.pubkey) return
  if (target.event.created_at > upToCreatedAt) return

  await deleteStoredEvent(db, tx, target)
}

async function deleteStoredDeletionRequestById (db, tx, id, author) {
  if (!HEX64_RE.test(id)) return false

  const target = await run('get', [eventIdIndexKey(id)], EVENTS_STORE, null, { db, tx })
    .then(v => v.result)

  if (!target || target.event.kind !== 5 || target.event.pubkey !== author) return false

  await deleteStoredEvent(db, tx, target)
  return true
}

async function deleteStoredEvent (db, tx, stored) {
  await run('delete', [stored.i], EVENTS_STORE, null, { db, tx })

  if (stored.event.kind === 34601 && stored.cr && Number.isSafeInteger(stored.ci)) {
    const owner = db.name.startsWith(NOSTRDB_PREFIX)
      ? db.name.slice(NOSTRDB_PREFIX.length)
      : null
    if (owner) {
      tx.addEventListener('complete', () => {
        removeChunkCopy(owner, stored.cr, stored.ci, { eventId: stored.event.id }).catch(() => {})
      }, { once: true })
    }
  }

  if (stored.br?.length) {
    const owner = db.name.startsWith(NOSTRDB_PREFIX)
      ? db.name.slice(NOSTRDB_PREFIX.length)
      : null
    if (owner) {
      tx.addEventListener('complete', () => {
        scheduleBlobReferenceReconciliation(owner, stored.br)
      }, { once: true })
    }
  }

  if (stored.event.kind === 5) {
    await removeDeletionRequestContributions(db, tx, stored.i)
  }
}

async function removeDeletionRequestContributions (db, tx, requestIdKey) {
  const rows = await getDeletionRowsForRequest(db, tx, requestIdKey)

  for (const row of uniqueDeletionRows(rows)) {
    const contributors = validContributors(row.c)
      .filter(contributor => contributor[0] !== requestIdKey)

    if (contributors.length === 0) {
      await run('delete', [row.ref], DELETIONS_STORE, null, { db, tx })
    } else {
      await run('put', [{
        ...row,
        ca: maxContributorCreatedAt(contributors),
        c: contributors
      }], DELETIONS_STORE, null, { db, tx })
    }
  }
}

async function getDeletionRowsForRequest (db, tx, requestIdKey) {
  const range = IDBKeyRange.bound([requestIdKey, 0], [requestIdKey, 0xffffffff])
  const rows = []

  await scanCursor(db, DELETIONS_STORE, DELETION_INDEX.request, range, {
    tx,
    onItem: row => {
      rows.push(row)
      return true
    }
  })

  return rows
}

function uniqueDeletionRows (rows) {
  return [...new Map(rows.map(row => [row.ref, row])).values()]
}

async function countDeletionRequestKeys (db, author, signal) {
  let count = 0
  await scanKeyCursor(db, EVENTS_STORE, INDEX.pubkeyKind, deletionRequestKeyRange(author), {
    onItem: () => {
      throwIfAborted(signal)
      count++
      return true
    }
  })
  return count
}

async function selectDeletionRequestPruneIds (db, author, { cutoffMs, limit, signal }) {
  const selected = []
  let after = null

  while (selected.length < limit || after) {
    const batch = await deletionRequestKeyBatch(db, author, {
      after,
      batchSize: DELETION_REQUEST_PRUNE_SCAN_BATCH_SIZE,
      signal
    })
    after = batch.after
    if (batch.items.length === 0) break

    const infos = await scoreDeletionRequestKeyBatch(db, batch.items, cutoffMs, signal)
    for (const info of infos) {
      addDeletionPruneCandidate(selected, info, limit)
    }
    if (batch.done) break
  }

  selected.sort(compareDeletionPruneInfo)
  return selected.map(info => info.id)
}

async function deletionRequestKeyBatch (db, author, { after = null, batchSize, signal }) {
  const items = []
  const range = deletionRequestKeyRange(author, after?.key)

  await scanKeyCursor(db, EVENTS_STORE, INDEX.pubkeyKind, range, {
    onItem: item => {
      throwIfAborted(signal)
      if (after && compareDeletionRequestKeyCursorItem(item, after) <= 0) return true

      items.push({ key: item.key, primaryKey: item.primaryKey })
      return items.length < batchSize
    }
  })

  return {
    items,
    after: items.length ? items[items.length - 1] : after,
    done: items.length < batchSize
  }
}

async function scoreDeletionRequestKeyBatch (db, items, cutoffMs, signal) {
  const tx = db.transaction([EVENTS_STORE, DELETIONS_STORE], 'readonly')
  const done = txDone(tx)
  const infos = []

  for (const item of items) {
    throwIfAborted(signal)

    const stored = await run('get', [item.primaryKey], EVENTS_STORE, null, { db, tx })
      .then(v => v.result)
    if (!stored?.event || stored.event.kind !== 5) continue

    const receivedAt = Number.isFinite(stored.ra) ? stored.ra : -Infinity
    if (receivedAt > cutoffMs) continue

    const rows = uniqueDeletionRows(await getDeletionRowsForRequest(db, tx, item.primaryKey))
    const addressTargetCount = rows.filter(isAddressDeletionRow).length
    const eventTargetCount = rows.length - addressTargetCount

    infos.push({
      id: stored.event.id,
      createdAt: stored.event.created_at,
      receivedAt,
      score: (addressTargetCount * DELETION_REQUEST_ADDRESS_TARGET_WEIGHT) + eventTargetCount
    })
  }

  await done
  return infos
}

async function deleteDeletionRequestIdsInBatches (db, ids, author, { batchSize, deleted, signal }) {
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize)
    const tx = db.transaction([EVENTS_STORE, DELETIONS_STORE], 'readwrite')
    const done = txDone(tx)

    for (const id of batch) {
      throwIfAborted(signal)
      if (await deleteStoredDeletionRequestById(db, tx, id, author)) deleted.push(id)
    }

    await done
  }
}

function addDeletionPruneCandidate (selected, info, limit) {
  if (limit <= 0) return
  selected.push(info)
  selected.sort(compareDeletionPruneInfo)
  if (selected.length > limit) selected.pop()
}

function deletionRequestKeyRange (author, lowerKey = null) {
  const pubkey = pubkeyIndexKey(author)
  const lower = lowerKey || [pubkey, 5, 0]
  return IDBKeyRange.bound(lower, [pubkey, 5, 0xffffffff])
}

function compareDeletionRequestKeyCursorItem (a, b) {
  const keyOrder = compareKeys(a.key, b.key)
  if (keyOrder !== 0) return keyOrder
  return compareKeys(a.primaryKey, b.primaryKey)
}

function compareDeletionPruneInfo (a, b) {
  if (a.score !== b.score) return a.score - b.score
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  if (a.receivedAt !== b.receivedAt) return a.receivedAt - b.receivedAt
  return a.id.localeCompare(b.id)
}

// Address tombstones are compacted only with requests at the same cutoff.
// Event-only tombstones have no cutoff, so they can fill the selected group.
function selectDeletionCompaction (infos, maxRefs) {
  const addressGroups = new Map()
  const eventOnlyInfos = []

  for (const info of infos) {
    if (info.targets.some(isAddressDeletionRow)) {
      const group = addressGroups.get(info.event.created_at) ?? []
      group.push(info)
      addressGroups.set(info.event.created_at, group)
    } else {
      eventOnlyInfos.push(info)
    }
  }

  const addressCandidate = selectAddressDeletionCompaction(addressGroups, eventOnlyInfos, maxRefs)
  if (addressCandidate) return addressCandidate

  const eventOnlyCandidate = buildDeletionCompaction(eventOnlyInfos, maxRefs, null)
  return eventOnlyCandidate.selected.length >= 2 ? eventOnlyCandidate : null
}

function selectAddressDeletionCompaction (addressGroups, eventOnlyInfos, maxRefs) {
  let best = null

  for (const [createdAt, infos] of [...addressGroups.entries()].sort((a, b) => a[0] - b[0])) {
    const candidate = buildDeletionCompaction(infos, maxRefs, createdAt)
    if (candidate.selected.length < 2) continue
    if (!best || compareDeletionCompaction(candidate, best) > 0) best = candidate
  }

  if (!best) return null

  for (const info of eventOnlyInfos) {
    addInfoToDeletionCompaction(best, info, maxRefs)
  }

  return best
}

function buildDeletionCompaction (infos, maxRefs, createdAt) {
  const candidate = {
    selected: [],
    targets: new Map(),
    createdAt
  }

  for (const info of infos) {
    addInfoToDeletionCompaction(candidate, info, maxRefs)
  }

  return candidate
}

function addInfoToDeletionCompaction (candidate, info, maxRefs) {
  const newTargets = info.targets.filter(row => !candidate.targets.has(row.ref))
  if (candidate.targets.size + newTargets.length > maxRefs) return false

  candidate.selected.push(info)
  for (const row of info.targets) {
    if (!candidate.targets.has(row.ref)) candidate.targets.set(row.ref, row)
  }
  return true
}

function compareDeletionCompaction (a, b) {
  if (a.selected.length !== b.selected.length) return a.selected.length - b.selected.length
  if (a.targets.size !== b.targets.size) return a.targets.size - b.targets.size
  return b.createdAt - a.createdAt
}

function isAddressDeletionRow (row) {
  return row?.tag?.[0] === 'a'
}

function validContributors (contributors) {
  if (!Array.isArray(contributors)) return []

  return contributors.filter(contributor => (
    Array.isArray(contributor) &&
    contributor.length === 2 &&
    typeof contributor[0] === 'string' &&
    Number.isInteger(contributor[1]) &&
    contributor[1] >= 0
  ))
}

function maxContributorCreatedAt (contributors) {
  return contributors.reduce((max, contributor) => Math.max(max, contributor[1]), 0)
}

function parseAddress (address) {
  if (typeof address !== 'string') return null

  const [kindStr, pubkey, ...dtagParts] = address.split(':')
  const kind = Number(kindStr)

  if (!Number.isInteger(kind) || kind < 0 || kind > 0xffff) return null
  if (!HEX64_RE.test(pubkey)) return null

  return { kind, pubkey, dtag: dtagParts.join(':') }
}

function normalizeStringArray (value, pattern) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(item => typeof item === 'string' && pattern.test(item)))].sort()
}

function normalizeNumberArray (value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(item => Number.isInteger(item) && item >= 0 && item <= 0xffff))]
    .sort((a, b) => a - b)
}

function normalizeTagValues (value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(item => typeof item === 'string'))].sort()
}

function pruneOrTagsCoveredByAndTags (tags, andTags) {
  if (andTags.length === 0) return tags

  const andValuesByName = new Map()
  for (const tag of andTags) {
    const values = andValuesByName.get(tag.name) ?? new Set()
    for (const value of tag.values) values.add(value)
    andValuesByName.set(tag.name, values)
  }

  const pruned = []
  for (const tag of tags) {
    const andValues = andValuesByName.get(tag.name)
    if (!andValues) {
      pruned.push(tag)
      continue
    }

    const values = tag.values.filter(value => !andValues.has(value))
    if (values.length > 0) pruned.push({ ...tag, values })
  }

  return pruned
}

function normalizeTimestamp (value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function normalizeLimit (value) {
  return Number.isInteger(value) && value >= 0 ? value : Infinity
}

function compareNewest (a, b) {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function compareOldest (a, b) {
  if (a.created_at !== b.created_at) return a.created_at - b.created_at
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function compareKeys (a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const compared = compareKeys(a[i], b[i])
      if (compared !== 0) return compared
    }
    return a.length - b.length
  }
  if (isBinaryKey(a) && isBinaryKey(b)) {
    const aBytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
    const bBytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
    for (let i = 0; i < Math.min(aBytes.length, bBytes.length); i++) {
      if (aBytes[i] !== bBytes[i]) return aBytes[i] - bBytes[i]
    }
    return aBytes.length - bBytes.length
  }
  if (a === b) return 0
  return a < b ? -1 : 1
}

function isBinaryKey (value) {
  return ArrayBuffer.isView(value)
}

function sameTags (a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false

  return a.every((tag, index) => sameTag(tag, b[index]))
}

function sameTag (a, b) {
  return Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, valueIndex) => value === b[valueIndex])
}

function imkcTagIndexes (tags) {
  if (!Array.isArray(tags)) return []
  return tags
    .map((tag, index) => Array.isArray(tag) && tag[0] === 'imkc' ? index : -1)
    .filter(index => index >= 0)
}

function isExpectedDoubleSignedImkcTag (tag) {
  return Array.isArray(tag) &&
    tag.length === 3 &&
    tag[0] === 'imkc' &&
    HEX64_RE.test(tag[1] || '') &&
    SIG_RE.test(tag[2] || '')
}

function sameTagsAllowingImkcRewrite (signedTags, templateTags) {
  if (!Array.isArray(signedTags) || !Array.isArray(templateTags) || signedTags.length !== templateTags.length) return false
  const signedImkcIndexes = imkcTagIndexes(signedTags)
  const templateImkcIndexes = imkcTagIndexes(templateTags)
  if (signedImkcIndexes.length !== 1 || templateImkcIndexes.length !== 1) return false
  if (signedImkcIndexes[0] !== templateImkcIndexes[0]) return false

  return signedTags.every((tag, index) => {
    if (index === signedImkcIndexes[0]) return isExpectedDoubleSignedImkcTag(tag)
    return sameTag(tag, templateTags[index])
  })
}

function compactResult ({
  compacted = false,
  created = null,
  consumed = [],
  targets = []
} = {}) {
  return { compacted, created, consumed, targets }
}

function deletionPruneResult ({ deleted = [] } = {}) {
  return { pruned: deleted.length > 0, deleted }
}

function throwIfAborted (signal) {
  if (!signal?.aborted) return
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted()
  throw new Error('operation aborted')
}

function txDone (tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'))
    tx.onerror = () => reject(tx.error || new Error('transaction failed'))
  })
}

function getDTag (event) {
  return event.tags.find(tag => tag[0] === 'd')?.[1] ?? null
}

function kindUsesDCoordinate (kind) {
  return !isRegularReplaceableKind(kind)
}

function isRegularReplaceableKind (kind) {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)
}

function isAddressableKind (kind) {
  return kind >= 30000 && kind < 40000
}

function channelName (ownerPubkey) {
  return `${NOSTRDB_PREFIX}${ownerPubkey}`
}

export const __nostrDbInternals = {
  channelName,
  compareNewest,
  getCoordinate,
  isAddressableKind,
  isRegularReplaceableKind,
  kindUsesDCoordinate,
  startNostrDbMaintenance,
  stopNostrDbMaintenance
}
