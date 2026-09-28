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
- 60 messages per 2 seconds per bucket, drained round-robin per virtual socket;
- 256 queued frames / 1 MiB per virtual socket, then only that socket is
  closed with 1013;
- buckets with no members close after 30 seconds.

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
relay actually authenticated the connection.

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
delivered event ids (LRU, 256 entries / 5 minutes). `OK` replies route only to
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

Credits bound how much either side buffers. `dispose()` on the launcher
endpoint closes every virtual socket owned by that app instance.

## Vault delegation

The vault sends a second `MessageChannel` port in `VAULT_READY`. After the
launcher validates the iframe source/origin and the vault validates the
reply origin, the launcher creates a delegated relay endpoint and the vault
installs a thin `window.WebSocket` shim (hard-coded
`ENABLE_LAUNCHER_RELAY_POOL` flag). The launcher owns the real virtual
socket, so registry, speculative connect, pool adoption, detach and
fallback logic stay only here; the vault pipes frames, credits and close
events. Activation requires a completed handshake advertising
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
scenario. A CDP browser scenario (one app opening dozens of sockets to the
same relay and asserting the physical socket count) is the next validation
step for a real browser.

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
