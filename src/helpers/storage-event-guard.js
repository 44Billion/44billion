// useWebStorage writes received values back to storage. Discard delayed events
// that no longer describe it, preventing stale values from echoing between tabs.
export function installStorageEventGuard (target = window) {
  const onStorage = event => {
    if (event.key === null || !event.storageArea) return
    if (event.storageArea.getItem(event.key) !== event.newValue) event.stopImmediatePropagation()
  }
  target.addEventListener('storage', onStorage, { capture: true })
  return () => target.removeEventListener('storage', onStorage, { capture: true })
}
