import Router from 'url-router'

const router = new Router({
  '/:napp(\\+{1,3}[^/]+):appPath($|\\/.*)': {},
  '/:napp(naddr1[^/]+):appPath($|\\/.*)': {},
  '/app-updates': {
    mount: 'system-views',
    path: '/app-updates',
    tag: 'napp-updates',
    loadModule: () => import('#views/napp-updates/index.js')
  },
  '/app-data-access': {
    mount: 'system-views',
    path: '/app-data-access',
    tag: 'app-data-access',
    loadModule: () => import('#views/app-data-access/index.js')
  },
  '/sticky-sessions': {
    mount: 'system-views',
    path: '/sticky-sessions',
    tag: 'sticky-sessions',
    loadModule: () => import('#views/sticky-sessions/index.js')
  },
  '/event-storage': {
    mount: 'system-views',
    path: '/event-storage',
    tag: 'event-storage',
    loadModule: () => import('#views/event-storage/index.js')
  },
  '/settings': {
    mount: 'system-views',
    path: '/settings',
    tag: 'a-settings',
    loadModule: () => import('#views/settings/index.js')
  }
})

export default router
