# NostrDB internals and maintenance

Developer notes for [NostrDB](../src/services/idb/nostrdb/index.js) and its
[shared chunk cache](../src/services/idb/browser/queries/chunk-cache.js).
The [storage model](storage-model.md) inventories persisted stores and keys;
[APP_API.md](../APP_API.md) defines the injected app contract. Keep these notes
aligned with changes to maintenance defaults and transaction boundaries.

## Ownership and storage

Each owner has a `44billion_nostrdb:<ownerPubkey>` database containing `events`,
`deletions`, `kindRegistry`, `maintenance`, `accountCoverage`, and `cacheAccess`
(schema version 4). The owner identifies the database, not necessarily the author
of every event in it. Event records carry local app references (`ap`), receipt
time (`ra`, milliseconds), and a sync anchor (`sa`). Cleanup grace periods use
receipt time rather than the event's authored timestamp where noted below.

Kind 34601 chunk events store metadata in NostrDB and externalize their content
into the shared `44billion_browser` chunk stores. Those are separate databases;
an IndexedDB transaction cannot update both together.

## Selective lookup and ingestion

Tag planning probes `byTag.getAllKeys(range, limit)` without loading event
payloads. It never counts a complete index range. The existing plan is probed
first; a completely observed candidate of at most 64 entries is accepted
immediately. Otherwise, try mandatory AND values, OR `o` mirrors for exclusively
kind-1006 queries, then remaining OR groups in original order. Use the first
small complete candidate, or retain the existing plan if none is found.

Each OR group remains a complete candidate; a mandatory AND value can
independently seed the scan. A short sample is exact only when it contains fewer
keys than requested. A full sample is inconclusive, even if the remaining budget
allowed fewer than 65 keys. Candidate sizes conservatively sum OR intervals;
overlapping values may overestimate size, never authorize missing alternatives.
Every fetched event still passes the entire filter, including author/kind,
other tags, exclusions, expiration and search. Even an empty probe only selects
an access path: the actual query still runs, observing later committed changes.

Planning has an all-or-nothing budget of sixteen distinct index intervals per
filter. Larger candidate sets use the existing plan without partial probes.
Each request returns at most 65 primary keys and the entire planning operation
returns at most 256, across one request at a time. Observations are shared only
within that operation. Early decisions do not start unused probes. These bounds
limit requested work, not waiting time behind other IndexedDB transactions.
Direct ID/coordinate and sync-anchor plans remain unchanged. Planning inside an
existing transaction uses that transaction; otherwise it uses a short readonly
transaction. Failed probes remain errors; only an owned transaction is aborted
by the planner. No vault/network/timer awaits occur within the live transaction.
No new store, index, counter, persistent cache or app-specific rule is involved.

This matters for personal-copy provenance and recovery records. A context or
inner-kind predicate can match thousands of wrappers while a source/record-ID
mirror matches only the relevant copies. Selecting that mirror avoids loading
unrelated ciphertext. AND filters must choose a mandatory value rather than
scanning the union of all their values; OR alternatives cannot be omitted.

For validated personal copies without an outer coordinate and with a non-deletion
inner event, provenance candidates are read once inside the quota write
transaction. Winner selection, loser removal, references and usage commit
together. Coordinate/merge and deletion paths retain their external preparation
and transactional snapshot revalidation, using the same selective planner. No
vault, network or timer work runs in the write transaction.

Ordinary validated public duplicates can finish in a readonly `events` +
`maintenance` transaction before quota admission. This requires an existing ID,
ready usage counters and no app-reference change. Personal copies, chunks,
deletions and operations with merge/deletion side effects are excluded. Misses,
uninitialized counters and changes follow the original write path and recheck
their state there. Access and connection-generation checks fence late results.
An unchanged duplicate does not update usage, timestamps, cache classification,
references or subscriber notifications. Its readonly observation is the operation's
linearization point; a later independent deletion remains authoritative.

Event mutations update exact per-owner counters in their own write transaction.
Global quota review is asynchronous; see the advisory quota contract below.
Development-only bounded diagnostics add `query-planning` (`probes`,
`keysExamined`, candidate `examined`, `earlyDecision`, `budgetExhausted` and time;
`count` remains a probe-count alias),
`query-candidates` (materialized tag entries), `provenance-query` and
`duplicate-read`, correlated through existing bridge request IDs. They contain no
tag values, event contents, keys or ciphertext.

