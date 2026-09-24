import { accountEventPages, assertHistoryReport, ACCOUNT_PAGE_SIZE } from './account-event-pages.js'
import { missingCoverage } from './account-event-coverage.js'
import { isEphemeralEvent } from 'libp2r2p/event'
import {
  eventKinds, isEphemeralKind,
  CUSTOM_APP_DATA, REGULAR_CUSTOM_APP_DATA, PERSONAL_COPY,
  GIFT_WRAP, PRIVATE_DIRECT_MESSAGE, SEAL, ENCRYPTED_DIRECT_MESSAGE,
  PRIVATE_CHANNEL_BROADCAST, MUTE_LIST, BOOKMARKS, BOOKMARK_SET,
  KIND_MUTE_SET, DRAFT_LONG, DRAFT_CLASSIFIED_LISTING, BINARY_DATA_CHUNK
} from 'libp2r2p/kind'
import { isValidPublicRelayUrl, normalizeRelayUrl } from 'libp2r2p/url'

// These belong to app/private-message/file flows, not automatic account import.
const excludedKinds = new Set([
  CUSTOM_APP_DATA, REGULAR_CUSTOM_APP_DATA, PERSONAL_COPY,
  GIFT_WRAP, PRIVATE_DIRECT_MESSAGE, SEAL, ENCRYPTED_DIRECT_MESSAGE,
  PRIVATE_CHANNEL_BROADCAST, MUTE_LIST, BOOKMARKS, BOOKMARK_SET,
  KIND_MUTE_SET, DRAFT_LONG, DRAFT_CLASSIFIED_LISTING, BINARY_DATA_CHUNK
])
export const accountKinds = [...new Set(Object.values(eventKinds))]
  .filter(kind => !isEphemeralKind(kind) && !excludedKinds.has(kind))
  .sort((a, b) => a - b)
const allowedKinds = new Set(accountKinds)
// 44b-relay silently truncates longer lists. Deduplicate before splitting.
const MAX_KINDS_PER_FILTER = 30
const groupsOf = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))
const kindGroups = groupsOf(accountKinds, MAX_KINDS_PER_FILTER)
export const ACCOUNT_OVERLAP_SECONDS = 10 * 60
const REFRESH_MS = 5 * 60 * 1000

export function shouldStoreAccountEvent (event) {
  return allowedKinds.has(event.kind) && !isEphemeralEvent(event)
}

function writeRelays (event) {
  return (event?.tags ?? []).flatMap(tag => {
    if (tag[0] !== 'r' || (tag[2] && tag[2] !== 'write')) return []
    try {
      const url = normalizeRelayUrl(tag[1])
      return isValidPublicRelayUrl(url) ? [url] : []
    } catch { return [] }
  })
}

function newer (event, previous) {
  return !previous || event.created_at > previous.created_at || (event.created_at === previous.created_at && event.id < previous.id)
}
function pause (ms, signal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    timer.unref?.()
    signal.addEventListener('abort', finish, { once: true })
  })
}
function permanent (error) {
  return /^(auth-required:|restricted:|blocked:|invalid:)/.test(error?.message ?? '')
}

