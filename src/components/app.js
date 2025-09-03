import resetCssString from '#assets/styles/reset.css'
import globalCssString from '#assets/styles/global.css'
import { f, useSignal, useTask } from '#f'
import { NAPP_ENTITY_REGEX } from '#helpers/nip19.js'

document.head.insertAdjacentHTML('beforeend', `<style>${resetCssString}${globalCssString}</style>`)

if (IS_DEVELOPMENT) {
  // https://esbuild.github.io/api/#live-reload
  new EventSource('/esbuild').addEventListener('change', () => location.reload())
}

f(function aApp () {
  // we rely on us being the top for reusing same
  // key for storage partition
  if (window.location.origin !== window.top.location.origin) {
    window.open(window.location.href, '_blank') // open itself on a new tab to be on top
    return
  }

  const shouldLoadSingleNapp$ = useSignal(null)
  useTask(async () => {
    const firstRoutePart = window.location.pathname.replace(/^\/|\/.*$/g, '')
    const isNappRoute = NAPP_ENTITY_REGEX.test(firstRoutePart)

    shouldLoadSingleNapp$(
      window !== window.top &&
      isNappRoute // TODO: or also if @<valid nip05expanded or npub>
    )
    await (shouldLoadSingleNapp$() ? import('#zones/single-napp/index.js') : import('#zones/multi-napp/index.js'))
  })
  if (shouldLoadSingleNapp$() === null) return

  return shouldLoadSingleNapp$()
    ? this.h`<single-napp />`
    : this.h`<multi-napp />`
})
