import Router from 'url-router'

const router = new Router({
  '/:napp(\\+{1,3}\\w+):appPath($|\\/.*)': {}
})

export default router
