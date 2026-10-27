# AGENTS.md

This document is the primary brief for AI assistants working on this repository. Read it in full before making changes.

## Documentation

- Document this project and its dependencies. Describe consuming apps generically;
  keep their names, setup instructions, and project-specific commands in their
  own repositories.

## Project Overview

44billion is a Nostr app (napp) launcher. UI components are built with the sibling
[`thenameisf`](../f) framework — custom elements with signals-based reactivity,
light DOM, and no per-component build step (esbuild only bundles the app). Follow
the framework's component conventions: `f('tag', ...)` declarations, signal props,
`useStore`/`useTask`, and light-DOM slots.

## Routing

- Use pathname URLs and the browser History API through `useLocation` from `#f`
  and `url-router`. Render matched system views with `<f-route>`, imported from
  `#f/components/f-route.js`; do not restore a local `a-route` implementation.
- Navigate through the location store's `pushState`, `replaceState`, `back`,
  and `forward` methods. Read route data from `props.route$` or
  `useClosestStore('<f-route>').route$`. Preserve app-window routing and verify
  direct URLs, reloads, and browser Back/Forward when changing navigation.
- App iframes use isolated origins. Use `reloadAppIframe` to reload them through
  the parent-owned `src`, retaining the bridge marker; do not access the child
  document's `location.reload()`. Keep draft data cleanup before navigation.

## Injected app APIs

- Keep [`APP_API.md`](APP_API.md) updated in the same change that adds or changes
  an injected API. Consumers use the committed version on `main` as their contract.
- NIP-44 v3 app methods and internal NostrDB callers send/receive `ArrayBuffer`
  plaintext throughout the local launcher/vault channel, including Double DH
  and scoped signers. `nip07-client.js` snapshots input before awaiting the
  handshake. Base64 belongs only at the vault's remote bunker adapter and in
  encrypted activity-log JSON; do not add conversions to the local bridge.
- Document identity scope, permissions, handshake timing, errors, and subscription
  cleanup. Persona-scoped access must be checked in the launcher on every request
  and revoked for live subscriptions when membership changes.
- Personal-copy mirror preparation uses an internal, launcher-only
  `NIP07_BATCH / obfuscateMany` protocol. Bound it to 64 operations and 256 KiB,
  deduplicate exact operations in the vault, preserve output order and log only
  counts/timing. Apps cannot send the batch code through the NIP-07 bridge.
  Recovery archives inherit the original request priority/classification, carry
  an internal `recovery` scheduling hint and share a global two-job vault cap.
- Stored permissions match app, name, kind and permission scope exactly; `-1`
  never authorizes a specific kind. `scope: ''` is kind-wide. A non-empty scope
  is stored only when the launcher-owned `(kind, scope)` registry has a
  translated label; unknown scopes fall back to `''`. The registry starts empty,
  and startup reconciliation deletes unsupported scoped grants.
  NIP-44 v3 uses personal permissions by logical kind, kind 1006 included, while
  26300/26400/3560 are permissionless crypto transport. Legacy NIP-04/NIP-44 v2
  use the separate `legacyCryptoAccess/-1` grant.
  `signEvent`/`doubleSignEvent` exempt 26300/26400/3560/1006, but kind-5
  address deletions must still request access to their target kinds. Common
  event-store reads and public writes are permissionless; personal wrapper
  writes request their inner kind, while kind-5 adds and `remove` retain the
  deletion prompts. Private kind-5 personal copies classify their inner tags
  like public deletions. Derive an opaque launcher-owned in-memory dedupe key
  for one-time deletes so “delete for everyone” shares one prompt across its
  two persistence paths; never accept a key from the app or persist it.
  Settings exposes `App Data Access` from Advanced. It lists every remembered
  grant once by app, regardless of workspace or account, and allows exact
  individual revocation or confirmed app-wide revocation. Revocation applies to
  future protected requests; it does not reload app windows, cancel permissionless
  event-store reads, or delete app data.

## Styling Rules

