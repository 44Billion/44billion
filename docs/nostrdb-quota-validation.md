# Asynchronous NostrDB quota validation

## Contract

Ordinary mutations update their owner's existing `maintenance.quotaUsage` row
in the event transaction. They neither acquire the origin quota Web Lock nor
enumerate or sum other owners' databases. Legacy counters are initialized only
for the bank being modified. The existing exclusive lock remains responsible
for aggregate maintenance, settings and database lifecycle operations.

Positive budgets permit temporary overshoot until maintenance observes it;
there is no strict bound on that overshoot. Known category gates reject new net
growth, while deletion, unchanged duplicates and non-growing replacements remain
possible. Reference-induced category transfers preserve existing targets even
when their destination budget is exceeded. Zero budgets refuse growth
immediately. Cache cleanup is background-only.

These are logical UTF-8 serialized event-byte budgets, not a promise about
physical browser storage. IndexedDB failures still surface normally. No database
version, store, index, event, wrapper, app API or dependency changed.

## Deterministic checks

`npm test` passed all 1,232 launcher tests. Coverage includes:

- Cross-owner insertion and deletion while another operation holds the global
  maintenance lock; foreground database enumeration is forbidden by the fixture.
- Concurrent overshoot followed by category-specific blocking; exclusion and
  limit increases restore admission. Failed reviews retain known gates.
  An existing but inaccessible bank cannot publish a partial replacement total.
- Local counters, replacement deltas, transaction rollback, deletions, expiration,
  app cleanup, protected references/chunks and resumable legacy initialization.
- One-second coalescing without deadline postponement; 64-transaction/4-MiB
  acceleration; 250-ms start separation; dirty follow-up, idle cadence, cache
  follow-up and capped backoff with a controlled clock.
- Persist-before-notify snapshots, immutable inputs/outputs, stale revisions,
  invalid summaries, failed persistence and attention clearing after quota raises.
  Failed quota broadcasts do not fail committed mutations or durable reviews.

Run the focused files with:

```sh
node --test --experimental-test-module-mocks \
  tests/services/nostrdb-quotas.test.js \
  tests/services/nostrdb-quota-state.test.js \
  tests/services/chunk-cache.test.js \
  tests/services/storage-audit.test.js
```

The relay registry TTL and idle NEG tests previously depended on real delays
of a few milliseconds. Both now use controlled time and assert expiry boundaries,
so busy integration runs cannot expire their fixtures during setup. Browser
context selection now scopes frame metadata by CDP session and excludes internal
bridge/download documents; unknown frame URLs never qualify as app contexts.

## Protected Chrome integration

All browser checks use `bin/run-browser-tests.js`, disposable profiles and
sequential invocations, with the existing 3-GiB/no-swap cgroup restriction.

The quota scenario checks actual two-tab admission/removal while maintenance is
held, cross-tab growth gates, retained protected references, access updates,
reload and owner removal. The event-storage scenario passed three consecutive fresh-profile runs after
synthetic field edits/clicks were synchronized with controlled-value render
commits. It checks percentages beyond
100%, excess bytes, zero limits, accessible capped bars, the menu/Settings/storage
notification chain, drafts, failure/retry, themes and navigation.

```sh
node bin/run-browser-tests.js -- node tests/browser/nostrdb-quotas.js
node bin/run-browser-tests.js -- node tests/browser/event-storage.js
node bin/run-browser-tests.js -- node tests/browser/nostrdb-readonly.js
node bin/run-browser-tests.js -- node tests/browser/account-events.js
```

The current private-chat and signer consumers are additionally exercised through
their protected runtime fixtures with the real signer, injected APIs and storage.
Only transport/probe/media boundaries are controlled. Self-chat confirmation
still depends on its local commit; remote ACK confirmation remains independent
of local persistence.

The attachment regression reproduced with the baseline launcher as well. Its
caption assertion needed to bring the new row near visibility before expecting
lazily resolved metadata. Its cold locked-startup assertion incorrectly required
a history failure, although account availability now defers opening that history.
The updated fixture first checks deferred startup and disabled sending, then
explicitly requests the real history service while locked to exercise failed
reads and unlock/Retry coverage.
The preview checks wait for decoded images and reveal new offscreen references.
The lock/send scenario now waits for the app notification, verifies disabled
sending and retained preparation, then sends after unlock without recompression.
Accepted-send failure/retry identity and byte retention stay covered by the
consumer's deterministic tests. No production message behavior was changed to
satisfy those assertions. The scroll cohort starts beyond earlier future
timestamps; scroll gap sampling runs after the rendering turn so it observes
ResizeObserver compensation rather than intermediate pre-paint positions. The
two-pixel gap tolerance and no-initial-animation assertions are preserved.
Attachment deletion after reload explicitly pages to a catalog-backed message
instead of assuming the most recent 25 rows include a file.

