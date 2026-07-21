import { useGlobalSignal, useTask } from '#f'
import { getEffectiveLocale, subscribeLocaleChanged } from './index.js'

const LOCALE_SIGNAL_NAMESPACE = 'i18n_effectiveLocale'

function useLocaleSignal () {
  return useGlobalSignal(
    LOCALE_SIGNAL_NAMESPACE,
    getEffectiveLocale,
    { shouldCache: false }
  )
}

export function useInitLocale () {
  const locale$ = useLocaleSignal()
  useTask(({ cleanup }) => cleanup(subscribeLocaleChanged(locale$)))
}

export default function useLocale () {
  return useLocaleSignal()()
}
