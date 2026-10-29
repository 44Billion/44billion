import { decode } from 'nostr-tools/nip19'

const hexKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const reportReasons = new Set(['nudity', 'malware', 'profanity', 'illegal', 'spam', 'impersonation', 'other'])
const emojiPattern = /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?(?:[\u{E0020}-\u{E007E}]+\u{E007F})?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*)$/u

export function publicKeyFromTarget (target) {
  if (typeof target !== 'string') throw new Error('invalid-pubkey')
  if (hexKey(target)) return target
  const value = decode(target.replace(/^nostr:/, ''))
  if (value.type === 'npub') return value.data
  if (value.type === 'nprofile') return value.data.pubkey
  throw new Error('INVALID_PUBLIC_KEY')
}

export function createNappletSocial ({ network, account, locks = globalThis.navigator?.locks }) {
  const latestResult = async (kind, pubkey = account.getPublicKey(), { allowIncomplete = false, relays } = {}) => {
    account.guard()
    if (!pubkey) return null
    const response = await network.router.query([{ kinds: [kind], authors: [pubkey], limit: 1 }], { limit: 20, ...(relays?.length ? { relays } : {}) })
    account.guard()
    if (!allowIncomplete && (response.error || response.incomplete)) throw new Error(response.error || 'INCOMPLETE_PUBLIC_STATE')
    return (response.events || []).sort((a, b) => b.event.created_at - a.event.created_at || a.event.id.localeCompare(b.event.id))[0] || null
  }
  const latest = async (...args) => (await latestResult(...args))?.event || null
  const requireSigner = () => { account.guard(); const pubkey = account.getPublicKey(); if (!pubkey) throw new Error('not-signed-in'); return pubkey }
  const publish = (kind, content, tags) => network.router.publish({ kind, content, tags, created_at: Math.floor(Date.now() / 1000) })
  const follows = async () => ({ ok: true, pubkeys: [...new Set((await latest(3))?.tags.filter(tag => tag[0] === 'p' && hexKey(tag[1])).map(tag => tag[1]) || [])] })
  const updateFollows = async (values, remove) => {
    requireSigner()
    if (!Array.isArray(values) || !values.length) throw new Error('invalid-pubkey')
    const pubkeys = [...new Set(values.map(publicKeyFromTarget))]
    const current = await latest(3)
    let tags = current?.tags || []
    if (remove) tags = tags.filter(tag => tag[0] !== 'p' || !pubkeys.includes(tag[1]))
    else tags = [...tags, ...pubkeys.filter(pubkey => !tags.some(tag => tag[0] === 'p' && tag[1] === pubkey)).map(pubkey => ['p', pubkey])]
    return publish(3, current?.content || '', tags)
  }
  const changeFollows = (values, remove) => {
    const pubkey = requireSigner()
    return locks ? locks.request(`44billion:napplet-list:${pubkey}:3:`, () => updateFollows(values, remove)) : updateFollows(values, remove)
  }
  return {
    latest, follows,
    async getProfile (target) {
      const pubkey = publicKeyFromTarget(target)
      const pointer = target.replace(/^nostr:/, '')
      const relays = /^nprofile1/i.test(pointer) ? decode(pointer).data.relays : undefined
      const result = await latestResult(0, pubkey, { relays })
      const event = result?.event
      let profile = null
      if (event) { try { const value = JSON.parse(event.content); if (value && typeof value === 'object' && !Array.isArray(value)) profile = value } catch {} }
      return { ok: true, pubkey, profile, ...(event ? { result } : {}) }
    },
    follow: pubkeys => changeFollows(pubkeys, false),
    unfollow: pubkeys => changeFollows(pubkeys, true),
    async react (eventId, reaction, emoji) {
      requireSigner()
      if (!hexKey(eventId)) throw new Error('invalid-target')
      const shortcode = typeof reaction === 'string' && /^:[a-zA-Z0-9_]+:$/.test(reaction)
      if (!['+', '-'].includes(reaction) && !emojiPattern.test(reaction) && !shortcode) throw new Error('invalid-reaction')
      if (shortcode !== (emoji !== undefined)) throw new Error('invalid-reaction')
      if (emoji !== undefined) {
        let url
        try { url = new URL(emoji) } catch { throw new Error('invalid-reaction') }
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid-reaction')
      }
      const result = await network.router.getEvent(eventId)
      const target = result.result?.event
      if (!target) throw new Error('EVENT_NOT_FOUND')
      const tags = [['e', target.id], ['p', target.pubkey], ['k', String(target.kind)]]
      if (target.kind >= 30000 && target.kind < 40000) tags.push(['a', `${target.kind}:${target.pubkey}:${target.tags?.find(tag => tag[0] === 'd')?.[1] || ''}`])
      if (emoji) tags.push(['emoji', reaction.replace(/^:|:$/g, ''), emoji])
      return publish(7, reaction, tags)
    },
    async report (target, reason, text) {
      requireSigner()
      if (!reportReasons.has(reason)) throw new Error('invalid-report-reason')
      if (!target || !['pubkey', 'event'].includes(target.type) || typeof text !== 'string') throw new Error('invalid-target')
      if (target.relay !== undefined && typeof target.relay !== 'string') throw new Error('invalid-target')
      const tags = []
      if (target.type === 'pubkey') tags.push(['p', publicKeyFromTarget(target.pubkey), reason])
      else {
        if (!hexKey(target.id) || (target.pubkey !== undefined && !hexKey(target.pubkey))) throw new Error('invalid-target')
        const author = target.pubkey || (await network.router.getEvent(target.id, target.relay ? { relays: [target.relay] } : undefined)).result?.event?.pubkey
        if (!hexKey(author)) throw new Error('author-unresolved')
        tags.push(['e', target.id, reason], ['p', author, reason])
      }
      return publish(1984, text, tags)
    }
  }
}
