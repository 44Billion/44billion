import { toSignal } from '#f'

export const nappletSettings$ = toSignal(null)
export const nappletNotices$ = toSignal([])
export const nappletBadges$ = toSignal({})
export const nappletUploads$ = toSignal({})
export const nappletMedia$ = toSignal({})

export function closeNappletUi (windowId) {
  nappletUploads$(items => Object.fromEntries(Object.entries(items).filter(([, item]) => item.windowId !== windowId)))
  if (nappletSettings$()?.windowId === windowId) nappletSettings$(null)
  nappletNotices$(items => items.filter(item => item.windowId !== windowId))
  nappletBadges$(items => Object.fromEntries(Object.entries(items).filter(([id]) => id !== windowId)))
  nappletMedia$(items => Object.fromEntries(Object.entries(items).filter(([id]) => id !== windowId)))
}

export function presentNappletNotice (name, presentation) {
  nappletNotices$(items => [...items.filter(item => item.notificationId !== presentation.notificationId), { ...presentation, name }].slice(-8))
}

export function dismissNappletNotice (windowId, notificationId, fromUser = false) {
  const item = nappletNotices$().find(item => item.windowId === windowId && item.notificationId === notificationId)
  if (item) nappletNotices$(items => items.filter(value => value !== item))
  if (fromUser) item?.emit({ type: 'notify.dismissed', notificationId })
}

export const nappletUploadChoice$ = toSignal(null)

export function confirmNappletUpload (options) {
  if (nappletUploadChoice$() || options.signal.aborted) return Promise.resolve(undefined)
  return new Promise(resolve => {
    const finish = servers => {
      if (nappletUploadChoice$()?.finish !== finish) return
      options.signal.removeEventListener('abort', cancel)
      nappletUploadChoice$(null)
      resolve(servers)
    }
    const cancel = () => finish()
    options.signal.addEventListener('abort', cancel, { once: true })
    nappletUploadChoice$({ ...options, finish })
  })
}