- **Colors come from [`src/assets/styles/theme.js`](src/assets/styles/theme.js).**
  It is the single source of authored UI colors. Each token is a
  `light-dark(<light>, <dark>)` pair resolved natively from `prefers-color-scheme`
  (via `color-scheme: light dark` in `global.css`), or a relative color expression
  derived from another token (`oklch(from var(--token) l c h / NN)`). Do not author
  color literals (`oklch(...)`, `#hex`, `rgb(...)`, `light-dark(...)`) outside
  `theme.js` (or the `inverted-colors` accessibility rule in `reset.css`); consume
  tokens via `cssVars.colors.*` (which expand to `var(--token)`). UGC media (avatar
  photos, images, video) must never receive theme inversion filters.
- **Component styles are global — always scope them.** thenameisf renders a
  component's `<style>` tag into the light DOM, so every rule applies
  document-wide. Never write top-level class selectors inside a component's
  `<style>` block; nest every rule under the component's host tag or a
  component-specific root id (e.g. `#confirmation-dialog-card { .title { ... } }`).
  An unscoped `.title` in one view leaks into every other component that happens
  to use that class.
- The CSS reset sets `html { font-size: 0.0625em }`, so `1rem ≈ 1px`: use `rem`
  for `font-size` only and `px` for everything else.

## Testing

- Repository-wide lint (`npx eslint .`) imports global exclusions from
  `.gitignore` through neostandard; keep ignored/generated files out of lint
  without excluding tracked HTML inline scripts. The HTML plugin must remain
  compatible with the installed ESLint flat config.

- Run `npm test` (Node built-in test runner) and keep the theme test
  (`tests/helpers/theme.test.js`) green — it enforces token format, WCAG contrast
  pairs, and the absence of authored color literals outside `theme.js`.

- Permission cards own a transient three-line text limit, increased by two on
  each activation. Use a native button and a CSS custom property for the clamp;
  keep expansion separate from grant/deny, with no overflow measurement or
  persisted expansion state. Each keyed request starts with its own limit.
  The protected `tests/browser/permission-dialog.js` check covers pointer and
  keyboard expansion, narrow layouts, full text and independent requests.
  The protected `tests/browser/app-data-access.js` check covers alphabetical app
  ordering, grouped grants, scope redaction, individual revocation and confirmed
  app-wide revocation against real IndexedDB.

## Persisted state

- Every localStorage/sessionStorage key or IndexedDB store must be documented in
  [`docs/storage-model.md`](docs/storage-model.md) and registered in
  [`src/constants/storage-schema.js`](src/constants/storage-schema.js) in the
  same change that introduces it.
- When changing storage or lifecycle behavior, check all three in the same
  change: `docs/storage-model.md`, `src/constants/storage-schema.js`, and
  `src/services/storage-audit/audit.js` (plus `repair.js` if cleanup changes).
  Update them whenever a persisted key/template, an IndexedDB store, or an
  audit invariant changes. In-memory registry keys are not persisted and do
  not need registration.
- The launcher runs a two-phase storage audit on load: the post-render pass
  detects inconsistent workspace/app/account state and schedules a repair
  reload; the pre-render pass applies the pending repair plan. Keep the audit
  pure, prefer existing cleanup routines, and preserve unknown keys.

## Connectivity recovery

- The coordinated library patch uses local private-messenger readiness by default
  and incremental peer preparation. Keep these policies in the library; no app
  bridge, physical pool or WebSocket changes accompany this dependency update.

- Use `isOnline` and `onOnline` from `libp2r2p/network`. The shared library
  monitor owns connectivity probes, capped retry delays, and browser wake-up
  listeners. `ConnectivityRetryCoordinator` owns waiters, cancellation, and
  concurrency of resumed app work; do not restore its duplicate probe timer.
- Use the coordinated `libp2r2p@^0.11.36` range in package.json;
  package-lock.json records the resolved release. Validate against the installed package rather than sibling
  source imports; it includes the shared connectivity monitor.

## Development runtime and consumer tests

- `start:adb` composes `bin/adb-session.js` with `ensureRuntime()` directly.
  Keep the ADB session alive when reusing a launcher; do not wrap `npm start`
  in a detached process group or exit before asynchronous cleanup finishes.
  Consumer apps share the ADB session helper while retaining their own watcher.
  Forward only app-facing ports 10000/4000. Pin the selected device, honor
  `ANDROID_SERIAL`, use `--no-rebind`, and remove only owned mappings that still
  match their original endpoints. Console availability must not gate manual use.
