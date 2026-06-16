import uFuzzy from '@leeoniya/ufuzzy'

export const SEARCH_BATCH_SIZE = 500
export const SEARCH_MAX_BATCHES = 20
export const SEARCH_MAX_CANDIDATES = SEARCH_BATCH_SIZE * SEARCH_MAX_BATCHES

const searchCollator = typeof Intl === 'undefined'
  ? null
  : new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

// Search field config example:
// 0: { contentJson: ['name'] }
// 30023: { content: true, tags: ['title', 'summary'] }
const SEARCH_FIELD_CONFIG = {
  0: { contentJson: ['name'] },
  30023: { content: true, tags: ['title', 'summary'] }
}

export function parseSearch (value) {
  const parsed = { text: '', sortOld: false, autocomplete: false }
  if (typeof value !== 'string') return parsed

  const terms = []
  for (const token of value.trim().split(/\s+/)) {
    if (!token) continue
    if (token === 'sort:old') {
      parsed.sortOld = true
    } else if (token === 'autocomplete:true') {
      parsed.autocomplete = true
    } else if (!isSearchExtensionToken(token)) {
      terms.push(token)
    }
  }

  parsed.text = terms.join(' ')
  return parsed
}

export function rankSearchCandidates (candidates, filter, compareTime) {
  if (candidates.length === 0) return []

  const needle = uFuzzy.latinize(filter.searchText)
  const haystack = uFuzzy.latinize(candidates.map(candidate => candidate.text))
  const events = candidates.map(candidate => candidate.event)
  // eslint-disable-next-line new-cap
  const searcher = new uFuzzy({
    compare: compareSearchStrings,
    sort: filter.autocomplete
      ? typeaheadSearchSort(events, filter, compareTime)
      : regularSearchSort(events, filter, compareTime)
  })
  const [idxs, info, order] = searcher.search(haystack, needle, true, SEARCH_MAX_CANDIDATES)

  if (!idxs || idxs.length === 0) return []

  if (info && order) {
    return order.map(infoIdx => candidates[info.idx[infoIdx]])
  }

  return idxs
    .map(idx => candidates[idx])
    .sort((a, b) => compareTime(a.event, b.event, filter))
}

export function eventMatchesSearch (event, filter, compareTime) {
  const text = getSearchableText(event)
  return !!text && rankSearchCandidates([{ event, text }], filter, compareTime).length > 0
}

export function getSearchableText (event) {
  const config = SEARCH_FIELD_CONFIG[event.kind]
  const values = []

  if (!config) {
    values.push(event.content)
  } else {
    if (Array.isArray(config.tags)) {
      for (const name of config.tags) {
        for (const tag of event.tags) {
          if (tag[0] === name && tag[1]) values.push(tag[1])
        }
      }
    }

    if (config.content) values.push(event.content)

    if (Array.isArray(config.contentJson)) {
      const json = parseJsonObject(event.content)
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

function regularSearchSort (events, filter, compareTime) {
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
      compareTime(events[idx[ia]], events[idx[ib]], filter) ||
      compare(haystack[idx[ia]], haystack[idx[ib]])
    ))
  }
}

function typeaheadSearchSort (events, filter, compareTime) {
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
      compareTime(events[idx[ia]], events[idx[ib]], filter) ||
      compare(haystack[idx[ia]], haystack[idx[ib]])
    ))
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
