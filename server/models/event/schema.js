import { defaultRankingRules } from '../../config/mdb.js'

export default {
  uid: 'events',
  // https://www.meilisearch.com/docs/learn/core_concepts/primary_key#formatting-the-document-id
  // The document id must be an integer or a string.
  // If the id is a string, it can only contain alphanumeric characters (a-z, A-Z, 0-9),
  // hyphens (-), and underscores (_).
  primaryKey: 'ref',
  attributes: [
    'ref', // id or address: dTag ? bytesToBase64(sha256(new TextEncoder().encode(`${kind}:${pubkey}:${dTag}`)) : bytesToBase64(base16ToBytes(id)))
    // [`${k} ${vN}`] // whitespace is a soft word separator - https://www.meilisearch.com/docs/learn/engine/datatypes#separators
    // useful in case we want to turn itags searchable (instead)
    // of just filterable
    // for filtering, = is like an exact search though case-insensitive
    'itags',
    'fts', // add anything other than .content here
    // keep in memory and from time to time write to db
    // and if not dirty for a while, remove from memory
    'sat', // seen/stored at
    'aat', // accessed at, in seconds - debounce when setting this
    'exp', // expiration date, in seconds
    // v nostr event v
    'id',
    'pubkey',
    'kind',
    'tags',
    'content',
    'created_at',
    'sig'
  ],
  // https://www.meilisearch.com/docs/reference/api/settings#settings-object
  settings: {
    displayedAttributes: [
      '*'
    ],
    searchableAttributes: [
      'content',
      'fts' // add anything other than .content here
    ],
    filterableAttributes: [
      'id',
      'pubkey',
      'kind',
      'itags', // k vN
      'created_at',
      'sat',
      'aat',
      'exp'
    ],
    sortableAttributes: [
      'created_at',
      'sat'
    ],
    rankingRules: [
      ...defaultRankingRules,
      'created_at:desc'
    ]
    // stopWords: [],
    // nonSeparatorTokens: [], // allows to remove of some tokens from the default list of separators - https://github.com/meilisearch/meilisearch/pull/3946
    // separatorTokens: [],
    // dictionary: [],
    // synonyms: {
    //   wolverine: ['xmen', 'logan'],
    //   logan: ['wolverine', 'xmen'],
    // }, // search-only, not filtering
    // distinctAttribute: null,
    // typoTolerance: { enabled, minWordSizeForTypos: { oneTypo, twoTypos }, disableOnWords: [], disableOnAttributes: [] }
    // faceting: { maxValuesPerFacet": 100 },
    // pagination": { maxTotalHits": 1000 },
    // proximityPrecision": 'byWord',
    // searchCutoffMs: null
  }
}
