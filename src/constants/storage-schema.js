// Workspace app/instance templates also hold builtin-napplet-store; no separate store or origin.
// Single source of truth for the launcher's persisted state.
//
// Every key/template listed here must also be explained in docs/storage-model.md.
// Before introducing a new persisted field, add its definition here and update
// the storage audit + documentation in the same change.
//
// appId is global and shared across users/workspaces; appKey identifies one
// app instance. App metadata/caches are keyed by appId; per-instance keys are
// id/route/visibility only. In-memory app-bridge registry keys are not
// persisted and must not be listed here.

export const STORAGE_AREA = {
  LOCAL: 'local',
  SESSION: 'session'
}

// Host-owned NIP-5D installations, schema 1; signed event + verified blob bytes.
export const NAPPLET_DATABASE = '44billion_napplets'
export const NAPPLET_INSTALLATIONS_STORE = 'installations'
// JSON string map per encoded workspace user and publisher-safe napplet app ID.
export const NAPPLET_STATE_PREFIX = 'local_nappletState_'
// Reserved string-map entry inside the existing per-account/app napplet record.
// JSON settings object, maximum 32 KiB; no standalone WebStorage key.
export const NAPPLET_CONFIG_STATE_KEY = 'launcher:config'
export const NAPPLET_INTENT_DEFAULTS_KEY = 'local_nappletIntentDefaults'

export const GLOBAL_LOCAL_KEYS = [
  'storage_version',
  NAPPLET_INTENT_DEFAULTS_KEY, // User -> archetype -> verified catalog ID.
  'local_devApps', // Development-only app classification and retained file versions.
  'config_locale',
  'config_isSingleWindow',
  'config_appUpdateMode',
  'config_vaultUrl',
  'config_stickySessions',
  'config_relayPoolEnabled',
  'session_defaultUserPk',
  'session_accountUserPks',
  'session_workspaceKeys',
  'session_openWorkspaceKeys',
  'session_unread_appUpdateCount',
  'session_subdomainNextId',
  'session_subdomainFreeIds',
  'local_subdomainLifecycle', // { version: 1, pending: string[], assignments: { [id]: token } }
  '44billion:vault-accepted-message-queue:v1',
  '44billion:app-asset-budget:v1',
  '44billion:nostrdb-quotas:v1',
  '44billion:nostrdb-quota-state:v1', // Last successful aggregate and per-category growth gates.
  'local_embeddedOnlyRetentionAdmissions',
  'local_pendingStorageRepairPlan',
  'local_nostrDbPendingDeletions', // Owner -> deletion token; blocks reopening until cleanup commits.
  'local_storageRepairInProgress',
  'local_storageRepairAttempts',
  // Development-only marker for the launcher's full environment reset.
  'local_devFullReset',
  'local_stickySessionSnapshots',
  'local_stickySessionClaims',
  'local_stickySessionSeenIds',
  'local_stickySessionDeletions',
  'local_widgets', // Records include optional isPinned (legacy default: false).
  'local_personas',
  // Persona membership must include the workspace user; enforced by model/audit.
  'local_appPersonaSelections'
]

export const GLOBAL_SESSION_KEYS = [
  'session_singleNappOpenAppCounts',
  '_subdomain_nav_userPk',
  'session_tabWorkspaceKeys',
  'session_stickyTabId'
]

export const WORKSPACE_LOCAL_SUFFIXES = [
  '_userPk',
  '_pinnedAppIds',
  '_unpinnedAppIds',
  '_unpinnedCoreAppIdsObj'
]

export const WORKSPACE_SESSION_SUFFIXES = [
  '_openAppKeys'
]

export const APP_BY_ID_LOCAL_SUFFIX = '_appKeys'

export const APP_INSTANCE_LOCAL_SUFFIXES = [
  '_id',
  '_route'
]

export const APP_INSTANCE_SESSION_SUFFIXES = [
  '_visibility'
]

export const WIDGET_SESSION_SUFFIXES = [
  '_route',
  '_visibility'
]

export const APP_METADATA_SUFFIXES = [
  '_name',
  '_description',
  '_icon',
  '_relayHints'
]

// 44billion_browser.chunkState record written only after a Blossom root has
// passed full-body SHA-256 validation.
export const BLOSSOM_FILE_VALIDATION_PREFIX = 'blossomFileValidation:'

export const ACCOUNT_SUFFIXES = [
  '_isReadOnly',
  '_isLocked',
  '_profile',
  '_relays',
  '_supportsContentKeyMethods'
]

export const DYNAMIC_LOCAL_PREFIXES = [
  NAPPLET_STATE_PREFIX,
  'session_workspaceByKey_',
  'session_appByKey_',
  'session_appById_',
  'session_accountByUserPk_',
  'session_subdomainByUserAndApp_',
  'session_subdomainToApp_'
]

export const DYNAMIC_SESSION_PREFIXES = [
  'session_workspaceByKey_',
  'session_appByKey_',
  'session_widgetByKey_'
]

// Persisted within each app origin, not the launcher's storage areas.
export const APP_ORIGIN_SESSION_KEYS = ['44billion:subdomain-assignment']

// Owned/maintained by libp2r2p inside app and vault origins, never WebStorage
// repair candidates in the launcher origin. See docs/storage-model.md.
export const PRIVATE_MESSENGER_PENDING_DECRYPTION_DATABASE = 'libp2r2p:private-messenger:<pubkey>:pending-decryption:idb-queue'
export const PRIVATE_MESSENGER_PENDING_DECRYPTION_STORES = ['items', 'state']

// Per-owner 44billion_nostrdb:<ownerPubkey>, schema version 4.
// The checkpoint is committed with the corresponding events/deletions batch.
export const NOSTRDB_MAINTENANCE_STORE = 'maintenance'
// { key, after: event ID index key | null, completedAt: milliseconds | null }
export const NOSTRDB_UNCLAIMED_APP_DATA_KEY = 'unclaimedAppData'

// NostrDB v3 accounting/LRU; schema 4 moves quotaUsage to its dedicated store.
export const NOSTRDB_CACHE_ACCESS_STORE = 'cacheAccess'
export const NOSTRDB_QUOTA_STORE = 'quota'
export const NOSTRDB_QUOTA_USAGE_KEY = 'quotaUsage'
export const NOSTRDB_QUOTA_SETTINGS_KEY = '44billion:nostrdb-quotas:v1'
export const NOSTRDB_QUOTA_STATE_KEY = '44billion:nostrdb-quota-state:v1'

// Per-owner NostrDB maintenance records; no injected eventStore API.
// Registry: { key, version: 1, generation, kinds }; coverage records:
// { key, version: 1, generation, relay, kind, intervals: [[since, until]] }.
export const NOSTRDB_ACCOUNT_COVERAGE_PREFIX = 'accountEventCoverage:'
export const NOSTRDB_ACCOUNT_COVERAGE_REGISTRY = 'accountEventCoverage:registry'
export const NOSTRDB_ACCOUNT_COVERAGE_STORE = 'accountCoverage'

export const NOSTRDB_PENDING_DELETIONS_KEY = 'local_nostrDbPendingDeletions'
