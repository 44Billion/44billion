import { useGlobalSignal, useGlobalComputed, useTask } from '#f'

let handlerByKeyMap
let abortController

function handleStorageChange (storageArea, e) {
  if (e.storageArea !== storageArea) return

  // if cleared
  if (e.key === null) return handlerByKeyMap.forEach(handler => handler.globalSignal$(undefined))

  let handler
  if (!(handler = handlerByKeyMap.get(e.key))) return

  // null when triggered by removeItem
  handler.globalSignal$(e.newValue === null ? undefined : JSON.parse(e.newValue))
}

export function useLocalStorageByKey (...args) {
  return useWebStorageByKey(localStorage, ...args)
}

export function useSessionStorageByKey (...args) {
  return useWebStorageByKey(sessionStorage, ...args)
}

export default function useWebStorageByKey (storageArea = localStorage, key, initialValueOrFn) {
  const wsKey = `useWebStorageByKey_${key}`
  const ws$ = useGlobalSignal(
    wsKey,
    () => Object.prototype.hasOwnProperty.call(storageArea, wsKey)
      ? JSON.parse(storageArea.getItem(wsKey))
      : (typeof initialValueOrFn === 'function'
          ? initialValueOrFn()
          : initialValueOrFn)
  )

  // Mimicking a global useTask
  useGlobalComputed(wsKey, () => {
    const nextValue = ws$()
    if (nextValue === undefined) storageArea.removeItem(key)
    else storageArea.setItem(key, JSON.stringify(nextValue))
  })() // () because without an observer it wouldn't re-run on ws$ change

  useTask(({ cleanup }) => {
    const onStorage = handleStorageChange.bind(window, storageArea)
    if (!handlerByKeyMap) {
      handlerByKeyMap = new Map()
      window.addEventListener('storage', onStorage, { signal: (abortController = new AbortController()).signal })
    }
    let handler
    if (!(handler = handlerByKeyMap.get(key))) {
      handlerByKeyMap.set(key, (handler = {
        globalSignal$: ws$,
        subCount: 0
      }))
    }
    handler.subCount++

    cleanup(() => {
      if (--handler.subCount > 0) return

      handlerByKeyMap.delete(key)
      if (handlerByKeyMap.size === 0) {
        abortController.abort()
        abortController = undefined
        handlerByKeyMap = undefined
      }
    })
  })

  return ws$
}
