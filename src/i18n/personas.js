import { getT } from '#i18n/index.js'

export const personaLocales = {
  'Switch User': { en: 'Switch User', fr: 'Changer d’Utilisateur', it: 'Cambia Utente', de: 'Benutzer Wechseln', es: 'Cambiar Usuario', 'pt-BR': 'Trocar Usuário', ru: 'Сменить Пользователя', 'zh-CN': '切换用户', 'zh-TW': '切換使用者', ja: 'ユーザーを切り替え', ko: '사용자 전환' },
  'All Users': { en: 'All Users', fr: 'Tous les Utilisateurs', it: 'Tutti gli Utenti', de: 'Alle Benutzer', es: 'Todos los Usuarios', 'pt-BR': 'Todos os Usuários', ru: 'Все Пользователи', 'zh-CN': '所有用户', 'zh-TW': '所有使用者', ja: 'すべてのユーザー', ko: '모든 사용자' },
  'Workspace User': { en: 'Workspace User', fr: 'Utilisateur de l’Espace', it: 'Utente dello Spazio', de: 'Arbeitsbereichsbenutzer', es: 'Usuario del Espacio', 'pt-BR': 'Usuário do Workspace', ru: 'Пользователь Пространства', 'zh-CN': '工作区用户', 'zh-TW': '工作區使用者', ja: 'ワークスペースのユーザー', ko: '작업 공간 사용자' }
}

export const personaT = getT(personaLocales)
