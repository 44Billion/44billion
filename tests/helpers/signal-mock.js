export function toTestSignal (initialValueOrFn) {
  let current = typeof initialValueOrFn === 'function'
    ? initialValueOrFn()
    : initialValueOrFn

  const signal = (...args) => {
    if (args.length === 0) return current
    current = typeof args[0] === 'function' ? args[0](current) : args[0]
    return current
  }
  signal.get = () => current
  signal.peek = () => current
  signal.set = value => signal(value)
  return signal
}

export function toTestStore (initialValueOrFn) {
  const definition = typeof initialValueOrFn === 'function'
    ? initialValueOrFn()
    : initialValueOrFn
  const store = {}

  for (const [key, value] of Object.entries(definition)) {
    if (key.endsWith('$')) {
      store[key] = typeof value === 'function'
        ? (...args) => value.call(store, ...args)
        : toTestSignal(value)
    } else {
      store[key] = typeof value === 'function' ? value.bind(store) : value
    }
  }

  return store
}
