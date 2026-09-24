# 44billion

A Nostr app launcher with isolated app origins, injected signer/event-store APIs,
local app installation, and live draft updates. See [APP_API.md](APP_API.md) for
the injected contract and [AGENTS.md](AGENTS.md) for contribution rules.

[NostrDB internals and maintenance](docs/nostrdb.md) documents event-store cleanup,
concurrency, recovery and storage growth limits for developers.

## Development

Install npm dependencies here and in the sibling `ez-vault` repository. Node.js
24+ and Python 3 are required. Run `npm start` to start or reuse the local runtime:

- Launcher: `http://localhost:10000`
- esbuild: `http://127.0.0.1:8080`
- Existing development vault origin: `http://localhost:4000`

The supervisor waits for the builds, rejects port conflicts, and stops only its
own children on shutdown. The vault uses untracked `.dev` output, also available
through `http://vault.localhost:10000`; production uses `ez-vault/docs`.
`/__dev/health` identifies this checkout and reports readiness in development only.

Sibling apps can import `ensureRuntime()` from `bin/dev-runtime.js`. The returned
handle includes `url`, `owned`, `closed`, and an asynchronous `close()` method.
Reusing a server never transfers ownership of its processes.

`npm run start:adb` starts/reuses this runtime and exposes ports 10000 and 4000
to Android using `adb reverse`. Install Android platform-tools, enable debugging,
authorize the computer, and verify `adb devices` first. Open
`http://localhost:10000` in Chrome/Edge on the phone. Use `-- --debug` for verbose
console logs, `-- --browser=edge` to prefer Edge, or `ANDROID_SERIAL` to select a
device. [Wireless ADB](https://developer.android.com/tools/adb#connect-to-a-device-over-wi-fi)
also works after pairing and connecting. Phone storage and vault accounts are
separate from the desktop browser.

`bin/adb-session.js` exposes `startAdbSession({ signal })` for consumer development
tools. Its handle owns only the ADB mappings it creates, with a `close()` method;
matching existing reverse mappings are reused and conflicts fail explicitly.
The console uses a dynamically assigned host port (`CDP_PORT` can override it).
ADB stays active when the supervisor reuses an existing launcher. Ctrl+C awaits
owned runtime cleanup and removes owned mappings; esbuild's 8080 stays internal.

## Validation

`npm test` runs the Node suite; `npm run test:browser` runs the launcher's existing
Chrome regressions. `CHROME_BIN` selects a Chrome executable. Consumer apps can use
`tests/browser/runtime/` to install local, unpublished builds with the production
manifest/chunk writers and test the full launcher in disposable Chrome profiles.
The Chrome helper blocks external traffic by default and supports network fixtures.

A normal app-document reload preserves data. A new draft version currently clears
app-origin data and app-owned events before reloading. The initial manifest and
relay replays of an installed version do not trigger that cleanup. Draft events
received before the first manifest is saved wait for the normal update poll;
only a newer manifest with a different file aggregate triggers a reload.
Persistence tests must keep the version fixed and reload normally. Browser test
fixtures are never production APIs or published app files.

## Local app development

Consumer apps can use `bin/local-app-publisher.js` with `ensureRuntime()` to serve
watched builds without publishing. Open the printed local link in an ordinary
browser, including Android with the existing forwarded ports.

The development-only `/__dev/apps/` routes accept registered build bytes, provide
SSE notifications and receive installation reports. Registration requires the
private token in `tmp/local-dev-session.json`, owned by the running local server.
No arbitrary filesystem paths are served and no injected app API is added.

The browser keeps a persistent local-app classification and uses the real cache
writers. New files are verified and stored before activating the manifest. Reloads
preserve the app route, storage and eventStore; published draft updates still clear
runtime data. A confirmed **Clear local app data and reload** action in the app
menu clears only the selected user/app, coordinating other instances first.
Above it, **Reset development environment and reload** deletes every account in
the vault and all local data of every app in the browser, then reloads into a
clean launcher. It aborts and reports an error when the vault is unreachable,
because the accounts would come back on the next load. Reopen the local link
printed by the watcher to reinstall the app files.
Failures of either development reset open an informational dialog (no action
button, only dismiss) instead of a menu notice.

Version locks protect files still used by open tabs. Installation failures keep
the previous manifest; obsolete files are pruned once their versions are unused.
Stopping a watcher preserves the last cached installation. Uninstalling removes
its classification. Local development does not validate remote upload/discovery;
use the publishing workflow to check those paths.


Account event tracking groups writable accounts by relay and kind selection.
Read-only accounts use separate metadata-only groups (see below). One launcher coordinator owns the feeds; seeds read
only kind 10002, and current write relays import eligible public kinds into each
author's own NostrDB. Filters contain at most 30 distinct kinds and 500 authors.
A newer relay list reconciles membership, retaining unchanged groups and draining
accepted events from retired groups. Removing an account or unmounting the root
cancels its pending delivery. Only kinds 0/10002 also update vault metadata.

The published `libp2r2p@^0.10.22` pool coordinates subscription capacity. Grouped
feeds start with a bounded recent snapshot, with **ten minutes of overlap**.
Before releasing buffered live events, the tracker completes any truncated recent
pages and catches up gaps from each identity/kind's previous confirmed edge.
New accounts fill older history in the background. Queries group only compatible
bounds; live membership is independent of previous coverage. There is no periodic historical refresh. The pool emits ordered `live-progress`
controls every 60 seconds of healthy live observation, including quiet periods.
The tracker commits those intervals only after earlier event writes finish.
Interrupted live attempts are cancelled, dropping buffered events and retrying
with ten minutes of overlap from confirmed coverage. Progress describes observed
continuity, not proof that a relay supplied every event.

Read-only accounts follow kind 10002 on seeds and kinds 0/10002 on discovered
write relays, forwarding newer versions to the vault. Their initial snapshot has
no recent-time restriction; saturated batches split by author and kind. They do
not open NostrDB or store coverage. Changing to read-only deletes the owner's DB
and its chunk-cache references, preserving shared payloads used by other owners.
A durable deletion intent blocks access until interrupted cleanup completes,
even if the account becomes writable again. Locked accounts with private keys
can still store already-signed public events. Profiles, relay lists, workspaces
and app installations remain available outside NostrDB.

Inclusive coverage is persisted per owner, normalized relay and kind, after
all corresponding event writes commit. Reloads resume missing history instead of
re-reading completed intervals. Startup drops records for no-longer-selected
kinds and registers new kinds without coverage; new relays also start empty.
Removing a relay retains its coverage, while deleting the owner database removes
it. Ordinary event deletion does not reset sync progress or resurrect that event.

Historical reads request at most 200 events. EOSE alone is not proof of complete
coverage: saturated responses are subdivided by timestamp, then author/kind at a
single second. For the exceptional case of 200 events from one author/kind/second,
the received events are saved and that second is considered covered with a
warning; excess events may be missed because standard NIP-01 has no ID cursor.
Coverage describes the relay's returned data, not a guarantee of remote retention
or completeness. Confirmed old history is not revisited; events arriving later
outside the recent overlap may therefore be missed.

Failed initial history/storage attempts discard buffered live and retry with
capped backoff and jitter; completed subwindows remain confirmed. Backfill and
periodic-refresh failures preserve an initialized live stream. Explicit permission
or invalid-filter refusals are not retried automatically. Error diagnostics include
relay, phase and selection without event content. Unknown kinds are not imported;
new known kinds enter through updates to the library's list, subject to exclusions.

Automatic import excludes ephemeral kinds and tag-defined ephemeral events, plus:

- NIP-78 app data (78/30078) and personal copies (1006).
- Encrypted DMs (4), seals (13), private DMs (14), gift wraps (1059) and private
  channel broadcasts (3560).
- Mute lists (10000), bookmarks (10003), bookmark sets (30003) and kind mute sets
  (30007).
- Long-form drafts (30024), classified-listing drafts (30403) and binary chunks
  (34601).

These exclusions affect automatic account import only. Apps retain their own
explicit ingestion flows; the policy does not prohibit storing these kinds in
NostrDB. File metadata (1063), deletions (5), follows (3) and other eligible public
lists remain included. Only profiles (0) and relay lists (10002) additionally go
to the vault's account-metadata channel. Apps can treat the store as the local
source of truth for their user's public events and private personal copies;
third-party public events remain relay-backed caches. See [APP_API.md](APP_API.md)
for personal-copy reads and subscriptions with initial replay.

Apps can prepare native, streaming downloads of `nostr.alt/nfile1…` files with
`window.napp.getFileDownloadUrl()`. The reserved route belongs to the app origin
and bridge instance; `localOnly=1` never queries relays. See [APP_API.md](APP_API.md)
for filename, range, cancellation and instance-lifetime behavior.

Browser npm scripts run inside a Linux user-systemd service limited to 3 GiB
(including Chrome, launcher, vault and build children), with swap disabled and
an automatic 15-minute stop. The runner reports the observed memory peak.
Stop an existing development runtime before testing so every process is inside
that group. For individual scripts use
`node bin/run-browser-tests.js -- node tests/browser/app-bridge.js`.
Do not run multiple browser suites concurrently; unsupported systems fail
explicitly instead of silently running without a memory limit.

### Browser source maps

`bin/build-settings.js` contains the single `EMIT_SOURCEMAPS` switch (default
`true`). It controls production builds, including launcher chunks, service workers
and injected bridge scripts. Development always emits source maps, regardless of
this flag. Set it to `false` and rebuild production to omit both map artifacts and
`sourceMappingURL` references. This does not revoke copies already downloaded by
someone else.

Maps include original source text (including bundled dependencies) and are served
as JSON from `/~~sourcemaps/<sha256>.map` on the launcher and numeric app origins.
Deploy the complete `dist/44billion` output, including `~~sourcemaps`. Only the
current build is retained; an old tab may get a 404 until reloaded. Hashes prevent
old code from using a different build's map. The shared router used by the
production server provides these routes without separate server configuration.

Map responses use `Cache-Control: no-store`. Both service workers send these
requests directly to the network, without Cache Storage, offline fallback or app
bridge access. Maps are fetched on demand by debugging tools, not precached.
Enable JavaScript source maps in browser DevTools to inspect original files and
set breakpoints. Injected scripts appear under `/~~injected/` as debugger names;
these names are not additional HTTP script routes.

The development build publishes code and maps together in memory on port 8080
and streams reload notifications at `/esbuild`. Failed builds retain the previous
successful snapshot and report failure to the development supervisor.

Validation: `npm test`, `npm run build`, and
`node bin/run-browser-tests.js -- node tests/browser/sourcemaps.js` (after a
production build and with the development runtime stopped). The Chrome check
uses the production router and bundles on temporary local ports; external traffic
is blocked and the existing 3 GiB runner limit applies.
