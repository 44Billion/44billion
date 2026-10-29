import { toSignal } from '#f'

export const nappletSettings$ = toSignal(null)
export const nappletNotices$ = toSignal([])
export const nappletBadges$ = toSignal({})
export const nappletMedia$ = toSignal({})

export function closeNappletUi (windowId) {
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
