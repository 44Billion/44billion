import { f, useComputed, useSignal, useTask } from '#f'
import useWebStorage from '#hooks/use-web-storage.js'
import { cssVars } from '#assets/styles/theme.js'

f(function appIconOrIndex () {
  const storage = useWebStorage(localStorage)
  const appId$ = useComputed(() => this.props.app$().id)
  const appIndex$ = useComputed(() => this.props.app$().index)

  const iconUrl$ = useSignal(null)
  const hasIcon$ = useComputed(() => !!iconUrl$())
  const previousCachedIconFx$ = useSignal(null)

  // Check for cached icon first, then load if needed
  useTask(async ({ track }) => {
    const [appId, cachedIcon] = track(() => [appId$(), storage[`session_appById_${appId$()}_icon$`]()])
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

  return this.h`
    <div style=${`
      display: block;
      z-index: 1;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    `}>
      ${hasIcon$()
        ? this.h`
        <img
          src=${iconUrl$()}
          alt="App Icon"
          style=${`
            width: 70%;
            height: 70%;
            object-fit: cover;
            border-radius: 15%;
          `}
        />
      `
        : this.h`
        <span style=${`
          color: ${cssVars.colors.fgFont};
          font-weight: bold;
          font-size: 14px;
        `}>${appIndex$()}</span>
      `}
    </div>
  `
})
