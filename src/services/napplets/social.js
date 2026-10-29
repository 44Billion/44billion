import { decode } from 'nostr-tools/nip19'

export function publicKeyFromTarget (target) {
  if (/^[a-f0-9]{64}$/.test(target)) return target
  const value = decode(target.replace(/^nostr:/, ''))
  if (value.type === 'npub') return value.data
  if (value.type === 'nprofile') return value.data.pubkey
  throw new Error('INVALID_PUBLIC_KEY')
}

export function createNappletSocial ({ network, account, locks = globalThis.navigator?.locks }) {
  const latest = async (kind, pubkey = account.getPublicKey(), { allowIncomplete = false } = {}) => {
    account.guard()
    if (!pubkey) return null
    const response = await network.router.query([{ kinds: [kind], authors: [pubkey], limit: 1 }], { limit: 20 })
    account.guard()
    if (!allowIncomplete && (response.error || response.incomplete)) throw new Error(response.error || 'INCOMPLETE_PUBLIC_STATE')
    return (response.events || []).map(result => result.event).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0] || null
  }
  const publish = (kind, content, tags) => network.router.publish({ kind, content, tags, created_at: Math.floor(Date.now() / 1000) })
  const follows = async () => ({ ok: true, pubkeys: (await latest(3))?.tags.filter(tag => tag[0] === 'p').map(tag => tag[1]) || [] })
  const updateFollows = async (values, remove) => {
    const pubkeys = values.map(publicKeyFromTarget)
    const current = await latest(3)
    let tags = current?.tags || []
    if (remove) tags = tags.filter(tag => tag[0] !== 'p' || !pubkeys.includes(tag[1]))
    else tags = [...tags, ...pubkeys.filter(pubkey => !tags.some(tag => tag[0] === 'p' && tag[1] === pubkey)).map(pubkey => ['p', pubkey])]
    return publish(3, current?.content || '', tags)
  }
  const changeFollows = (values, remove) => {
    const pubkey = account.getPublicKey()
    return locks ? locks.request(`44billion:napplet-list:${pubkey}:3:`, () => updateFollows(values, remove)) : updateFollows(values, remove)
  }
  return {
    latest, follows,
    async getProfile (target) {
      const pubkey = publicKeyFromTarget(target)
      const event = await latest(0, pubkey)
      let profile = null
      if (event) { try { const value = JSON.parse(event.content); if (value && typeof value === 'object' && !Array.isArray(value)) profile = value } catch {} }
      return { ok: true, pubkey, profile, ...(event ? { result: { event } } : {}) }
    },
    follow: pubkeys => changeFollows(pubkeys, false),
    unfollow: pubkeys => changeFollows(pubkeys, true),
    async react (eventId, reaction, emoji) {
      const result = await network.router.getEvent(eventId)
      const target = result.result?.event
      if (!target) throw new Error('EVENT_NOT_FOUND')
      const tags = [['e', target.id], ['p', target.pubkey], ['k', String(target.kind)]]
      if (emoji) tags.push(['emoji', reaction.replace(/^:|:$/g, ''), emoji])
      return publish(7, reaction, tags)
    },
    async report (target, reason, text) {
      const tags = []
      if (target.type === 'pubkey') tags.push(['p', publicKeyFromTarget(target.pubkey), reason])
      else {
        const event = (await network.router.getEvent(target.id)).result?.event
        if (!event) throw new Error('EVENT_NOT_FOUND')
        tags.push(['e', event.id, reason], ['p', event.pubkey, reason])
      }
      return publish(1984, text, tags)
    }
  }
}