## Performance comparison

Baseline: launcher commit `373a889`. The benchmark overlays only the original
NostrDB `index.js` and `quotas.js` while bundling, without replacing working-tree
files or installed packages. Each version runs in its own disposable profile.

Three owners contain 5,000 auxiliary recovery-like personal copies each. Each
scenario measures 12 sequential prepared private-copy saves: idle; 25 concurrent
history queries; and 100 concurrent signed profile writes. The benchmark verifies
local counter totals. Run with an optional JSON source map of the baseline:

```sh
node bin/run-browser-tests.js -- node tests/browser/nostrdb-quota-performance.js baseline.json
```

Results are written to `/tmp/44billion-quota-performance.json`. The final isolated
run on 2026-10-20 produced the following values (milliseconds):


| Scenario | Baseline median / p95 | Current median / p95 | Bank enumerations, baseline / current |
| --- | ---: | ---: | ---: |
| Idle | 6.8 / 22.1 | 5.0 / 16.5 | 12 / 0 |
| 25 history queries | 7.6 / 64.9 | 5.5 / 47.5 | 12 / 0 |
| 100 profile writes | 7.1 / 415.7 | 9.2 / 128.5 | 112 / 0 |

The largest p95 improvement occurred while profile writes competed across banks,
although that scenario's median increased from 7.1 to 9.2 ms in this run. No foreground bank enumeration or
global quota-lock wait remains. This does not remove normal IndexedDB transaction
serialization within a bank.

Background maintenance is disabled in this foreground microbenchmark. This is
an isolated IndexedDB experiment: wrapper preparation/decryption is
controlled, not a measurement of the real vault, relay latency, first ACK or the
chat bubble. With 12 samples, p95 is the largest observation. Production captures
have different history, hardware and startup work; these figures cannot establish
an end-to-end delivery deadline. The causal checks are foreground completion
while maintenance owns the lock and zero foreground cross-bank enumeration.


## Final regression results

| Suite | Result |
| --- | ---: |
| Launcher Node | 1,232 passed |
| Messaging library Node | 937 passed |
| Private-chat consumer Node | 388 passed |
| Signing vault Node | 403 passed |

The library fixture now controls relay-list discovery and connectivity as well
as message transport. Its formerly live NIP-65 discovery sockets no longer keep
the deterministic suite running after its assertions complete. No library
production files or package versions changed.

Protected Chrome passed foreground mutations under the held maintenance lock,
quota propagation between tabs, storage UI (three consecutive runs), read-only
lifecycle, real account-event ingestion, full self-chat/attachments/scroll/order/
delete/reload, direct paired-vault synchronization (including overflow recovery),
and remote send timing/first-ACK behavior. The full chat run peaked at 2,392 MiB;
the paired-vault run peaked at 1,914 MiB, both below the 3-GiB guard.

The remote timing fixture observed envelope preparation at 233.8 ms and fallback
start at 3,003.7 ms from the send request. It confirms the existing timing/ACK
contract with controlled transport; it is not a production latency distribution.

Launcher-wide lint, private-chat consumer lint and lint of the changed library
fixture passed. Normal production builds passed for the launcher, signing vault
(the launcher's ordinary build preparation) and private-chat consumer. Manifests
and lockfiles stayed unchanged; no npm publication or local dependency reference
was introduced.


The final package check found stale 0.11.27 library files in the launcher/vault
installations despite their 0.11.28 lockfile metadata. Ordinary `npm install`
had not repaired that mismatch. Clean lockfile installs restored the declared
registry package; the vault install needed npm 12's per-command `allow-remote=root`
for its existing direct JSR alias, without changing project configuration. Package
file hashes now match the private-chat consumer's installed 0.11.28. Launcher/vault
Node suites, browser integration, performance and production builds were repeated
against those restored bytes. Manifests and lockfiles remain unchanged.
