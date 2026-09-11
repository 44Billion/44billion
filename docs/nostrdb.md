# NostrDB internals and maintenance

Developer notes for [NostrDB](../src/services/idb/nostrdb/index.js) and its
[shared chunk cache](../src/services/idb/browser/queries/chunk-cache.js).
The [storage model](storage-model.md) inventories persisted stores and keys;
[APP_API.md](../APP_API.md) defines the injected app contract. Keep these notes
aligned with changes to maintenance defaults and transaction boundaries.

## Ownership and storage

Each owner has a `44billion_nostrdb:<ownerPubkey>` database containing `events`,
`deletions`, `kindRegistry`, `maintenance`, and `cacheAccess` (schema version 3). The owner identifies the database, not necessarily
the author of every event in it. Event records carry local app references (`ap`),
receipt time (`ra`, milliseconds), and a sync anchor (`sa`). Cleanup grace periods
use receipt time rather than the event's authored timestamp where noted below.

Kind 34601 chunk events store metadata in NostrDB and externalize their content
into the shared `44billion_browser` chunk stores. Those are separate databases;
an IndexedDB transaction cannot update both together.

## Scheduled routines

`getNostrDb(owner)` caches one instance per owner in the current module context
and starts maintenance by default. `{ maintenance: false }` skips starting it;
it does not stop tasks already running. Deletion-request maintenance starts only
when `maintenanceOptions.signEvent` is supplied.

| Routine | Default schedule | Work and limits per execution |
| --- | --- | --- |
| `maintainNostrDbCache` | First check after 1 second; excess pages 1 second apart; otherwise every minute | Initializes missing quota summaries, then removes at most 100 globally oldest cache events, examining at most 1,000 candidates. |
| `purgeExpired` | Immediately, then every hour | Finds expired events and removes them and their deletion contributions. No batch cap; selected deletions share one write transaction. |
| Unclaimed-data scheduler / `purgeUnclaimedAppData` | Checks after 1 second; pauses 1 second between pages; new sweep 24 hours after the last completion | Each page scans up to 1,000 records and deletes up to 100 unclaimed app-trackable events received at least 30 days ago. Progress and completion time survive reloads. |
| `maintainDeletionRequests` | Immediately, then every hour, with a signer | Runs one compaction, then pruning, for the selected author (the owner by default). Compaction combines compatible kind 5 requests into a signed event with up to 100 target tags. Pruning targets a total of 1,000 requests, removing at most 100 per run after a 30-day receipt grace period. |
| `maintainChunks` | Immediately, then every minute | Reconciles owner events, shared payload links and reference counts; selects up to 256 global purge candidates and processes those belonging to this owner. Unreferenced roots have a 10-minute grace period; event deletion uses batches of 256. |
| `maintainAllChunkCaches` | Global scheduler: immediately, then every minute | Discovers owners and runs their chunk maintenance sequentially, then reconciles stale payload stages after a 10-minute grace period. The first scheduled run sweeps all payload pages; subsequent runs process one page. |

Timers run only while the page is alive and may be throttled by the browser.
Except for the persisted unclaimed-data completion deadline, intervals are
in-memory delays scheduled after a run finishes.
`startGlobalChunkMaintenance()` is started by the app bridge independently of
the per-owner tasks. `startDeletionCompaction()` also exists as a standalone
scheduler, but automatic startup uses the combined maintenance routine.

Unclaimed cleanup applies to kinds 78/30078 and kinds absent from the app-neutral
registry, when `ap` has no valid app references. It does not filter by author.
Third-party events referenced by the owner are retained. Missing `ra` is treated
as old enough for cleanup.

### Resumable unclaimed-data cleanup

`startUnclaimedAppDataPurge()` checks for work after `pageDelayMs` (1 second by
default), giving initialization a brief head start. A pending sweep resumes at
the primary key strictly after `maintenance.unclaimedAppData.after`. The position
advances even when a page finds no candidates, and remains usable if that event
is deleted. Candidate discovery retains only up to 100 IDs, reading event values
one at a time; the 1,000-record cap bounds scan work per page, not an array of
1,000 retained events. Individual event sizes and browser allocations still
affect actual memory usage.

Each page uses one transaction for reading the checkpoint, scanning, rechecking
and deleting candidates, and saving progress. It releases the transaction and
candidate list before waiting another second. Reaching a page limit may require
one final empty page to detect the end. Completion clears `after` and saves
`completedAt`; the next full sweep is due 24 hours later. A new visit checks this
persisted deadline rather than restarting a 24-hour timer. Insertions before the
current position and records that become eligible after being visited are
reconsidered in the next sweep, which starts at the beginning.

A failed page is retried after 1 minute without advancing the checkpoint. The
stop function cancels future scheduling; an in-flight page can still commit.
Explicit `purgeUnclaimedAppData(options)` calls process one resumable page and
return its deletion count, bypassing the daily cooldown by default. Scheduler
options include `intervalMs`, `pageDelayMs`, and `runImmediately`; setting
`runImmediately: false` deliberately delays the first check by `intervalMs`.

