import { base62ToBase16, base16ToBase62 } from '#helpers/base62.js'
import { bytesToBase36, base36ToBase62, base62ToBase36 } from '#helpers/base36.js'
import { base16ToBytes } from '#helpers/base16.js'

// 63 - (1<channel> + 5<b36loggeduserpkslug> 50<b36pk>)
// <b36loggeduserpkslug> pk chars at positions [7][17][27][37][47]
// to avoid vanity or pow colisions
export const NOSTR_APP_D_TAG_MAX_LENGTH = 7

export function isNostrAppDTagSafe (string) {
  return isSubdomainSafe(string) && string.length <= NOSTR_APP_D_TAG_MAX_LENGTH
}

function isSubdomainSafe (string) {
  return /(?:^[a-z0-9]$)|(?:^(?!.*--)[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$)/.test(string)
}

export function deriveNostrAppDTag (string) {
  return toSubdomainSafe(string, NOSTR_APP_D_TAG_MAX_LENGTH)
}

async function toSubdomainSafe (string, maxStringLength) {
  const byteLength = baseMaxLengthToMaxSourceByteLength(maxStringLength, 36)
  const bytes = (await toSha1(string)).slice(0, byteLength)
  return bytesToBase36(bytes, maxStringLength)
}

async function toSha1 (string) {
  const bytes = new TextEncoder().encode(string)
  return new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))
}

// baseMaxLengthToMaxSourceByteLength(19, 62) === 14 byte length
// baseMaxLengthToMaxSourceByteLength(7, 36) === 4 byte length
function baseMaxLengthToMaxSourceByteLength (maxStringLength, base) {
  if (!base) throw new Error('Which base?')
  const baseLog = Math.log(base)
  const log256 = Math.log(256)

  const maxByteLength = (maxStringLength * baseLog) / log256

  return Math.floor(maxByteLength)
}

export function appSubdomainToGroupsObj (subdomain) {
  return subdomain.match(/^(?<channelEnum>[abc]{1})(?<userSlugB36>[a-z0-9]{5})(?<pubkeyB36>[a-z0-9]{50})(?<dTag>[a-z0-9-]{1,7})$/).groups
}

export function appSubdomainToAppId (subdomain) {
  const {
    channelEnum,
    pubkeyB36,
    dTag
  } = appSubdomainToGroupsObj(subdomain)
  return `${channelEnum}${base36ToBase62(pubkeyB36, 43)}${dTag}`
}

export function appIdToAppSubdomain (appId, loggedInUserB36) {
  if (!loggedInUserB36) throw new Error('Which user?')

  // This guarantees the app's local db doesn't need to account for multiple users
  const userSlugB36 = [7, 17, 27, 37, 47].map(i => loggedInUserB36[i]).join('')
  const {
    groups: {
      channelEnum,
      pubkeyB62,
      dTag
    }
  } = appId.match(/^(?<channelEnum>[abc]{1})(?<pubkeyB62>[A-Za-z0-9]{43})(?<dTag>[a-z0-9-]{1,7})$/)
  return `${channelEnum}${userSlugB36}${base62ToBase36(pubkeyB62)}${dTag}`
}

export function appIdToAddressObj (appId) {
  const {
    groups: {
      channelEnum,
      pubkeyB62,
      dTag
    }
  } = appId.match(/^(?<channelEnum>[abc]{1})(?<pubkeyB62>[A-Za-z0-9]{43})(?<dTag>[a-z0-9-]{1,7})$/)
  if (!isNostrAppDTagSafe(dTag)) throw new Error('Invalid d tag')
  const channel = {
    a: 'main',
    b: 'next',
    c: 'draft'
  }[channelEnum]
  const kind = {
    main: 37448, // stable
    next: 37449, // insider
    draft: 37450 // vibe coded preview
  }[channel] ?? 37448
  const pubkey = base62ToBase16(pubkeyB62)
  return {
    kind,
    pubkey,
    dTag
  }
}

export function appIdToDbAppRef (appId) {
  const {
    groups: {
      channelEnum,
      pubkeyB62,
      dTag
    }
  } = appId.match(/^(?<channelEnum>[abc]{1})(?<pubkeyB62>[A-Za-z0-9]{43})(?<dTag>[a-z0-9-]{1,7})$/)
  if (!isNostrAppDTagSafe(dTag)) throw new Error('Invalid d tag')
  if (!{
    a: 'main',
    b: 'next',
    c: 'draft'
  }[channelEnum]) throw new Error('Invalid channel')

  return [channelEnum, base16ToBytes(base62ToBase16(pubkeyB62)), dTag]
}

export function addressObjToAppId (obj) {
  const channelEnum = {
    37448: 'a',
    37449: 'b',
    37450: 'c'
  }[obj.kind]
  if (!channelEnum) throw new Error('Invalid kind')
  const pubkeyB62 = base16ToBase62(obj.pubkey, 43)
  if (!isNostrAppDTagSafe(obj.dTag)) throw new Error('Invalid d tag')
  return `${channelEnum}${pubkeyB62}${obj.dTag}`
}

// use subdomain-formatted one
// export function appIdObjectToAppId (obj) {
//   return bytesToBase62(new TextEncoder().encode(`${obj.kind}:${obj.pubkey}:${obj.dTag}`))
// }

// '/a/b', '/a/b/', '/a/b.html', '/a/b.htm', '/a/b/index.html' and '/a/b/index.htm'
//  should match /a/b/index.html or /a/b/index.htm or /a/b.html or /a/b.htm
export function findRouteFileTag (pathname, bundleTags) {
  const fileTags = bundleTags.filter(t => t[0] === 'file' && /\.html?$/.test(t[2]))
  let tag
  for (const filename of getPotentialFilenameMatches(pathname)) {
    if ((tag = fileTags.find(v => v[2] === filename))) return tag
  }

  return null
}

function * getPotentialFilenameMatches (pathname) {
  let basePath = pathname.slice(1) // Remove the leading '/'
  if (/\.html?$/.test(basePath)) yield basePath
  else if (basePath.endsWith('/')) basePath = basePath.slice(0, -1)

  let cleanPath = basePath.replace(/(?:\/index)?\.html?$/, '')
  if (cleanPath.endsWith('/')) cleanPath = cleanPath.slice(0, -1)

  let next
  if (cleanPath.length > 0) {
    if ((next = `${cleanPath}.html`) !== basePath) yield next
    if ((next = `${cleanPath}.htm`) !== basePath) yield next
    if ((next = `${cleanPath}/index.html`) !== basePath) yield next
    if ((next = `${cleanPath}/index.htm`) !== basePath) yield next
  }

  // fallbacks
  if (basePath !== 'index.html') yield 'index.html'
  if (basePath !== 'index.htm') yield 'index.htm'
}
