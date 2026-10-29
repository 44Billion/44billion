import { LIST_KINDS, SET_KINDS } from '@kehto/nip/51'
import { publicKeyFromTarget } from './social.js'

const typesByKind = {
  10000: ['pubkey', 'event', 'hashtag', 'word'], 10001: ['event'], 10003: ['event', 'address'],
  10006: ['relay'], 10007: ['relay'], 10015: ['hashtag'], 10050: ['relay'],
  30000: ['pubkey'], 30002: ['relay'], 30003: ['event', 'address'], 30015: ['hashtag']
}
const tagForType = { pubkey: 'p', event: 'e', address: 'a', hashtag: 't', word: 'word', relay: 'r' }
const supported = Object.entries(typesByKind).map(([kind, supportedItemTypes]) => ({ kind: Number(kind), type: LIST_KINDS[kind] || SET_KINDS[kind], addressable: Number(kind) >= 30000, supportedItemTypes, privateItems: false }))

export function createNappletLists ({ network, account, locks = globalThis.navigator?.locks }) {
  const mutate = async (remove, reference, items, options = {}) => {
    const support = supported.find(item => reference.kind === item.kind || reference.type === item.type)
    if (!support) return { ok: false, error: 'unsupported-list' }
    if (support.addressable && !reference.identifier) return { ok: false, error: 'missing-identifier' }
    if (items.some(item => item.visibility === 'private')) return { ok: false, error: 'private-items-unsupported' }
    if (items.some(item => !support.supportedItemTypes.includes(item.itemType))) return { ok: false, error: 'unsupported-item' }
    const pubkey = account.getPublicKey()
    if (!pubkey) return { ok: false, error: 'not-signed-in' }
    const run = async () => {
      account.guard()
      const filter = { kinds: [support.kind], authors: [pubkey], limit: 1, ...(support.addressable ? { '#d': [reference.identifier] } : {}) }
      const response = await network.router.query([filter], { limit: 20 })
      if (response.error || response.incomplete) return { ok: false, error: 'list-unavailable' }
      const current = response.events.map(result => result.event).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0]
      if (!current && !options.create) return { ok: false, error: 'list-not-found' }
      let tags = current?.tags || (support.addressable ? [['d', reference.identifier]] : [])
      if (!current) {
        for (const key of ['title', 'description', 'image']) if (typeof options[key] === 'string') tags.push([key, options[key]])
      }
      let changed = 0
      for (const item of items) {
        const type = tagForType[item.itemType]
        const value = item.itemType === 'pubkey' ? publicKeyFromTarget(item.value) : item.value
        const exists = tags.some(tag => tag[0] === type && tag[1] === value)
        if (remove && exists) { tags = tags.filter(tag => tag[0] !== type || tag[1] !== value); changed++ } else if (!remove && !exists) { tags = [...tags, [type, value, ...(item.relay ? [item.relay] : [])]]; changed++ }
      }
      if (!changed) return { ok: true, added: 0, removed: 0, skipped: items.length }
      const result = await network.router.publish({ kind: support.kind, content: current?.content || '', tags, created_at: Math.floor(Date.now() / 1000) })
      return { ...result, [remove ? 'removed' : 'added']: changed, skipped: items.length - changed }
    }
    return locks ? locks.request(`44billion:napplet-list:${pubkey}:${support.kind}:${reference.identifier || ''}`, run) : run()
  }
  return { supported: () => structuredClone(supported), add: (ref, items, options) => mutate(false, ref, items, options), remove: (ref, items, options) => mutate(true, ref, items, options) }
}
