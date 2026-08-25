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
  '/sticky-sessions': {
    mount: 'system-views',
    path: '/sticky-sessions',
    tag: 'sticky-sessions',
    loadModule: () => import('#views/sticky-sessions/index.js')
  },
  '/settings': {
    mount: 'system-views',
    path: '/settings',
    tag: 'a-settings',
    loadModule: () => import('#views/settings/index.js')
  }
})

export default router
