# Vault request scheduling

The launcher owns two FIFO request queues, with five running requests maximum.
Normal work may occupy four slots, reserving capacity for messaging. With both
classes eligible, service three priority requests then one normal request.
Identifiable chunks may occupy two slots; a blocked chunk does not block later
eligible work. This policy changes scheduling only, never permissions or crypto.
Requests explicitly marked as recovery archives are normal-priority work with a
global ceiling of two running jobs. The hint is launcher-owned and cannot be
supplied through the public app NIP-07 surface.

Classify signEvent/doubleSignEvent and NIP44v3 (including Double DH) by existing
kind arguments: 9, 1063, 3560, 26300, 26400 and 34601 are priority. Personal-copy
1006 signatures use inner k tags. Obfuscation of those kinds or 1006 is priority.
Kind 34601 and transport events with an explicit i chunk tag share the chunk cap.
A crypto call without chunk information cannot be classified as a file chunk.
Kinds also used for history/cache receive the same priority; no app-specific
scope prefixes or app scheduling API are introduced.

Local addPersonalCopy preparation inherits the original kind's classification
for encryption, obfuscation and signing, using request-local callbacks. Cached
NostrDB callbacks retain their ordinary account scope, never a request's priority.

Requests settle once. Queue time counts against the original timeout, including
before connection. Connection replacement cancels the previous generation; late
results cannot settle new work. Pending work admitted after a disconnect waits
for the next connection. Existing instant control calls retain their bypass.

Development-only messaging-performance records expose request/parent/event IDs,
queue counts, queue wait, total request time and vault execution time. Event-store
writes correlate quota-lock waiting/execution to their request. The most recent
128 records are kept in memory; records contain fixed stages and timings, not
message/event payloads, crypto buffers, raw scopes or keys. Correlation and timing
reply fields are internal diagnostics, absent in production; public app methods
and NIP07 parameters are unchanged.

NostrDB scheduler wait/start/completion records remain available in that bounded
in-memory snapshot, but their per-transaction console lines are opt-in. Set
`globalThis.__44BILLION_SCHEDULER_TRACE__ = true` in the launcher's top context
before capturing scheduler transitions; ordinary development consoles stay quiet.

For recovery-record writes, development traces also carry the fixed library seed
coordinate (`seedRecordId`). It links a session's main event/publication trace to
the derived personal-copy hash and its internal signer requests. This extraction
is diagnostic-only, validates the coordinate shape and never changes priority.

Personal-copy preparation overlaps encryption and independent mirrors, with four
outstanding fallback primitives per preparation. Signing follows complete
preparation; original mirror/tag order is retained. The launcher sends mirror,
source, author and context obfuscations through one internal
`NIP07_BATCH / obfuscateMany` call, followed by the context-dependent coordinate
call. The vault bounds batches to 64 operations and 256 KiB, deduplicates exact
operations and returns results in input order. Unsupported vaults fall back to
individual calls; timeouts do not fall back. App NIP-07 cannot invoke the batch
code and batch params/results are never written to the activity log.

Request-local callbacks keep inherited priority. The launcher reuses only
context/author obfuscations after existing guards: per-account/
connection-generation/kind/scope/value keys, 64/account, 256/realm, 60-second
idle lifetime. Disconnect and committed account changes clear the cache and
fence late results. No IDs, arbitrary tags, callbacks or key material are cached.
