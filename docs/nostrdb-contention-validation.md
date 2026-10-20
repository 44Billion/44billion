# NostrDB contention validation — 2026-10-19

Historical results for the original exact-count planner. Production subsequently
exposed a regression on bursts of queries that were already selective; this
workload did not cover that case. See the
[2026-10-20 correction and validation](nostrdb-bounded-planner-validation.md).

This change preserves schema 3, existing stores/indexes, quota limits, event
formats and the lock-before-write-transaction order. See
[the planner and ingestion notes](nostrdb.md#selective-lookup-and-ingestion).

## Controlled archive workload

The protected Chrome fixture uses three owner databases, a small foreground
conversation, 15,000 synthetic auxiliary recovery rows, a concurrent recovery
lookup/archive write and 104 duplicate signed profile submissions per round.
Synthetic historical rows reproduce index cardinality; they are not an imported,
cryptographically validated history. Newly admitted events use real signatures
and personal-copy encryption. The comparison replaces only the core NostrDB
module with its saved pre-change source for the baseline.

Seven measured rounds per version, milliseconds, median / nearest-rank p95:

| Measurement | Before | After |
| --- | ---: | ---: |
| Foreground persistence | 963.3 / 1128.4 | 402.8 / 436.5 |
| Foreground quota-lock wait | 958.9 / 1122.9 | 0.3 / 8.6 |
| Foreground quota-lock occupancy | 2.3 / 2.4 | 394.5 / 411.6 |
| Sum of quota-lock occupancy per round | 1366.1 / 1538.7 | 479.8 / 492.1 |
| Entire round | 1480.5 / 1672.7 | 593.3 / 637.0 |
| Cumulative planning per round | 0 / 0 | 157.6 / 161.9 |

Every optimized round completed all 104 eligible duplicates through readonly
lookups. Tag cursors materialized no unrelated auxiliary rows; the baseline
materialized at least 45,000 per round. The new path also passed a two-tab
provenance-winner race and a duplicate read while another tab held the quota lock.

The foreground operation now reaches admission earlier. It can still hold the
global lock while its IndexedDB transaction waits behind previously scheduled
readonly work, including duplicate reads and index counts. Its individual
occupancy increased even though aggregate occupancy and completion time fell.
Index counts avoid materializing event payloads but are not free; these results
do not establish constant-time planning or eliminate IndexedDB scheduling costs.

Reproduce sequentially with disposable profiles and the protected harness:

```sh
git show HEAD:src/services/idb/nostrdb/index.js > /tmp/nostrdb-before.js
node bin/run-browser-tests.js -- node tests/browser/nostrdb-contention.js --baseline-index=/tmp/nostrdb-before.js --output=/tmp/nostrdb-before.json
node bin/run-browser-tests.js -- node tests/browser/nostrdb-contention.js --output=/tmp/nostrdb-after.json
```

Save the baseline from the pre-change revision; after committing, replace `HEAD`
with that revision. Never run the two browser commands concurrently.

## Complete messaging runtime

A consuming messenger was exercised with the real launcher, vault, signer,
IndexedDB, outbox and UI, using a controlled relay transport. A clean archive of
the pre-change runtime supplied the comparison. Eight sends per condition and
version, milliseconds, median / p95:

| Condition | Measurement | Before | After |
| --- | --- | ---: | ---: |
| Idle | Self-chat confirmation | 128.0 / 230.8 | 126.9 / 167.8 |
| Idle | Remote visual confirmation | 180.7 / 225.7 | 186.1 / 270.1 |
| Idle | Remote first ACK | 159.2 / 204.5 | 177.1 / 256.3 |
| History recovery | Self-chat confirmation | 153.0 / 222.0 | 174.8 / 213.5 |
| History recovery | Remote visual confirmation | 245.1 / 324.2 | 224.6 / 349.6 |
| History recovery | Remote first ACK | 225.3 / 308.5 | 202.8 / 325.9 |
| File transfer | Self-chat confirmation | 277.0 / 519.2 | 241.9 / 359.0 |
| File transfer | Remote visual confirmation | 244.3 / 291.8 | 249.6 / 342.4 |
| File transfer | Remote first ACK | 230.6 / 261.3 | 225.4 / 312.3 |

This fresh-profile runtime has a much smaller history than the archive workload.
It shows no uniform end-to-end improvement; several remote p95 values increased.
The small sample, shared machine and controlled transport do not establish a
public-relay regression or a production speed guarantee. The targeted evidence
is removal of unrelated scans and duplicate admissions, not these noisy ACK
differences. Neither fixture reproduces the production capture's exact database,
device, startup traffic or reported thirteen-second delay.

The runtime checks passed incoming delivery during a held ACK, self-chat during
that wait, a 1 MiB transfer, ACK before local persistence, and local-only recovery
after an acknowledged message's local write failed. Remote confirmation remained
independent of local persistence. Self-chat confirmation still required its
definitive local write. Direct vault synchronization passed paired-device contact
and self-chat delivery, key recovery, lock/unlock, live overflow and reload.

## Regression checks and limitations

- Launcher Node suite: 1,201 tests passed. Consumer library, messenger and vault
  Node suites also passed. Local-listener tests required an unrestricted run;
  sandbox `EPERM` failures were not treated as product failures.
- Protected Chrome: native contention/two-tab races, quota admission, readonly
  lifecycle, messaging performance/correctness, profile recovery and direct vault
  synchronization passed. Browsers ran sequentially, each under the harness's
  3 GiB / no-swap limit.
- Profile recovery passed on repetition. Its first attempt failed with a
  permission rejection during startup; the clean baseline passed. That initial
  failure remains a test instability, not a clean first-run result.
- The general self-chat suite stopped at its composer-draft assertion before
  reaching the targeted persistence cases. The identical assertion failed in the
  clean pre-change runtime. The focused messaging cases above passed; the entire
  general suite cannot be reported as passing.
- The longer private-chat scenario passed attachments, deletions and retry of the
  same event ID after reload, then failed its final persona-revocation shape
  assertion. The clean baseline failed identically: the expected object omits
  the existing `isDefaultUser` and `supportsContentKeyMethods` fields. This is
  another existing test expectation; the full scenario is not a passing suite.
- The dedicated sender-seed file-recovery scenario timed out before exposing
  its expected manual-download control, with an empty sender outbox and
  `PRIVATE_CHANNEL_FETCH_INCOMPLETE` diagnostics from the controlled transport.
  The clean baseline timed out at the same assertion, also after 267 seconds.
  Recovery after relay eviction was therefore not reached or validated by this
  scenario. This limitation is separate from the passing 1 MiB transfer checks.
- Lint for every changed JavaScript file passed. Repository-wide lint remains
  blocked by an existing HTML-plugin exception in `.history`; linting tracked
  JavaScript separately also reports existing parse/style errors in the old
  layout and unrelated tests. No unrelated lint fixes are included.
- Normal production builds for the launcher, vault and consuming messenger
  passed, without manifest or lockfile changes.

Storage schema registration and storage-audit invariants were reviewed; neither
requires a change. No dependency version, consumer contract or npm publication
is part of this delivery.