The protected `tests/browser/nostrdb-contention.js` fixture exercises three owner
databases, 15,000 synthetic auxiliary-history rows, 104 repeated profile writes,
two-tab provenance races and readonly duplicates while quota is held. Synthetic
history is a cardinality fixture, not an imported cryptographically validated
history; new writes use real signatures and encryption. Its optional
`--baseline-index=/absolute/path/index.js` and `--output=/absolute/path/results.json`
support comparisons with a saved prior source snapshot. Report sample sizes and
separate foreground timings from profile/background distributions; do not infer
production latency guarantees from this controlled workload.

The [validation record](nostrdb-contention-validation.md) includes the measured
before/after distributions, remaining IndexedDB contention and known test limits.
It describes the original exact-count implementation. The
[bounded-planner correction](nostrdb-bounded-planner-validation.md) documents its
regression on already-selective bursts and the replacement's validation.
`tests/browser/nostrdb-query-planning.js` adds empty/small concurrent queries,
paginated fifty-message history and coverage maintenance in three accounts;
`--planner-source=/absolute/path/query-plan.js` compares a saved planner with the
same workload. Run it sequentially through the protected browser harness.

Account-event coverage checkpoints are grouped by relay and eligible kind in the
`accountCoverage` store. Schema 4 moves legacy rows out of `maintenance` in the
version-change transaction without changing their record format or touching
quota, unclaimed-data or unknown keys. The registry is read first, then all
per-kind reads are submitted within the same readwrite transaction. Missing
records and changed coverage are written from their read success handlers;
unchanged ranges are not rewritten. The coordinator opens this transaction only
through the `maintenance` write scheduler with the `accountCoverage` scope, so it
can overlap event/quota transactions on disjoint stores. Generation validation,
abort handling and the completion barrier keep event commits and checkpoint
commits separately ordered. The account tracker collects completed page rectangles
for 50 ms per coverage database, merges all available relays/kinds, and flushes
one `markBatch` transaction. Scan completion awaits the checkpoint barrier; a
crash before the window flushes can repeat a page but cannot advance coverage
without its events. Cancelled requests are discarded, while a generation or
storage failure aborts the whole batch. The protected
`tests/browser/account-events.js` fixture verifies the pipeline and
single-transaction batching alongside a real personal-copy write.

Personal-copy creation sends the inner JSON as UTF-8 bytes in an `ArrayBuffer`
to the vault's NIP-44 v3 signer. Both internal personal-copy readers decode
the returned buffer directly with `TextDecoder`. App-facing NIP-44 v3 methods,
Double DH and scoped signers use the same binary plaintext contract. Local
nsec accounts encrypt/decrypt bytes directly; only remote bunker requests use
standard Base64 plaintext on the NIP-46 wire. The vault's activity log represents
buffers as Base64 inside encrypted JSON fields. These transport changes do not
change stored ciphertext formats or require migrating existing copies. See
`APP_API.md`.

Local `addPersonalCopy` snapshots and validates the inner event once, then
reuses its prepared mirrors and provenance during initial ingest. After signing,
the launcher checks owner, kind, timestamp, ciphertext and tags, allowing the
expected `imkc` proof completion. A module-private WeakMap binds preparation to
the exact signed object; NostrDB consumes it once after signature verification
and checks an event snapshot. This avoids decrypting the just-created wrapper
and repeating its obfuscation calls. Cloned, changed, retried and externally
received wrappers use ordinary full validation; app options cannot grant this
trust. Normal quotas, provenance resolution, subscriptions and chunk staging
still run. Preparation is memory-only and adds no persisted fields or schema.

Personal-copy mirrors use `NIP07_BATCH / obfuscateMany` between the launcher and
vault. A typical recovery seed therefore performs one mirror batch, one
coordinate obfuscation, one encryption and one signature rather than one vault
request per mirror. Batch inputs are bounded and deduplicated by the vault;
unknown/oversized requests fail before crypto. The internal `recovery` add option
is scheduling metadata only and is removed before NostrDB sees the add options.

## Scheduled routines

`getNostrDb(owner)` caches one instance per owner in the current module context
and starts maintenance by default. `{ maintenance: false }` skips starting it;
it does not stop tasks already running. Deletion-request maintenance starts only
when `maintenanceOptions.signEvent` is supplied.

