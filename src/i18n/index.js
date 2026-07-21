import { getT as getBaseT } from 'libp2r2p/i18n'

export const SUPPORTED_LOCALES = Object.freeze([
  'en', 'fr', 'it', 'de', 'es', 'pt-BR', 'ru', 'zh-CN', 'zh-TW', 'ja', 'ko'
])

const validation = Object.freeze({
  requiredLocales: SUPPORTED_LOCALES,
  referenceLocale: 'en',
  requireReferenceKey: true
})

export function getT (locales, options = {}) {
  return getBaseT(locales, { ...options, validation })
}
