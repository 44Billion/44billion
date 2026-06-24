const DEFAULT_TOMBSTONE_GRACE_SECONDS = 21 * 24 * 60 * 60
const DEFAULT_MAX_TOMBSTONE_TAGS = 100
const CRDT_CLOCK_SKEW_SECONDS = 60
const CRDT_META_PREFIX = '~'
const CRDT_CONTENT_TAG = '~'
const CRDT_RANK_WIDTH = 8
const CRDT_RANK_RADIX = 36n
const CRDT_RANK_SPACE = CRDT_RANK_RADIX ** BigInt(CRDT_RANK_WIDTH)
const TOMBSTONE_TAGS = new Set(['z', 'zz'])

/*
NostrDB reserves "~" metadata for local CRDT merges of owner-authored
replaceable/addressable events:

- normal tags append "~u=<seconds>;o=<rank>"
- tombstone tags append "~u=<seconds>;i=<indexes>"
- content uses a separate ["~", "u=<seconds>"] marker

"u" is the field update time, "o" is the normal-tag order rank, and "i" is the
tombstone identity index list. Local mode preserves authoring intent by trusting
the incoming tag order; sync mode favors deterministic device convergence by
ordering from CRDT ranks and canonical tie-breakers.

Order ranks are fixed-width 8-char base36 strings because they are compact ASCII,
lexicographically sortable when padded, and provide 36^8 sparse positions for
future midpoint-style inserts without changing the metadata shape.
*/
export function buildCrdtMergeTemplate (incoming, existing, options = {}) {
  const config = normalizeCrdtOptions(options)
  const incomingState = eventState(incoming, config)
  const existingState = existing ? eventState(existing, config) : emptyState()
  const tagActions = new Map()

  for (const action of existingState.tags.values()) setWinningAction(tagActions, action)
  for (const action of existingState.tombstones.values()) setWinningAction(tagActions, action)
  for (const action of incomingState.tags.values()) setWinningAction(tagActions, action)
  for (const action of incomingState.tombstones.values()) setWinningAction(tagActions, action)

  if (config.mergeSource === 'local') {
    for (const [key, action] of existingState.tags) {
      if (incomingState.tags.has(key) || incomingState.tombstones.has(key)) continue
      setWinningAction(tagActions, tombstoneActionFromDeletedTag(action, incoming, config))
    }
  }

  const content = winningAction(existingState.content, incomingState.content)
  const normalTags = []
  const tombstones = []

  for (const action of tagActions.values()) {
    if (action.type === 'tag') normalTags.push(action)
    if (action.type === 'delete') tombstones.push(action)
  }

  const orderedNormalTags = orderNormalTags(normalTags, existingState, incomingState, config)
  tombstones.sort(compareTombstones)

  const tags = [
    ...orderedNormalTags.map(action => cloneTag(action.tag)),
    [CRDT_CONTENT_TAG, serializeContentMetadata(content.timestamp)],
    ...tombstones.slice(0, config.maxTombstoneTags).map(action => cloneTag(action.tag))
  ]

  const createdAt = mergedCreatedAt(incoming, existing, content, orderedNormalTags, tombstones, config)
  if (createdAt === null) return null

  return {
    kind: incoming.kind,
    pubkey: incoming.pubkey,
    created_at: createdAt,
    tags,
    content: content.value
  }
}

function normalizeCrdtOptions ({
  tagIdentity,
  tombstoneGraceSeconds,
  maxTombstoneTags,
  tombstoneTagName,
  mergeSource,
  now
} = {}) {
  return {
    tagIdentity: normalizeTagIdentity(tagIdentity),
    tombstoneGraceSeconds: Number.isInteger(tombstoneGraceSeconds) && tombstoneGraceSeconds >= 0
      ? tombstoneGraceSeconds
      : DEFAULT_TOMBSTONE_GRACE_SECONDS,
    maxTombstoneTags: Number.isInteger(maxTombstoneTags) && maxTombstoneTags >= 0
      ? maxTombstoneTags
      : DEFAULT_MAX_TOMBSTONE_TAGS,
    tombstoneTagName: normalizeTombstoneTagName(tombstoneTagName),
    mergeSource: mergeSource === 'sync' ? 'sync' : 'local',
    now: Number.isInteger(now) && now >= 0 ? now : Math.floor(Date.now() / 1000)
  }
}

