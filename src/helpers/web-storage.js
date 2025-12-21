export function setWebStorageItem (storageArea = localStorage, key, value) {
  const oldValue = storageArea.getItem(key)
  let newValue

  if (value === undefined) {
    storageArea.removeItem(key)
    newValue = null
  } else {
    newValue = JSON.stringify(value)
    storageArea.setItem(key, newValue)
  }

  // Manually dispatch storage event to trigger same-tab updates
  if (typeof window !== 'undefined' && typeof StorageEvent !== 'undefined') {
    const storageEvent = new StorageEvent('storage', {
      key,
      oldValue,
      newValue,
      storageArea,
      url: window.location.href
    })

    window.dispatchEvent(storageEvent)
  }
  return value
}

export function setLocalStorageItem (key, value) {
  setWebStorageItem(localStorage, key, value)
}

export function setSessionStorageItem (key, value) {
  setWebStorageItem(sessionStorage, key, value)
}
