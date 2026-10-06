# Unified relay pool

The launcher can multiplex Nostr relay WebSockets for itself and for every app
it embeds. Browsers throttle WebSocket connections per host (and some also
globally), and relays add their own per-IP/per-connection limits; sharing one
physical socket per relay removes most of that pressure without any app-facing
API.

## Constraints

- One pool per launcher tab. `SharedWorker` is intentionally out of scope.
- No `window.napp.relayPool`: the only surface is a transparent
  `window.WebSocket` shim installed before app scripts run.
- Only Nostr relay traffic is pooled. A socket that does not prove itself
  Nostr stays a plain 1:1 connection.
- The vault (ez-vault) uses the same pool through a delegated bridge: the
  launcher owns its virtual sockets and the vault only pipes frames. Bunker
  (NIP-46) traffic is pooled too.

## Relay identification

`RelayRegistry` keeps the known relay URLs for the session. Sources:

- libp2r2p `seedRelays`, `freeRelays` and `nappRelays`;
- the user's NIP-65 relay lists already ingested into NostrDB;
- URLs classified by a previous connection;
- a positive NIP-11 probe (`Accept: application/nostr+json`, 3s, CORS,
  positive-only cache).

The launcher broadcasts the registry to app pages through `BROWSER_READY` and
`RELAY_REGISTRY`, so a relay learned by one app is pooled for every later
connection.

For an unknown URL the shim opens a speculative 1:1 socket, fires `open` as
the browser would, and holds frames in both directions until the first frame
decides:

- a strict NIP-01/42/45/77 frame (`REQ`, `EVENT`, `CLOSE`, `COUNT`, `AUTH`,
  `NEG-*` client side; `EVENT`, `EOSE`, `CLOSED`, `OK`, `NOTICE`, `AUTH`,
  `COUNT`, `NEG-*` server side) adopts the same virtual socket into a pool
  bucket before any held frame is released;
- anything else (binary, other protocols, malformed/unknown ops) flushes the
  held frames to the speculative socket and stays 1:1 for the life of that
  virtual socket.

Non-empty `optionalProtocol` bypasses pooling entirely; the shim only keeps the
`ws://` -> `wss://` upgrade on HTTPS pages.

## Buckets, limits and routing

A bucket is one physical socket keyed by `(normalized relay URL, identity)`.
Identity is `null` until a client sends `AUTH`; anonymous clients share the
anonymous bucket. Defaults live in `src/services/relay-pool/constants.js`:

- 24 subscriptions per bucket (the relay allows 30 per connection);
- 4 buckets per relay per tab, with spill and a **per-host** connection
  limiter that respects the relay's 3 new connections/second and 10 per 5
  seconds without making unrelated relays wait for each other;
- a 60-message token bucket per relay host, refilling 30 messages/second and
  shared by physical sockets (round-robin within each socket);
- 256 queued frames / 1 MiB per virtual socket, then only that socket is
  closed with 1013;
- open buckets with no members close after 30 seconds; queued/connecting
  buckets are destroyed immediately when their last member leaves.

Subscription ids are namespaced per virtual socket before going to the relay
and rewritten back before delivery. A `REQ` that reuses a raw subscription id
replaces the existing subscription on the same namespaced id, matching NIP-01
instead of leaking a second relay-side subscription. `EVENT`, `EOSE`,
`CLOSED`, `COUNT` and
`NEG-*` route by namespaced id; `OK` routes by event id to the publishers;
`NOTICE` is broadcast in the bucket; `AUTH` is stored and broadcast, and a
newcomer receives the stored challenge so it can sign on demand.

## AUTH: confirmation, merge and reconnect

A relay `AUTH` challenge never triggers a migration: most relays send it
proactively and most clients ignore it. The client's `AUTH` response is the
trigger.

Every client AUTH is validated locally before the pool routes it: signature
and id via `isValidEvent`, kind 22242, `created_at` window, `relay` tag
matching the relay URL and `challenge` tag matching the current bucket
challenge. Invalid AUTHs are answered with a synthetic
`["OK", id, false, "invalid: ..."]` and are never forwarded.

