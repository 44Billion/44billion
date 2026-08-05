import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { toTestStore } from './signal-mock.js'

let renderAvatar
let generatedAvatars = 0
let defaultUserPk

globalThis.localStorage = {}

mock.module('#f', {
  namedExports: {
    f: (_name, render) => { renderAvatar = render },
    useStore: toTestStore
  }
})
mock.module('#helpers/avatar.js', {
  namedExports: {
    getSvgAvatar: () => {
      generatedAvatars++
      return '<svg />'
    },
    isValidAvatarPicture: picture => picture === '/profile/avatar.png'
  }
})
mock.module('#shared/icons/icon-user-circle.js', { namedExports: {} })
mock.module('#shared/svg.js', { namedExports: {} })
mock.module('libp2r2p/base62', { namedExports: { base62ToBase16: value => value } })
mock.module('#hooks/use-web-storage.js', {
  defaultExport: () => new Proxy({}, {
    get: (_target, key) => key === 'session_defaultUserPk$'
      ? () => defaultUserPk
      : () => undefined
  })
})
mock.module('#assets/styles/theme.js', {
  namedExports: { cssVars: { colors: { bgAvatar: 'black', bgAvatarLoading: 'gray' } } }
})
mock.module('#i18n/index.js', {
  namedExports: { getT: () => key => key }
})

await import('../../src/components/shared/avatar.js')

describe('a-avatar fallback generation', () => {
  it('does not generate an SVG while a valid picture is available', () => {
    generatedAvatars = 0
    defaultUserPk = undefined
    const context = {
      props: { pk: 'publisher', picture: '/profile/avatar.png' },
      h: () => ({})
    }

    renderAvatar.call(context)

    assert.equal(generatedAvatars, 0)
  })

  it('generates the local SVG when the picture is unavailable', () => {
    generatedAvatars = 0
    defaultUserPk = undefined
    const context = {
      props: { pk: 'publisher' },
      h: () => ({})
    }

    renderAvatar.call(context)

    assert.ok(generatedAvatars > 0)
  })

  it('uses the account icon for the default unauthenticated user', () => {
    generatedAvatars = 0
    defaultUserPk = 'default-user'
    let template
    const context = {
      props: { pk: defaultUserPk },
      h: strings => {
        template = strings.join('')
        return {}
      }
    }

    renderAvatar.call(context)

    assert.match(template, /<icon-user-circle/)
    assert.equal(generatedAvatars, 0)
  })
})