Deletion pruning is a soft target, not an admission limit: recent requests are
protected and excess requests are removed gradually. Candidates with fewer
effective targets are removed first (address targets weigh four times event
targets), then older requests. Removing a request also removes its contributions
to tombstones; targets with no remaining contributors lose that deletion block.
Compaction preserves address cutoffs by grouping compatible timestamps.

## Other maintenance paths

- `deleteEventsByApp(appId)` runs during app cleanup, in batches of 64. It removes
  the app reference, deletes rows with no remaining app references, and retains
  shared rows and third-party rows still referenced by the owner. Retained rows
  lose the uninstalled app association even when no other app remains.
- Database opening synchronizes `kindRegistry`. When previously unknown kinds
  become app-neutral, their app references are removed before the new registry
  is saved. Custom app-data kinds retain their app ownership semantics.
- App claims from reads/subscriptions are queued in memory and flushed after
  250 ms, or triggered at 100 queued IDs. Writes preserve `ra` and `sa`; pending
  claims can be lost on page termination.
- Chunk ingestion under quota pressure calls `purgeChunkRoot(..., { force: true })`
  for unreferenced roots, bypassing the 10-minute grace period. Referenced roots
  are excluded by the reference check.

## Concurrency

44billion supports simultaneous app windows within one launcher tab; opening
another browser tab is not necessary for that workflow. Maintenance has no
leader election covering a complete routine across tabs. Quota mutations use the
global Web Lock `44billion:nostrdb-quota:v1`, including database creation/removal,
event admission, deletion, reclassification and quota settings changes.

`maintenanceStops` prevents duplicate automatic schedulers on one NostrDB
instance. Each scheduler's `running` flag and chained timer prevent that
scheduler from overlapping itself. The global chunk scheduler is also a singleton
only within the current module context. These guards do not serialize direct
method calls, separately created schedulers/instances, or another tab. Global
and per-owner chunk maintenance can overlap even within one tab.

The shared cache uses the Web Lock `44billion:chunk-cache:v1` around selected
cache operations. Without Web Locks, its fallback promise queue is local to the
module context. Neither chunk nor quota locking makes the complete NostrDB/payload workflow atomic.
IndexedDB serializes conflicting write transactions, but reads, signing and
decisions made between transactions can still interleave. The NostrDB
`BroadcastChannel` delivers event notifications; it does not coordinate maintenance.

Unclaimed-data pages read and advance their shared checkpoint inside the same
quota transaction as their deletions. Concurrent page calls therefore serialize
their progress, including across connections; this does not elect a scheduler
leader or make a whole sweep atomic.

Stopping a scheduler cancels its next timer without aborting work already in
flight. Stopping and restarting therefore does not establish an execution barrier.

## Interruption, atomicity and recovery

Atomicity applies to each IndexedDB transaction, not to an entire maintenance
cycle. A transaction commits its changes together or aborts them together. Every event
mutation includes `events`, `deletions`, `cacheAccess` and `maintenance`; references,
LRU membership, tombstones and local usage commit or roll back together. App
association changes alone do not change byte accounting.

| Operation | Transaction boundary |
| --- | --- |
| Expiration purge | Selected event removals, deletion contributions, cache classification and usage in one quota transaction; candidate discovery happens earlier. |
| Unclaimed-data purge | Checkpoint read, bounded scan, revalidated deletions and checkpoint write share one quota transaction. |
| Deletion compaction | Selection and signing precede the write. The new request, its tombstones and removal of consumed requests share one transaction. Notification follows commit. |
| Deletion pruning / app cleanup | Each deletion batch is atomic; the entire scan and all batches are not. |
| Chunk maintenance | Multiple transactions across two databases, including cache updates triggered after NostrDB commit. No global rollback. |
| Kind-registry synchronization | Event-reference cleanup and saving the registry are separate transactions. |

After interruption, completed batches remain and unfinished work may be revisited
on a later run; there is no general durable job queue. Unclaimed-data cleanup and
the global payload-stage sweep persist their page positions with their changes.
An aborted unclaimed-data page rolls back both deletions and progress, so a later
run retries that range. Chunk reconciliation removes
cache links whose events are absent, rebuilds missing links when payloads exist,
recounts references, and deletes chunk events whose payload is missing or invalid.
Stale pending payload stages are cleared after their grace period. This is repair
on subsequent maintenance, not a guarantee that all interrupted data is restored.

