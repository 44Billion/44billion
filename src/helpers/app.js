import { base62ToBase16, base16ToBase62 } from '#helpers/base62.js'
import { base16ToBytes } from '#helpers/base16.js'

const nappEventKinds = {
  // file chunk
  34600: true,
  // app listing
  37348: true, // main
  37349: true, // next
  37350: true, // draft
  // site manifest
  35128: true, // main
  35129: true, // next
  35130: true  // draft
}
export const shouldIncludeNappRelays = filter =>
  !filter.kinds || filter.kinds.length === 0 || filter.kinds.some(k => nappEventKinds[k])

export const NOSTR_APP_D_TAG_MAX_LENGTH = 260

export function isNostrAppDTagSafe (string) {
  return typeof string === 'string' && string.length <= NOSTR_APP_D_TAG_MAX_LENGTH
}

function parseAppId (appId) {
  if (!appId || appId.length < 44) throw new Error('Invalid appId')
  const channelEnum = appId[0]
  if (channelEnum !== 'a' && channelEnum !== 'b' && channelEnum !== 'c') throw new Error('Invalid channel')
  const pubkeyB62 = appId.slice(1, 44)
  if (!/^[A-Za-z0-9]{43}$/.test(pubkeyB62)) throw new Error('Invalid pubkey in appId')
  const dTag = appId.slice(44)
  return { channelEnum, pubkeyB62, dTag }
}

export function appIdToAddressObj (appId) {
  const { channelEnum, pubkeyB62, dTag } = parseAppId(appId)
  if (!isNostrAppDTagSafe(dTag)) throw new Error('Invalid d tag')
  const channel = {
    a: 'main',
    b: 'next',
    c: 'draft'
  }[channelEnum]
  const kind = {
    main: 35128,
    next: 35129,
    draft: 35130
  }[channel]
  const pubkey = base62ToBase16(pubkeyB62)
  return {
    kind,
    pubkey,
    dTag
  }
}

export function appIdToDbAppRef (appId) {
  const { channelEnum, pubkeyB62, dTag } = parseAppId(appId)
  if (!isNostrAppDTagSafe(dTag)) throw new Error('Invalid d tag')
  return [channelEnum, base16ToBytes(base62ToBase16(pubkeyB62)), dTag]
}

export function addressObjToAppId (obj) {
  const channelEnum = {
    35128: 'a',
    35129: 'b',
    35130: 'c'
  }[obj.kind]
  if (!channelEnum) throw new Error('Invalid kind')
  const pubkeyB62 = base16ToBase62(obj.pubkey, 43)
  if (!isNostrAppDTagSafe(obj.dTag)) throw new Error('Invalid d tag')
  return `${channelEnum}${pubkeyB62}${obj.dTag}`
}

// '/a/b', '/a/b/', '/a/b.html', '/a/b.htm', '/a/b/index.html' and '/a/b/index.htm'
//  should match /a/b/index.html or /a/b/index.htm or /a/b.html or /a/b.htm
export function findRouteFileTag (pathname, manifestTags) {
  const pathTags = manifestTags.filter(t => t[0] === 'path')
  let tag
  for (const filename of getPotentialFilenameMatches(pathname)) {
    if ((tag = pathTags.find(v => {
      // Be defensive: allow leading "/" in tag value even though spec says no leading "/"
      const tagPath = v[1]?.[0] === '/' ? v[1].slice(1) : v[1]
      return tagPath === filename
    }))) return tag
  }

  return null
}

function * getPotentialFilenameMatches (pathname, htmlOnly = false) {
  // Remove the leading '/'
  let basePath = pathname[0] === '/' ? pathname.slice(1) : pathname
  const endsWithHtml = /\.html?$/.test(basePath)
  if (endsWithHtml || (!htmlOnly && !!basePath)) yield basePath
  if (!endsWithHtml && basePath.endsWith('/')) basePath = basePath.slice(0, -1)

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