Valid AUTHs follow these rules:

- already on the bucket for that pubkey: forward the AUTH; identity stays
  pending until the relay answers `OK true` (`OK false` reverts the bucket to
  anonymous);
- a confirmed bucket for that pubkey can receive the socket (room and no
  connection-bound state): discard the AUTH, move the socket there, replay its
  subscriptions/counts/pending publishes and answer a synthetic
  `["OK", id, true, ...]`; the relay sees no second AUTH because the
  connection is already authenticated as that pubkey;
- on an anonymous bucket: migrate other members off if it is shared, then let
  this connection authenticate in place. A second authenticated bucket for
  the same pubkey is allowed and stays a future unification candidate; a full
  or connection-bound confirmed bucket no longer forces a reconnect loop;
- on an authenticated bucket for a different pubkey: never switch that
  connection's identity (the relay would drop the previous identity and its
  subscriptions). Present a reconnect (`close 1006`); the next AUTH runs from
  a fresh anonymous bucket.

If the relay never answers a forwarded AUTH within `authPendingTimeoutMs`
(30s), the pool synthesizes `["OK", id, false, "error: AUTH timeout"]` to
the client and marks the bucket `unverified`. The bucket keeps serving its
current members, but is excluded from anonymous placement, AUTH merges and
consolidation targets until it closes, because it is unknown whether the
relay actually authenticated the connection. Once an unverified bucket is
empty it is reclaimed (`destroyed`) before a new anonymous member is refused,
so a single AUTH timeout cannot permanently consume the per-relay bucket
budget.

A `REQ` that cannot fit its bucket first runs anonymous/authenticated
consolidation and looks for a spill bucket again. Only when no anonymous
bucket can accept it does the pool close that virtual socket with 1013
`relay pool capacity`, logging the bucket count, how many are full,
unverified or authenticating, and the total subscription count for the host.

The pool always prefers merging on the next AUTH and exposes `authMerges`,
`authSwaps` and `authReconnects` in the snapshot. Multiple authenticated
buckets for the same `(relay, pubkey)` are consolidated proactively:
whenever a subscription slot frees (`CLOSE`/`CLOSED`), a NEG session closes,
a member leaves an authenticated bucket, or a new identity is confirmed, the
pool moves merge-safe members from smaller buckets into the largest open
bucket with room (`consolidations` counter). Members with an exchanged NEG
session are skipped until the session closes (see below);
pending publishes/COUNTs move with the normal replay/dedupe. Emptied
buckets still close after the usual 30s idle.

Anonymous buckets are consolidated the same way with two extra guards:
buckets with a pending AUTH are never targets, and new anonymous members are
not placed in them while the AUTH is in flight (a member waiting for its own
AUTH OK is never moved). The anonymous pass first tries all-or-nothing —
moving every member of a smaller bucket into a larger open bucket — and only
falls back to a throttled partial move (5s per relay) when no source can be
emptied at once. It runs before pending members are retried, so the freed
capacity serves sockets that were waiting for a bucket.

During a merge the pool replays each subscription's last `REQ`, pending
`EVENT` publishes (relays deduplicate by event id), pending `COUNT`s and
delivers the destination bucket's stored challenge, deduplicating recently
delivered event ids per subscription (LRU, 256 entries / 5 minutes). Each
client `REQ`, including reuse of its ID, starts a new cache. Internal migrations
preserve the existing subscription cache; `CLOSE`/`CLOSED` release it. Overlapping
queries therefore receive their own events, including recovery retries. `OK` replies route only to
currently pending publishers; removing that pending set suppresses unsolicited
repeats. Never cache acknowledged event IDs across publication attempts: a new
`EVENT` with the same ID needs a new `OK`, including after an `auth-required`
rejection and authentication. Otherwise a healthy relay's acceptance is silently
lost and the caller times out.

