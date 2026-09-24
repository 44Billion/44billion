export const NOSTRDB_CAPABILITIES = Object.freeze([
  'search',
  'search:sort:asc',
  'search:sort:desc',
  // Note: it could instead be an `algo: "sync"` filter field
  // but we decided to use search extensions for any custom
  // behavior we come up with
  'search:algo:sync',
  'search:autocomplete:true',
  'ids_only',
  '!ids',
  '&tags',
  'multi_filters',
  'subscribe:scheduled',
  'subscribe:initial',
  'app_export',
  'remove'
])
