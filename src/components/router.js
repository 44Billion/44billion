import Router from 'url-router'

const router = new Router({
  '/:napp(app-\\w+):appPath($|\\/.*)': {}
})

export default router
