import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { toTestSignal, toTestStore } from './signal-mock.js'

if (!globalThis.localStorage) {
  const values = new Map()
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  }
}

const globalStores = new Map()

mock.module('#f', {
  namedExports: {
    f: () => {},
    toSignal: toTestSignal,
    useGlobalStore: (namespace, init) => {
      if (!globalStores.has(namespace) && init) globalStores.set(namespace, toTestStore(init))
      return globalStores.get(namespace)
    },
    useClosestStore: () => {},
    useStore: () => {},
    useCallback: value => value,
    useSignal: toTestSignal,
    useGlobalSignal: (_namespace, value) => toTestSignal(value),
    useTask: () => {}
  }
})
mock.module('#f/components/f-to-signals.js', { namedExports: {} })
mock.module('#shared/modal.js', { namedExports: {} })
mock.module('#shared/app-icon.js', { namedExports: {} })
mock.module('#shared/icons/icon-x.js', { namedExports: {} })
mock.module('#shared/icons/icon-check.js', { namedExports: {} })
mock.module('#shared/icons/icon-help-hexagon-filled.js', { namedExports: {} })
mock.module('#services/idb/browser/queries/permission.js', {
  namedExports: { hasPermission: async () => false, createOrUpdatePermission: async () => {} }
})
mock.module('#assets/styles/theme.js', {
  namedExports: { cssStrings: {}, cssClasses: {}, cssVars: { colors: {} }, jsVars: { breakpoints: {} } }
})
mock.module('#hooks/use-web-storage.js', { defaultExport: () => ({}) })

const {
  getEffectiveLocale,
  getT,
  resolveSupportedLocale,
  setLocalePreference,
  subscribeLocaleChanged,
  SUPPORTED_LOCALES
} = await import('../../src/i18n/index.js')
const {
  assetBudgetLocales,
  getAssetBudgetConfirmation
} = await import('../../src/i18n/asset-budget.js')
const {
  formatPermissionText,
  permissionDialogLocales
} = await import('../../src/components/zones/permission-dialog/index.js')
const {
  useConfirmationDialogStore
} = await import('../../src/components/zones/confirmation-dialog/index.js')

describe('component translation catalogs', () => {
  it('requires every supported locale and matching placeholders', () => {
    assert.deepEqual(SUPPORTED_LOCALES, ['en', 'fr', 'it', 'de', 'es', 'pt-BR', 'ru', 'zh-CN', 'zh-TW', 'ja', 'ko'])
    assert.equal(getT(assetBudgetLocales, { locale: 'en' })('More app storage?'), 'More app storage?')
    assert.equal(getT(permissionDialogLocales, { locale: 'en' })('Allow'), 'Allow')
    assert.throws(() => getT({ Hello: { en: 'Hello' } }), /missing translation/)
    assert.throws(() => getT({ Hello: { en: 'Hello' } }, {
      validation: { requiredLocales: ['en'] }
    }), /missing translation/)
    assert.throws(() => getT({
      'Hello {{name}}': Object.fromEntries(SUPPORTED_LOCALES.map(locale => [locale, 'Hello']))
    }), /placeholder mismatch/)
  })

  it('formats asset-budget messages with filename, size, and subject', () => {
    const result = getAssetBudgetConfirmation({
      nextApprovedBytes: 10,
      filename: 'photo.webp',
      formatBytes: value => `${value} MiB`
    })
    assert.match(result.message, /photo\.webp/)
    assert.match(result.message, /10 MiB/)

    const update = getAssetBudgetConfirmation({
      nextApprovedBytes: 20,
      subject: 'update',
      formatBytes: value => `${value} MiB`
    })
    assert.match(update.message, /update/)
    assert.match(update.message, /20 MiB/)
  })
})

