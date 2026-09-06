export function createPersonaPublicKeysClient ({ reportError = console.error } = {}) {
  const listeners = new Set()
  let current
  let fingerprint
  const notify = (subscription, keys) => queueMicrotask(() => {
    if (!listeners.has(subscription)) return
    try {
      const result = subscription.listener([...keys])
      if (result?.catch) result.catch(reportError)
    } catch (error) { reportError(error) }
  })
  return {
    onPersonaPublicKeysChanged (listener) {
      if (typeof listener !== 'function') throw new TypeError('listener should be a function')
      const subscription = { listener }
      listeners.add(subscription)
      if (current) notify(subscription, current)
      return () => { listeners.delete(subscription) }
    },
    setPublicKeys (keys) {
      if (!Array.isArray(keys) || !keys.every(key => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key))) return
      current = [...new Set(keys)]
      const next = JSON.stringify([...current].sort())
      if (next === fingerprint) return
      fingerprint = next
      for (const subscription of listeners) notify(subscription, current)
    }
  }
}
