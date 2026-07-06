import uFuzzy from '@leeoniya/ufuzzy'

import { eventKinds } from '#constants/event.js'

/*
Search is a bounded local fuzzy pass over IndexedDB-filtered events, not a full
text index. Query-time early stop is match-count based: once enough uFuzzy
matches have been collected after a small amount of chronological coverage, the
scan can stop and final ranking is quality-first only within that collected set.
This keeps broad searches responsive, but a better match farther away in time can
be missed after early stop triggers.
*/
export const SEARCH_BATCH_SIZE = 500
export const SEARCH_MAX_BATCHES = 20
export const SEARCH_MAX_CANDIDATES = SEARCH_BATCH_SIZE * SEARCH_MAX_BATCHES
export const SEARCH_MIN_BATCHES = 2
export const SEARCH_MIN_MATCHES = 100
export const SEARCH_MATCH_MULTIPLIER = 8
export const SEARCH_MAX_MATCHES = 1000

const searchCollator = typeof Intl === 'undefined'
  ? null
  : new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

// Search field config example:
// 0: { contentJson: ['name'] }
// 30023: { content: true, tags: ['title', 'summary'] }
const LOCAL_COPY_KIND = eventKinds.LOCAL_COPY ?? 1006

const SEARCH_FIELD_CONFIG = {
  0: { contentJson: ['name'], tags: ['name'] },
  30023: { content: true, tags: ['title', 'summary'] }
}

// Parse NIP-50 search text into uFuzzy input and the extensions this DB knows.
export function parseSearch (value) {
  const parsed = { text: '', algorithm: 'created_at', sort: 'desc', sortOld: false, autocomplete: false }
  if (typeof value !== 'string') return parsed

  const terms = []
  for (const token of value.trim().split(/\s+/)) {
    if (!token) continue
    if (token === 'sort:asc') {
      parsed.sort = 'asc'
      parsed.sortOld = true
    } else if (token === 'sort:desc') {
      parsed.sort = 'desc'
      parsed.sortOld = false
    } else if (token === 'algo:sync') {
      parsed.algorithm = 'sync'
    } else if (token === 'autocomplete:true') {
      parsed.autocomplete = true
    } else if (!isSearchExtensionToken(token)) {
      terms.push(token)
    }
  }

  parsed.text = terms.join(' ')
  return parsed
}

// Cheaply keep only candidates that uFuzzy considers matches for this batch.
export function matchSearchCandidates (candidates, filter) {
  if (candidates.length === 0) return []

  const needle = uFuzzy.latinize(filter.searchText)
  const haystack = uFuzzy.latinize(candidates.map(candidate => candidate.text))
  // eslint-disable-next-line new-cap
  const searcher = new uFuzzy()
  const [idxs] = searcher.search(haystack, needle, true, 0)

  if (!idxs || idxs.length === 0) return []

  return idxs.map(idx => candidates[idx])
}

// Final quality-first ordering over the bounded set collected by the DB scan.
export function rankSearchCandidates (candidates, filter, compareTime) {
  if (candidates.length === 0) return []

  const needle = uFuzzy.latinize(filter.searchText)
  const haystack = uFuzzy.latinize(candidates.map(candidate => candidate.text))
  // eslint-disable-next-line new-cap
  const searcher = new uFuzzy({
    compare: compareSearchStrings,
    sort: filter.autocomplete
      ? typeaheadSearchSort(candidates, filter, compareTime)
      : regularSearchSort(candidates, filter, compareTime)
  })
  const [idxs, info, order] = searcher.search(haystack, needle, true, SEARCH_MAX_CANDIDATES)

  if (!idxs || idxs.length === 0) return []

  if (info && order) {
    return order.map(infoIdx => candidates[info.idx[infoIdx]])
  }

  return idxs
    .map(idx => candidates[idx])
    .sort((a, b) => compareTime(a, b, filter))
}

export function eventMatchesSearch (event, filter, compareTime) {
  const text = getSearchableText(event)
  return !!text && rankSearchCandidates([{ event, text }], filter, compareTime).length > 0
}