| Routine | Default schedule | Work and limits per execution |
| --- | --- | --- |
| `maintainNostrDbCache` | Commit requests coalesce at 1 second; volume can expedite; excess pages 1 second apart; otherwise every minute | Initializes missing quota summaries, then removes at most 25 globally oldest cache events, examining at most 100 candidates. |
| `purgeExpired` | Immediately, then every hour | Finds expired events and removes them and their deletion contributions in `maintenance` transactions of at most 100 events, yielding between batches. |
| Unclaimed-data scheduler / `purgeUnclaimedAppData` | Checks after 1 second; pauses 1 second between pages; new sweep 24 hours after the last completion | Each page scans up to 1,000 records and deletes up to 100 unclaimed app-trackable events received at least 30 days ago. Progress and completion time survive reloads. |
| `maintainDeletionRequests` | Immediately, then every hour, with a signer | Runs one compaction, then pruning, for the selected author (the owner by default). Compaction combines compatible kind 5 requests into a signed event with up to 100 target tags, and — when vault encryption and a signer are available — merges owner-authored, non-expiring private deletion envelopes from the same context into a rewritten wrapper; third-party and expiring envelopes are left for pruning/purge. Pruning targets a total of 1,000 requests (public plus envelopes), removing at most 100 per run after a 30-day receipt grace period. |
| Unreferenced-hearsay prune (`pruneUnreferencedHearsays`) | Immediately, then every 10 minutes | Scans personal copies with `v=2`, keeps those referenced by another copy in the same context, and removes at most 100 unreferenced hearsays older than 10 minutes per run. Needs no signer. |
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
- Database opening synchronizes `kindRegistry` through `maintenance` scheduled
  writes. When previously unknown kinds become app-neutral, their app references
  are removed before the new registry is saved. Custom app-data kinds retain
  their app ownership semantics.
- App claims from reads/subscriptions are queued in memory and flushed after
  250 ms, or triggered at 100 queued IDs. The `events`-only transaction is
  scheduled as `background`. Writes preserve `ra` and `sa`; pending claims can
  be lost on page termination.
- Chunk ingestion under quota pressure calls `purgeChunkRoot(..., { force: true })`
  for unreferenced roots, bypassing the 10-minute grace period. Referenced roots
  are excluded by the reference check.

## Concurrency

44billion supports simultaneous app windows within one launcher tab; opening
another browser tab is not necessary for that workflow. Quota reviews, settings and database lifecycle use the existing global Web Lock
`44billion:nostrdb-quota:v1`. Ordinary event admission, deletion and reclassification
never acquire it or enumerate other owner databases. Their local accounting stays
atomic through IndexedDB transactions. Reviews are single-flight per context and
serialize across tabs; other chunk maintenance retains its existing coordination.

`maintenanceStops` prevents duplicate automatic schedulers on one NostrDB
instance. Each scheduler's `running` flag and chained timer prevent that
scheduler from overlapping itself. The global chunk scheduler is also a singleton
only within the current module context. These guards do not serialize direct
method calls, separately created schedulers/instances, or another tab. Global
and per-owner chunk maintenance can overlap even within one tab.

The in-memory write scheduler runs one logical scheduler per owner/database. It
schedules live readwrite transactions only; queries, counts and subscriptions
continue directly through IndexedDB readonly concurrency. Every job declares its
store scope and a launcher-owned class: `foreground`, `normal`, `background` or
`maintenance`. Transactions with disjoint stores may start together; intersecting
stores remain serialized. Higher classes run first, with bounded starvation
protection for lower classes and round-robin app lanes inside each class. `system`
has its own lane. There is deliberately no pending-job cap per app and no
queue-full error.

The app bridge derives class from the authenticated app and normalized event
kind, never from app-provided scheduling fields. Kinds 9, 1063, 3560, 26300,
26400 and 34601 and explicit removals are foreground. Other app writes are
normal. A structurally valid recovery archive carrying the internal `recovery`
claim becomes background; an invalid claim remains normal. Account ingestion is
background. Coverage, quota/cache maintenance, kind-registry repair, expiration,
unclaimed cleanup and other upkeep are maintenance. The scheduler holds no slot
while crypto, signer, network, Web Lock or timer work is pending. Aborts remove
queued work, and every start revalidates access and the cached connection
generation before opening a transaction.

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
| Expiration purge | Candidate discovery happens earlier; up to 100 selected event removals, deletion contributions, cache classification and usage share each quota transaction. |
| Unclaimed-data purge | Checkpoint read, bounded scan, revalidated deletions and checkpoint write share one quota transaction. |
| Deletion compaction | Selection and signing precede the write. The new request, its tombstones and removal of consumed requests share one transaction. Notification follows commit. |
| Deletion pruning / app cleanup | Each deletion batch is atomic; the entire scan and all batches are not. |
| Chunk maintenance | Multiple transactions across two databases, including cache updates triggered after NostrDB commit. No global rollback. |
| Kind-registry synchronization | Event-reference cleanup and saving the registry are separate scheduled maintenance transactions. |

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
| Public outside cache: own and owner-referenced third-party events | 512 MiB | Refuse growth |
| Private: all personal-copy wrappers | 1 GiB | Refuse growth |
| Cache: unreferenced third-party public events | 128 MiB and 50,000 events | Evict by approximate LRU |

