import { f, useComputed, useSignal, useTask } from '#f'
import useWebStorage from '#hooks/use-web-storage.js'
import { cssVars } from '#assets/styles/theme.js'

f(function appIcon () {
  const storage = useWebStorage(localStorage)
  const appId$ = useComputed(() => this.props.app$().id)
  const appIndex$ = useComputed(() => this.props.app$().index ?? '?')
  const style$ = useComputed(() => this.props.style$?.() ?? this.props.style ?? '')

  const iconUrl$ = useSignal(null)
  const hasIcon$ = useComputed(() => !!iconUrl$())
  const previousCachedIconFx$ = useSignal(null)

  // Check for cached icon first, then load if needed
  useTask(async ({ track }) => {
    const [, cachedIcon] = track(() => [appId$(), storage[`session_appById_${appId$()}_icon$`]()])
    if (cachedIcon?.fx && previousCachedIconFx$() === cachedIcon.fx) {
      return
    }
    previousCachedIconFx$(cachedIcon?.fx || null)

    // Check if icon is already cached in storage
    if (cachedIcon?.url) {
      iconUrl$(cachedIcon.url)
      return
    }

    // If no cached icon, reset the icon URL
    iconUrl$(null)
  })

  return hasIcon$()
    ? this.h`
      <img
        src=${iconUrl$()}
        alt="App Icon"
        style=${`
          width: 100%;
          height: 100%;
          object-fit: cover;
          border-radius: 10px;
          ${style$()}
        `}
      />
    `
    : this.h`
      <span style=${`
        border-radius: 10px;
        background-color: ${cssVars.colors.subtleBg};
        color: ${cssVars.colors.fgFont};
        font-weight: bold;
        font-size: 14px;
        display: flex;
        justify-content: center;
        align-items: center;
        width: 100%;
        height: 100%;
        ${style$()}
      `}>${appIndex$()}</span>
    `
})
