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
- Document identity scope, permissions, handshake timing, errors, and subscription
  cleanup. Persona-scoped access must be checked in the launcher on every request
  and revoked for live subscriptions when membership changes.

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

- Run `npm test` (Node built-in test runner) and keep the theme test
  (`tests/helpers/theme.test.js`) green — it enforces token format, WCAG contrast
  pairs, and the absence of authored color literals outside `theme.js`.

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

- Use `isOnline` and `onOnline` from `libp2r2p/network`. The shared library
  monitor owns connectivity probes, capped retry delays, and browser wake-up
  listeners. `ConnectivityRetryCoordinator` owns waiters, cancellation, and
  concurrency of resumed app work; do not restore its duplicate probe timer.
- These consumer changes depend on the companion libp2r2p monitor update.
  Until it is published, validate against the sibling library locally. Update
  the npm dependency and lockfile to a version containing it before shipping;
  the current published version does not contain the monitor.

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
  Production serves `ez-vault/docs`. Preserve the existing localhost:4000 origin
  so development vault accounts remain accessible.
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
- Local controls use thenameisf and existing i18n/confirmation conventions, and
  are excluded from production builds. No new window.napp API is introduced.

- Keep `storage-event-guard.js` ahead of component mounting. The installed
  thenameisf storage adapter writes received values back; delayed remove/set
  events can otherwise echo indefinitely between tabs. The guard discards
  superseded events. Retain its regression test when upgrading the adapter.


## Account event ingestion

- `useTrackAccountEvents` owns the account feeds and aborts them on account
  removal or root unmount. Track history and live events without a kind filter
  on seed relays and known/discovered write relays, including relay-list updates.
- Store account events in the owner's existing NostrDB. Exclude NIP-78 kinds
  78/30078 (apps must claim them directly) and ephemeral events, including the
  library's tag-defined ephemeral classification. Only kinds 0 and 10002 are
  forwarded to the vault account-metadata channel. The event store owns version
  selection. No new persisted cursor, key or database is introduced.
- Event-store subscriptions support opt-in initial replay, with live delivery
  registered before the snapshot. Preserve cancellation and deduplication by ID.

The account tracker also imports already available signed vault profiles and
relay lists into NostrDB before relay delivery, preserving immediate offline
access without echoing those cached events back to the vault.
