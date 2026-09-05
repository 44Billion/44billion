export function createInstanceMetadataClient ({ reportError = console.error } = {}) {
  const ready = Promise.withResolvers()
  const listeners = new Set()
  let current
  let serialized

  const notify = (subscription, metadata) => {
    queueMicrotask(() => {
      if (!listeners.has(subscription)) return
      try {
        const result = subscription.listener(structuredClone(metadata))
        if (result?.catch) result.catch(reportError)
      } catch (error) { reportError(error) }
    })
  }
  return {
    async getInstanceMetadata () {
      await ready.promise
      return structuredClone(current)
    },
    onInstanceMetadataChanged (listener) {
      if (typeof listener !== 'function') throw new TypeError('listener should be a function')
      const subscription = { listener }
      listeners.add(subscription)
      if (current) notify(subscription, current)
      return () => { listeners.delete(subscription) }
    },
    setMetadata (metadata) {
      if (!metadata || typeof metadata.instanceKey !== 'string') return
      const nextSerialized = JSON.stringify(metadata)
      if (nextSerialized === serialized) return
      serialized = nextSerialized
      current = structuredClone(metadata)
      ready.resolve()
      for (const subscription of listeners) notify(subscription, current)
    }
  }
}
