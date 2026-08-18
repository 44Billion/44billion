# Persistent state model

This document and `src/constants/storage-schema.js` are the source of truth for
the launcher's persisted state. Any new key/template or IndexedDB store must be
added to both files in the same change. The storage audit uses the same key
templates to classify and remove orphaned data.

Values written through `useWebStorage`/`setWebStorageItem` are JSON-encoded.

## localStorage

### Global

- `storage_version` — schema migration marker (`"2"`).
- `config_locale` — selected UI locale.
- `config_isSingleWindow` — boolean; false means multi-window.
- `config_appUpdateMode` — `always`, `wifi`, or `manual`.
- `config_vaultUrl` — configured vault URL.
- `session_defaultUserPk` — base62 pubkey of the default user, or absent.
- `session_accountUserPks` — ordered base62 pubkeys of connected accounts.
- `session_workspaceKeys` — ordered workspace keys.
- `session_openWorkspaceKeys` — ordered active workspace keys; must be a subset of workspace keys.
- `session_unread_appUpdateCount` — optional badge count.
- `session_subdomainNextId` — next numeric subdomain id.
- `session_subdomainFreeIds` — released numeric ids.
- `44billion:vault-accepted-message-queue:v1` — pending vault messages.
- `44billion:app-asset-budget:v1` — per-app cached byte budgets.
- `local_embeddedOnlyRetentionAdmissions` — embedded-only retention admissions.
- `local_pendingStorageRepairPlan` — durable repair plan, retained until applied.
- `local_storageRepairInProgress` — crash-safe repair marker.
- `local_storageRepairAttempts` — repair retry counter.

### Per workspace (`<wsKey>`)

- `session_workspaceByKey_<wsKey>_userPk`
- `session_workspaceByKey_<wsKey>_pinnedAppIds`
- `session_workspaceByKey_<wsKey>_unpinnedAppIds`
- `session_workspaceByKey_<wsKey>_unpinnedCoreAppIdsObj`
- `session_workspaceByKey_<wsKey>_appById_<appId>_appKeys`

### Per app instance (`<appKey>`)

- `session_appByKey_<appKey>_id`
- `session_appByKey_<appKey>_route`

### Per app metadata (`<appId>`)

- `session_appById_<appId>_name`
- `session_appById_<appId>_description`
- `session_appById_<appId>_icon`
- `session_appById_<appId>_relayHints`

### Per account (`<userPk>`)

- `session_accountByUserPk_<userPk>_isReadOnly`
- `session_accountByUserPk_<userPk>_isLocked`
- `session_accountByUserPk_<userPk>_profile`
- `session_accountByUserPk_<userPk>_relays`

### Subdomain mappings

- `session_subdomainByUserAndApp_<userPk>_<appId>`
- `session_subdomainToApp_<subdomain>`

## sessionStorage

- `session_workspaceByKey_<wsKey>_openAppKeys` — ordered open window keys.
- `session_appByKey_<appKey>_visibility` — `open`, `minimized`, or `closed`.
- `session_singleNappOpenAppCounts` — embedded app open counters.
- `_subdomain_nav_userPk` — ephemeral subdomain redirect target.

## IndexedDB

### `44billion_browser`

- `fileChunks` — app file chunks keyed by `[appId, fx, pos]`.
- `siteManifests` — site manifest events keyed by `[c, p, d]`.
- `permissions` — app permissions keyed by `[appId, name, eKind]`.
- `chunkPayloads` — deduplicated chunk payloads.
- `chunkCopies` — owner/root/index copies.
- `chunkPayloadRoots` — owner/root/content-hash associations.
- `chunkRoots` — owner chunk roots and purge metadata.
- `chunkState` — chunk-cache reconciliation state.

### `44billion_nostrdb:<ownerPubkey>`

- `events` — Nostr events with app/owner references.
- `deletions` — deletion tombstones.
- `kindRegistry` — app-neutral kinds.

## Cleanup invariants

- A workspace is valid only when it has a string `userPk` that exists in
  `session_accountUserPks` (or is the default user).
- `pinnedAppIds` and `unpinnedAppIds` are disjoint.
- Every listed app has at least one valid instance; instance records are
  referentially complete and `visibility` is one of the three allowed values.
- `openAppKeys` only contains open instances.
- Subdomain maps are bidirectional.

The two-phase audit removes only confirmed inconsistent/orphaned entries,
reusing existing app/account cleanup routines. Unknown keys are preserved.
