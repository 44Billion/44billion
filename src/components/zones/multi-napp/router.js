import Router from 'url-router'

const router = new Router({
  '/:napp(\\+{1,3}\\w+):appPath($|\\/.*)': {},
  '/app-updates': {
    mount: 'system-views',
    path: '/app-updates',
    tag: 'napp-updates',
    loadModule: () => import('#views/napp-updates/index.js')
  },
  '/settings': {
    mount: 'system-views',
    path: '/settings',
    tag: 'a-settings',
    loadModule: () => import('#views/settings/index.js')
  }
})

export default router