NEG sessions are pinned to their physical connection only while they are
really in progress. Per NIP-77 a session ends on `NEG-CLOSE` from the
client, on `NEG-ERR` from the relay (after which the subscription is
considered closed), or when a new `NEG-OPEN` reuses the subscription id
(the previous session is closed first). The pool implements all three and
also closes inactive sessions after `negSessionIdleMs` (60s) with a
synthetic `["NEG-ERR", id, "closed: ..."]`; a `negTombstoneMs` tombstone
answers a late `NEG-MSG` for that id with another `NEG-ERR` instead of
dropping it. Once the session is closed the member becomes merge-safe for
consolidation.

## Failure handling

Invalid framing from a pooled upstream, repeated abnormal closes or a failed
migration quarantine that relay for the session. Existing virtual sockets are
detached to a direct connection (the shim replays its recent non-AUTH frames)
and new sockets bypass the pool. A `config_relayPoolEnabled = false` kill
switch disables pooling entirely; the launcher and app shims then behave like
the previous `ws://` -> `wss://` guard.

## Bridge

Each app page creates a second `MessageChannel` port in `APP_IFRAME_READY`,
dedicated to relay frames. Internal messages:

- `RELAY_ATTACH` / `RELAY_ATTACHED` / `RELAY_DETACH`;
- `RELAY_SEND` / `RELAY_FRAME`;
- `RELAY_CREDIT` for frame/byte credits in both directions;
- `RELAY_CLOSE` / `RELAY_CLOSED`;
- `RELAY_REGISTRY` / `RELAY_REGISTRY_ADD`.

Both directions preserve FIFO, including when a large queued frame does not
fit the remaining credit but a newer small frame would. In particular, `EOSE`
cannot overtake queued `EVENT`s and prematurely complete a history read. App and
vault consumers return receive credits in a microtask, including a trailing
partial batch, so the next large frame cannot stall waiting for unreturned
credits. Credits acknowledge delivery across the port, not completion of the
consumer's asynchronous event processing.

Launcher-to-app/vault receive budgets are separate from publication limits:

| Scope | Frames | Accounted volume |
| --- | ---: | ---: |
| Credit window per virtual connection | 128 | 1 MiB |
| Pending queue per virtual connection | 1,024 | 4 MiB |
| Endpoint total (one app/vault port) | 4,096 | 16 MiB |
| All bridge endpoints in the tab | 16,384 | 64 MiB |

Aggregate totals include queued frames **and sent frames awaiting credit**.
A frame larger than the 1 MiB window, up to 4 MiB, travels alone when all
outstanding credits have returned. It cannot overtake a queued frame. A frame
above 4 MiB immediately closes its virtual connection with 1013 and
`relay bridge frame too large`, instead of waiting for impossible credit.
Individual backlog overflow closes that connection. Endpoint/tab overflow evicts
the largest occupant in that scope (by volume when exceeded, otherwise frames),
repeating only if needed. Shared physical sockets survive and no overflow
triggers direct-socket fallback.

Outgoing publication limits remain 64 frames / 256 KiB of credit and 256 frames /
1 MiB queued, with the existing connection, subscription and rate limits.
An outgoing app/vault overflow tells the launcher to release its attachment.
Close, detach and disposal release payloads and credit ledgers and suppress
pending refunds. This is bounded buffering, not upstream relay flow control.

Volume fields retain string length (UTF-16 code units) for text and byte length
for binary. They do not measure UTF-8 wire size or total browser memory: parsed
objects, copies in transit and other browser allocations are outside this budget.

Receive `RELAY_FRAME` messages carry a monotonically increasing `sequence` per
virtual connection. New consumers echo the last `through` sequence in each credit
batch. The launcher validates the acknowledged FIFO prefix, frame count, exact
volume and optional sequence before releasing credit; invalid credits close only
the offending virtual connection. Legacy consumers omit the sequence/timestamps
and retain count/volume validation; indistinguishable equal-size replayed legacy
acknowledgments cannot be identified without a sequence.