export async function getSearchableTextForEvent (event, { decryptLocalCopyContent } = {}) {
  if (event?.kind !== LOCAL_COPY_KIND || typeof decryptLocalCopyContent !== 'function') {
    return getSearchableText(event)
  }

  try {
    const plaintext = await decryptLocalCopyContent(event)
    const innerEvent = normalizeSearchEvent(parseJsonObject(plaintext))
    return innerEvent ? getSearchableText(innerEvent) : ''
  } catch {
    return ''
  }
}

// Extract the text fields that should participate in fuzzy search for each kind.
export function getSearchableText (event) {
  const config = SEARCH_FIELD_CONFIG[event?.kind]
  const values = []
  const tags = Array.isArray(event?.tags) ? event.tags : []
  const content = typeof event?.content === 'string' ? event.content : ''

  if (!config) {
    values.push(content)
  } else {
    if (Array.isArray(config.tags)) {
      for (const name of config.tags) {
        for (const tag of tags) {
          if (tag[0] === name && tag[1]) values.push(tag[1])
        }
      }
    }

    if (config.content) values.push(content)

    if (Array.isArray(config.contentJson)) {
      const json = parseJsonObject(content)
      for (const key of config.contentJson) {
        const value = json?.[key]
        if (typeof value === 'string') values.push(value)
      }
    }
  }

  return values
    .filter(value => typeof value === 'string' && value.trim())
    .join('\n')
}

function regularSearchSort (candidates, filter, compareTime) {
  return (info, haystack, _needle, compare = compareSearchStrings) => {
    const {
      idx,
      chars,
      terms,
      interLft2,
      interLft1,
      start,
      intraIns,
      interIns,
      cases
    } = info

    return idx.map((_, i) => i).sort((ia, ib) => (
      chars[ib] - chars[ia] ||
      intraIns[ia] - intraIns[ib] ||
      (
        (terms[ib] + interLft2[ib] + 0.5 * interLft1[ib]) -
        (terms[ia] + interLft2[ia] + 0.5 * interLft1[ia])
      ) ||
      interIns[ia] - interIns[ib] ||
      start[ia] - start[ib] ||
      cases[ib] - cases[ia] ||
      compareTime(candidates[idx[ia]], candidates[idx[ib]], filter) ||
      compare(haystack[idx[ia]], haystack[idx[ib]])
    ))
  }
}

function typeaheadSearchSort (candidates, filter, compareTime) {
  return (info, haystack, _needle, compare = compareSearchStrings) => {
    const {
      idx,
      chars,
      terms,
      interLft2,
      interLft1,
      start,
      intraIns,
      interIns
    } = info

    return idx.map((_, i) => i).sort((ia, ib) => (
      chars[ib] - chars[ia] ||
      intraIns[ia] - intraIns[ib] ||
      start[ia] - start[ib] ||
      haystack[idx[ia]].length - haystack[idx[ib]].length ||
      (
        (terms[ib] + interLft2[ib] + 0.5 * interLft1[ib]) -
        (terms[ia] + interLft2[ia] + 0.5 * interLft1[ia])
      ) ||
      interIns[ia] - interIns[ib] ||
      compareTime(candidates[idx[ia]], candidates[idx[ib]], filter) ||
      compare(haystack[idx[ia]], haystack[idx[ib]])
    ))
  }
}

function normalizeSearchEvent (event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null
  return {
    ...event,
    tags: Array.isArray(event.tags) ? event.tags : [],
    content: typeof event.content === 'string' ? event.content : ''
  }
}

function parseJsonObject (value) {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isSearchExtensionToken (token) {
  const colon = token.indexOf(':')
  if (colon <= 0 || colon === token.length - 1) return false

  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(token.slice(0, colon))
}

function compareSearchStrings (a, b) {
  if (searchCollator) return searchCollator.compare(a, b)
  if (a === b) return 0
  return a < b ? -1 : 1
}
