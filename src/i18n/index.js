import { getCurrentDeviceLocale, getT as getBaseT, validateLocales } from 'libp2r2p/i18n'

export const SUPPORTED_LOCALES = Object.freeze([
  'en', 'fr', 'it', 'de', 'es', 'pt-BR', 'ru', 'zh-CN', 'zh-TW', 'ja', 'ko'
])

export const AUTO_LOCALE = 'auto'
export const LOCALE_STORAGE_KEY = 'config_locale'

const validation = Object.freeze({
  requiredLocales: SUPPORTED_LOCALES,
  referenceLocale: 'en',
  requireReferenceKey: true
})

function localeLanguage (locale) {
  try {
    return new Intl.Locale(locale).language
  } catch {
    return String(locale).split('-')[0].toLowerCase()
  }
}

export function resolveSupportedLocale (locale) {
  let canonical
  try {
    canonical = Intl.getCanonicalLocales(String(locale).replace(/_/g, '-'))[0]
  } catch {
    return 'en'
  }

  const exact = SUPPORTED_LOCALES.find(value => value.toLowerCase() === canonical.toLowerCase())
  if (exact) return exact

  const language = localeLanguage(canonical)
  if (language === 'zh') {
    try {
      const { script, region } = new Intl.Locale(canonical)
      return script === 'Hant' || ['TW', 'HK', 'MO'].includes(region) ? 'zh-TW' : 'zh-CN'
    } catch {
      return /(?:^|-)(?:hant|tw|hk|mo)(?:-|$)/i.test(canonical) ? 'zh-TW' : 'zh-CN'
    }
  }

  return SUPPORTED_LOCALES.find(value => localeLanguage(value) === language) ?? 'en'
}

function readStoredLocalePreference () {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY))
    return value === AUTO_LOCALE || SUPPORTED_LOCALES.includes(value) ? value : AUTO_LOCALE
  } catch {
    return AUTO_LOCALE
  }
}

export function getLocalePreference () {
  return readStoredLocalePreference()
}

function resolvePreference (preference = readStoredLocalePreference()) {
  return resolveSupportedLocale(preference === AUTO_LOCALE ? getCurrentDeviceLocale() : preference)
}

let effectiveLocale = resolvePreference()
const localeListeners = new Set()

function updateDocumentLocale (locale) {
  if (globalThis.document?.documentElement) document.documentElement.lang = locale
}

function refreshEffectiveLocale () {
  const previous = effectiveLocale
  const locale = resolvePreference()
  effectiveLocale = locale
  updateDocumentLocale(locale)
  if (locale !== previous) {
    for (const listener of [...localeListeners]) {
      queueMicrotask(() => {
        if (!localeListeners.has(listener)) return
        try { listener(locale) } catch (error) { console.error(error) }
      })
    }
  }
  return locale
}

updateDocumentLocale(effectiveLocale)

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.storageArea === localStorage && event.key === LOCALE_STORAGE_KEY) refreshEffectiveLocale()
  })
  window.addEventListener('languagechange', () => {
    if (readStoredLocalePreference() === AUTO_LOCALE) refreshEffectiveLocale()
  })
}

export function setLocalePreference (preference) {
  if (preference !== AUTO_LOCALE && !SUPPORTED_LOCALES.includes(preference)) {
    throw new RangeError(`Unsupported locale: ${preference}`)
  }
  localStorage.setItem(LOCALE_STORAGE_KEY, JSON.stringify(preference))
  return refreshEffectiveLocale()
}

export function getEffectiveLocale () {
  return effectiveLocale
}

export function subscribeLocaleChanged (listener, { emitCurrent = false } = {}) {
  if (typeof listener !== 'function') throw new TypeError('listener should be a function')
  localeListeners.add(listener)
  let active = true
  if (emitCurrent) {
    queueMicrotask(() => {
      if (!active) return
      try { listener(getEffectiveLocale()) } catch (error) { console.error(error) }
    })
  }
  return () => {
    if (!active) return
    active = false
    localeListeners.delete(listener)
  }
}

export function getT (locales, options = {}) {
  validateLocales(locales, validation)
  if (options.locale !== undefined) return getBaseT(locales, { ...options, validation })

  const translators = new Map()
  return (key, values) => {
    const locale = effectiveLocale
    let translate = translators.get(locale)
    if (!translate) {
      translate = getBaseT(locales, { ...options, locale })
      translators.set(locale, translate)
    }
    return translate(key, values)
  }
}