- `npm start` runs `bin/dev.js`, a Node supervisor. `bin/dev-runtime.js` exposes
  `ensureRuntime()` for sibling development/test tools. Reuse only a matching
  checkout/protocol that reports ready at `/__dev/health`; never terminate
  unrelated servers. Handles stop only their own processes.
- Keep ports 10000 (launcher), 8080 (esbuild), and 4000 (existing vault origin)
  fixed. The bridge expects localhost:10000. Wait for the launcher and vault
  builds before reporting readiness; handle SIGINT, SIGTERM and child failure.
- The vault development server and launcher vault route serve `ez-vault/.dev`.
  Production serves `ez-vault/dist`. Run `npm run build` in 44billion before
  starting or restarting production: it installs both projects with
  `npm i --include=dev`, builds the vault, then builds the launcher. A missing
  `../ez-vault` warns and builds only the launcher; an invalid sibling or a failed
  command aborts. Run `npm i` manually in 44billion first if dependencies needed
  by the builder's imports are missing or changed. Preparation lives in
  `bin/prepare-production-build.js`, runs before hashing/bundling, and never runs
  in development. Generated dist/ output remains ignored by Git. Preserve the
  existing localhost:4000 origin so development vault accounts remain accessible.
- The health endpoint is development-only; it is not an injected app API.
  Draft updates retain their current origin/event cleanup behavior.
- The draft watcher must wait for the first-open manifest write. Recheck the
  installed timestamp and file aggregate after acquiring the update slot;
  initial feed replay, duplicate/deferred events, and metadata-only revisions
  must not emit a reload notification or clear app data.
- `tests/browser/runtime/` contains reusable Node/CDP and installation helpers
  for consumer integration tests. Use production manifest/chunk writers and
  the ordinary launcher app-opening flow; shared cache installation lives in
  `src/services/local-dev/install.js`. Do not duplicate storage schemas in
  consumer projects. Fixtures and generated keys belong only to disposable
  browser profiles. Development classification is documented separately below.
- CDP frame metadata is scoped by target session as well as frame ID. Select
  app contexts only after their document URL is known; never evaluate app
  assertions in same-origin bridge or file-download iframes (`/~~` routes).
- The default Chrome helper denies external traffic through a local proxy,
  including WebSockets/CONNECT. Network fixtures may supply controlled responses;
  injected APIs, the vault, and permissions stay real. `externalNetwork: true`
  is reserved for explicitly invoked publication checks, not normal test suites.
- Consumer browser tests reload a fixed app version to verify persistence.
  They must not restore data before asserting recovery. Capture diagnostics
  before removing the profile, including when a scenario fails.

## Local app development

- Consumer development workflows may register immutable local builds through the
  development server. Preserve the separate real-publishing workflow. The local
  publisher identity is persistent and never comes from remote publishing credentials.
- `/__dev/apps/` is development-only, same-origin and loopback-host restricted.
  Node registration requires the private supervisor token; never expose it to app
  URLs or user-facing logs. Reject unregistered files and mismatched hashes.
- `local_devApps` classifies installations outside Nostr manifests. Exclude these
  apps from automatic/manual remote updates and network cache-miss fallback.
  Retain classification when the watcher stops; remove it on uninstall.
- Hold the registry install lock while activating builds and pruning. A live
  instance holds shared app-version and user/app locks. Keep old roots until their
  version locks are free. Do not delete active files to make a new build fit.
- Local reloads preserve data and routes. Explicit reset confirms the selected
  user/app, pauses its instances, acquires the exclusive user lock, and reports
  strict origin or eventStore cleanup failures. The development-only local reset
  retains trusted bridge documents and their runtime service worker; ordinary app
  documents and workers must be gone. Recycling checks and remote draft cleanup
  retain their existing behavior.
