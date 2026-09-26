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
- The vault (ez-vault) is a follow-up. When it is added, bunker traffic stays
  out of the launcher pool.

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
- 4 buckets per relay per tab, with spill and a connection limiter that
  respects the relay's 3 new connections/second and 10 per 5 seconds;
- 60 messages per 2 seconds per bucket, drained round-robin per virtual socket;
- 256 queued frames / 1 MiB per virtual socket, then only that socket is
  closed with 1013;
- buckets with no members close after 30 seconds.

Subscription ids are namespaced per virtual socket before going to the relay
and rewritten back before delivery. `EVENT`, `EOSE`, `CLOSED`, `COUNT` and
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

Valid AUTHs take one of two paths:

- a confirmed bucket for that pubkey already exists and the virtual socket
  has no connection-bound state: the AUTH is discarded, the socket moves to
  that bucket, its subscriptions/counts/pending publishes are replayed and
  the client receives a synthetic `["OK", id, true, ...]`; the relay sees no
  second AUTH because the connection is already authenticated as that pubkey;
- otherwise the AUTH is forwarded on the current connection. The bucket
  identity stays pending until the relay answers `OK true`; `OK false`
  reverts it to anonymous. Switching away from another authenticated pubkey
  migrates the other virtual sockets first and replays the authenticator's
  subscriptions after confirmation (the relay may have reset them).

During a merge the pool replays each subscription's last `REQ`, pending
`EVENT` publishes (relays deduplicate by event id), pending `COUNT`s and
delivers the destination bucket's stored challenge, deduplicating recently
delivered event ids (LRU, 256 entries / 5 minutes) and repeated `OK` replies.

If a confirmed bucket exists but cannot receive the socket (bucket full) or
the socket has state that cannot be transplanted — a NIP-77 session after any
`NEG-MSG`/`NEG-ERR`, because negentropy state is connection-bound — the pool
presents the switch as a reconnect (`close 1006`). The app reconnects and its
next AUTH follows the merge path; no per-app identity hint is needed.

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

## launcher/libp2r2p integration

The launcher captures the original `WebSocket` constructor, installs the shim
in its own realm and configures libp2r2p through the new
`relayPool.setWebSocket(...)` API when the installed version provides it (the
global patch also covers older versions, because `RelayConnection` reads
`globalThis.WebSocket` when it connects).

## Metrics and tests

`relayPoolSnapshot()` reports physical sockets, buckets, members, frames,
migrations, detaches, quarantines, auth swaps, auth merges, forced auth
reconnects and rejected AUTHs; the launcher logs a summary at debug level
while the pool is active. The development-only
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
- ez-vault is not pooled yet; bunker traffic must stay outside the launcher
  pool when it is added.
