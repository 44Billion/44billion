import { f, useComputed, useSignal, useTask } from '#f'
import AppFileManager from '#services/app-file-manager/index.js'
import { decode } from '#services/base93-decoder.js'
import { streamFileChunksFromDb } from '#services/idb/browser/queries/file-chunk.js'
import useWebStorage from '#hooks/use-web-storage.js'
import { cssVars } from '#assets/styles/theme.js'

f(function appIconOrIndex () {
  const storage = useWebStorage(localStorage)
  const appId = this.props.appId
  const appKey = this.props.appKey
  const index = this.props.index

  const iconUrl$ = useSignal(null)
  const hasIcon$ = useComputed(() => !!iconUrl$())
  const isLoading$ = useSignal(false)

  // Check for cached icon first, then load if needed
  useTask(async ({ track, cleanup }) => {
    track(() => [this.props.appId, this.props.appKey]) // Re-run when props change

    if (isLoading$()) return

    // First check if icon is already cached in storage
    const cachedIcon = storage[`session_appByKey_${appKey}_icon$`]?.()
    if (cachedIcon) {
      iconUrl$(cachedIcon)
      return
    }

    // If no cached icon, try to load it using AppFileManager
    isLoading$(true)
    const ac = new AbortController()
    cleanup(() => ac.abort())

    try {
      // Get app file manager instance
      const appFiles = await AppFileManager.create(appId)

      if (ac.signal.aborted) return

      // Check if app has favicon metadata
      const favicon = appFiles.getFaviconMetadata()
      if (!favicon) {
        console.log('No favicon found for app', appId)
        return
      }

      // Check if favicon is cached
      const cacheStatus = await appFiles.getFileCacheStatus(null, favicon.tag, { withMeta: true })
      if (!cacheStatus.isCached) {
        console.log('Favicon not cached for app', appId)
        return
      }

      if (ac.signal.aborted) return

      // Load favicon chunks and create blob URL
      const chunks = []

      for await (const chunk of streamFileChunksFromDb(appId, favicon.rootHash)) {
        if (ac.signal.aborted) return
        chunks.push(chunk.evt.content)
      }

      if (chunks.length === 0 || ac.signal.aborted) return

      // Decode base93 content to binary
      const binaryChunks = chunks.map(chunk => decode(chunk))
      const blob = new Blob(binaryChunks, { type: favicon.contentType })

      // Convert to data URL for persistent caching (doesn't get revoked)
      const reader = new FileReader()
      const dataUrlPromise = new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result)
        reader.onerror = reject
        reader.readAsDataURL(blob)
      })

      const dataUrl = await dataUrlPromise
      if (ac.signal.aborted) return

      iconUrl$(dataUrl)

      // Store data URL in session storage (won't be invalidated)
      storage[`session_appByKey_${appKey}_icon$`](dataUrl)
    } catch (error) {
      if (!ac.signal.aborted) {
        console.log('Failed to load app icon:', error)
      }
    } finally {
      if (!ac.signal.aborted) {
        isLoading$(false)
      }
    }
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
        `}>${index}</span>
      `}
    </div>
  `
})