- A second confirmed menu action, rendered above that one, resets the whole
  development environment: it asks the vault to delete its own accounts and
  databases over the messenger (`LOCAL_DEV_WIPE`), clears every mapped app origin,
  and leaves `local_devFullReset` plus a reload for the next boot, which deletes
  all launcher IndexedDB stores, caches, OPFS entries and service workers before
  anything reopens them. The vault wipe is mandatory: abort with a visible error
  instead of reloading into an environment the vault would refill with the same
  accounts. The marker retries once and is then dropped, never reloading forever.
- Local controls use thenameisf and existing i18n/confirmation conventions, and
  are excluded from production builds. No new window.napp API is introduced.
- Development reset failures are reported through the informational
  `<info-dialog>` (card derived from the confirmation dialog: icon, title,
  message and a single dismiss action), never as a notice inside the window
  menu, which unmounts as soon as the menu closes. The dialog is mounted only
  in the multi-napp zone and only in development builds.

- Keep `storage-event-guard.js` ahead of component mounting. The installed
  thenameisf storage adapter writes received values back; delayed remove/set
  events can otherwise echo indefinitely between tabs. The guard discards
  superseded events. Retain its regression test when upgrading the adapter.


## Account event ingestion

- `useTrackAccountEvents` owns one coordinator, groups writable account authors
  by relay/eligible kind set, and cancels on removal/unmount.
  Seeds independently discover kind 10002; write groups use at most 30 kinds and
  500 authors. Retiring groups stop and drain accepted events; account removal
  discards that account's pending delivery. Preserve unchanged groups.
- Account ingestion persists inclusive owner/normalized-relay/kind coverage in
  NostrDB's `accountCoverage` store. Reconcile eligible kinds at startup, retain retired
  relay coverage, and fence checkpoints against database resets. Event commits
  precede checkpoint commits. The coverage writer is `maintenance` work but its
  store is disjoint from event and quota writes; invalid coverage resets safely
  without touching unrelated stores.
  Coalesce completed pages for 50 ms per coverage database, merge their ranges
  in memory, then use one `markBatch` transaction for all available relays and
  kinds. Pipeline all per-relay/kind reads and issue conditional writes from
  their success handlers. Flush at scan completion and before propagating its
  result; abandoned signals may repeat a page. Repeated coverage must not rewrite
  unchanged rows; retain generation validation, whole-batch abort behavior and
  the transaction-completion barrier.
- Grouped recent snapshots and resumptions use ten minutes of overlap;
  historical queries combine only matching bounds. Saturated pages subdivide
  time, then authors/kinds. The explicit single-author/kind/second saturation
  tradeoff warns and marks coverage (possible excess loss); do not silently add
  a nonstandard ID cursor. Never revisit confirmed old ranges automatically.
- Backfill failure must not stop initialized live input. Initial failure must
  discard buffered live, preserve committed subwindows and retry with capped
  jittered backoff. Respect explicit permanent refusals and root cancellation.
- Use the public same-relay retry predicate for relay failures. `pow:`, local
  authentication and unknown reads are terminal; preserve that decision for
  unchanged groups, including refused backfill after later live reconnection.
  Keep error source/filter context in a WeakMap, never on shared native errors.
  Storage has independent recovery. Local admission/buffer errors keep their
  explicit local policy. Retry at max(jittered backoff deadline, retryAt); offline
  waits through ConnectivityRetryCoordinator and spends no backoff step.
- Store only eligible known public account events in the owner's NostrDB. Keep
  the README import exclusions and library/tag-defined ephemeral checks. Only
  kinds 0/10002 update the vault metadata channel; account import adds no public
  eventStore API. Test the published pool with controlled transport, and use the
  protected `tests/browser/account-events.js` check for real-IDB reload coverage.
  Kind 13300 is a private personal-copy contact list and stays excluded from
  automatic account import; kind 30000 remains an eligible custom follow list.
- Event-store subscriptions support opt-in initial replay, with live delivery
  registered before the snapshot. Preserve cancellation and deduplication by ID.

- No periodic history refresh: process automatic `live-progress` controls in
  event order and confirm coverage only after preceding writes commit. Cancel a
  failed live attempt, discard its buffered events and resume with overlap.
  Ignore unknown controls. Do not use progress to bridge disconnected epochs.
