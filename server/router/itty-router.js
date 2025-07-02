const IttyRouter = ({ base = '', routes = [], ...other } = {}) => ({
  __proto__: new Proxy({}, {
    get: (target, prop, receiver, path) =>
      (route, ...handlers) =>
        routes.push(
          [
            prop.toUpperCase(),
            // https://itty.dev/itty-router/route-patterns
            // '/foo/bar/baz' > /foo/bar/baz
            // '/todos/:id/:action?' > /todos/13 | /todos/13/edit => params: { action: 'edit' }
            // '/files/:file.:extension' > /files/kitten.jpeg => params: { file: 'kitten', extension: 'jpg' }
            // '/files/manifest.:extension?' > /files/manifest => params: {} | /files/manifest.json => params: { extension: 'json' }
            // '*' > /todos/13/edit | /foo/bar | /
            // '/test/*' > /test/todos/13/edit | /test/foo/bar
            // /goto/:url+ > /goto/https://google.com => params: { url: 'https://google.com }
            RegExp(`^${(path = (base + route)
              .replace(/\/+(\/|$)/g, '$1'))                       // strip double & trailing slash
              .replace(/(\/?\.?):(\w+)\+/g, '($1(?<$2>*))')       // greedy params
              .replace(/(\/?\.?):(\w+)/g, '($1(?<$2>[^$1/]+?))')  // named params and image format
              .replace(/\./g, '\\.')                              // dot in path
              .replace(/(\/?)\*/g, '($1.*)?')                     // wildcard
            }/*$`),
            handlers,                                             // embed handlers
            path                                                  // embed clean route path
          ]
        ) && receiver // this is to be able to chain like router.x().y()
  }),
  routes,
  ...other,
  async fetch (request, ...args) {
    let response
    let match
    // const url = new URL(request.url)
    if (!request.webUrl) throw new Error('Missing req.webUrl')
    // const query = request.query = { __proto__: null }
    // // 1. parse query params
    // for (const [k, v] of request.webUrl.searchParams) query[k] = query[k] ? Array.prototype.concat(query[k], v) : v

    let method
    let regex
    let handlers
    let path
    // 2. then test routes
    for ([method, regex, handlers, path] of routes) {
      if ((method === request.method || method === 'ALL') && (match = request.webUrl.pathname.match(regex))) {
        request.params = match.groups || {} // embed params in request
        request.route = path // embed route path in request
        let handler
        for (handler of handlers) {
          // !== undefined instead of !== null from https://raw.githubusercontent.com/kwhitley/itty-router/v5.x/src/IttyRouter.ts
          if ((response = await handler(request.proxy ?? request, ...args)) !== undefined) return response
        }
      }
    }
  }
})
export default IttyRouter
