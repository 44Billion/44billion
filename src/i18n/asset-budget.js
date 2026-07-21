import { getT } from './index.js'

export const assetBudgetLocales = {
  'More app storage?': {
    en: 'More app storage?', fr: 'Plus de stockage pour l’application ?', it: 'Più spazio per l’app?', de: 'Mehr App-Speicher?', es: '¿Más almacenamiento para la aplicación?', 'pt-BR': 'Mais armazenamento para o app?', ru: 'Больше места для приложения?', 'zh-CN': '增加应用存储空间？', 'zh-TW': '增加應用程式儲存空間？', ja: 'アプリの保存容量を増やしますか？', ko: '앱 저장 공간을 늘릴까요?'
  },
  '{{filename}} needs more cached storage. Allow this app\'s assets up to {{size}}?': {
    en: '{{filename}} needs more cached storage. Allow this app\'s assets up to {{size}}?', fr: '{{filename}} nécessite davantage de stockage en cache. Autoriser les ressources de cette application jusqu’à {{size}} ?', it: '{{filename}} richiede più spazio nella cache. Consentire fino a {{size}} per le risorse dell’app?', de: '{{filename}} benötigt mehr Cache-Speicher. App-Ressourcen bis {{size}} zulassen?', es: '{{filename}} necesita más almacenamiento en caché. ¿Permitir hasta {{size}} para los recursos de esta aplicación?', 'pt-BR': '{{filename}} precisa de mais armazenamento em cache. Permitir até {{size}} para os recursos deste app?', ru: 'Файлу {{filename}} нужно больше места в кеше. Разрешить ресурсам приложения занимать до {{size}}?', 'zh-CN': '{{filename}} 需要更多缓存空间。允许此应用的资源最多使用 {{size}} 吗？', 'zh-TW': '{{filename}} 需要更多快取空間。允許此應用程式的資源最多使用 {{size}} 嗎？', ja: '{{filename}} にはさらにキャッシュ容量が必要です。このアプリのアセットに最大 {{size}} を許可しますか？', ko: '{{filename}}에 더 많은 캐시 저장 공간이 필요합니다. 이 앱의 자산에 최대 {{size}}까지 허용할까요?'
  },
  'This app needs more cached storage. Allow this app\'s assets up to {{size}}?': {
    en: 'This app needs more cached storage. Allow this app\'s assets up to {{size}}?', fr: 'Cette application nécessite davantage de stockage en cache. Autoriser ses ressources jusqu’à {{size}} ?', it: 'Questa app richiede più spazio nella cache. Consentire fino a {{size}} per le sue risorse?', de: 'Diese App benötigt mehr Cache-Speicher. App-Ressourcen bis {{size}} zulassen?', es: 'Esta aplicación necesita más almacenamiento en caché. ¿Permitir hasta {{size}} para sus recursos?', 'pt-BR': 'Este app precisa de mais armazenamento em cache. Permitir até {{size}} para seus recursos?', ru: 'Этому приложению нужно больше места в кеше. Разрешить его ресурсам занимать до {{size}}?', 'zh-CN': '此应用需要更多缓存空间。允许其资源最多使用 {{size}} 吗？', 'zh-TW': '此應用程式需要更多快取空間。允許其資源最多使用 {{size}} 嗎？', ja: 'このアプリにはさらにキャッシュ容量が必要です。アセットに最大 {{size}} を許可しますか？', ko: '이 앱에 더 많은 캐시 저장 공간이 필요합니다. 자산에 최대 {{size}}까지 허용할까요?'
  },
  'This update needs more cached storage. Allow this app\'s assets up to {{size}}?': {
    en: 'This update needs more cached storage. Allow this app\'s assets up to {{size}}?', fr: 'Cette mise à jour nécessite davantage de stockage en cache. Autoriser les ressources de l’application jusqu’à {{size}} ?', it: 'Questo aggiornamento richiede più spazio nella cache. Consentire fino a {{size}} per le risorse dell’app?', de: 'Dieses Update benötigt mehr Cache-Speicher. App-Ressourcen bis {{size}} zulassen?', es: 'Esta actualización necesita más almacenamiento en caché. ¿Permitir hasta {{size}} para los recursos de la aplicación?', 'pt-BR': 'Esta atualização precisa de mais armazenamento em cache. Permitir até {{size}} para os recursos do app?', ru: 'Этому обновлению нужно больше места в кеше. Разрешить ресурсам приложения занимать до {{size}}?', 'zh-CN': '此更新需要更多缓存空间。允许应用资源最多使用 {{size}} 吗？', 'zh-TW': '此次更新需要更多快取空間。允許應用程式資源最多使用 {{size}} 嗎？', ja: 'この更新にはさらにキャッシュ容量が必要です。アプリのアセットに最大 {{size}} を許可しますか？', ko: '이 업데이트에 더 많은 캐시 저장 공간이 필요합니다. 앱 자산에 최대 {{size}}까지 허용할까요?'
  },
  'Allow {{size}}': {
    en: 'Allow {{size}}', fr: 'Autoriser {{size}}', it: 'Consenti {{size}}', de: '{{size}} zulassen', es: 'Permitir {{size}}', 'pt-BR': 'Permitir {{size}}', ru: 'Разрешить {{size}}', 'zh-CN': '允许 {{size}}', 'zh-TW': '允許 {{size}}', ja: '{{size}} を許可', ko: '{{size}} 허용'
  }
}

const t = getT(assetBudgetLocales)

export function getAssetBudgetConfirmation ({ nextApprovedBytes, filename, subject = 'app', formatBytes }) {
  const size = formatBytes(nextApprovedBytes)
  const key = filename
    ? '{{filename}} needs more cached storage. Allow this app\'s assets up to {{size}}?'
    : subject === 'update'
      ? 'This update needs more cached storage. Allow this app\'s assets up to {{size}}?'
      : 'This app needs more cached storage. Allow this app\'s assets up to {{size}}?'
  return {
    title: t('More app storage?'),
    message: t(key, { filename, size }),
    confirmText: t('Allow {{size}}', { size })
  }
}