- Read-only accounts have separate unrestricted replaceable snapshots: seeds
  kind 10002, write relays kinds 0/10002, forwarding only newer vault metadata.
  Never create their NostrDB, coverage or cached-event import. React to flag
  changes even when pubkey membership is unchanged.
- All eventStore operations except static `supports` reject read-only owners
  before DB creation or prompts; persona authorization comes first. Use
  `READ_ONLY_ACCOUNT` / `READ_ONLY_TEMPORARY_ACCOUNT`. Vault lock alone is not
  a public-event storage restriction.
- Read-only transitions durably fence access with
  `local_nostrDbPendingDeletions`, cancel idle streams/maintenance, close old
  instances across tabs and delete owner DB + chunk references. Retry incomplete
  cleanup after reload and before writable access resumes. Never swallow chunk
  cleanup failures or recreate absent owner DBs during cleanup. Preserve shared
  payloads, vault metadata, workspaces and installations. Run protected
  `tests/browser/nostrdb-readonly.js` for the two-tab lifecycle regression.

For writable accounts, the tracker imports already available signed vault profiles
and relay lists into NostrDB before relay delivery, preserving immediate offline
access without echoing those cached events back to the vault.

## Local file download contract

- Keep `/~~nfile/<entity>` interception ahead of app-page routing. The injected
  `getFileDownloadUrl` validates nostr.alt nfile URLs, waits for handshake, and
  includes the exact instance bridge marker. Pass `FetchEvent.clientId`
  explicitly; never read `Request.clientId` for nfile routing.
- Identified bridges are strict across tabs and service-worker restarts. Preserve
  localOnly, stream backpressure/cancellation, HEAD/ranges, attachment disposition
  with sanitized names, and nosniff. Do not materialize downloads into file-sized
  Blobs or route local misses to network.
- Personal-copy chunk ingestion continues normalizing public local 34601 events
  with separated bytes. Owner personal copies retain referenced roots through
  inner `r` tags, including inner events from another author. No new encryption,
  persistence schema or quota category is introduced for file attachments.

- Chrome runtime tests exclude service workers from debugger-paused auto-attach.
  Otherwise stopping/restarting a worker can hang its fetch before bootstrap.
  The deny-by-default proxy still blocks worker network traffic. Observe download
  and worker lifecycle events from the page/browser CDP sessions.

- Run browser suites through `bin/run-browser-tests.js -- <command> [args]`.
  It requires Linux user systemd, caps the complete owned process group at
  3 GiB with zero swap and a 15-minute lifetime, and reports its observed peak.
  There is no unbounded fallback. Stop existing local runtimes first: reusing
  one outside the cgroup would leave build/vault memory outside the limit.
  The service kills descendants on exit/failure. CDP evaluations release their
  object group; bounded diagnostics and detached target cleanup belong in the
  shared harness. Do not run multiple browser suites concurrently.

## Browser source maps

- `bin/build-settings.js` owns `EMIT_SOURCEMAPS` for every production build layer.
  Development always emits maps regardless of the flag. Preserve original-source
  mappings through worker rebundling and separate maps for injected scripts;
  disabling the flag must leave no map files or directives in production.
- Build outputs are finalized as one snapshot before development serving/readiness.
  Keep port 8080 and the `/esbuild` reload stream compatible with the supervisor.
- `/~~sourcemaps/<sha256>.map` is reserved on root/numeric app origins. Serve only
  current build artifacts with JSON/no-store headers and an actual 404 for misses.
  Both workers must bypass caches and app bridge processing for this route.
- Run the protected `tests/browser/sourcemaps.js` check after a production build
  when changing mapping, serving or worker routing. It exercises actual bundles
  and the shared production router without starting the production server.

## Relay bridge queues

- Preserve FIFO within outgoing classes and incoming normal traffic even when
  a newer smaller frame fits remaining credit. Eligible controls can bypass
  dependency-blocked controls from other streams and unrelated queued history;
  EOSE/CLOSED and NEG controls never overtake earlier results of their own stream.
