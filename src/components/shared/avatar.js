import { f, useStore } from '#f'
import { getSvgAvatar, isValidAvatarPicture } from '#helpers/avatar.js'
import '#shared/icons/icon-user-circle.js'
import '#shared/svg.js'
import { base62ToBase16 } from 'libp2r2p/base62'
import useWebStorage from '#hooks/use-web-storage.js'
import { cssVars } from '#assets/styles/theme.js'
import { getT } from '#i18n/index.js'

export const avatarLocales = getLocales()
const t = getT(avatarLocales)

f('a-avatar', function () {
  const storage = useWebStorage(localStorage)
  const { props } = this
  const store = useStore({
    usePlaceholder$: props.usePlaceholder$ ?? props.usePlaceholder ?? false,
    pk$: props.pk$ ?? props.pk,
    isDefaultUser$ () {
      const pk = this.pk$()
      return Boolean(pk) && pk === storage.session_defaultUserPk$()
    },
    picture$ () {
      const picture = props.picture$?.() ?? props.picture ?? storage[`session_accountByUserPk_${this.pk$()}_profile$`]()?.picture
      if (!picture) return null

      return isValidAvatarPicture(picture) ? picture : null
    },
    svg$ () {
      const seed = this.pk$()
      if (!seed || this.isDefaultUser$()) return
      return getSvgAvatar(base62ToBase16(seed, { mode: 'integer', byteLength: 32 }))
    }
  })

  if (store.isDefaultUser$()) {
    return this.h`<icon-user-circle props=${this.props} />`
  }

  if (store.picture$()) {
    return this.h`<img
      src=${store.picture$()}
      alt=${t('User avatar')}
      style=${`
        width: 100%;
        height: 100%;
        object-fit: cover;
        border-radius: 50%;
        background-color: ${cssVars.colors.bgAvatar};
      `}
    />`
  }

  if (!store.pk$() || !store.svg$()) {
    return store.usePlaceholder$()
      ? this.h`<div
          style=${`
            width: 100%;
            height: 100%;
            border-style: solid;
            border-width: 0;
            overflow: hidden;
          `}
        >
          <style>${`
              @keyframes pulse {
                50% {
                  opacity: .5;
                }
              }
            .animate-background {
              animation: pulse 2s cubic-bezier(.4,0,.6,1) infinite;
              background-color: ${cssVars.colors.bgAvatarLoading};
              position: relative;
              height: 100%;
            }
          `}</style>
          <div class='animate-background' />
        </div>`
      : this.h`<icon-user-circle props=${this.props} />`
  }

  return this.h`<a-svg props=${{ ...this.props, svg: store.svg$() }} />`
})

function getLocales () {
  return {
    'User avatar': { en: 'User avatar', fr: 'Avatar de l’utilisateur', it: 'Avatar utente', de: 'Benutzeravatar', es: 'Avatar del usuario', 'pt-BR': 'Avatar do usuário', ru: 'Аватар пользователя', 'zh-CN': '用户头像', 'zh-TW': '使用者頭像', ja: 'ユーザーのアバター', ko: '사용자 아바타' }
  }
}
