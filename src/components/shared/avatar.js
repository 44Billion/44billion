import { f, useStore, useAsyncComputed } from '#f'
import { getSvgAvatar } from '#helpers/avatar.js'
import '#shared/icons/icon-user-circle.js'
import '#shared/svg.js'
import { base62ToBase16 } from '#helpers/base62.js'
import useWebStorage from '#hooks/use-web-storage.js'
import { cssVars } from '#assets/styles/theme.js'

// todo: if there's kind 0 picture, use it
f('aAvatar', function () {
  const storage = useWebStorage(localStorage)
  const store = useStore({
    pk$: this.props.pk$ ?? this.props.pk,
    picture$ () {
      const picture = storage[`session_accountByUserPk_${this.pk$()}_profile$`]()?.picture
      if (!picture) return null

      const isDataImage = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*(?:;base64)?,/i.test(picture)
      const isHttpImageUrl = /^(https?:\/\/)[^\s?#]+\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)(?:[?#].*)?$/i.test(picture)
      const isRelativeImageUrl = /^(?:\.{0,2}\/)?[^\s?#]+\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)(?:[?#].*)?$/i.test(picture)
      if (!(isDataImage || isHttpImageUrl || !isRelativeImageUrl)) return null

      return picture
    },
    svg$: useAsyncComputed(() => {
      const seed = store.pk$()
      if (!seed) return
      return getSvgAvatar(base62ToBase16(seed))
    })
  })

  if (store.picture$()) {
    return this.h`<img
      src=${store.picture$()}
      alt='User avatar'
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
    return this.h`<icon-user-circle props=${this.props} />`
  }

  return this.h`<a-svg props=${{ ...this.props, svg: store.svg$() }} />`
})