- Return trailing receive credits in a microtask; they acknowledge port delivery,
  not downstream asynchronous processing. Outgoing publication limits remain
  64 frames/256 KiB of credit and 256 frames/1 MiB queued. Incoming defaults are
  128 frames/1 MiB of credit, 1,024 frames/4 MiB queued, 4,096 frames/16 MiB per
  endpoint and 16,384 frames/64 MiB per tab, including outstanding credit.
  Large frames up to 4 MiB travel alone; larger frames fail explicitly. Aggregate
  overflow releases the largest occupant in its scope, never a shared socket.
- Close/detach/dispose release payload queues; outgoing overflow tells the
  launcher to release the member. Ignore stale frames and credit work after close.
- `relayPoolSnapshot().bridge` aggregates launcher-to-consumer queues and the
  latest 16 overflow diagnostics. Keep them in memory and free of frame contents,
  filters and account identities. The legacy volume accounting uses string length
  for text and byte length for binary; do not silently change protocol units.
- See `docs/relay-pool.md` and the bridge/e2e Node regressions. A bridge overflow
  may leave shared physical sockets healthy; `droppedByOp` is a separate metric.

- Deduplicate incoming events per subscription and client REQ generation (256
  IDs/5 minutes), preserving the cache across internal migration only. New REQ
  and CLOSE release the previous cache; overlapping history queries are independent.
- Credit ledgers retain bounded sizes/sequences/times only. Validate FIFO refunds;
  new consumers echo sequence and optional performance-epoch timestamps. Legacy
  consumers retain count/volume validation and RTT metrics. Cross-context stage
  estimates must not be presented as downstream processing time or heap usage.

- Outgoing work tokens are shared per relay host (60 burst, 30/s), including
  spill/auth buckets. CLOSE bypasses tokens and per-type params cooldowns, after
  removing all queued REQ generations for that subscription. Accept optional
  string params in CLOSED/OK transport classification. Physical scheduling may
  bypass blocked types while retaining FIFO within each type and port queues.
  Keep cooldowns bounded to five minutes and clear timers on shutdown.


Cached vault metadata is an optional signed bootstrap source: validate author,
expected kind and signature before populating account-event state or NostrDB.
Provisional/invalid metadata does not block grouped discovery. Duplicate,
superseded, ignored and locally blocked records are already resolved; real
storage failures still prevent coverage advancement. Presentation caches and
the storage schema are unchanged; no destructive cache repair is needed.

- Relay timing uses public `parseRelayRetryAdvice`. Add only optional Nostr
  `@<Unix milliseconds>` params to correlated rate-limited CLOSED/OK with valid
  timing; forward the effective host/type cooldown without recalculating at queue
  delivery. Ignore legacy timing objects and unknown operation IDs. Preserve
  port FIFO, volume units, CLOSE and operation deadlines.
- `failureDiagnostics` uses trusted fixed codes/origins and a 32-record ring.
  Pool/bridge failures and unverified consumer reports never count as confirmed
  relay failures. Do not trust remote provenance/policy fields, add custom
  WebSocket event properties or change send routing based on these diagnostics.

- Physical recovery belongs only to launcher-owned pool sockets. Keep native
  eligible failures separate from relay refusals, local actions and consumer
  reports. State is per normalized URL; connection throughput budgets stay per
  host. Healthy siblings suppress failure steps; same-generation failures spend
  one step, with a single recovery trial, 1–30s jittered absolute deadlines and
  reset after 30s of continuous open availability.
- Use public connectivity APIs with one bounded check/listener per pool. Offline
  spends no stage; absent demand and shutdown cancel network work. Keep five
  minutes of idle recovery state and fence stale completions.
- The physical 10s watchdog starts at native construction, never queue admission.
  Preserve consumer deadlines and immediate last-member cancellation before open.
  Internal ATTACH_PENDING acknowledges every accepted pool member without
  capability negotiation or compatibility timers. Keep the injected shim current;
  synchronization of app workers with launcher versions is separate work. Known
  vault relays attach directly to owned members; unknown/quarantined delegation
  remains on its existing virtual-socket path. No custom WebSocket properties.
- Keep physical recovery metrics bounded/copied and separate physical timeout
  from bridge timeout. The controlled recovery/e2e tests exercise installed
  libp2r2p and real ports; protected relay-bridge browser tests cover the three
  consumer paths. No library release, dependency or persistent-state change.

## Private-messenger dependency contract

