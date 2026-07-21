import { test } from 'node:test'
import assert from 'node:assert/strict'
import { APP_LOCALES, createAppLocaleClient } from '../../src/helpers/window-message/app-locale-client.js'

test('exposes the eleven effective locales', () => {
  assert.deepEqual(APP_LOCALES, ['en', 'fr', 'it', 'de', 'es', 'pt-BR', 'ru', 'zh-CN', 'zh-TW', 'ja', 'ko'])
})

test('getLocale waits for the handshake locale', async () => {
  const client = createAppLocaleClient()
  const localePromise = client.getLocale()
  assert.equal(client.setLocale('invalid'), false)
  assert.equal(client.setLocale('pt-BR'), true)
  assert.equal(await localePromise, 'pt-BR')
})

test('listeners receive the current locale, changes, and support idempotent unlisten', async () => {
  const errors = []
  const client = createAppLocaleClient({ reportError: error => errors.push(error) })
  client.setLocale('en')
  const seen = []
  const unlisten = client.onLocaleChanged(locale => seen.push(locale))
  await Promise.resolve()
  client.setLocale('en')
  client.setLocale('ja')
  await Promise.resolve()
  assert.deepEqual(seen, ['en', 'ja'])
  unlisten()
  unlisten()
  client.setLocale('ko')
  await Promise.resolve()
  assert.deepEqual(seen, ['en', 'ja'])
  assert.deepEqual(errors, [])
  assert.throws(() => client.onLocaleChanged(null), /listener should be a function/)
})

test('one failing listener does not block another', async () => {
  const errors = []
  const client = createAppLocaleClient({ reportError: error => errors.push(error) })
  const seen = []
  client.onLocaleChanged(() => { throw new Error('boom') })
  client.onLocaleChanged(locale => seen.push(locale))
  client.setLocale('fr')
  await Promise.resolve()
  assert.deepEqual(seen, ['fr'])
  assert.equal(errors[0]?.message, 'boom')
})
