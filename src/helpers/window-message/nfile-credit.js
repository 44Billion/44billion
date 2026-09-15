// One credit per ReadableStream pull bounds MessagePort buffering even when
// local storage is faster than the browser's download destination.
export function createNfileCredit () {
  let credit = false
  let closed = false
  let wake
  return {
    grant () { if (!closed) { credit = true; wake?.() } },
    close () { closed = true; wake?.() },
    async take () {
      if (!closed && !credit) await new Promise(resolve => { wake = resolve })
      wake = null
      if (closed) return false
      credit = false
      return true
    }
  }
}
