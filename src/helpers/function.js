// const withRetry = (() => {
//   const defaultMaxRetries = 3
//   const backoffInterval = 51
//   function calculateBackoff (timesRetried) {
//     const randMultiplier = Math.ceil(
//       Math.random() * (Math.pow(2, timesRetried + 2) - 1)
//     )
//     return backoffInterval * randMultiplier // ms
//   }

//   return function (fn, maxRetries = defaultMaxRetries, timesRetried = 0) {
//     return (...args) =>
//       Promise.resolve(fn(...args))
//         .catch(err => {
//           if (timesRetried === maxRetries) throw err

//           const time = calculateBackoff(timesRetried++)
//           return new Promise(resolve => {
//             setTimeout(() => resolve(withRetry(fn, maxRetries, timesRetried)(...args)), time)
//           })
//         })
//   }
// })()

// no trailing
export function syncThrottle (fn, minTimeFrame = 250, { leading = true } = {}) {
  let lastTime = leading ? Date.now() - minTimeFrame : Date.now()

  return function (...args) {
    const elapsedTime = Date.now() - lastTime
    const hasElapsedEnoughTime = elapsedTime >= minTimeFrame
    if (!hasElapsedEnoughTime) return

    fn.apply(this, args)
    lastTime = Date.now()
  }
}

const argsToKey = (() => {
  const objectIds = new WeakMap()
  let nextId = 0

  function getObjectId (value) {
    if (!objectIds.has(value)) {
      objectIds.set(value, `obj:${++nextId}`)
    }
    return objectIds.get(value)
  }

  function fallbackSerialize (value) {
    if (value === null) return 'null'
    const type = typeof value
    switch (type) {
      case 'undefined':
        return 'undefined'
      case 'string':
        return `string:${value}`
      case 'number':
        return `number:${Number.isNaN(value) ? 'NaN' : value}`
      case 'boolean':
        return `boolean:${value}`
      case 'bigint':
        return `bigint:${value}n`
      case 'symbol':
        return `symbol:${value.description ?? ''}`
      case 'function':
        return getObjectId(value)
      case 'object':
        return getObjectId(value)
      default:
        return `unknown:${String(value)}`
    }
  }

  return function argsToKey (...args) {
    try {
      const serialized = JSON.stringify(args)
      if (serialized !== undefined) return serialized
    } catch (_err) {
      // ignore and fallback
    }

    return args.map(fallbackSerialize).join('|')
  }
})()

// just leading, no trailing
export function debounce (fn, minTimeFrame = 250, { getKey = argsToKey } = {}) {
  const lastCallByKey = new Map()
  const inflightByKey = new Map()
  const lastPromiseByKey = new Map()
  const defaultKey = Symbol('debounceDefaultKey')

  return function debounced (...args) {
    const key = getKey ? getKey(...args) : defaultKey
    if (key === undefined || key === null) {
      throw new Error('debounce: key cannot be undefined or null')
    }

    const inflight = inflightByKey.get(key)
    if (inflight) return inflight

    const now = Date.now()
    const lastCallAt = lastCallByKey.get(key)
    if (lastCallAt !== undefined && now - lastCallAt < minTimeFrame) {
      return lastPromiseByKey.get(key) ??
        (() => { throw new Error('debounce: no last promise found') })()
    }

    lastCallByKey.set(key, now)

    const promise = Promise.resolve()
      .then(() => fn.apply(this, args))
      .catch(err => {
        lastCallByKey.delete(key)
        throw err
      })
      .finally(() => {
        inflightByKey.delete(key)
      })

    inflightByKey.set(key, promise)
    lastPromiseByKey.set(key, promise)
    return promise
  }
}
