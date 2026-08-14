import { f, useMemo, useStore, useTask } from '#f'
import useWebStorage from '#hooks/use-web-storage.js'
import { cssVars } from '#assets/styles/theme.js'
import AppFileManager from '#services/app-file-manager/index.js'
import connectivityRetry from '#services/connectivity-retry.js'
import {
  getAppIconLayerState,
  getAppIconMonogram,
  isDataAppIconUrl,
  normalizeAppIconCandidates,
  reconcileAppIconCandidates,
  shouldShowAppIconShimmer
} from '#helpers/app-icon.js'
import { getT } from '#i18n/index.js'

export const appIconLocales = getLocales()
const t = getT(appIconLocales)

// Upper bound for a single icon resolution (manifest + candidate fetch).
// The retry coordinator frees its slot when this elapses, so a hung network
// task can never leave every icon stuck in the loading state.
const ICON_LOAD_TIMEOUT_MS = 15000

// Rejects late load/error events from a candidate that is no longer current.
function imageMatchesCandidate (image, candidate) {
  const loadedUrl = image.currentSrc || image.src
  try {
    return new URL(loadedUrl, document.baseURI).href === new URL(candidate.url, document.baseURI).href
  } catch (_) {
    return loadedUrl === candidate.url
  }
}

f('app-icon', ({ h, props }) => {
  const storage = useWebStorage(localStorage)
  // Native objects with internal slots must stay outside useStore's proxies.
  const runtime = useMemo(() => ({
    currentAppId: null,
    imageElement: null,
    retryRelease: null,
    rejectedByUrl: new Map(),
    abortController: new AbortController()
  }))
  const store = useStore(() => ({
    appId$ () { return props.app$().id },
    appName$ () {
      const app = props.app$()
      const cachedName = storage[`session_appById_${app.id}_name$`]()
      return [app.name, cachedName]
        .find(name => typeof name === 'string' && name.trim())
        ?.trim() || ''
    },
    style$ () { return props.style$?.() ?? props.style ?? '' },
    cachedIcon$: null,
    iconCandidates$: [],
    iconIndex$: 0,
    candidatesKey$: null,
    exhausted$: false,
    isLoading$: false,
    isResolutionPending$: true,
    displayedIcon$: null,
    currentIcon$ () { return this.iconCandidates$()[this.iconIndex$()] ?? null },
    resetForApp (appId) {
      if (runtime.currentAppId === appId) return
      this.finishRetry()
      runtime.abortController.abort()
      runtime.abortController = new AbortController()
      runtime.currentAppId = appId
      runtime.imageElement = null
      runtime.rejectedByUrl = new Map()
      this.isLoading$(false)
      this.isResolutionPending$(true)
      this.displayedIcon$(null)
      this.exhausted$(false)
    },
    useCandidates (candidates) {
      const reconciled = reconcileAppIconCandidates(
        candidates,
        this.displayedIcon$(),
        new Set(runtime.rejectedByUrl.keys())
      )
      this.iconCandidates$(reconciled.candidates)
      this.iconIndex$(reconciled.index)
      if (this.currentIcon$()) this.isResolutionPending$(false)
    },
    rejectedCandidates () {
      return [...runtime.rejectedByUrl.values()]
    },
    finishRetry () {
      runtime.retryRelease?.()
      runtime.retryRelease = null
    },
    setImageElement (element) {
      runtime.imageElement = element
    },
    markIconLoaded (event) {
      if (Number(event.currentTarget.dataset.iconIndex) !== this.iconIndex$()) return
      const icon = this.currentIcon$()
      if (!icon || !imageMatchesCandidate(event.currentTarget, icon)) return
      this.displayedIcon$(icon)
      this.finishRetry()
    },
    async waitAndRetry () {
      try {
        await connectivityRetry.waitUntilOnline({ signal: runtime.abortController.signal })
        if (runtime.abortController.signal.aborted) return
        if (this.currentIcon$()) {
          await connectivityRetry.run(() => new Promise(resolve => {
            runtime.retryRelease = resolve
            const image = runtime.imageElement
            const candidate = this.currentIcon$()
            if (!image || !candidate) return this.finishRetry()
            image.removeAttribute('src')
            queueMicrotask(() => {
              if (runtime.abortController.signal.aborted || runtime.imageElement !== image) {
                return this.finishRetry()
              }
              image.src = candidate.url
            })
          }), { signal: runtime.abortController.signal })
        } else {
          this.isLoading$(false)
          await this.loadNextIcon()
        }
      } catch (error) {
        if (error?.name !== 'AbortError') console.error('Failed to resume app icon:', error)
      }
    },
    async loadNextIcon () {
      if (this.isLoading$() || runtime.abortController.signal.aborted) return
      const appId = this.appId$()
      const signal = runtime.abortController.signal
      this.isLoading$(true)
      try {
        const icon = await connectivityRetry.run(async () => {
          const appFiles = await AppFileManager.create(appId, undefined, { signal })
          return appFiles.getNextIcon({ rejected: this.rejectedCandidates(), signal })
        }, { signal, timeoutMs: ICON_LOAD_TIMEOUT_MS })
        if (signal.aborted || this.appId$() !== appId) return
        if (icon) {
          const candidates = this.iconCandidates$().slice()
          if (!candidates.some(candidate => candidate.url === icon.url)) candidates.push(icon)
          this.useCandidates(candidates)
        } else {
          this.exhausted$(true)
          this.isResolutionPending$(false)
        }
      } catch (error) {
        if (error?.name === 'AbortError' || signal.aborted || this.appId$() !== appId) return
        let online = false
        try { online = await connectivityRetry.confirmOnline({ force: true }) } catch (_) {}
        if (!online) await this.waitAndRetry()
        else {
          this.exhausted$(true)
          this.isResolutionPending$(false)
          console.error('Failed to load app icon:', error)
        }
      } finally {
        if (!signal.aborted && runtime.abortController.signal === signal) this.isLoading$(false)
      }
    },
    async showNextIcon (event) {
      this.finishRetry()
      const renderedIndex = Number(event.currentTarget.dataset.iconIndex)
      if (renderedIndex !== this.iconIndex$()) return
      const candidate = this.currentIcon$()
      if (!candidate) return
      if (!imageMatchesCandidate(event.currentTarget, candidate)) return

      if (!isDataAppIconUrl(candidate.url)) {
        let online = false
        try { online = await connectivityRetry.confirmOnline({ force: true }) } catch (_) {}
        if (!online) return this.waitAndRetry()
      }

      runtime.rejectedByUrl.set(candidate.url, candidate)
      const nextIndex = this.iconCandidates$().findIndex((next, index) =>
        index > renderedIndex && !runtime.rejectedByUrl.has(next.url)
      )
      if (nextIndex >= 0) this.iconIndex$(nextIndex)
      else await this.loadNextIcon()
    }
  }))

  useTask(({ track }) => {
    const [appId, cachedIcon] = track(() => [
      store.appId$(),
      storage[`session_appById_${store.appId$()}_icon$`]()
    ])
    store.resetForApp(appId)
    const candidates = normalizeAppIconCandidates(cachedIcon)
    const key = JSON.stringify([appId, candidates])
    if (store.candidatesKey$() === key) return
    store.candidatesKey$(key)
    store.cachedIcon$(cachedIcon)
    store.useCandidates(candidates)
  })

  useTask(async ({ track }) => {
    const [appId, candidatesKey] = track(() => [store.appId$(), store.candidatesKey$()])
    if (!appId || !candidatesKey || store.currentIcon$() || store.exhausted$()) return
    await store.loadNextIcon()
  })

  // A reused keyed node keeps its already-loaded <img> with the same src, so
  // no new `load`/`error` event fires on re-attach and displayedIcon would
  // never flip, leaving the candidate-layer shimmer visible forever.
  // Reconcile the image's completion state explicitly after each render.
  useTask(({ track }) => {
    const icon = track(() => store.currentIcon$())
    const image = runtime.imageElement
    if (!icon || !image || !image.isConnected) return
    if (!image.complete || !imageMatchesCandidate(image, icon)) return
    if (image.naturalWidth > 0) store.markIconLoaded({ currentTarget: image })
    else store.showNextIcon({ currentTarget: image })
  }, { after: 'rendering' })

  useTask(({ cleanup }) => {
    cleanup(() => {
      store.finishRetry()
      runtime.abortController.abort()
    })
  })

  if (shouldShowAppIconShimmer({
    resolutionPending: store.isResolutionPending$(),
    isLoading: store.isLoading$(),
    candidateIcon: store.currentIcon$(),
    displayedIcon: store.displayedIcon$()
  })) {
    return h`<div
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
          50% { opacity: .5; }
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

  const icon = store.currentIcon$()
  const displayedIcon = store.displayedIcon$()
  if (displayedIcon || (icon && !store.exhausted$())) {
    const layerState = getAppIconLayerState(displayedIcon, icon)

    return h`
      <style>
        @keyframes iconPulse {
          0% { opacity: 0.1; }
          50% { opacity: 0.25; }
          100% { opacity: 0.1; }
        }
      </style>
      <span
        role='img'
        aria-label=${t('App icon')}
        style=${`
        display: block;
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
      `}>
        <span
          aria-hidden='true'
          style=${`
            position: absolute;
            inset: 0;
            border-radius: inherit;
            background: currentColor;
            opacity: 0.1;
            visibility: ${layerState.isShimmerVisible ? 'visible' : 'hidden'};
            animation: ${layerState.isShimmerVisible ? 'iconPulse 1.4s ease-in-out infinite' : 'none'};
          `}
        />
        <img
          src=${displayedIcon?.url ?? null}
          alt=''
          aria-hidden='true'
          style=${`
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            visibility: ${layerState.isDisplayedLayerVisible ? 'visible' : 'hidden'};
            ${store.style$()}
          `}
        />
        <img
          ref=${store.setImageElement}
          src=${icon?.url ?? null}
          loading='lazy'
          data-icon-index=${icon ? store.iconIndex$() : -1}
          onload=${store.markIconLoaded}
          onerror=${store.showNextIcon}
          alt=''
          aria-hidden='true'
          style=${`
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            opacity: ${layerState.isCandidateLayerVisible ? 1 : 0};
            pointer-events: none;
            ${store.style$()}
          `}
        />
      </span>
    `
  }

  const monogram = getAppIconMonogram(store.appId$(), store.appName$())
  return h`
    <span
      role='img'
      aria-label=${t('App icon')}
      style=${`
      color-scheme: light dark;
      container-type: inline-size;
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background-color: light-dark(${monogram.lightBg}, ${monogram.darkBg});
      color: light-dark(${monogram.lightFg}, ${monogram.darkFg});
      ${store.style$()}
    `}
    >
      <span
        aria-hidden='true'
        style=${`
          font-size: 14rem;
          font-size: clamp(14rem, 42cqi, 24rem);
          font-weight: 700;
          line-height: 1;
          letter-spacing: -0.04em;
          user-select: none;
        `}
      >${monogram.label}</span>
    </span>
  `
})

function getLocales () {
  return {
    'App icon': { en: 'App icon', fr: 'Icône de l’application', it: 'Icona dell’app', de: 'App-Symbol', es: 'Icono de la aplicación', 'pt-BR': 'Ícone do app', ru: 'Значок приложения', 'zh-CN': '应用图标', 'zh-TW': '應用程式圖示', ja: 'アプリアイコン', ko: '앱 아이콘' }
  }
}
