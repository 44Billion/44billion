# Persistent state model

This document and `src/constants/storage-schema.js` are the source of truth for
the launcher's persisted state. Any new key/template or IndexedDB store must be
added to both files in the same change. The storage audit uses the same key
templates to classify and remove orphaned data.

Values written through `useWebStorage`/`setWebStorageItem` are JSON-encoded.

`appId` is global and shared across users and workspaces; `appKey` identifies
one app instance. App metadata/caches keyed by `appId` are therefore global,
while `session_appByKey_<appKey>_*` stores only per-instance state. Keys used
by the in-memory app-bridge registry (for example `single-napp:...`) are
ephemeral and intentionally not persisted; they do not belong here or in
`storage-schema.js`.

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
- App metadata/caches are global by `appId`; they remain valid while any
  workspace/account has the app or a subdomain mapping exists.

### Derived-list normalization

`session_workspaceByKey_<wsKey>_openAppKeys` is the ordered window list:
`workspaceWindow` renders one `<app-window>` per key, so a stale key (instance
removed/uninstalled but still listed), a duplicate, or a key whose
`visibility` is not `open` would render broken, duplicated, or unwanted
windows after a reload. Keeping the list consistent is a correctness repair,
not a space optimization (`sessionStorage` entries are tiny).

Three core lists receive the same treatment:

- `session_workspaceKeys` — deduped (duplicates would render duplicated
  workspace windows).
- `session_accountUserPks` — deduped (duplicates would double-count/clean up
  accounts).
- `session_openWorkspaceKeys` — deduped and filtered to a subset of
  `session_workspaceKeys` (a stale first key would leave the active
  workspace/user undefined).

All four lists are normalized on every load before components render
(`normalizePersistedListsInStorage`, invoked from the storage-audit bootstrap
in the root window only): `openAppKeys` drops instance keys that are not
referenced or not `open`, and the core lists are deduped/filtered, then logs
`[storage-audit] Normalized openAppKeys for workspace <ws>: N -> M ...`
(`session_workspaceKeys`, `session_accountUserPks` and
`session_openWorkspaceKeys` have their own `Normalized ...` log lines)
whenever something changes. Missing keys are left untouched — writing `[]`
for an absent key would be a no-op mutation — and invalid JSON/array values
are intentionally left for the audit, which reports them as `invalid_array`
issues and repairs them through the normal reload plan.

The post-render audit no longer schedules silent writes for these lists; it
only logs `... would change: ...` as a clue. If any of these logs appears on
every load, something is continuously corrupting the state and should be
investigated.

### Embedded single-napp retention

`singleNappOpenedAtByOwner` is **not** a `localStorage`/`sessionStorage` key.
It lives inside each app's site-manifest metadata in IndexedDB
(`44billion_browser` / `siteManifests`, record field `s`) as a map of
`ownerPubkey` → last-opened timestamp (`manifest.meta.singleNappOpenedAtByOwner`).

It is recorded by `AppUpdater.recordEmbeddedOnlyRetention` when the
`<single-napp />` zone renders an app for a real account. While at least one
owner is within the 30-day retention window
(`SINGLE_NAPP_RETENTION_MS`), uninstalling the app deliberately preserves its
`session_appById_*` metadata and cached assets so embedded links keep working.

The expiry is handled by the normal cleanup job
(`AppUpdater.initCleanupJob()` → `app-cleanup-job`): it removes stale owners,
and when no installed owner and no recent owner remain, it removes cached
files, `session_appById_*` metadata and subdomain mappings. The audit must not
flag metadata of apps that still own a site manifest — do not reintroduce
`orphan_app_metadata_key` for appIds covered by the cleanup job. The
storage-audit bootstrap computes the manifest-owned set with
`AppUpdater.getSiteManifestAppIds` and passes it to `auditPersistedState` as
`manifestAppIds`; the orphan rule only applies when the manifest is already
gone (i.e. the normal cleanup can no longer act on the app). Apps whose
retention window simply expired are left to the cleanup job, which removes
their metadata/assets on its next run without forcing a reload.

Timestamps in the future (`openedAt > now`, e.g. from a skewed clock) are
treated as stale during partitioning and are logged with a
`[app-updater]`/`[single-napp-retention]` warning, so corrupted data can never
cause permanent retention.

The two-phase audit removes only confirmed inconsistent/orphaned entries,
reusing existing app/account cleanup routines. Unknown keys are preserved.