## Vault delegation

The vault sends a second `MessageChannel` port in `VAULT_READY`. After the
launcher validates the iframe source/origin and the vault validates the
reply origin, the launcher creates a delegated relay endpoint and the vault
installs a thin `window.WebSocket` shim (hard-coded
`ENABLE_LAUNCHER_RELAY_POOL` flag). Known, non-quarantined relays attach
directly to pool members owned by the vault. Other URLs retain launcher-owned
virtual sockets for registry, speculative connect, adoption, detach and fallback.
The vault pipes frames, credits and close events without implementing scheduling. Activation requires a completed handshake advertising
`relayPoolSupported && relayPoolEnabled`; standalone vaults, old launchers
and disabled pools keep native sockets. The physical sockets originate from
the launcher origin, which Nostr relays normally ignore. Delegated sockets
are tagged with `owner: 'vault'`, so the snapshot distinguishes vault,
launcher and app members even when they share a bucket.

## launcher/libp2r2p integration

The launcher captures the original `WebSocket` constructor, installs the shim
in its own realm and configures libp2r2p through the new
`relayPool.setWebSocket(...)` API when the installed version provides it (the
global patch also covers older versions, because `RelayConnection` reads
`globalThis.WebSocket` when it connects).

## Metrics and tests

`relayPoolSnapshot()` reports physical sockets, buckets (also grouped by
host), subscriptions, members and pending members (both also grouped by
owner: `launcher`, `app` or `vault`), frames, drops by op, late `CLOSED`
confirmations, capacity rejections, migrations, consolidations, detaches,
quarantines, per-relay failure records (`relayFailures` with the last close
code/reason/phase and `connectionFailures`), auth swaps, auth merges, forced
auth reconnects and rejected AUTHs; the launcher logs a
summary at debug level while the pool is active. Members that cannot get a
bucket immediately are logged and retried when a subscription slot frees.
Each `relayFailures` entry carries `lastCode` plus a human label
(`lastCodeLabel`), `lastReason`, `lastPhase`, `lastWasClean`,
`lastOpenedAt` and `lastLifetimeMs`. Browsers usually report `1006`
("abnormal closure, no close frame") with an empty reason; a null
`lastLifetimeMs` means the socket never opened (DNS/TCP/TLS/attach
failure), while a long lifetime points to a drop after the connection was
established.

`relayPoolSnapshot().bridge` reports launcher-to-consumer queues separately
from physical pool routing. It includes endpoint/attachment counts, current
queued frames/volume, oldest queue age, and `queues` with owner (`app`/`vault`),
relay, opaque endpoint/virtual IDs, head frame size, per-attachment peaks and
remaining frame/volume credits. Only backlogged attachments appear in `queues`.
`connections` includes every active attachment, with `pendingFrames`,
`pendingBytes` and `oldestPendingMs` for sent frames awaiting acknowledgment.
The bridge also sums pending frames/volume across connections. Outstanding
ledgers contain only size, sequence and timestamps, never another payload copy.

