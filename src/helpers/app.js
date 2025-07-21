import { bytesToBase62, base62ToBase16, base16ToBase62 } from '#helpers/base62.js'
import { base16ToBytes } from '#helpers/base16.js'

export const NOSTR_APP_D_TAG_MAX_LENGTH = 19

export function isNostrAppDTagSafe (string) {
  return isSubdomainSafe(string) && string.length <= NOSTR_APP_D_TAG_MAX_LENGTH
}

function isSubdomainSafe (string) {
  return /(?:^[A-Za-z0-9]$)|(?:^(?!.*--)[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9]$)/.test(string)
}

export function deriveNostrAppId (string) {
  return toSubdomainSafe(string, NOSTR_APP_D_TAG_MAX_LENGTH)
}

async function toSubdomainSafe (string, maxStringLength) {
  const byteLength = base62MaxLengthToMaxSourceByteLength(maxStringLength)
  const bytes = (await toSha1(string)).slice(0, byteLength)
  return bytesToBase62(bytes, maxStringLength)
}

async function toSha1 (string) {
  const bytes = new TextEncoder().encode(string)
  return new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))
}

// base62MaxLengthToMaxSourceByteLength(19) === 14 byte length
function base62MaxLengthToMaxSourceByteLength (maxStringLength) {
  const log62 = Math.log(62)
  const log256 = Math.log(256)

  const maxByteLength = (maxStringLength * log62) / log256

  return Math.floor(maxByteLength)
}

export function userSubdomainToPk (subdomain) {
  const pk = base62ToBase16(subdomain.match(/^u(?<pubkeyB62>[A-Za-z0-9]{43})$/).groups.pubkeyB62)
  if (!/[a-f0-9]{64}/.test(pk)) throw new Error('Wrong pk format')
  return pk
}

export function pkToUserSubdomain (pk) {
  if (!/[a-f0-9]{64}/.test(pk)) throw new Error('Wrong pk format')
  return `u${base16ToBase62(pk, 43)}`
}

export function appIdToAddressObj (appId /* subdomain-formatted */) {
  const {
    groups: {
      channelEnum,
      pubkeyB62,
      dTag
    }
  } = appId.match(/^(?<channelEnum>[abc]{1})(?<pubkeyB62>[A-Za-z0-9]{43})(?<dTag>[A-Za-z0-9-]{1,19})$/)
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
  } = appId.match(/^(?<channelEnum>[abc]{1})(?<pubkeyB62>[A-Za-z0-9]{43})(?<dTag>[A-Za-z0-9-]{1,19})$/)
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
  for (const filename of getPotentialFilenameMatches(pathname)) {
    if (fileTags.find(v => v[2] === filename)) return filename
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
