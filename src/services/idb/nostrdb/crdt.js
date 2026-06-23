const DEFAULT_TOMBSTONE_GRACE_SECONDS = 21 * 24 * 60 * 60
const DEFAULT_MAX_TOMBSTONE_TAGS = 100
const CRDT_CLOCK_SKEW_SECONDS = 60
const CONTENT_U_AT_TAG = 'u@'
const TOMBSTONE_TAGS = new Set(['z', 'zz'])

// Local CRDT convention for owner-authored replaceable/addressable events:
// enrich missing per-field clocks, merge against the current coordinate row,
// and leave signing/storage decisions to index.js so no IDB write tx stays open.
export function buildCrdtMergeTemplate (incoming, existing, options = {}) {
  const config = normalizeCrdtOptions(options)
  const incomingState = eventState(incoming, config)
  const existingState = existing ? eventState(existing, config) : emptyState()
  const tagActions = new Map()

  for (const action of existingState.tags.values()) setWinningAction(tagActions, action)
  for (const action of existingState.tombstones.values()) setWinningAction(tagActions, action)
  for (const action of incomingState.tags.values()) setWinningAction(tagActions, action)
  for (const action of incomingState.tombstones.values()) setWinningAction(tagActions, action)

  for (const [key, action] of existingState.tags) {
    if (incomingState.tags.has(key) || incomingState.tombstones.has(key)) continue
    setWinningAction(tagActions, tombstoneActionFromDeletedTag(action, incoming, config))
  }

  const content = winningAction(existingState.content, incomingState.content)
  const normalTags = []
  const tombstones = []

  for (const action of tagActions.values()) {
    if (action.type === 'tag') normalTags.push(action)
    if (action.type === 'delete') tombstones.push(action)
  }

  normalTags.sort(compareNormalTagOrder(existingState, incomingState))
  tombstones.sort(compareTombstones)

  const tags = [
    ...normalTags.map(action => cloneTag(action.tag)),
    [CONTENT_U_AT_TAG, String(content.timestamp)],
    ...tombstones.slice(0, config.maxTombstoneTags).map(action => cloneTag(action.tag))
  ]

  const createdAt = nextMergedCreatedAt(incoming, existing)
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

  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index]
    if (!Array.isArray(tag) || typeof tag[0] !== 'string') continue

    if (isContentUpdatedAtTag(tag)) {
      const timestamp = parseStrictTimestamp(tag[1])
      if (timestamp !== null) {
        state.content = winningAction(state.content, contentAction(
          event.content,
          capActionTimestamp(timestamp, event, config)
        ))
      }
      continue
    }

    if (isTombstoneTag(tag)) {
      const action = tombstoneActionFromTag(tag, event, config)
      if (action) setWinningAction(state.tombstones, action)
      continue
    }

    const timestamp = capActionTimestamp(tagUpdatedAt(tag) ?? event.created_at, event, config)
    const enriched = normalizeTagClock(tag, timestamp)
    const indexes = identityIndexes(enriched[0], config)
    const key = identityKey(indexes, valuesAtIndexes(enriched, indexes))
    const action = {
      type: 'tag',
      key,
      indexes,
      values: valuesAtIndexes(enriched, indexes),
      tagName: enriched[0],
      tag: enriched,
      timestamp,
      payload: JSON.stringify(enriched)
    }

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

function isContentUpdatedAtTag (tag) {
  return tag[0] === CONTENT_U_AT_TAG
}

function isTombstoneTag (tag) {
  return TOMBSTONE_TAGS.has(tag[0])
}

function tombstoneActionFromTag (tag, event, config) {
  const parsed = parseTombstoneTag(tag)
  if (!parsed) return null
  const timestamp = capActionTimestamp(parsed.timestamp, event, config)
  if (config.now - timestamp > config.tombstoneGraceSeconds) return null

  const normalized = normalizeTombstoneClock(tag, timestamp)

  return {
    type: 'delete',
    key: identityKey(parsed.indexes, parsed.values),
    indexes: parsed.indexes,
    values: parsed.values,
    tagName: tag[0],
    tag: normalized,
    timestamp,
    payload: JSON.stringify(normalized)
  }
}

function tombstoneActionFromDeletedTag (action, incoming, config) {
  const timestamp = capActionTimestamp(incoming.created_at, incoming, config)
  const tagName = tombstoneTagNameFor(action.tagName, config)
  const tag = [
    tagName,
    encodeTombstoneValues(action.values),
    `u@ ${timestamp}:${action.indexes.join(':')}`
  ]

  return {
    type: 'delete',
    key: action.key,
    indexes: action.indexes,
    values: action.values,
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

  const match = /^u@ (\d+)((?::\d+)*)$/.exec(tag[2])
  if (!match) return null

  const timestamp = Number(match[1])
  if (!Number.isInteger(timestamp) || timestamp < 0) return null

  const indexes = match[2]
    .slice(1)
    .split(':')
    .filter(Boolean)
    .map(value => Number(value))
  if (indexes.length === 0 || indexes.some(index => !Number.isInteger(index) || index < 0)) return null

  const values = decodeTombstoneValues(tag[1])
  if (values.length !== indexes.length) return null

  return { timestamp, indexes, values }
}

function parseStrictTimestamp (value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const timestamp = Number(value)
  return Number.isInteger(timestamp) && timestamp >= 0 ? timestamp : null
}

function tagUpdatedAt (tag) {
  for (const value of tag) {
    if (typeof value !== 'string') continue
    const match = /^u@ (\d+)(?::.*)?$/.exec(value)
    if (!match) continue

    const timestamp = Number(match[1])
    if (Number.isInteger(timestamp) && timestamp >= 0) return timestamp
  }
  return null
}

function normalizeTagClock (tag, timestamp) {
  const normalized = cloneTag(tag)

  for (let i = 0; i < normalized.length; i++) {
    if (!/^u@ \d+(?::.*)?$/.test(normalized[i])) continue
    normalized[i] = normalized[i].replace(/^u@ \d+/, `u@ ${timestamp}`)
    return normalized
  }

  return [...normalized, `u@ ${timestamp}`]
}

function normalizeTombstoneClock (tag, timestamp) {
  const normalized = cloneTag(tag)
  normalized[2] = normalized[2].replace(/^u@ \d+/, `u@ ${timestamp}`)
  return normalized
}

// Field-level CRDT clocks may be future-dated for scheduled events, but not
// beyond the event's own declared time plus a small clock-skew allowance.
function capActionTimestamp (timestamp, event, config) {
  return Math.min(timestamp, Math.max(config.now, event.created_at) + CRDT_CLOCK_SKEW_SECONDS)
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
  return a.payload >= b.payload ? a : b
}

function compareNormalTagOrder (existingState, incomingState) {
  return (a, b) => compareOrder(orderRank(a.key, existingState, incomingState), orderRank(b.key, existingState, incomingState))
}

function orderRank (key, existingState, incomingState) {
  if (existingState.order.has(key)) return [0, existingState.order.get(key)]
  if (incomingState.order.has(key)) return [1, incomingState.order.get(key)]
  return [2, key]
}

function compareOrder (a, b) {
  if (a[0] !== b[0]) return a[0] - b[0]
  if (a[1] === b[1]) return 0
  return a[1] < b[1] ? -1 : 1
}

function compareTombstones (a, b) {
  if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp
  if (a.payload === b.payload) return 0
  return a.payload < b.payload ? -1 : 1
}

function nextMergedCreatedAt (incoming, existing) {
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