The three categories are exclusive, for both bytes and event counts. Cache does
not consume public quota, and removing cache does not free public capacity.
Bytes are exactly UTF-8 `JSON.stringify(stored.event)`, excluding
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

### Admission and asynchronous coordination

Each mutation updates the events, deletion contributions, reference classification
and per-owner usage in one readwrite transaction. Aborts roll back all of them.
There is no delta journal and no new IndexedDB schema. Ordinary mutations only
initialize their own legacy counters; they never sum usage or wait for the global
quota lock. Access and the connection generation are rechecked before mutation.

Admission consults the last known global usage and current configured limits.
Positive net byte growth is refused in blocked categories; cache count growth is
also checked. Zero limits disable new growth immediately. For positive limits,
a category becomes blocked after a review observes usage *above* its limit.
Concurrent admissions can exceed it before that review. Duplicates, removals and
net non-growing replacements remain possible. Transfers of already stored targets
between public and cache happen after direct admission deltas are determined:
they do not block a referrer or removal. Every protected target is retained; no
promotion candidate is discarded to accommodate its referrer.

The shared maintenance sums only small ready `maintenance.quotaUsage` records.
Its snapshot is advisory: different owners may be observed at different moments.
It never publishes a partial sum on failed enumeration, initialization or access.
Failure preserves the previous usable totals/gates. Without usable prior totals,
positive budgets remain available; zero budgets remain disabled. Real transaction
and browser storage failures are still reported. A rejected quota mutation returns
the existing `quota`/`quotaCategory` result and rolls back atomically.

Committed changes request a review after one second without moving an earlier
deadline. At 64 mutations or 4 MiB of absolute byte changes per context, request
an expedited review. Scheduled global starts are at least 250ms apart. Demands
arriving during a run cause a subsequent run. Idle checks happen each minute;
remaining cache excess causes another round after one second. Failures retry with
1–30s exponential backoff; fresh demands do not bypass that backoff. Startup,
focus/visibility, settings and database lifecycle also request review.

Reviews/configuration publish `44billion:nostrdb-quota-state:v1` under the existing
exclusive lock, with increasing revision, last successful check time, totals,
limits, category gates and maintenance status. Persist before notifying readers.
Local callbacks, storage events and BroadcastChannel share state/demand; delayed
notifications cannot replace a newer revision. Resume reloads the persisted state.
Failed persistence does not undo event commits. It preserves the usable state,
reports a development diagnostic and retries. No account/event identities appear
in the global snapshot. Configuration immediately reapplies the known totals to
new limits, then requests fresh aggregation. In-flight writes can finish under
the previous gate. There is no strict bound on excess during delays or failures.
Broadcast notifications are best-effort hints: failures cannot turn a committed
mutation or a valid persisted review into an operation failure. Storage events,
resume reloads and periodic review remain available when that channel is denied.

Only maintenance evicts cache. Each round merges global LRU heads, examines at
most 100 candidates and deletes at most 25, aiming for 90% of byte and count limits.
Deletion revalidates timestamp, existence and protection inside its transaction,
since foreground writes no longer share the global lock. Referenced data cannot
be removed by cache pressure. Public/private excess never deletes retained events.

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
tabs. Each batch uses transactions of at most 25 records, yielding between them.
Reads in a transaction are submitted together; each dependent update starts from
its read success handler, while the transaction completion barrier still waits
for every update.
Touches bypass the origin quota lock: they change neither bytes nor counts. Each
queued touch captures the already-cached connection's in-memory generation; access
and generation are rechecked before its transaction. Closed, replaced, removed or
read-only connections are discarded. This path never opens/recreates a database.
Deletion rechecks eligibility and last access in its own transaction; a changed
timestamp returns to LRU selection under the examination limit.
Only `cacheAccess` is written, without rewriting event/tag indices or
recreating removed/promoted rows. Losing pending touches affects LRU quality,
not event integrity. Synthetic app reads can still influence approximate LRU.

### Initialization, settings and repair

