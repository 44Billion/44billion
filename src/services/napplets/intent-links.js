// Runs inside the sandbox after the injected namespace and before app scripts.
// Keep the function self-contained so it can be serialized into srcdoc.
export function installIntentLinks () {
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0) return
    const anchor = event.target.closest?.('a[href]')
    const uri = anchor?.getAttribute('href')
    if (!uri?.startsWith('napplet:')) return
    event.preventDefault()
    try {
      Promise.resolve(window.napplet.intent.invoke(uri)).catch(() => {})
    } catch {}
  })
}