- The prepared 0.11.22 patch adds the specific legacy queue-index migration and
  bounded pending-ciphertext recovery. onContentKeysChanged uses the existing
  authorized signer-state port lifecycle, forwarding committed vault changes as
  opaque per-account revisions. Keep revisions/inventories out of WebStorage;
  no key material crosses this notification. Public error contexts preserve
  selected crypto codes/coordinates and bounded causes. Slow publication timing
  is JSON text with the existing threshold and no event payloads.

- Consume libp2r2p 0.11.36 through the registry-resolved lockfile. Its private
  messenger observes owned pauses and recovers them independently of historical
  completion; explicit caller pauses remain caller-owned. Session factories must
  provide readStatus and initial/subsequent onStateChanged notifications. No
  injected app API, WebSocket property or bridge wire change is introduced.

- The 0.11.20 messenger optionally hedges automatic NIP-65 publication with
  fallbackDelayMs and supports per-publication cancellation in RelayPool.sendEvent.
  Launcher consumers retain the null default; do not change operation retries,
  the physical pool, bridge protocol or WebSocket events for this dependency bump.

## Prepared package validation

Vault requests use the launcher-owned scheduler described in
`docs/vault-request-scheduling.md`: five running requests, four normal maximum,
two identifiable chunks maximum, and three priority admissions per normal
admission when both classes are eligible. Preserve account permissions and
connection-generation isolation. Personal-copy preparation inherits priority
through request-local callbacks, never cached database callbacks. Diagnostics
are development-only, bounded and contain identifiers/timings only.

Kind 18716 uses `CONTENT_KEY_ANNOUNCEMENT` from `libp2r2p/kind`. The 0.11.21
catalog makes it eligible for account import and shared across apps; opening
NostrDB reconciles stale app references. The removed content-key event constant
must not be restored as an alias.

Before registry publication, validate the exact prepared libp2r2p tarball through
public imports. Final lockfiles retain npm URLs and that archive's real integrity;
publish the same archive manually. No local dependency references are committed.


## Quota maintenance scheduling

- Cache access timestamps bypass the global quota lock and only use cached
  connection generations, revalidating access before a transaction. Never open
  databases for statistics, recreate removed access rows or touch a replacement
  generation. Keep 2,048 queued IDs, 100 per flush, 25 per transaction and minute
  per-record throttling, with yields between transactions. Pipeline the reads in
  each transaction and issue conditional updates from their success handlers;
  retain the transaction-completion barrier and all existence/generation checks.
- Ready counters use readonly `quota` reads. Periodic eviction is limited to
  100 examinations/25 deletions per lock round; ordinary admission performs no
  eviction or global sums. Revalidate LRU timestamps/eligibility in the deletion transaction and reselect changed candidates.
- Event mutations atomically maintain existing per-owner counters without taking
  the global quota lock. Background review publishes the versioned advisory
  `44billion:nostrdb-quota-state:v1` summary under that lock, which still coordinates
  configuration and DB creation/removal. Preserve legacy reconstruction and the
  schema-4 relocation of the unchanged quota record into `quota`.
  Permit temporary excess; block positive net admission only on known exceeded
  categories (zero limits immediately). Reference-induced transfers never discard
  protected targets or block removals. Keep last usable gates during maintenance
  failure; unknown positive budgets remain available. Preserve shared scheduler
  coalescing/volume thresholds, cross-tab revisions and root-owned UI subscription.

## Send scheduling and preparation

User-authorized private scheduling spans all buckets per host: 3 priority / 1
normal, eight of 60 tokens reserved, unchanged 2s refill/cooldowns. Only outer
3560 and validated AUTH are priority on relay publication; signer kinds remain
unchanged. Encrypted chunks cannot be distinguished from other 3560 envelopes.
Shims reserve 4 frames/32 KiB outgoing; return reserves 8/64 KiB. Incoming high
(private OK/AUTH), intermediate (other correlated OK/COUNT/EOSE/CLOSED/NEG),
and normal get hierarchical 3:1 then 2:1 service (9:2:1 when all are eligible).
Controls over 16 KiB stay normal. Preserve own-stream dependencies in both
directions of ordering: terminators wait for earlier results, live EVENT waits
for EOSE, NEG errors wait for earlier NEG responses. Do not promote history.
Keep bounded attachment-local correlation and sequence ledgers in dispatch
order. Vault outgoing policy parity is tested.
Personal-copy primitives overlap at most four; sign after dependencies. Stable
context/author mirrors have bounded generation-fenced in-memory reuse after
guards, never app scopes or shared callback mutation. No storage schema changes.

