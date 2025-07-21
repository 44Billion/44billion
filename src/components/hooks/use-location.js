import { useGlobalStore, useTask } from '#f'

export function useLocationInit (router) {
  const { onPopState } = useGlobalStore('_f_useLocation', {
    url$: () => new URL(window.location),
    state$ () { return this.url$() && history.state },
    params$ () { return router?.find?.(this.url$().pathname.replace(/\/+$/, ''))?.params ?? {} },
    replaceState (...args) {
      history.replaceState(...args)
      if (args[2] && location.href !== this.url$().href) this.url$(new URL(window.location))
    },
    pushState (...args) {
      if (!args[2] || location.href === this.url$().href) throw new Error('Use replaceState when keeping url')
      history.pushState(...args)
      this.url$(new URL(window.location))
    },
    onPopState () { this.url$(new URL(window.location)) }
    // todo: hasPreviousPage back/forward/go().. if hasPreviousPage=false do nothing for back/go(-...)
  })
  useNavigateInit(onPopState)
}

export default function useLocation (router) {
  if (router) useLocationInit(router)
  return useGlobalStore('_f_useLocation')
}

function useNavigateInit (onPopState) {
  useTask(({ cleanup }) => {
    const controller = new AbortController()
    cleanup(() => controller.abort())
    // triggered on
    // - browser back/forward button
    // - history.back/forward/go()
    // - on page load (Chrome and Safari), but this listener wouldn't be ready yet
    window.addEventListener('popstate', onPopState, { signal: controller.signal })
  })
}