// One coordinator per launcher root. Identity state and durable progress remain
// owner-scoped even when feeds combine accounts (including read-only accounts).
export function createAccountEventTracker ({ pool, seeds, signal, reportError = console.error, warn = console.warn, now = () => Math.floor(Date.now() / 1000), refreshMs = REFRESH_MS, random = Math.random }) {
  const accounts = new Map()
  const entries = new Map()
  const tasks = new Set()
  let reconcileQueued = false
  const spawn = promise => { tasks.add(promise); promise.finally(() => tasks.delete(promise)).catch(() => {}) }
  const report = (error, entry, phase, filter) => reportError(error, { relay: entry.relay, phase, authors: filter?.authors ?? entry.authors, kinds: filter?.kinds ?? entry.kinds, since: filter?.since, until: filter?.until })

  function retire (entry) {
    entry.retired.abort()
    entry.stream?.stopAndDrain()
  }
  function scheduleReconcile () {
    if (reconcileQueued || signal.aborted) return
    reconcileQueued = true
    queueMicrotask(() => { reconcileQueued = false; reconcile() })
  }
  function reconcile () {
    if (signal.aborted) return
    const desired = new Map()
    function group (relay, kinds, account) {
      relay = normalizeRelayUrl(relay)
      const key = JSON.stringify([relay, kinds])
      if (!desired.has(key)) desired.set(key, { relay, kinds, members: [] })
      desired.get(key).members.push(account)
    }
    for (const account of accounts.values()) {
      for (const relay of new Set(seeds)) group(relay, [10002], account)
      for (const relay of new Set(writeRelays(account.latest.get(10002)))) {
        for (const kinds of kindGroups) group(relay, kinds, account)
      }
    }
    const next = new Map()
    for (const selection of desired.values()) {
      // Respect common relay author limits independently of kind limits.
      for (const members of groupsOf(selection.members.sort((a, b) => a.pubkey.localeCompare(b.pubkey)), 500)) {
        const authors = members.map(account => account.pubkey)
        const key = JSON.stringify([selection.relay, selection.kinds, members.map(account => account.identity)])
        next.set(key, { ...selection, authors, members })
      }
    }
    for (const [key, entry] of entries) {
      if (!next.has(key)) { retire(entry); entries.delete(key) }
    }
    for (const [key, selection] of next) {
      if (entries.has(key)) continue
      const entry = { ...selection, retired: new AbortController(), stream: null }
      entry.signal = AbortSignal.any([signal, entry.retired.signal])
      entries.set(key, entry)
      spawn(maintain(entry))
    }
  }

  async function persist (entry, event, filter) {
    const account = entry.members.find(account => account.pubkey === event.pubkey)
    if (!account?.active || signal.aborted) return
    if (!filter.kinds.includes(event.kind) || !filter.authors.includes(event.pubkey) || !shouldStoreAccountEvent(event)) return
    if ((filter.since !== undefined && event.created_at < filter.since) || (filter.until !== undefined && event.created_at > filter.until)) return
    const result = await account.db.add(event)
    // Duplicate, older replaceable versions and locally deleted originals are
    // already durably resolved. Other refusals must not advance coverage.
    if (!result.ok && !['duplicate', 'superseded', 'ignored', 'blocked'].includes(result.code)) {
      throw Object.assign(new Error(`Account event storage failed: ${result.code}`), { code: result.code })
    }
    if (!account.active || signal.aborted || result.code === 'blocked') return
    if ([0, 10002].includes(event.kind) && newer(event, account.latest.get(event.kind))) {
      account.latest.set(event.kind, event)
      account.sendToVault(event)
      if (event.kind === 10002) scheduleReconcile()
    }
  }
  async function recordsFor (entry, kinds = entry.kinds) {
    const records = new Map()
    for (const account of entry.members) {
      if (!account.active) continue
      await account.initialize()
      records.set(account, await account.coverage.read(entry.relay, kinds, entry.signal))
    }
    return records
  }
  async function mark (entry, records, filter) {
    entry.signal.throwIfAborted()
    for (const [account, rows] of records) {
      if (!account.active || !filter.authors.includes(account.pubkey)) continue
      await account.coverage.mark(rows.filter(row => filter.kinds.includes(row.kind)), filter.since, filter.until, entry.signal)
    }
  }
  async function scan (entry, filter, records, firstPage) {
    try {
      for await (const complete of accountEventPages({ pool, relay: entry.relay, filter, signal: entry.signal, firstPage, persist: (event, filter) => persist(entry, event, filter), warn })) {
        await mark(entry, records, complete)
      }
    } catch (error) {
      error.accountFilter = filter
      throw error
    }
  }

  // Historical jobs combine only identical bounds and compatible author/kind
  // rectangles. Generate one network operation at a time instead of enqueuing
  // every page in the pool. Newest missing ranges go first.
  function combineJobs (jobs) {
    const grouped = new Map()
    for (const job of jobs) {
      job.authors.sort()
      const key = JSON.stringify([job.since, job.until, job.authors])
      if (!grouped.has(key)) grouped.set(key, { ...job, kinds: [] })
      grouped.get(key).kinds.push(...job.kinds)
    }
    return [...grouped.values()].flatMap(job => groupsOf([...new Set(job.kinds)], 30).map(kinds => ({ ...job, kinds }))).sort((a, b) => b.until - a.until)
  }
  function jobsFor (records, boundsFor) {
    const byKind = new Map()
    for (const [account, rows] of records) {
      for (const row of rows) {
        const bounds = boundsFor(row)
        if (!bounds) continue
        for (const [since, until] of missingCoverage(row.intervals, ...bounds)) {
          const key = JSON.stringify([since, until, row.kind])
          if (!byKind.has(key)) byKind.set(key, { since, until, kinds: [row.kind], authors: [] })
          byKind.get(key).authors.push(account.pubkey)
        }
      }
    }
    return combineJobs(byKind.values())
  }
  async function backfill (entry, until) {
    let delay = 1000
    while (!entry.signal.aborted) {
      try {
        const records = await recordsFor(entry)
        const jobs = jobsFor(records, () => [0, until])
        if (!jobs.length) return
        for (const job of jobs) {
          await scan(entry, job, records)
          await pause(0, entry.signal)
        }
        return
      } catch (error) {
        if (entry.signal.aborted) return
        report(error, entry, 'backfill', error.accountFilter)
        if (permanent(error)) return
        await pause(Math.min(30000, delay * (0.8 + random() * 0.4)), entry.signal)
        delay = Math.min(delay * 2, 30000)
      }
    }
  }

  async function run (ownerEntry) {
    const attempt = new AbortController()
    const entry = { ...ownerEntry, signal: AbortSignal.any([ownerEntry.signal, attempt.signal]) }
    const records = await recordsFor(entry)
    entry.signal.throwIfAborted()
    // All grouped accounts share this recent interval. Older gaps since a
    // previous visit are caught up by compatible windows before releasing live;
    // first-time deep history runs separately after initial completion.
    const since = Math.max(0, now() - ACCOUNT_OVERLAP_SECONDS)
    const filter = { authors: entry.authors, kinds: entry.kinds, since, limit: ACCOUNT_PAGE_SIZE }
    const stream = pool.getEventsFeedGenerator(filter, [entry.relay], {
      signal, snapshot: true, timeoutAfterFirstEose: null
    })
    ownerEntry.stream = stream
    let count = 0
    let oldest = Infinity
    let initialComplete = false
    let background
    let until
    let refreshAt = Infinity
    let next = stream.next()
    try {
      while (!signal.aborted) {
        // Periodic refresh is a separate bounded read; it never interrupts an
        // initialized live stream or advances coverage from the latest live ID.
        const refreshAbort = new AbortController()
        const wakeSignal = AbortSignal.any([entry.signal, refreshAbort.signal])
        const outcome = refreshAt === Infinity || entry.signal.aborted
          ? await next
          : await Promise.race([next, pause(Math.max(0, refreshAt - Date.now()), wakeSignal).then(() => null)])
        refreshAbort.abort()
        if (outcome === null) {
          if (entry.signal.aborted) continue
          try {
            const current = await recordsFor(entry)
            const cutoff = now()
            // Regroup refreshes by last confirmed edge, including overlap even
            // where an earlier attempt already covered those seconds.
            const refreshes = new Map()
            for (const [account, rows] of current) {
              for (const row of rows) {
                const start = Math.max(0, Math.min(row.intervals.at(-1)?.[1] ?? cutoff, cutoff) - ACCOUNT_OVERLAP_SECONDS)
                const key = JSON.stringify([start, row.kind])
                if (!refreshes.has(key)) refreshes.set(key, { authors: [], kinds: [row.kind], since: start, until: cutoff })
                refreshes.get(key).authors.push(account.pubkey)
              }
            }
            for (const job of combineJobs(refreshes.values())) await scan(entry, job, current)
          } catch (error) {
            if (!entry.signal.aborted) report(error, entry, 'recent', error.accountFilter)
            if (permanent(error)) refreshAt = Infinity
          }
          if (refreshAt !== Infinity) refreshAt = Date.now() + refreshMs
          continue
        }
        if (outcome.done) break
        const item = outcome.value
        if (item.type === 'error') throw item.error
        if (item.type === 'event') {
          if (!initialComplete) { count++; oldest = Math.min(oldest, item.event.created_at) }
          await persist(entry, item.event, initialComplete ? { authors: entry.authors, kinds: entry.kinds } : filter)
        }
        if (item.type === 'eose') {
          assertHistoryReport(item)
          until = item.snapshot?.until
          if (!Number.isSafeInteger(until)) throw new Error('Missing account history snapshot bounds')
          if (!entry.signal.aborted) {
            try {
              await scan(entry, { authors: entry.authors, kinds: entry.kinds, since: item.snapshot.since, until }, records, { count, oldest, report: item })
              // Revisit the last ten minutes of the previous confirmed edge and
              // complete the offline gap. These bounds vary independently by owner/kind.
              const catchups = new Map()
              for (const [account, rows] of records) {
                for (const row of rows) {
                  if (!row.intervals.length) continue
                  const start = Math.max(0, row.intervals.at(-1)[1] - ACCOUNT_OVERLAP_SECONDS)
                  if (start >= since) continue
                  const key = JSON.stringify([start, row.kind])
                  if (!catchups.has(key)) catchups.set(key, { authors: [], kinds: [row.kind], since: start, until: since - 1 })
                  catchups.get(key).authors.push(account.pubkey)
                }
              }
              for (const job of combineJobs(catchups.values())) await scan(entry, job, records)
            } catch (error) {
              if (!entry.signal.aborted) throw error
            }
          }
          initialComplete = true
          refreshAt = Date.now() + refreshMs
          if (!entry.signal.aborted) background = backfill(entry, since - 1)
        }
        next = stream.next()
      }
      if (!initialComplete && !entry.signal.aborted) throw new Error('Account feed ended before its initial EOSE')
    } finally {
      ownerEntry.stream = null
      attempt.abort()
      // return() discards live waiting behind a failed historical attempt.
      await stream.return()
      // Backfill has its own retry loop; stop it with this attempt, not only
      // when account membership changes.
      if (background) await background
    }
  }
  async function maintain (entry) {
    let delay = 1000
    while (!entry.signal.aborted) {
      try { await run(entry); delay = 1000 } catch (error) {
        if (!entry.signal.aborted) report(error, entry, 'initial-or-live', error.accountFilter)
        if (permanent(error)) return
      }
      if (entry.signal.aborted) return
      await pause(Math.min(30000, delay * (0.8 + random() * 0.4)), entry.signal)
      delay = Math.min(delay * 2, 30000)
    }
  }

  signal.addEventListener('abort', () => {
    for (const account of accounts.values()) account.active = false
    for (const entry of entries.values()) retire(entry)
    entries.clear()
  }, { once: true })
  return {
    setAccounts (configs) {
      if (signal.aborted) return
      const wanted = new Set(configs.map(config => config.pubkey))
      for (const [pubkey, account] of accounts) if (!wanted.has(pubkey)) { account.active = false; accounts.delete(pubkey) }
      for (const config of configs) {
        if (accounts.has(config.pubkey)) continue
        const cached = [0, 10002].map(kind => config.getStoredEvent(kind)).filter(event => event?.pubkey === config.pubkey)
        const account = { ...config, identity: crypto.randomUUID(), active: true, latest: new Map(cached.map(event => [event.kind, event])) }
        let initialized
        account.initialize = () => {
          initialized ??= (async () => {
            await account.coverage.reconcile(accountKinds, signal)
            for (const event of cached) {
              signal.throwIfAborted()
              if (!account.active) return
              const result = await account.db.add(event)
              if (!result.ok && result.code !== 'blocked') throw new Error(`Cached account metadata storage failed: ${result.code}`)
            }
          })().catch(error => { initialized = null; throw error })
          return initialized
        }
        accounts.set(config.pubkey, account)
        spawn(account.initialize().catch(error => { if (!signal.aborted && account.active) reportError(error, { phase: 'cached', authors: [account.pubkey] }) }))
      }
      scheduleReconcile()
    },
    async settled () { await Promise.allSettled([...tasks]) }
  }
}
