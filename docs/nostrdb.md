# NostrDB internals and maintenance

Developer notes for [NostrDB](../src/services/idb/nostrdb/index.js) and its
[shared chunk cache](../src/services/idb/browser/queries/chunk-cache.js).
The [storage model](storage-model.md) inventories persisted stores and keys;
[APP_API.md](../APP_API.md) defines the injected app contract. Keep these notes
aligned with changes to maintenance defaults and transaction boundaries.

## Ownership and storage

Each owner has a `44billion_nostrdb:<ownerPubkey>` database containing `events`,
`deletions`, `kindRegistry`, and `maintenance` (added in schema version 2 without
rewriting existing stores). The owner identifies the database, not necessarily
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
Missing `ra` is treated as old enough for cleanup.

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
  shared rows. This does not depend on the event author.
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
leader election or exclusive lock covering a complete routine across tabs.

`maintenanceStops` prevents duplicate automatic schedulers on one NostrDB
instance. Each scheduler's `running` flag and chained timer prevent that
scheduler from overlapping itself. The global chunk scheduler is also a singleton
only within the current module context. These guards do not serialize direct
method calls, separately created schedulers/instances, or another tab. Global
and per-owner chunk maintenance can overlap even within one tab.

The shared cache uses the Web Lock `44billion:chunk-cache:v1` around selected
cache operations. Without Web Locks, its fallback promise queue is local to the
module context. Neither mechanism locks the complete NostrDB/cache workflow.
IndexedDB serializes conflicting write transactions, but reads, signing and
decisions made between transactions can still interleave. The NostrDB
`BroadcastChannel` delivers event notifications; it does not coordinate maintenance.

Unclaimed-data pages read and advance their shared checkpoint inside the same
write transaction as their deletions. Concurrent page calls therefore serialize
their progress, including across connections; this does not elect a scheduler
leader or make a whole sweep atomic.

Stopping a scheduler cancels its next timer without aborting work already in
flight. Stopping and restarting therefore does not establish an execution barrier.

## Interruption, atomicity and recovery

Atomicity applies to each IndexedDB transaction, not to an entire maintenance
cycle. A transaction commits its changes together or aborts them together.

| Operation | Transaction boundary |
| --- | --- |
| Expiration purge | Selected event removals and deletion contributions in one `events`/`deletions` transaction; candidate discovery happens earlier. |
| Unclaimed-data purge | Checkpoint read, bounded scan, revalidated deletions and checkpoint write share one `events`/`deletions`/`maintenance` transaction. |
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

## Growth limits

There is no general event-count cap, mandatory TTL or oldest-first eviction
policy for events whose `pubkey` differs from the database owner. Deduplication,
coordinate replacement, explicit expiration/deletion and applicable app cleanup
reduce some data, but ordinary third-party events can accumulate up to browser
storage limits.

The 1,000-request pruning target applies only to kind 5 for the selected author;
automatic maintenance selects the owner. The shared chunk cache's 2 GiB quota
applies to unreferenced payload bytes globally, not to event counts or all stored
bytes. Referenced payloads are outside that budget. Batch and query limits also
do not bound the total number of stored events.
