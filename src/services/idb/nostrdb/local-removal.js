// Shared by the trusted bridge and database so authorization sees the same targets.
export function normalizeLocalRemovalTargets (targets) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 100) return null
  const normalized = new Map()
  for (const pair of targets) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[1] !== 'string') return null
    const [type, value] = pair
    let target
    if (type === 'e' && /^[0-9a-f]{64}$/i.test(value)) {
      target = ['e', value.toLowerCase()]
    } else if (type === 'a') {
      const match = /^(\d+):([0-9a-f]{64}):([\s\S]*)$/i.exec(value)
      if (!match) return null
      const kind = Number(match[1])
      if (!Number.isSafeInteger(kind) || kind > 0xffff) return null
      const d = kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000) ? '' : match[3]
      target = ['a', `${kind}:${match[2].toLowerCase()}:${d}`]
    } else return null
    normalized.set(JSON.stringify(target), target)
  }
  return [...normalized.values()]
}

export function localRemovalResult (code, deleted = 0) {
  const messages = {
    deleted: 'Events were removed locally.',
    noop: 'No matching local events were found.',
    invalid: 'Expected 1 to 100 valid event ID or address pairs.',
    unavailable: 'IndexedDB or quota coordination is unavailable.',
    error: 'Local event removal failed.'
  }
  return { ok: code === 'deleted' || code === 'noop', code, message: messages[code], deleted }
}