function normalizeTagIdentity (tagIdentity) {
  const fallback = { default: [0, 1], byName: new Map() }
  if (!tagIdentity || typeof tagIdentity !== 'object' || Array.isArray(tagIdentity)) return fallback

  const byName = new Map()
  if (tagIdentity.byName && typeof tagIdentity.byName === 'object' && !Array.isArray(tagIdentity.byName)) {
    for (const [name, indexes] of Object.entries(tagIdentity.byName)) {
      const normalized = normalizeIndexList(indexes)
      if (normalized.length > 0) byName.set(name, normalized)
    }
  }

  const defaultIndexes = normalizeIndexList(tagIdentity.default)
  return {
    default: defaultIndexes.length > 0 ? defaultIndexes : fallback.default,
    byName
  }
}

function normalizeIndexList (indexes) {
  if (!Array.isArray(indexes)) return []
  return [...new Set(indexes.filter(index => Number.isInteger(index) && index >= 0))]
    .sort((a, b) => a - b)
}

function normalizeTombstoneTagName (tombstoneTagName) {
  const fallback = { default: 'zz', byName: new Map() }
  if (!tombstoneTagName || typeof tombstoneTagName !== 'object' || Array.isArray(tombstoneTagName)) return fallback

  const byName = new Map()
  if (tombstoneTagName.byName && typeof tombstoneTagName.byName === 'object' && !Array.isArray(tombstoneTagName.byName)) {
    for (const [name, value] of Object.entries(tombstoneTagName.byName)) {
      if (value === 'z' || value === 'zz') byName.set(name, value)
    }
  }

  return {
    default: tombstoneTagName.default === 'z' || tombstoneTagName.default === 'zz'
      ? tombstoneTagName.default
      : fallback.default,
    byName
  }
}

function eventState (event, config) {
  const state = emptyState()
  const tags = Array.isArray(event.tags) ? event.tags : []

  for (const tag of tags) {
    if (!Array.isArray(tag) || typeof tag[0] !== 'string') continue

    if (isContentMetadataTag(tag)) {
      const metadata = parseContentMetadata(tag)
      if (metadata && metadata.timestamp !== null) {
        state.content = winningAction(state.content, contentAction(
          event.content,
          capActionTimestamp(metadata.timestamp, event, config)
        ))
      }
      continue
    }

    if (isTombstoneTag(tag)) {
      const action = tombstoneActionFromTag(tag, event, config)
      if (action) setWinningAction(state.tombstones, action)
      continue
    }

    const metadata = tagMetadata(tag)
    const timestamp = capActionTimestamp(metadata?.timestamp ?? event.created_at, event, config)
    const baseTag = stripReservedMetadataValues(tag)
    if (baseTag.length === 0) continue

    const indexes = identityIndexes(baseTag[0], config)
    const values = valuesAtIndexes(baseTag, indexes)
    const key = identityKey(indexes, values)
    const rank = metadata?.rank ?? null
    const action = normalTagAction({
      key,
      indexes,
      values,
      tagName: baseTag[0],
      baseTag,
      timestamp,
      rank
    })

    setWinningAction(state.tags, action)
    if (!state.order.has(key)) state.order.set(key, state.order.size)
  }

  if (!state.content) {
    state.content = contentAction(
      event.content,
      capActionTimestamp(event.created_at, event, config)
    )
  }
  return state
}

function emptyState () {
  return {
    tags: new Map(),
    tombstones: new Map(),
    order: new Map(),
    content: null
  }
}

