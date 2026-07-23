import { eventKinds } from 'libp2r2p/kind'

const eventTags = {
  ADDRESS: 'a', // https://github.com/nostr-protocol/nips/blob/master/23.md
  CHALLENGE: 'challenge',
  DEDUPLICATION: 'd',
  DELEGATION: 'delegation',
  EVENT: 'e',
  EXPIRATION: 'expiration',
  GEOLOCATION: 'g', // not used by anyone yet ["g", "DE", "country"] or ["g", "ww8p1r4t8", "geohash"]
  HASHTAG: 't',
  IMAGE: 'image', // https://github.com/nostr-protocol/nips/blob/master/23.md
  LANGUAGE: 'l', // https://github.com/nostr-protocol/nips/blob/master/12.md
  NONCE: 'nonce',
  PUBKEY: 'p',
  PUBLISHED_AT: 'published_at', // https://github.com/nostr-protocol/nips/blob/master/23.md
  RELAY: 'relay',
  REFERENCE: 'r',
  SUBJECT: 'subject',
  SUMMARY: 'summary', // https://github.com/nostr-protocol/nips/blob/master/23.md
  TITLE: 'title' // https://github.com/nostr-protocol/nips/blob/master/23.md
}

export {
  eventKinds,
  eventTags
}
