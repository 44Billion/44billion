import { useTask } from '#f'
import { instanceMetadata, readInstanceCatalog } from '#services/instance-metadata/index.js'
import { createInstancePresentationObserver } from '#helpers/instance-presentation.js'

const presentation = createInstancePresentationObserver(instanceMetadata)

// Initialize once in the screen (or the standalone launcher's separate realm).
export function useInitInstanceMetadata ({ storage, isSystemRoute = () => false, revealWidgets = () => false }) {
  useTask(({ track }) => {
    const catalog = track(() => readInstanceCatalog(key => storage[`${key}$`]()))
    instanceMetadata.setCatalog(catalog)
  })
  useTask(({ track }) => {
    const environment = track(() => ({
      systemRoute: isSystemRoute(), revealWidgets: revealWidgets()
    }))
    instanceMetadata.setEnvironment(environment)
  })
  useTask(({ cleanup }) => {
    cleanup(presentation.start(window, document, document.getElementById('screen') ?? document.body))
  }, { after: 'rendering' })
}

export function useInstanceMetadataSurface (instanceKey, readSurface) {
  useTask(({ track, cleanup }) => {
    const { key, surface } = track(() => ({
      key: typeof instanceKey === 'function' ? instanceKey() : instanceKey,
      surface: readSurface()
    }))
    cleanup(presentation.register(key, surface))
  }, { after: 'rendering' })
}