function contentAction (value, timestamp) {
  return {
    type: 'content',
    value: typeof value === 'string' ? value : '',
    timestamp,
    payload: typeof value === 'string' ? value : ''
  }
}

function normalTagAction ({ key, indexes, values, tagName, baseTag, timestamp, rank }) {
  const tag = [...baseTag, serializeNormalMetadata(timestamp, rank)]
  return {
    type: 'tag',
    key,
    indexes,
    values,
    tagName,
    baseTag,
    timestamp,
    rank,
    tag,
    payload: JSON.stringify(tag)
  }
}

function isContentMetadataTag (tag) {
  return tag[0] === CRDT_CONTENT_TAG && typeof tag[1] === 'string'
}

function parseContentMetadata (tag) {
  return parseMetadataFields(tag[1], { prefixed: false })
}

function isTombstoneTag (tag) {
  return TOMBSTONE_TAGS.has(tag[0])
}

function tombstoneActionFromTag (tag, event, config) {
  const parsed = parseTombstoneTag(tag)
  if (!parsed) return null

  const timestamp = capActionTimestamp(parsed.timestamp, event, config)
  // Sync merges age tombstones from event data, not local wall time, so devices
  // do not disagree about whether the same tombstone is stale.
  if (tombstoneAge(event, timestamp, config) > config.tombstoneGraceSeconds) return null

  return tombstoneAction({
    key: identityKey(parsed.indexes, parsed.values),
    indexes: parsed.indexes,
    values: parsed.values,
    tagName: tag[0],
    timestamp
  })
}

function tombstoneActionFromDeletedTag (action, incoming, config) {
  const timestamp = capActionTimestamp(incoming.created_at, incoming, config)
  return tombstoneAction({
    key: action.key,
    indexes: action.indexes,
    values: action.values,
    tagName: tombstoneTagNameFor(action.tagName, config),
    timestamp
  })
}

function tombstoneAction ({ key, indexes, values, tagName, timestamp }) {
  const tag = [
    tagName,
    encodeTombstoneValues(values),
    serializeTombstoneMetadata(timestamp, indexes)
  ]

  return {
    type: 'delete',
    key,
    indexes,
    values,
    tagName,
    tag,
    timestamp,
    payload: JSON.stringify(tag)
  }
}

function tombstoneTagNameFor (name, config) {
  return config.tombstoneTagName.byName.get(name) ?? config.tombstoneTagName.default
}

function parseTombstoneTag (tag) {
  if (!Array.isArray(tag) || !isTombstoneTag(tag)) return null
  if (typeof tag[1] !== 'string' || typeof tag[2] !== 'string') return null

  const metadata = parseMetadataFields(tag[2])
  if (!metadata || metadata.timestamp === null || metadata.indexes.length === 0) return null

  const values = decodeTombstoneValues(tag[1])
  if (values.length !== metadata.indexes.length) return null

  return { timestamp: metadata.timestamp, indexes: metadata.indexes, values }
}

function tagMetadata (tag) {
  for (const value of tag) {
    if (typeof value !== 'string' || !value.startsWith(CRDT_META_PREFIX)) continue
    const metadata = parseMetadataFields(value)
    if (metadata?.timestamp !== null) return metadata
  }
  return null
}

function parseMetadataFields (value, { prefixed = true } = {}) {
  if (typeof value !== 'string') return null
  const source = prefixed
    ? value.startsWith(CRDT_META_PREFIX) ? value.slice(CRDT_META_PREFIX.length) : null
    : value
  if (!source) return null

  const fields = new Map()
  for (const part of source.split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const key = part.slice(0, separator)
    const fieldValue = part.slice(separator + 1)
    if (key.length === 1 && fieldValue !== '') fields.set(key, fieldValue)
  }

  return {
    timestamp: parseNonNegativeInteger(fields.get('u')),
    rank: parseRank(fields.get('o')),
    indexes: parseIndexField(fields.get('i'))
  }
}

