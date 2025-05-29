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
