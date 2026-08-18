// Single source of truth for the launcher's persisted state.
//
// Every key/template listed here must also be explained in docs/storage-model.md.
// Before introducing a new persisted field, add its definition here and update
// the storage audit + documentation in the same change.

export const STORAGE_AREA = {
  LOCAL: 'local',
  SESSION: 'session'
}

export const GLOBAL_LOCAL_KEYS = [
  'storage_version',
  'config_locale',
  'config_isSingleWindow',
  'config_appUpdateMode',
  'config_vaultUrl',
  'session_defaultUserPk',
  'session_accountUserPks',
  'session_workspaceKeys',
  'session_openWorkspaceKeys',
  'session_unread_appUpdateCount',
  'session_subdomainNextId',
  'session_subdomainFreeIds',
  '44billion:vault-accepted-message-queue:v1',
  '44billion:app-asset-budget:v1',
  'local_embeddedOnlyRetentionAdmissions',
  'local_pendingStorageRepairPlan',
  'local_storageRepairInProgress',
  'local_storageRepairAttempts'
]

export const GLOBAL_SESSION_KEYS = [
  'session_singleNappOpenAppCounts',
  '_subdomain_nav_userPk'
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

export const APP_METADATA_SUFFIXES = [
  '_name',
  '_description',
  '_icon',
  '_relayHints'
]

export const ACCOUNT_SUFFIXES = [
  '_isReadOnly',
  '_isLocked',
  '_profile',
  '_relays'
]

export const DYNAMIC_LOCAL_PREFIXES = [
  'session_workspaceByKey_',
  'session_appByKey_',
  'session_appById_',
  'session_accountByUserPk_',
  'session_subdomainByUserAndApp_',
  'session_subdomainToApp_'
]

export const DYNAMIC_SESSION_PREFIXES = [
  'session_workspaceByKey_',
  'session_appByKey_'
]
