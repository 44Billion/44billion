import { base62ToBase16, base16ToBase62 } from 'libp2r2p/base62'
import { base16ToBytes } from 'libp2r2p/base16'
import { findRouteAssetDescriptor } from '#helpers/site-manifest.js'

const nappEventKinds = {
  // file chunk
  34601: true,
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
  const pubkey = base62ToBase16(pubkeyB62, { mode: 'integer', byteLength: 32 })
  return {
    kind,
    pubkey,
    dTag
  }
}

export function appIdToDbAppRef (appId) {
  const { channelEnum, pubkeyB62, dTag } = parseAppId(appId)
  if (!isNostrAppDTagSafe(dTag)) throw new Error('Invalid d tag')
  return [
    channelEnum,
    base16ToBytes(base62ToBase16(pubkeyB62, { mode: 'integer', byteLength: 32 })),
    dTag
  ]
}

export function addressObjToAppId (obj) {
  const channelEnum = {
    35128: 'a',
    35129: 'b',
    35130: 'c'
  }[obj.kind]
  if (!channelEnum) throw new Error('Invalid kind')
  const pubkeyB62 = base16ToBase62(obj.pubkey, { mode: 'integer', minLength: 43 })
  if (!isNostrAppDTagSafe(obj.dTag)) throw new Error('Invalid d tag')
  return `${channelEnum}${pubkeyB62}${obj.dTag}`
}

// '/a/b', '/a/b/', '/a/b.html', '/a/b.htm', '/a/b/index.html' and '/a/b/index.htm'
//  should match /a/b/index.html or /a/b/index.htm or /a/b.html or /a/b.htm
export function findRouteFileTag (pathname, manifestTags) {
  const descriptor = findRouteAssetDescriptor(pathname, { tags: manifestTags })
  if (!descriptor) return null
  const tag = ['path', descriptor.filename, descriptor.root]
  Object.defineProperty(tag, 'descriptor', { value: descriptor })
  return tag
}