describe('permission translations', () => {
  const format = (locale, options) => formatPermissionText({
    ...options,
    translate: getT(permissionDialogLocales, { locale })
  })

  it('uses the complete natural phrase for broad personal access', () => {
    assert.equal(format('en', { name: 'eventAccessPersonal', eKind: -1 }), 'Can I access all personal data?')
    assert.equal(format('pt-BR', { name: 'eventAccessPersonal', eKind: -1 }), 'Posso acessar todos os dados pessoais?')
    assert.equal(format('de', { name: 'eventAccessPersonal', eKind: -1 }), 'Darf ich auf alle persönlichen Daten zugreifen?')
    assert.equal(format('zh-TW', { name: 'eventAccessPersonal', eKind: -1 }), '可以存取所有個人資料嗎？')
  })

  it('keeps public broad access and formats specific personal copies separately', () => {
    assert.equal(format('en', { name: 'eventAccess', eKind: -1 }), 'Can I access all app data?')
    assert.equal(format('en', { name: 'eventAccessPersonal', eKind: 34601 }), 'Can I access personal copies of files?')
    assert.match(format('ru', { name: 'eventAccessPersonal', eKind: 34601 }), /личным копиям/)
  })

  it('pluralizes deletion counts and preserves localized scope punctuation', () => {
    const event = count => ({ tags: Array.from({ length: count }, (_, index) => ['e', String(index)]) })
    assert.equal(format('en', { name: 'delete', eKind: 5, meta: { params: [event(1)] } }), 'Can I delete 1 item?')
    assert.equal(format('en', { name: 'delete', eKind: 5, meta: { params: [event(2)] } }), 'Can I delete 2 items?')
    assert.equal(format('ru', { name: 'delete', eKind: 5, meta: { params: [event(5)] } }), 'Можно удалить 5 элементов?')
    assert.equal(format('zh-CN', { name: 'eventAccess', eKind: 34601, meta: { scope: 'asset' } }), '可以访问此类数据吗：文件 (范围：asset)？')
  })
})

describe('reactive locale preference', () => {
  it('normalizes compatible and Chinese locales', () => {
    assert.equal(resolveSupportedLocale('pt-PT'), 'pt-BR')
    assert.equal(resolveSupportedLocale('zh-Hant-HK'), 'zh-TW')
    assert.equal(resolveSupportedLocale('zh-Hans-SG'), 'zh-CN')
    assert.equal(resolveSupportedLocale('not a locale'), 'en')
  })

  it('notifies effective changes once and supports idempotent unlisten', async () => {
    const seen = []
    const unlisten = subscribeLocaleChanged(locale => seen.push(locale))
    setLocalePreference('pt-BR')
    setLocalePreference('pt-BR')
    await Promise.resolve()
    assert.equal(getEffectiveLocale(), 'pt-BR')
    assert.deepEqual(seen, ['pt-BR'])
    unlisten()
    unlisten()
    setLocalePreference('en')
    await Promise.resolve()
    assert.deepEqual(seen, ['pt-BR'])
  })

  it('keeps dynamic translators current and explicit-locale translators fixed', () => {
    setLocalePreference('en')
    const dynamicT = getT(assetBudgetLocales)
    const fixedT = getT(assetBudgetLocales, { locale: 'fr' })

    assert.equal(dynamicT('More app storage?'), 'More app storage?')
    assert.equal(fixedT('More app storage?'), 'Plus de stockage pour l’application ?')

    setLocalePreference('pt-BR')

    assert.equal(dynamicT('More app storage?'), 'Mais armazenamento para o app?')
    assert.equal(fixedT('More app storage?'), 'Plus de stockage pour l’application ?')
  })

  it('translates omitted confirmation defaults lazily without replacing custom text', async () => {
    const store = useConfirmationDialogStore()

    setLocalePreference('en')
    const defaultRequest = store.requestConfirmation()
    assert.equal(store.title$(), 'Confirmation')
    assert.equal(store.message$(), 'Are you sure?')
    assert.equal(store.confirmText$(), 'Yes')

    setLocalePreference('pt-BR')
    assert.equal(store.title$(), 'Confirmação')
    assert.equal(store.message$(), 'Tem certeza?')
    assert.equal(store.confirmText$(), 'Sim')
    store.resolveCurrent()
    await defaultRequest

    const customRequest = store.requestConfirmation({
      title: 'Custom title',
      message: 'Custom message',
      confirmText: 'Custom action'
    })
    setLocalePreference('en')
    assert.equal(store.title$(), 'Custom title')
    assert.equal(store.message$(), 'Custom message')
    assert.equal(store.confirmText$(), 'Custom action')
    store.resolveCurrent()
    await customRequest
  })
})
