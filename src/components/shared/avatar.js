import { f, useStore, useTask } from '#f'
import { getSvgAvatar, isDataAvatarPicture, isValidAvatarPicture } from '#helpers/avatar.js'
import '#shared/icons/icon-user-circle.js'
import '#shared/svg.js'
import { base62ToBase16 } from 'libp2r2p/base62'
import useWebStorage from '#hooks/use-web-storage.js'
import { cssVars } from '#assets/styles/theme.js'
import { getT } from '#i18n/index.js'

export const avatarLocales = getLocales()
const t = getT(avatarLocales)
const AVATAR_PICTURE_TIMEOUT_MS = 15000

f('a-avatar', ({ h, props }) => {
  const storage = useWebStorage(localStorage)
  const store = useStore(() => ({
    usePlaceholder$: props.usePlaceholder$ ?? props.usePlaceholder ?? false,
    pk$: props.pk$ ?? props.pk,
    loadedPicture$: null,
    rejectedPicture$: null,
    isDefaultUser$ () {
      const pk = this.pk$()
      return Boolean(pk) && pk === storage.session_defaultUserPk$()
    },
    isProfilePending$ () {
      return props.profilePending$?.() ?? props.profilePending ?? false
    },
    picture$ () {
      const picture = props.picture$?.() ?? props.picture ?? storage[`session_accountByUserPk_${this.pk$()}_profile$`]()?.picture
      if (!picture) return null

      return isValidAvatarPicture(picture) ? picture : null
    },
    pictureToRender$ () {
      const picture = this.picture$()
      const rejected = this.rejectedPicture$()
      return picture && !(rejected?.pk === this.pk$() && rejected.picture === picture)
        ? picture
        : null
    },
    isPictureLoaded$ () {
      const picture = this.pictureToRender$()
      if (isDataAvatarPicture(picture)) return true
      const loaded = this.loadedPicture$()
      return !!picture && loaded?.pk === this.pk$() && loaded.picture === picture
    },
    markPictureLoaded (event) {
      const picture = this.pictureToRender$()
      if (!picture || event.currentTarget.getAttribute('src') !== picture) return
      this.loadedPicture$({ pk: this.pk$(), picture })
    },
    failPicture (picture, error) {
      if (!picture || picture !== this.pictureToRender$()) return
      console.error(`[avatar ${this.pk$() || 'unknown'}] Failed to load avatar picture:`, error)
      this.loadedPicture$(null)
      this.rejectedPicture$({ pk: this.pk$(), picture })
    },
    rejectPicture (event) {
      const picture = this.pictureToRender$()
      if (!picture || event.currentTarget.getAttribute('src') !== picture) return
      this.failPicture(picture, new Error(`Avatar picture failed to load: ${picture}`))
    },
    svg$ () {
      const seed = this.pk$()
      if (!seed || this.isDefaultUser$()) return
      return getSvgAvatar(base62ToBase16(seed, { mode: 'integer', byteLength: 32 }))
    }
  }))

  useTask(({ track, cleanup }) => {
    const isDefaultUser = track(() => store.isDefaultUser$())
    if (isDefaultUser) return

    const { picture, isLoaded } = track(() => ({
      picture: store.pictureToRender$(),
      isLoaded: store.isPictureLoaded$()
    }))
    if (!picture || isLoaded) return

    const timeoutId = setTimeout(() => {
      const error = new Error(`Avatar picture timed out after ${AVATAR_PICTURE_TIMEOUT_MS}ms: ${picture}`)
      error.name = 'TimeoutError'
      store.failPicture(picture, error)
    }, AVATAR_PICTURE_TIMEOUT_MS)
    cleanup(() => clearTimeout(timeoutId))
  })

  if (store.isDefaultUser$()) {
    return h`<icon-user-circle props=${props} />`
  }

  const picture = store.pictureToRender$()
  if (picture) {
    const isPictureLoaded = store.isPictureLoaded$()
    return h`
      <style>
        a-avatar .avatar-picture-loading {
          animation: avatarPulse 2s cubic-bezier(.4,0,.6,1) infinite;
        }
        @keyframes avatarPulse {
          0% { opacity: 0.1; }
          50% { opacity: 0.5; }
          100% { opacity: 0.1; }
        }
      </style>
      <span style=${`
        display: block;
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
      `}>
        <span
          aria-hidden='true'
          class=${isPictureLoaded ? '' : 'avatar-picture-loading'}
          style=${`
            position: absolute;
            inset: 0;
            background-color: ${cssVars.colors.bgAvatarLoading};
            visibility: ${isPictureLoaded ? 'hidden' : 'visible'};
          `}
        />
        <img
          src=${picture}
          decoding='async'
          onload=${store.markPictureLoaded}
          onerror=${store.rejectPicture}
          alt=${t('User avatar')}
          style=${`
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            border-radius: 50%;
            background-color: ${cssVars.colors.bgAvatar};
            visibility: ${isPictureLoaded ? 'visible' : 'hidden'};
          `}
        />
      </span>
    `
  }

  if (store.isProfilePending$() || !store.pk$() || !store.svg$()) {
    return store.usePlaceholder$()
      ? h`<div
          style=${`
            width: 100%;
            height: 100%;
            border-style: solid;
            border-width: 0;
            overflow: hidden;
          `}
        >
          <style>${`
              @keyframes avatarPlaceholderPulse {
                50% {
                  opacity: .5;
                }
              }
            a-avatar .animate-background {
              animation: avatarPlaceholderPulse 2s cubic-bezier(.4,0,.6,1) infinite;
              background-color: ${cssVars.colors.bgAvatarLoading};
              position: relative;
              height: 100%;
            }
          `}</style>
          <div class='animate-background' />
        </div>`
      : h`<icon-user-circle props=${props} />`
  }

  return h`<a-svg props=${{ ...props, svg: store.svg$() }} />`
})

function getLocales () {
  return {
    'User avatar': { en: 'User avatar', fr: 'Avatar de l’utilisateur', it: 'Avatar utente', de: 'Benutzeravatar', es: 'Avatar del usuario', 'pt-BR': 'Avatar do usuário', ru: 'Аватар пользователя', 'zh-CN': '用户头像', 'zh-TW': '使用者頭像', ja: 'ユーザーのアバター', ko: '사용자 아바타' }
  }
}
