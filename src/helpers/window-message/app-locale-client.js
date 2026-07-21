export const APP_LOCALES = Object.freeze([
  'en', 'fr', 'it', 'de', 'es', 'pt-BR', 'ru', 'zh-CN', 'zh-TW', 'ja', 'ko'
])

export function createAppLocaleClient ({ reportError = console.error } = {}) {
  const supported = new Set(APP_LOCALES)
  const ready = Promise.withResolvers()
  const listeners = new Set()
  let currentLocale

  function notify (listener, locale) {
    queueMicrotask(() => {
      if (!listeners.has(listener)) return
      try {
        const result = listener(locale)
        if (result?.catch) result.catch(reportError)
      } catch (error) {
        reportError(error)
      }
    })
  }

  return {
    getLocale: () => ready.promise,
    onLocaleChanged (listener) {
      if (typeof listener !== 'function') throw new TypeError('listener should be a function')
      listeners.add(listener)
      let active = true
      if (currentLocale) notify(listener, currentLocale)
      return () => {
        if (!active) return
        active = false
        listeners.delete(listener)
      }
    },
    setLocale (locale) {
      if (!supported.has(locale) || locale === currentLocale) return false
      currentLocale = locale
      ready.resolve(locale)
      for (const listener of [...listeners]) notify(listener, locale)
      return true
    }
  }
}
