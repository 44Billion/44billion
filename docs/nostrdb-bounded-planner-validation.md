# Bounded NostrDB planner validation — 2026-10-20

## Recovery planning follow-up

Production captures later showed five sequential recovery-planning transactions
per page, each dominated by `getAllKeys` probes at roughly 367–411 ms. They could
start before a foreground personal-copy write and delay its otherwise short
IndexedDB mutation.

The follow-up uses a launcher-validated internal recovery marker. Recovery
planning now queues baseline and the preferred `#o`/`&o` sample together,
selecting the smaller complete sample or preferring `o` when both saturate. Only
this speculative planning transaction is preemptible. A foreground intent begins
before personal-copy encryption, blocks new conflicting readonly jobs, and causes
active recovery planning to defer and retry after foreground clears. Baseline is
not used merely because planning was preempted.

## Regression and correction

The exact-count planner improved the previously broad recovery lookup but
regressed queries whose original path was already selective. Before choosing a
path, it counted every candidate interval, including broad provenance tags. A
production trace showed 115 four-count transactions created within 60 ms and
completed about 38 seconds later. The earlier cardinality benchmark did not
exercise that burst pattern; its results remain historical evidence for its
specific workload, not evidence that planning was inexpensive in general.

The replacement uses at most 16 distinct intervals, 65 primary keys per request
and 256 returned keys per planning operation, one request at a time. It accepts
the baseline when completely observed and at most 64 entries; otherwise it tries
mandatory AND values, personal-copy OR mirrors and remaining OR groups. Full
samples remain inconclusive. It never uses `count()` for planning or returns a
query result directly from a probe. See [the algorithm contract](nostrdb.md#selective-lookup-and-ingestion).

No schema, quota admission, provenance rule, permission, event format, dependency
or public API changes. The 128-record development diagnostic history additionally
allows probe/key counts, early-decision and budget-exhaustion flags; key values
and event contents are never recorded.

## Already-selective bursts and pagination

Protected Chrome, disposable profile, three owner databases, 15,000 synthetic
auxiliary recovery rows. Each burst combines reads, a new signed foreground
write and real coverage read/write transactions in all three accounts. Empty
queries target conversations with no matching messages. The pagination phase
creates 50 real encrypted personal copies and checks five distinct ten-message
pages while another self-chat copy is stored. Both versions verify every result.

Five measured rounds per case and version. The comparison overrides only the
planner with the exact-count source saved before this correction. Numbers are
milliseconds, median / nearest-rank p95 across rounds:

| Case | Exact-count round | Bounded round | Exact-count foreground write | Bounded foreground write |
| --- | ---: | ---: | ---: | ---: |
| 1 empty query | 94.3 / 102.0 | 6.9 / 8.0 | 93.2 / 100.6 | 6.1 / 7.1 |
| 25 empty queries | 1899.1 / 1915.2 | 12.0 / 13.3 | 1897.2 / 1913.5 | 10.3 / 11.7 |
| 100 empty queries | 7642.2 / 7823.5 | 27.1 / 32.5 | 7636.1 / 7820.4 | 23.8 / 28.7 |
| 100 paginated reads | 8000.2 / 8187.4 | 54.5 / 180.6 | 7972.0 / 8158.2 | 37.7 / 164.9 |

The corrected planner issued zero count calls. Each empty read stopped after one
empty key probe; every paginated read stopped after one probe of at most 50 keys.
Tests assert the per-request 65-key and per-operation 256-key limits. A single
pagination round had higher bounded write occupancy (160.5 ms); it remains in the
reported p95. Planning durations summed across concurrent queries include
overlapping waits and must not be interpreted as CPU time or wall-clock duration.

Reproduce sequentially, saving the exact-count module from the pre-fix revision:

```sh
git show babaf5f:src/services/idb/nostrdb/query-plan.js > /tmp/exact-count-plan.js
node bin/run-browser-tests.js -- node tests/browser/nostrdb-query-planning.js --planner-source=/tmp/exact-count-plan.js --output=/tmp/exact-bursts.json
node bin/run-browser-tests.js -- node tests/browser/nostrdb-query-planning.js --output=/tmp/bounded-bursts.json
```

## Previously broad recovery workload

Seven rounds per version of the existing native contention fixture, with 104
duplicate profile submissions and concurrent archive lookup/write. Same saved
planner comparison, milliseconds, median / p95:

| Measurement | Exact-count | Bounded |
| --- | ---: | ---: |
| Foreground persistence | 412.3 / 455.2 | 16.4 / 18.0 |
| Foreground quota-lock wait | 0.3 / 9.0 | 2.6 / 4.1 |
| Foreground quota-lock occupancy | 406.6 / 453.6 | 12.5 / 12.8 |
| Sum of lock occupancy per round | 489.7 / 537.2 | 15.0 / 15.3 |
| Entire round | 608.3 / 645.0 | 132.9 / 146.7 |
| Cumulative planning per round | 161.0 / 169.1 | 1.8 / 2.1 |

All 104 eligible duplicate submissions still bypassed quota admission in each
round. No unrelated auxiliary wrappers were materialized. The bounded fixture
materialized 0–6 legitimate copies from the small foreground context as successive
rounds added messages; exact counting had selected the narrower source-ID path.
Both versions passed deterministic two-tab provenance-winner selection and a
readonly duplicate while another tab held the global quota lock.

```sh
node bin/run-browser-tests.js -- node tests/browser/nostrdb-contention.js --planner-source=/tmp/exact-count-plan.js --output=/tmp/exact-archive.json
node bin/run-browser-tests.js -- node tests/browser/nostrdb-contention.js --output=/tmp/bounded-archive.json
```

These fixtures model historical index cardinality, not the exact production
database. Historical rows are synthetic; newly admitted messages use real
signatures and encryption. Small sample sizes, shared-machine scheduling and the
absence of public-relay transport preclude a production latency or delivery
guarantee. The demonstrated change is removal of unbounded planning work while
preserving query results and the earlier ingestion improvements.

## Regression coverage

The complete launcher Node suite passed 1,212 tests. Planner tests cover empty,
1/64/65-entry candidates, OR completeness, AND and mirror ordering, truncated
samples, the 256-key and 16-interval budgets, local-only sample reuse, storage
failures, supplied write transactions and unchanged direct/sync paths. An
integration test queues an insertion after an empty planning probe and verifies
that the actual query still sees it. Quota/provenance tests retain concurrent
admission, readonly generation fences, duplicate-reference and rollback checks.

The existing library, messenger and vault Node suites also passed, without source
or dependency changes. Protected Chrome message-delivery checks passed with the
real launcher, signer, vault, outbox and UI: self-chat while an ACK was held,
incoming delivery during the wait, a concurrent 1 MiB transfer, ACK independent
of local persistence, and local-only retry without republication or confirmation
regression. Direct paired-vault synchronization passed contacts/self-chat,
content-key recovery, lock/unlock, controlled live overflow and reload.

Fresh-runtime timings for eight local and eight remote sends in each condition
are included for context, milliseconds, median / p95. This is not a paired UI
before/after comparison or a reproduction of the production database:

| Condition | Self-chat visual confirmation | Remote first ACK | Remote visual confirmation |
| --- | ---: | ---: | ---: |
| Idle | 167.1 / 220.3 | 173.2 / 231.4 | 192.4 / 236.0 |
| History recovery | 203.3 / 357.0 | 223.6 / 305.5 | 237.4 / 354.5 |
| File transfer | 334.5 / 433.3 | 235.2 / 287.4 | 248.3 / 297.8 |

The complete visual history fixture is **not** a clean passing validation. Two
current runs observed 42 and 29 messages where the opening assertion expected
exactly 25; another reached pagination but failed its scroll-anchor assertion.
A clean pre-fix runtime passed the full fixture once, but reproduced the anchor
failure in the same no-measurement mode. A diagnostic run of that baseline with
only a one-second delay before the opening assertion observed 75 messages with
history loaded and older loading finished. Thus the fixed opening-size check
depends on observation timing even in the old runtime. No production consumer
or tracked consumer test was changed, and no assertions were weakened to claim
a pass. Native pagination/result checks above pass; visual opening/anchoring
stability was not established by that initial validation. The fixture corrections
are described in the follow-up below.

During that initial validation, lint passed for every changed JavaScript file,
but repository-wide lint failed in the existing `.history` HTML processor with
`TypeError: config.getRuleDefinition is not a function`; no unrelated lint changes
were included. Storage schema registration and audit/repair invariants were
reviewed and remain unchanged.

Normal production builds for the launcher, vault and consuming messenger passed.

## Validation tooling follow-up

Repository-wide lint now imports global exclusions from `.gitignore` using
neostandard's existing helper. The HTML processor failure also affected a tracked
loader template; upgrading the development-only HTML plugin to 8.2.1 fixes its
flat-config compatibility without excluding that template. Existing syntax and
style errors exposed by the full run were corrected. Configuration tests verify
both global ignores and continued rule execution on tracked HTML scripts. The
complete launcher Node suite passed 1,214 tests, and repository-wide lint passed.

The consuming messenger's history fixture now isolates the initial 25-copy page
from automatic viewport pagination. It holds UI page requests at the account
boundary, confirms an actual reading position away from the bottom, waits for
stable geometry, then captures the viewport controller's first readable row and
releases exactly one real page. The original signer, permissions and event store
remain in use. Timestamp ties, 235 unique messages, the three-pixel anchor bound,
draft retention and deletion/recovery assertions remain in place. Both diagnostic
modes exercise the same assertions; the optional measurement is no longer needed
as an accidental delay before measuring the anchor.

The broader text/scroll fixture now checks the documented optimistic-send
contract through real permission denial and retry, preserving event identity and
a newer draft. It drains the previous native permission modal before revocation,
and compares internal widths when asserting the absence of horizontal overflow;
border width is not overflow. The terminal scoped-state assertion includes the
current nullable capability and provisional-identity fields.
Only the HTML lint development dependency and its lockfile entries changed in
this follow-up; there is no runtime dependency update or package publication.

Protected sequential Chrome runs passed the final history fixture both with and
without the measurement phase. Anchor drift was 0.046875 and 0.34375 pixels,
respectively, with cgroup peaks of 2,818 and 2,683 MiB. The full text/scroll group
also passed at 2,100 MiB. All used the unchanged 3 GiB guard with swap disabled.
The complete private-chat group, including terminal scoped-state revocation,
passed at 1,942 MiB. The consuming messenger's complete Node suite also passed.
Normal production builds for the launcher, vault and consuming messenger passed
again after these tooling changes.
