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


Account event tracking continuously imports selected known public kinds authored by available
accounts from their current write relays into each owner's event store. Seed
relays are queried only for relay lists (10002). A newer relay list starts feeds
on added write relays and stops removed ones, draining events already accepted
before removal. A removed relay that is also a seed keeps only its relay-list
discovery feed. Account removal or root unmount cancels pending delivery.
Write feeds explicitly select kinds from libp2r2p's `eventKinds`, deduplicated
and split into groups of at most 30 (currently 85 kinds in three feeds per relay).
Each group retries independently; removing a relay stops and drains all its groups.
This avoids broad filters and 44b-relay's truncation of longer kind lists. Seeds
retain their separate kind-10002 discovery feed. Unknown kinds are not imported;
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
