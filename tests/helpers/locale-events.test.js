import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const originalDateTimeFormat = Intl.DateTimeFormat
const originalWindow = globalThis.window
const originalDocument = globalThis.document
const originalLocalStorage = globalThis.localStorage

let deviceLocale = 'en-US'
Intl.DateTimeFormat = function () {
  return { resolvedOptions: () => ({ locale: deviceLocale }) }
}

const values = new Map()
globalThis.localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: key => values.delete(key)
}
globalThis.window = new EventTarget()
globalThis.document = { documentElement: { lang: '' } }

const {
  AUTO_LOCALE,
  getEffectiveLocale,
  getLocalePreference,
  LOCALE_STORAGE_KEY,
  subscribeLocaleChanged
} = await import('../../src/i18n/index.js?locale-events')

function dispatchStorage () {
  const event = new Event('storage')
  Object.defineProperties(event, {
    key: { value: LOCALE_STORAGE_KEY },
    storageArea: { value: localStorage }
  })
  window.dispatchEvent(event)
}

after(() => {
  Intl.DateTimeFormat = originalDateTimeFormat
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  globalThis.localStorage = originalLocalStorage
})

test('reacts to cross-tab storage updates and updates document language', async () => {
  const seen = []
  const unlisten = subscribeLocaleChanged(locale => seen.push(locale))
  localStorage.setItem(LOCALE_STORAGE_KEY, JSON.stringify('fr'))
  dispatchStorage()
  await Promise.resolve()
  assert.equal(getEffectiveLocale(), 'fr')
  assert.equal(document.documentElement.lang, 'fr')
  assert.deepEqual(seen, ['fr'])
  unlisten()
})

test('treats invalid stored values as auto without overwriting them', () => {
  localStorage.setItem(LOCALE_STORAGE_KEY, JSON.stringify('unsupported'))
  dispatchStorage()
  assert.equal(getLocalePreference(), AUTO_LOCALE)
  assert.equal(localStorage.getItem(LOCALE_STORAGE_KEY), JSON.stringify('unsupported'))
  assert.equal(getEffectiveLocale(), 'en')
})

test('reacts to device language changes only while preference is automatic', () => {
  localStorage.setItem(LOCALE_STORAGE_KEY, JSON.stringify(AUTO_LOCALE))
  deviceLocale = 'zh-Hant-HK'
  window.dispatchEvent(new Event('languagechange'))
  assert.equal(getEffectiveLocale(), 'zh-TW')

  localStorage.setItem(LOCALE_STORAGE_KEY, JSON.stringify('de'))
  dispatchStorage()
  deviceLocale = 'ja-JP'
  window.dispatchEvent(new Event('languagechange'))
  assert.equal(getEffectiveLocale(), 'de')
})