Each connection's `latency` has `roundTrip`, `delivery`, `consumer` and `return`
metrics, each with `lastMs`, `maxMs` and `count` (one sample per credit batch).
Round trip uses the launcher's monotonic clock, from the first acknowledged frame.
Optional `receivedAt`/`returnedAt` from app/vault use
[`performance.timeOrigin + performance.now()`](https://developer.mozilla.org/en-US/docs/Web/API/Performance/timeOrigin)
to estimate launcher-to-consumer delivery, synchronous consumer handling up to
credit return, and return to the launcher. These are cross-context estimates,
not time spent in downstream asynchronous decryption or persistence. Inconsistent
or sleep-skewed timestamps are ignored. Older consumers still report round trip,
while stage metrics remain unpopulated. No unlimited timing history is retained.

`bridge.queueOverflows` counts incoming bridge overflows for the launcher
session. `bridge.recentOverflows` retains the last 16 records even after the
attachment or endpoint closes. Each includes the queue snapshot at overflow,
timestamp, direction, configured limits, which limits were exceeded and the
responsible `scope` (`frame`, `connection`, `endpoint` or `tab`). Aggregate
overflows include the affected total before eviction. The
same record is logged immediately as `relay endpoint queue overflow`. These
records contain no frames, event contents, filters, account identities or keys,
and are not persisted. `oldestQueuedMs` measures local queue residence, not
end-to-end latency or time spent processing events in the app/vault.

The pool's `droppedByOp` counts frames that no longer have a routed consumer;
it does not count discarded bridge queue contents. For example, an overflow
can remove a subscription and its pending publication while the shared physical
socket stays healthy, making subsequent `EVENT`, `EOSE` and `OK` frames count
as drops. Check the bridge records before interpreting those drops as a relay
connection failure.

`pendingPublicationsByRelay` counts member publication attempts still in the
local queue (`queued`) versus handed to the physical WebSocket (`awaitingOk`),
with `oldestMs` since the oldest pending attempt entered the pool. It does not
prove network transmission or remote receipt. Close removes those attempts;
migration requeues them while preserving the original age.

A relay `OK` arriving at least `slowPublicationMs` (3s) after pool admission logs
`slow publication response` with the outer event ID, relay, owner, accepted flag,
relay reason, total `elapsedMs`, last local `queueMs`, and `responseMs` since
that physical send. `slowPublicationResponses` counts these per member. This is
observability only: it changes neither consumer deadlines nor send status, and
cannot measure delays before pool admission or after forwarding the response to
the bridge. No event content, signatures or keys are logged. An app publication
timeout does not prove non-delivery: the event can reach another subscriber
before, or without, a timely `OK` reaching the publisher.

The development-only
`window.__44bSetRelayPoolEnabled(false)` flips the kill switch; a reload is
required.

Unit coverage lives in `tests/helpers/relay-pool-*.test.js`: classifier,
registry, bucket routing/spill, AUTH swap, migration, virtual-socket API
behavior, the app bridge and an end-to-end two-app/two-virtual-socket sharing
scenario. Regression tests cover mixed-size frame FIFO in both directions,
trailing credit returns, overflow teardown and bounded diagnostics; the installed
libp2r2p reader must receive all queued history before `EOSE` completes its query.
Run `node bin/run-browser-tests.js -- node tests/browser/relay-bridge.js` for
real launcher/app/vault port coverage with controlled upstream transport, a busy
consumer, burst delivery, REQ renewal, large isolated frames and oversized-frame
closure while another virtual connection remains usable. The runner includes
builds, launcher, vault and Chrome under the required 3 GiB limit.

## Known limitations

- Workers and `about:blank` iframes do not receive the shim; those sockets
  remain direct.
- Cross-tab sharing is out of scope.
- 44b-relay tracks a single authenticated pubkey per connection; the AUTH swap
  avoids its subscription reset. Making the relay NIP-42 multi-pubkey
  compliant is a separate follow-up.
- The vault shares buckets with apps; a misbehaving app can consume bucket
  capacity used by vault sockets. Per-socket quotas bound the impact;
  partitioning buckets by owner is the next mitigation if needed.
- Bunker/NIP-46 traffic is pooled and adds one postMessage hop. Keeping
  bunker relays direct remains the future latency escape hatch.


The installed libp2r2p 0.10.26 publication default waits up to 30 seconds for an
acknowledgement and returns immediately on the first accepting relay. The 3s
slow-response diagnostic is informational and does not change that deadline.
Consumers may still explicitly request a shorter deadline. nmmr 2.0.1 isolates
Node temporary leaf directories and browser record ownership; it removes the
startup sweeps that could delete another active builder's data.

## Live publication latency diagnostic

Run this explicitly against a real relay (it is excluded from `npm test`):

```sh
node bin/diagnose-relay-publication.js --publish \
  --relay wss://relay.44billion.net --samples 4 \
  --output /tmp/relay-publication-diagnostic.json
```

Without `--publish`, the command prints usage and makes no connections. Each
sample publishes four small synthetic events: kinds 3560 (persistent private
channel envelope kind) and 20000 (ephemeral control), via a native WebSocket
and via the actual virtual socket, MessagePort bridge and unified pool. All
events use a disposable key and a ten-minute expiration tag; their content is
diagnostic text, not real private messages. Expiration cleanup depends on the
relay. No account keys or application manifests are used.

Two virtual clients share one pooled physical connection. Connections open
before timing publications; path/kind order alternates between rounds. Every
event has a distinct ID to avoid duplicate-event shortcuts. Publications are
sequential, spaced by 500 ms, with a 30-second timeout (`--timeout` in ms).
`--samples` accepts 1–20 and counts rounds, not individual events.

The JSON report includes event IDs, UTC timestamps, acceptance/rejection,
connection setup times, pool statistics, and these per-publication timings:

- `totalMs`: client send through client receipt of `OK` (or timeout/close).
- `queueMs`: client send through invocation of the physical socket's `send`.
- `responseMs`: physical send through physical reception of `OK`, including
  transport and relay processing; this is not a server-only measurement.
- `dispatchMs`: physical reception through receipt by the virtual client.

The diagnostic rejects direct fallback for the pooled path and checks that
both members share one physical connection. It runs the production pool code
in Node with real MessagePorts, not a complete browser/launcher session under
load. A slow direct response establishes that pooling is not required for the
delay. Fast ephemeral controls alongside slow persistent events suggest
investigating persistence, but identifying the exact server stage requires
server-side timings. Small samples and changing relay load do not establish
comparative throughput or percentile latency.


### Work budgets and cancellation

The message budget is shared by host, including authenticated/spill buckets,
so opening extra sockets does not multiply an anonymous IP's outgoing burst.
The 44b-relay global token bucket allows 120 messages and refills 60/second;
its publication/auth/subscription-specific restrictions remain separate.

CLOSE bypasses work tokens and remote cooldowns. Before sending it, the pool
removes every queued REQ generation for that subscription. Thus cancellation
cannot be followed by a stale request, and still releases only that member's
subscription on the shared socket. Internal detach/migration cleanup uses the
same immediate control path.

CLOSED accepts/preserves an optional fourth metadata object; rejected OK uses
its fifth element. The public `parseRelayRetryAdvice` from libp2r2p accepts only
finite positive timing on leading `rate-limited:` refusals. Absolute `retry_at`
(Unix seconds, including fractions) takes precedence over relative `retry_after`
seconds, even when the absolute deadline has expired. Future waits are capped at
five minutes; invalid/absent absolute advice falls back to relative advice.

The pool computes advice once on receipt, extends the existing host cooldown
with max(existing deadline, advice.retryAt), and adds the effective `retry_at` to
a copy of that frame's extra object. It preserves `retry_after` and other fields.
Frames without valid advice acquire no synthetic wait. ID rewriting, FIFO port
queues, delayed credit returns and vault delegation preserve the timestamp;
they never recompute it at delivery. Existing operation deadlines still apply.
Older consumers can ignore the extension; upgraded libraries avoid an extra
relative wait after delayed delivery. Per-bucket drain timers and idle budget
state are released on close/expiry.

### Internal failure attribution

`relayPoolSnapshot().failureDiagnostics` contains fixed `byOrigin`/`byCode`
counters and at most 32 recent records. Origins are `pool`, `bridge`, `transport`,
`protocol` and `consumer-report`. Codes describe actions observed internally:
capacity, outgoing/receive overflow, invalid credit, rehome, local AUTH validation
or timeout, unavailable/timed-out attachment, native construction/send/close and
invalid server framing. Logs use the same sanitized records: time, relay,
known phase/code and optional close/lifetime facts, never payloads, filters or
account identities. Snapshots are copies, and records remain in memory only.

Consumer `RELAY_FAILURE` reports are unverified, even when they claim physical
transport failure. Locally observed pool/bridge failures and consumer reports
do not increment legacy confirmed connection/relay failure counters. Native
close/send and invalid server frame observations retain those diagnostics.
Construction failure is local, not proof that a relay refused an operation.

This attribution is diagnostic only. Nostr extras declaring `local`, `origin`,
`retryable` or other policy are preserved as inert data and never trusted.
WebSocket events retain their standard properties; no provenance travels over
Nostr or reaches an app via event metadata. Generic app libraries still cannot
reliably distinguish bridge failures from transport closures. Public error
predicates and send routing are unchanged; trusted app attribution remains future
work. Physical connection recovery is described below.


### Physical connection recovery

`physicalBackoffEnabled` defaults to true. The pool shares recovery by normalized
relay URL, while existing connection rate budgets remain per host. Native send
failure, the physical handshake watchdog, and native close codes 1001, 1005,
1006, 1011, 1012, 1013, 1014 and 1015 qualify. Other codes retain their original
handling. Construction errors, local closures, pool/bridge overflow or rehome,
consumer reports and Nostr refusals never advance physical backoff. Physical
observations establish transport behavior, not the underlying cause or blame.

A healthy sibling prevents a failure from advancing URL recovery. Failed sockets
in one generation consume at most one step. With demand, one bounded connectivity
check classifies pending failures; online confirmation sets an absolute deadline
from the failure time using 1, 2, 4... seconds, ±20% jitter, capped at 30 seconds.
Offline uses public `onOnline`, consumes no step and permits no new native socket.
Checks and the online listener are shared per pool, cancelled without demand and
fenced against old generations. Remounts/online notifications never renew a deadline.

When the deadline expires, one recovery socket may connect for the URL. Interested
members share it or wait. Open releases the trial lease; other buckets may then
connect under existing host budgets. Thirty continuous seconds with any open
socket reset recovery. Healthy sockets remain reusable, and the scheduler skips
blocked URLs rather than blocking unrelated destinations. Rate-limit `retry_at`
remains an independent operation deadline, never a physical failure or added wait.

The 10-second native handshake watchdog starts only when the socket is actually
constructed. Queue time is excluded. Caller deadlines remain authoritative: the
installed library can still cancel after its 3-second connection timeout. A last
consumer cancellation destroys queued/connecting buckets immediately, without a
failure step. Recovery state remains five minutes after losing interest, while
shutdown clears gates, network work and timers. Active attempts retain deadlines.

The private port protocol uses `RELAY_ATTACH_PENDING { virtualId }` for every
accepted pool member, with no capability negotiation. Acknowledgment ends the
injected app shim's attachment watchdog, confirming admission rather than socket
readiness; WebSocket stays CONNECTING until actual open, failure or cancellation.
Consumer deadlines and the physical handshake watchdog remain authoritative.
There are no compatibility timers or special closures for older injected shims.
An older shim served by an out-of-date app service worker can time out during a
long queue wait and fall back to a direct connection. Synchronizing worker/shim
versions is a separate runtime concern; this bridge does not emulate old behavior.
The existing delegated vault facade ignores the internal acknowledgment and
requires no update. Unknown/direct/speculative paths keep their existing behavior.
Endpoint disposal closes pending facades before releasing the port attachments.

`relayPoolSnapshot().connectionRecovery` reports native attempts, deferred
connections, offline waits and cancellations before open, plus at most 32 URL
summaries: next delay/deadline, recovery/check/trial state, healthy sockets and
interests. Details are copied, in memory only, and contain no frames, filters or
account identities. `RELAY_SOCKET_CONNECT_TIMEOUT` remains separate from bridge
attachment timeout. Test-only connectivity/jitter injections are internal; no
new app API, WebSocket property, Nostr metadata or persisted key is introduced.
