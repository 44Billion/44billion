import { f, useComputed, useSignal, useTask } from '#f'
import useWebStorage from '#hooks/use-web-storage.js'
import { cssVars } from '#assets/styles/theme.js'
import AppFileManager from '#services/app-file-manager/index.js'
import { debounce } from '#helpers/function.js'

async function addIconToCache (appId) {
  const appFiles = await AppFileManager.create(appId)
  await appFiles.getIcon() // this adds it to the cache
}
const debouncedAddIconToCache = debounce(addIconToCache, 1000)

f('appIcon', function () {
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

  const isLoading$ = useSignal(false)
  useTask(async ({ track }) => {
    const appId = track(() => appId$())
    if (!appId || hasIcon$()) return

    isLoading$(true)
    try {
      // shared by other <app-icon> instances
      await debouncedAddIconToCache(appId)
    } catch (err) {
      console.error('Failed to load app icon for appId:', appId, err)
    } finally {
      // after the other task sets the icon url
      requestIdleCallback(() => isLoading$(false), { timeout: 150 })
    }
  })

  if (isLoading$()) {
    return this.h`<div
      style=${`
        width: 100%;
        height: 100%;
        border-style: solid;
        border-width: 0;
        overflow: hidden;
        background-color: ${cssVars.colors.bg2};
      `}
    >
      <style>${`
        @keyframes pulse {
          50% {
            opacity: .5;
          }
        }
        .animate-background {
          animation: pulse 2s cubic-bezier(.4,0,.6,1) infinite;
          background-color: ${cssVars.colors.bg3};
          position: relative;
          height: 100%;
        }
      `}</style>
      <div class='animate-background' />
    </div>`
  }

  return hasIcon$()
    ? this.h`
      <img
        src=${iconUrl$()}
        alt="App Icon"
        style=${`
          width: 100%;
          height: 100%;
          object-fit: cover;
          ${style$()}
        `}
      />
    `
    : this.h`
      <span style=${`
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
