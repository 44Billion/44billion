// One bounded request at a time; signer permission is never involved.
export function watchSignerConnection ({ ping, update, signal, interval = 5000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer
  const check = async () => {
    let connected = false
    try { connected = await ping() === true } catch {}
    if (signal.aborted) return
    update(connected ? 'connected' : 'disconnected')
    timer = setTimer(check, interval)
  }
  if (!signal.aborted) timer = setTimer(check, interval)
  signal.addEventListener('abort', () => clearTimer(timer), { once: true })
}
