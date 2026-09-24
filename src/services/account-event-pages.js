export const ACCOUNT_PAGE_SIZE = 200

export function assertHistoryReport (report) {
  if (!report || report.relays.length !== 1 || !['eose', 'satisfied'].includes(report.relays[0].status)) {
    throw report?.relays?.[0]?.error ?? new Error('Account history did not complete with EOSE')
  }
}

// Inclusive time windows. Saturated responses are persisted but are not coverage;
// split time, then authors/kinds at a single timestamp. No until-1 cursor can
// accidentally skip ties. Yield confirmed rectangles as soon as each completes.
export async function * accountEventPages ({ pool, relay, filter, signal, persist, firstPage, warn = console.warn }) {
  const pending = [{ filter, page: firstPage }]
  while (pending.length) {
    signal.throwIfAborted()
    const { filter, page } = pending.pop()
    let count = page?.count ?? 0
    let oldest = page?.oldest ?? Infinity
    let report = page?.report
    if (!page) {
      const stream = pool.getEventsGenerator({ ...filter, limit: ACCOUNT_PAGE_SIZE }, [relay], {
        signal, timeoutAfterFirstEose: null
      })
      for await (const item of stream) {
        signal.throwIfAborted()
        if (item.type === 'error') throw item.error
        if (item.type === 'eose') report = item
        if (item.type === 'event') {
          count++
          oldest = Math.min(oldest, item.event.created_at)
          await persist(item.event, filter)
        }
      }
    }
    assertHistoryReport(report)
    if (count < ACCOUNT_PAGE_SIZE && report.relays[0].status === 'eose') {
      yield filter
      continue
    }
    if (filter.since < filter.until) {
      // Use the observed boundary to avoid repeatedly fetching a dense second
      // through decades of binary splits. This is still subdivision, not a
      // claim that events outside the returned page are absent.
      const middle = Number.isSafeInteger(oldest) && oldest >= filter.since && oldest <= filter.until
        ? Math.max(filter.since, oldest - 1)
        : filter.since + Math.floor((filter.until - filter.since) / 2)
      pending.push({ filter: { ...filter, until: middle } }, { filter: { ...filter, since: middle + 1 } })
    } else if (filter.authors.length > 1 || filter.kinds.length > 1) {
      const key = filter.authors.length > 1 ? 'authors' : 'kinds'
      const middle = Math.ceil(filter[key].length / 2)
      pending.push({ filter: { ...filter, [key]: filter[key].slice(middle) } }, { filter: { ...filter, [key]: filter[key].slice(0, middle) } })
    } else {
      // Explicit product tradeoff: NIP-01 provides no standard ID cursor. A
      // saturated author/kind/second is accepted, with a diagnostic, not retried
      // forever. Excess events in this very rare bucket may be missed.
      warn('Account history saturated for one author/kind/second', { relay, ...filter })
      yield filter
    }
  }
}