## NostrDB access scheduling

- Schedule live readwrite transactions and explicitly background/maintenance
  readonly transactions once per owner database. Normal app queries, counts and
  subscriptions remain direct readonly IndexedDB work. Declare the exact stores
  touched so transactions with disjoint stores may overlap.
- Schema 4 keeps hot quota counters in `quota` and coverage in
  `accountCoverage`. Ordinary event mutations include `quota` but not
  `maintenance`; unclaimed cleanup explicitly adds `maintenance` for its
  checkpoint while retaining the atomic quota/event scope.
- Classes are launcher-owned: app `add`/`addPersonalCopy` of kinds
  9/1063/3560/26300/26400/34601 and `remove` are `foreground`; other app writes
  are `normal`; structurally validated recovery archives and account ingestion
  are `background`; quota, coverage, cache-access and other upkeep are
  `maintenance`. Unknown or malformed kinds are `normal`.
- Derive class and `appId` at the authenticated bridge boundary. Never trust
  `scheduling`, `schedulerClass` or priority fields from app options. The
  internal `recovery: true` hint may lower a structurally valid recovery archive
  or paged recovery read to `background`; it is structurally validated, removed
  before reaching NostrDB and never raises priority.
- Schedule planner and cursor transactions independently around their live IDB
  work. Do not hold a readonly slot across personal-copy decrypt, chunk hydration,
  result projection or app callbacks. At most one scheduled readonly transaction
  may touch a given owner/store; a waiting foreground write runs before the next
  background read.
- Mark validated recovery reads with the launcher-only
  `NOSTRDB_RECOVERY_READ` symbol only after `isRecoveryReadQuery()` succeeds.
  Never trust an app-supplied planning marker. Recovery planning queues one
  baseline interval and one `#o`/`&o` `getAllKeys(65)` together; a complete
  smaller path wins, while two truncated paths prefer `o`. Multi-value `o` uses
  its full OR plan without probes; no usable `o` uses baseline.
- Scan validated recovery cursors in transactions of at most 64 newly examined
  entries. Preserve `(indexKey, primaryKey)`, resume with
  `continuePrimaryKey`, and yield to the event loop between chunks so foreground
  intent can block the next one. A chunk itself remains non-preemptible; keep
  `seen`, per-cursor match limits, scores and final ordering across chunks.
- Register a foreground intent before personal-copy encryption and hold it
  through the corresponding write. It blocks new conflicting scheduled readonly
  jobs without occupying a transaction slot. Only speculative recovery planning
  is preemptible: abort its transaction, keep the original promise pending, and
  retry the planning round after foreground intent and writes clear. Cursor reads
  and other transactions retain the no-preemption guarantee.
- Keep development performance records in the bounded snapshot without console
  output by default. The launcher's `__44BILLION_PERFORMANCE_TRACE__` global
  enables every sanitized stage; `__44BILLION_SCHEDULER_TRACE__` enables only
  scheduler transitions. This avoids thousands of background lines during
  ordinary development.
- Round-robin application lanes within each class and give `system` its own lane.
  Give lower classes a bounded turn after foreground/normal traffic. Do not add
  an app queue cap or a queue-full error. Serialize intersecting stores; allow a
  lower-class job with disjoint stores to pass a blocked higher-class job.
- Cancel queued jobs on close, account removal, reset or abort, revalidate access
  and connection generation before opening, and release the slot after every
  transaction failure/abort. Never hold a scheduler slot across crypto, network,
  signer, Web Lock or timer waits.
- Cache `quotaUsage.phase === ready` per raw database connection. The first
  mutation may perform the readonly preflight; later mutations validate quota
  inside their write transaction and force one reinitialization/retry if the
  cached state is stale. Explicit quota reviews force a fresh readiness check.