Power-loss durability is separate from atomicity. These transactions do not
request `durability: 'strict'`; they use the browser's default. A completion event
therefore does not provide an application-level guarantee that a recent commit
has reached physical storage. See the
[IndexedDB durability specification](https://www.w3.org/TR/IndexedDB/#transaction-durability-hint).

## Global quotas and references

[quotas.js](../src/services/idb/nostrdb/quotas.js) owns three logical budgets shared
by all owner databases, including databases whose account is disconnected:

| Category | Default | On excess |
| --- | --- | --- |
| Public: own and third-party events | 512 MiB | Refuse growth |
| Private: all personal-copy wrappers | 1 GiB | Refuse growth |
| Cache: unreferenced third-party public events | 128 MiB and 50,000 events | Evict by approximate LRU |

Cache also consumes public bytes. Exceeding only the public limit never triggers
cache eviction. Bytes are exactly UTF-8 `JSON.stringify(stored.event)`, excluding
internal metadata, indices and external chunk payloads. The count is a logical
budget, not IndexedDB disk usage. Kind 34601 is counted without its externalized
`content`. Every personal-copy context/inner author shares the private budget;
there is no per-context quota. Its encrypted contents grant no public protection.

`eventBytes` caches this size. `ownerRefs` and its multiEntry `byOwnerRef` index
contain normalized references extracted only from the owner's outer tags, when
the tag name has one character and `tag[1]` is a valid ID or coordinate. IDs use
`e:<base64url ID>`; coordinates use `a:<kind>:<base64url pubkey>:<d hash or empty>`,
matching existing coordinate keys. Hex case is normalized, empty `d` and colons
inside `d` work, duplicate references collapse. References may precede the target.
They protect only targets in that owner's DB; third-party references do not
propagate protection. Any still-stored owner referrer contributes, including an
expired referrer until it is physically removed. New input and signed/merged
outputs require valid cryptographic signatures; old records are not reverified.

Promotion removes the target's `cacheAccess` row. Losing the last reference
recreates it with the transition time. This does not prevent expiration, explicit
deletion or coordinate replacement by a newer version. Uninstall and unclaimed
cleanup retain protected third-party events. Unreferenced cache remains eligible
for other cleanup routines. Removing references may increase cache usage without
allocating storage; removal commits and background maintenance trims the excess.

### Admission and coordination

Under the global quota lock, enumerate all NostrDBs and sum their small persisted
`maintenance.quotaUsage` records. There is no separately persisted global total.
Signing/preparation precedes the lock. Transactions await only IndexedDB requests;
chunk staging, compensation and reconciliation remain outside them and retain
their existing separate lock. Unavailable enumeration/coordination refuses
admission as `unavailable`, without assuming zero usage.

Admission checks the net change after replacements, consumed deletion requests,
provenance reconciliation and reference changes. Duplicates without growth,
deletions, and replacements that do not increase an already-exceeded category
remain allowed. A quota failure aborts the whole attempted mutation and reports
`quotaCategory`, without revealing another account's events or identity.

When cache admission exceeds a ceiling, merge the oldest index candidate from
each DB, ordered by `lastAccessAt`, DB name and ID. Read candidates incrementally,
revalidate existence/protection on deletion, exclude versions needed by the
pending replacement, delete in transactions of at most 100, and examine at most
1,000 candidates per admission. Aim for 90% of both cache limits, but admit if the
hard limits fit even when that margin cannot be reached. Already committed cache
evictions survive a later admission failure; a rejected replacement itself never
partially commits. Public/private limits never authorize deleting preserved data.

### Approximate LRU

`cacheAccess` stores `{ i, lastAccessAt }` only for cache events and has the compound
`byLastAccess` index `[lastAccessAt, i]`. Full app queries and events actually
returned by app subscription iterators queue touches. ID-only results, counts,
internal reads, maintenance, export, sync and duplicate insertion do not.
The app bridge defers touches until authorization succeeds and it sends the
reply; cancelled or denied deliveries do not count. Initial subscription replay
touches only delivered events, not the whole snapshot.

The execution-context queue deduplicates IDs and retains at most 2,048 pending
touches, dropping the oldest when full. Flush after 250 ms in batches of 100;
check the stored timestamp to persist at most once per event per minute across
tabs. Only `cacheAccess` is written, without rewriting event/tag indices or
recreating removed/promoted rows. Losing pending touches affects LRU quality,
not event integrity. Synthetic app reads can still influence approximate LRU.

### Initialization, settings and repair

Existing databases initialize in two resumable passes, at most 1,000 rows per
transaction: fill event sizes/references, then classify cache and build counters.
`quotaUsage.phase` and `after` advance with each page's writes. The event loop is
released between pages; reads remain available, and admission waits for complete
summaries. Initialization does not delete excess public/private data. Cache
maintenance subsequently trims excess in bounded pages. Failure preserves the
last committed checkpoint and totals; a subsequent attempt resumes.

Launcher-only exports `getNostrDbQuotaLimits`, `setNostrDbQuotaLimits` and
`getNostrDbQuotaUsage` prepare a future settings UI. Byte overrides persist under
`44billion:nostrdb-quotas:v1`; the 50,000 count ceiling is separate and fixed.
Reducing public/private limits blocks growth only; reducing cache schedules
trimming. No injected quota configuration/usage API or settings screen is added.
Storage audit preserves the global configuration; repair uses the ordinary app
cleanup and owner removal paths, maintaining usage and deleting all owner-local
auxiliary stores along with the database.

The independent 1,000-request pruning target remains specific to kind 5 for the
selected author. The shared payload cache retains its global 2 GiB unreferenced
payload budget and existing pressure/staging/reconciliation policies; referenced
payloads remain outside that budget. Event quotas do not replace it.
