import Router from 'url-router'

const router = new Router({
  '/:napp(\\+{1,3}\\w+):appPath($|\\/.*)': {},
  '/napp-updates': {
    mount: 'system-views',
    path: '/napp-updates',
    tag: 'napp-updates',
    loadModule: () => import('#views/napp-updates/index.js')
  }
})

export default router
