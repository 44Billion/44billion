import {
  createI18n,
  getT,
  provideI18n,
  useI18nProvider,
  useT
} from 'thenameisf/i18n/reactive'

export const SUPPORTED_LOCALES = Object.freeze([
  'en', 'fr', 'it', 'de', 'es', 'pt-BR', 'ru', 'zh-CN', 'zh-TW', 'ja', 'ko'
])

export const AUTO_LOCALE = 'auto'
export const LOCALE_STORAGE_KEY = 'config_locale'

export const i18n = createI18n({
  supportedLocales: SUPPORTED_LOCALES,
  fallbackLocale: 'en',
  deferNotifications: true,
  validation: {
    requiredLocales: 'supported',
    referenceLocale: 'en',
    requireReferenceKey: true
  },
  browser: {
    storageKey: LOCALE_STORAGE_KEY,
    automaticPreference: AUTO_LOCALE,
    syncDocumentLanguage: true
  }
})

export const resolveSupportedLocale = i18n.resolveLocale
export const getLocalePreference = i18n.getLocalePreference
export const setLocalePreference = i18n.setLocalePreference
export const getEffectiveLocale = i18n.getLocale
export const subscribeLocaleChanged = i18n.subscribeLocaleChanged

// The application root owns browser listeners and document synchronization.
export function useInitI18n () {
  return useI18nProvider(i18n)
}

// Node tests and non-component entry points can own the same lifecycle
// explicitly without introducing automatic module side effects.
export function provideAppI18n () {
  return provideI18n(i18n)
}

export { getT, useT }
