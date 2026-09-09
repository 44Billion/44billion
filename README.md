# 44billion

A Nostr app launcher with isolated app origins, injected signer/event-store APIs,
local app installation, and live draft updates. See [APP_API.md](APP_API.md) for
the injected contract and [AGENTS.md](AGENTS.md) for contribution rules.

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

Version locks protect files still used by open tabs. Installation failures keep
the previous manifest; obsolete files are pruned once their versions are unused.
Stopping a watcher preserves the last cached installation. Uninstalling removes
its classification. Local development does not validate remote upload/discovery;
use the publishing workflow to check those paths.