function parseNonNegativeInteger (value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function parseIndexField (value) {
  if (typeof value !== 'string') return []
  const indexes = value.split(',').map(parseNonNegativeInteger)
  return indexes.length > 0 && indexes.every(index => index !== null) ? indexes : []
}

function parseRank (value) {
  return isValidRank(value) ? value : null
}

function isValidRank (value) {
  return typeof value === 'string' && /^[0-9a-z]{8}$/.test(value)
}

function stripReservedMetadataValues (tag) {
  return tag
    .map(value => String(value))
    .filter(value => !value.startsWith(CRDT_META_PREFIX))
}

function serializeNormalMetadata (timestamp, rank) {
  return rank ? `~u=${timestamp};o=${rank}` : `~u=${timestamp}`
}

function serializeTombstoneMetadata (timestamp, indexes) {
  return `~u=${timestamp};i=${indexes.join(',')}`
}

function serializeContentMetadata (timestamp) {
  return `u=${timestamp}`
}

function capActionTimestamp (timestamp, event, config) {
  // Local authoring may trust the current clock, while sync must depend only on
  // the event being merged so every device computes the same capped timestamp.
  const cap = config.mergeSource === 'sync'
    ? event.created_at + CRDT_CLOCK_SKEW_SECONDS
    : Math.max(config.now, event.created_at) + CRDT_CLOCK_SKEW_SECONDS
  return Math.min(timestamp, cap)
}

function tombstoneAge (event, timestamp, config) {
  return (config.mergeSource === 'sync' ? event.created_at : config.now) - timestamp
}

function identityIndexes (name, config) {
  return config.tagIdentity.byName.get(name) ?? config.tagIdentity.default
}

function valuesAtIndexes (tag, indexes) {
  return indexes.map(index => tag[index] ?? '')
}

function identityKey (indexes, values) {
  return `${indexes.join(':')}\u0000${JSON.stringify(values)}`
}

function setWinningAction (map, action) {
  map.set(action.key, winningAction(map.get(action.key), action))
}

function winningAction (a, b) {
  if (!a) return b
  if (!b) return a
  if (a.timestamp !== b.timestamp) return a.timestamp > b.timestamp ? a : b
  // Equal-time conflicts need a stable tie-breaker so A+B and B+A converge.
  return a.payload >= b.payload ? a : b
}

function orderNormalTags (actions, existingState, incomingState, config) {
  const byKey = new Map(actions.map(action => [action.key, action]))
  const orderedKeys = config.mergeSource === 'sync'
    ? syncOrderedKeys(actions)
    : localOrderedKeys(byKey, existingState, incomingState)
  const ordered = orderedKeys.map(key => byKey.get(key)).filter(Boolean)

  return assignRanks(ordered, config)
}

function localOrderedKeys (byKey, existingState, incomingState) {
  // Local mode treats the incoming event as the author's latest layout: incoming
  // survivors first, then older surviving tags that were not mentioned.
  const incomingKeys = orderedKeys(incomingState, byKey)
  const incomingKeySet = new Set(incomingKeys)
  const existingOnlyKeys = orderedKeys(existingState, byKey)
    .filter(key => !incomingKeySet.has(key))
  return uniqueKeys([...incomingKeys, ...existingOnlyKeys])
}

function syncOrderedKeys (actions) {
  // Sync mode uses valid unique ranks when possible; if rank data is incomplete
  // or corrupt, canonical identity/payload order gives every device one answer.
  const canUseRankOrder = hasUniqueValidRanks(actions)
  const ordered = [...actions].sort(canUseRankOrder ? compareByRank : compareByIdentityPayload)
  return ordered.map(action => action.key)
}

function orderedKeys (state, byKey) {
  return [...state.order.entries()]
    .filter(([key]) => byKey.has(key))
    .sort((a, b) => a[1] - b[1])
    .map(([key]) => key)
}

function uniqueKeys (keys) {
  const seen = new Set()
  const unique = []

  for (const key of keys) {
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(key)
  }

  return unique
}

function assignRanks (actions, config) {
  if (actions.length === 0) return []
  if (hasStrictlyIncreasingRanks(actions)) return actions.map(action => withRank(action, action.rank))

  // Rebalancing rewrites ranks over the full sparse space. Sync rebalances from
  // canonical order; local rebalances from the author's incoming-first order.
  const deterministicActions = config.mergeSource === 'sync'
    ? [...actions].sort(compareByIdentityPayload)
    : actions
  const ranks = rebalanceRanks(deterministicActions.length)

  return deterministicActions.map((action, index) => withRank(action, ranks[index]))
}

function hasUniqueValidRanks (actions) {
  const seen = new Set()

  for (const action of actions) {
    if (!isValidRank(action.rank) || seen.has(action.rank)) return false
    seen.add(action.rank)
  }

  return true
}

function hasStrictlyIncreasingRanks (actions) {
  let previous = null

  for (const action of actions) {
    if (!isValidRank(action.rank)) return false
    const value = rankValue(action.rank)
    if (previous !== null && value <= previous) return false
    previous = value
  }

  return true
}

function withRank (action, rank) {
  return normalTagAction({
    key: action.key,
    indexes: action.indexes,
    values: action.values,
    tagName: action.tagName,
    baseTag: action.baseTag,
    timestamp: action.timestamp,
    rank
  })
}

function rebalanceRanks (length) {
  // Even spacing keeps rank strings ordered and leaves large gaps for future
  // insertions without requiring immediate full rewrites.
  const step = CRDT_RANK_SPACE / BigInt(length + 1)
  return Array.from({ length }, (_, index) => formatRank(step * BigInt(index + 1)))
}

function formatRank (value) {
  return value.toString(36).padStart(CRDT_RANK_WIDTH, '0').slice(-CRDT_RANK_WIDTH)
}

function rankValue (rank) {
  let value = 0n

  for (const char of rank) {
    value *= CRDT_RANK_RADIX
    value += BigInt(parseInt(char, 36))
  }

  return value
}

function compareByRank (a, b) {
  const rank = compareStrings(a.rank, b.rank)
  if (rank !== 0) return rank
  return compareByIdentityPayload(a, b)
}

function compareByIdentityPayload (a, b) {
  const key = compareStrings(a.key, b.key)
  if (key !== 0) return key
  return compareStrings(a.payload, b.payload)
}

function compareTombstones (a, b) {
  // Tombstones stay last, but their internal order is deterministic so signed
  // sync-merged templates can converge to the same event id.
  if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp
  const key = compareStrings(a.key, b.key)
  if (key !== 0) return key
  const tagName = compareStrings(a.tagName, b.tagName)
  if (tagName !== 0) return tagName
  return compareStrings(a.payload, b.payload)
}

function compareStrings (a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function mergedCreatedAt (incoming, existing, content, normalTags, tombstones, config) {
  if (config.mergeSource === 'sync') {
    // Sync-created events use only CRDT field clocks; local merges keep
    // relay-friendly Nostr replacement ordering below.
    const createdAt = Math.max(
      content.timestamp,
      ...normalTags.map(action => action.timestamp),
      ...tombstones.map(action => action.timestamp)
    )
    return createdAt <= 0xffffffff ? createdAt : null
  }

  if (!existing) return incoming.created_at

  const createdAt = Math.max(incoming.created_at, existing.created_at + 1)
  return createdAt <= 0xffffffff ? createdAt : null
}

function encodeTombstoneValues (values) {
  return values.map(value => String(value).replaceAll('^', '-^')).join('^')
}

function decodeTombstoneValues (encoded) {
  const values = []
  let value = ''

  for (let i = 0; i < encoded.length; i++) {
    const char = encoded[i]
    if (char === '-' && encoded[i + 1] === '^') {
      value += '^'
      i++
    } else if (char === '^') {
      values.push(value)
      value = ''
    } else {
      value += char
    }
  }

  values.push(value)
  return values
}

function cloneTag (tag) {
  return tag.map(value => String(value))
}