Ready quota counters are confirmed through a readonly `maintenance` transaction,
without a broad write transaction on unrelated event/access stores. Periodic cache
maintenance examines at most 100 candidates and deletes at most 25 per round,
releasing the global lock before scheduling a remaining round (one-second delay
while excess remains, otherwise the existing minute interval). Admission performs no eviction. Development diagnostics distinguish local mutation
duration, review/maintenance work and the separate access transaction wait and
execution. Only background/configuration/lifecycle operations have quota-lock waits.

Existing databases initialize in two resumable passes, at most 1,000 rows per
transaction: fill event sizes/references, then classify cache and build counters.
`quotaUsage.phase` and `after` advance with each page's writes. The event loop is
released between pages; reads remain available, and admission waits for complete
summaries. Initialization does not delete excess public/private data. Cache
maintenance subsequently trims excess in bounded pages. Failure preserves the
last committed checkpoint and totals; a subsequent attempt resumes.

Launcher-only exports `getNostrDbQuotaLimits`, `setNostrDbQuotaLimits` and
`getNostrDbQuotaUsage` serve Settings → Advanced → Event storage (`/event-storage`).
Only three byte overrides persist under `44billion:nostrdb-quotas:v1`. The cache
count ceiling is derived with exact integer arithmetic:
`floor(cacheBytes × 50,000 / 134,217,728)`. Existing overrides automatically use
this proportion; the schema-3 quota record remains unchanged in schema 4. Zero
bytes means zero cache events.
Reducing public/private limits blocks growth only; reducing cache schedules
trimming. Configuration and global usage remain launcher-only.
The screen preserves drafts until Save and subscribes to the root-owned shared
quota state, without per-component polling. It observes changes across tabs without
overwriting dirty fields. It shows the check time, stale/error status, actual
percentage and excess bytes; bars remain capped at 100%. Zero limits display a
disabled category instead of an infinite percentage. Retained-category excess
marks the toolbar, Settings menu entry and Event storage row; cache only demands
attention if cleanup fails or exhausts candidates while excess remains. Opening
the menu does not dismiss the indicator. Its donut shows public outside cache, cache, and private
bytes directly; the center sums all three exclusive categories.
Storage audit preserves the global configuration; repair uses the ordinary app
cleanup and owner removal paths, maintaining usage and deleting all owner-local
auxiliary stores along with the database.

The independent 1,000-request pruning target remains specific to kind 5 for the
selected author. The shared payload cache retains its global 2 GiB unreferenced
payload budget and existing pressure/staging/reconciliation policies; referenced
payloads remain outside that budget. Event quotas do not replace it.

## Explicit local removal

`NostrDb.remove(targets)` is exposed through the app bridge with the same
permission requests as `{ kind: 5, tags: targets }`, without signing that descriptor.
See [the API contract](../APP_API.md#local-event-removal) for validation and scope.
It resolves IDs exactly and addresses to their current version inside a single
non-admission `withQuotaMutation`, calling `deleteStoredEvent` for each distinct
match. Persona access and connection generation are checked again before opening that
transaction. Aborts roll back every deletion and usage/reference/cache transition.

The common deletion path removes existing kind 5 contributions and runs the same
post-commit chunk-copy cleanup and blob reconciliation hooks. No new tombstone,
cascade or subscription notification is produced. Local success confirms the
NostrDB commit, not completion of external payload reconciliation. Buffered reads
are not revoked and removed events can arrive again. This also works above quotas;
reference removals may demote remaining targets to cache and schedule cleanup.

## Read and removal contracts

`query` rejects validation and storage failures; an empty result means a successful
read with no matches. `subscribe` emits event/ID envelopes with query score
metadata. With `initial: true`, the filter limit applies to the snapshot only;
`eose` separates it from buffered/live delivery, and overlap is deduplicated by
ID (plus score for sync). Deduplication state is discarded after the overlap.
See [APP_API.md](../APP_API.md) for shapes and cancellation/authorization details.
`remove` resolves every normalized target before deleting any record and returns
`removed: [{ id, targets }]` only after transaction commit; errors/noops return
an empty report. No storage schema changes are required by these contracts.

## Consumer recovery records

libp2r2p/private-messenger/event-store uses the public eventStore API to store
immutable kind-30078 recovery seeds and grants inside owner personal copies in
context ''. These remain outer kind 1006, count against the private quota, and
use existing sync and expiration rules. No new launcher schema or merge policy
is required. Their root fields deliberately are not r references: authorizations
do not retain chunks. Private kind-5 copies revoke inner coordinates; local
removal only evicts this device's copy. The synchronization transport must keep
its own recovery storage local to prevent recursive synchronization.
