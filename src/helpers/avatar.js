import { Avatar, Style } from '@dicebear/core'
import avataaars from '@dicebear/styles/avataaars.json' with { type: 'json' }

import { getRandomId } from '#helpers/misc.js'

const style = new Style(avataaars)

export const getSvgAvatar = function (seed = getRandomId()) {
  return new Avatar(style, {
    borderRadius: 50,
    idRandomization: true,
    seed
  }).toString()
}

// Identifies self-contained avatar pictures that require no network request.
export const isDataAvatarPicture = function (picture) {
  return typeof picture === 'string' &&
    /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*(?:;base64)?,/i.test(picture)
}

export const isValidAvatarPicture = function (picture) {
  if (
    typeof picture !== 'string' ||
    picture.length === 0 ||
    picture.trim() !== picture ||
    /\s/.test(picture)
  ) return false

  if (isDataAvatarPicture(picture)) return true

  try {
    const url = new URL(picture)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch (_) {
    return false
  }
}
