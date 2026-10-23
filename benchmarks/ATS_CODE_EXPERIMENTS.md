# ATS code experiments: virtual time and fixture hashing

Follow-up to [the initial ATS validation](ATS_VALIDATION.md), 23 October 2026.
**Superseded as the latest result by [the sub-30 s experiments](ATS_SUB30_EXPERIMENTS.md)**
(26.8–28.1 s, six workers). This file remains the record of the lease and fixture-hash changes.
The focus is portable **ATS/Japa-related code improvements**, not relocating the
database or buying more infrastructure. All ATS changes below exist only in the
isolated copy. No new Japa runtime optimization was shipped during this phase.

## Retained result

| Full unit run | Wall time | Failed / total |
| --- | ---: | ---: |
| Original ATS serial reference | 247.094 s | 19 / 8,515 |
| Fork, four workers, initial SMTP fixture fix | 86.453 s | 19 / 8,515 |
| Four workers + virtual lease time + scoped fixture hash cache | 46.174 s | 19 / 8,515 |
| Repeat, also using bounded dependency-file reads | 48.338 s | 19 / 8,515 |

Both retained follow-up runs matched all 8,515 test identities and exactly the
19 baseline failures, with one skipped test and no missing/extra/duplicate tests.
That is about **1.8–1.9× faster than the earlier four-worker run**, or **5.1–5.35×
faster than the original serial reference**. These are individual runs, not a
large repeated-median experiment; the bounded-read change is not separately
credited with a whole-suite gain.

**Neither a safe sub-30-second full run nor a sub-three-second full run was
achieved.** Faster-looking variants that added failures or lost results are not
accepted as wins. The full suite still has its 19 baseline failures.

## Change 1: advance lease time instead of sleeping

Patch: [lease-virtual-time.patch](ats-validation/experiments/lease-virtual-time.patch).
Affected file: `apps/web/tests/unit/services/lease.spec.ts`. No production lease
implementation changes are needed.

The heartbeat tests slept for 6+7, 6+7, and 7 seconds: **33 seconds of intentional
wall time**. The copy now optionally virtualizes `Date`, `setInterval`, and
`clearInterval` for the heartbeat group. It deliberately leaves Japa's
`setTimeout` timeouts and performance measurement real.

PostgreSQL stays real. Advancing the JavaScript clock does not pretend that
pending SQL has completed: the tests poll the real row for renewal, and drain
in-flight work through `heartbeat.stop()` before checking a stolen lease. The
stop test also checks that its interval is removed. Cleanup restores the clock.
The existing real concurrent-claim/CAS tests remain in place.

All 19 lease tests passed. Summed test execution dropped from about **33.8 s to
0.785 s**, while the standalone command still took 11.928 s including app boot,
migrations, seed, and shutdown. The first targeted prototype used virtual time
unconditionally; the saved patch gates it behind
`JAPA_EXPERIMENT_VIRTUAL_LEASE_TIME=1` so it can be compared with real waiting.
No test timeout was increased and no renewal/owner assertions were dropped.

## Change 2: reuse a valid hash for ordinary fixture passwords

Patch: [fixture-hash-cache.patch](ats-validation/experiments/fixture-hash-cache.patch).
Affected files: `apps/web/tests/helpers/factories.ts` and the new test helper
`fixture_hash_experiment.ts`.

`UserFactory.create()` supplies the same default plaintext password repeatedly.
The app uses real scrypt at cost 16,384. Passing a precomputed hash directly to
`User.create()` does **not** work: the auth model hook hashes the encoded string
again. Inspection ruled that approach out before relying on it.

The prototype uses `AsyncLocalStorage` to identify calls inside this factory.
Only the factory's exact default password, `password123`, can reuse one genuinely
computed scrypt hash per worker. Other passwords and calls outside that scope
invoke the original hasher. Verification remains real, as do model hooks and DB
writes. A rejected hash Promise is cleared so it cannot poison future fixtures.
The helper is gated behind `JAPA_EXPERIMENT_FIXTURE_HASH_CACHE=1`.

Three sequential samples of 25 default fixture users:

| Variant | Samples | Median |
| --- | --- | ---: |
| Real hashing for every fixture | 779.430 / 779.760 / 764.280 ms | 779.430 ms |
| Scoped default-password reuse | 31.011 / 26.768 / 29.366 ms | 29.366 ms |

That narrow fixture operation was about **26.5× faster**; the whole suite was not
26.5× faster. In the first retained full run, four workers reported 3,456 cache
hits and four initial cache misses. Remaining real hashing and verification were
not disabled.

Validation:

- Seven probe cases passed with caching both off and on: default/wrong-password
  verification, custom passwords and their distinct salts, fresh salts outside
  factory scope, null passwords, and three creation samples.
- All 18 session-controller HTTP tests passed with caching enabled, including real
  credential login. They were a correctness check, not another speed benchmark.
- Two full four-worker unit runs matched the baseline identities/failures.
- Modified ATS files passed targeted `oxlint --type-aware` checks. The copied root
  config emitted a Node module-type warning; there were no lint errors.

This is a **test-fixture prototype**, not a faster password algorithm. It reuses
one salt/hash for the default fixture password; tests of salt uniqueness or hash
work factors must use the real path. The helper wraps a shared driver method and
must be reviewed for interactions with tests that replace hash drivers before a
permanent ATS integration. It must never become a production authentication cache.
No production hashing configuration was reduced.

## Change 3: read dependency-scan inputs in bounded batches

Patch: [dependency-scan.patch](ats-validation/experiments/dependency-scan.patch).
Affected file: `apps/web/tests/unit/constants/declared_dependencies.spec.ts`.

The test read each source file sequentially. Under eight-worker load it exceeded
its unchanged two-second timeout. The patch reads batches of 32 files using
`Promise.all`, preserving input/report order and every dependency assertion.
It limits open descriptors/memory instead of issuing an unbounded read per file.

Both targeted tests passed, with about 1.123 s summed execution. The full
four-worker repeat also passed the scan. **This did not make eight-worker runs
reliable**: the scan could still time out under that load. Do not present it as
solving all contention or increasing the timeout to make the numbers green.

## Attempts not retained

| Variant | Wall time | Outcome / reason not accepted |
| --- | ---: | --- |
| Eight workers, clock + fixture cache, empty DBs | 39.666 s | All identities present, but one extra dependency-scan timeout: 20 failures. |
| Eight workers, prepared DBs + diagnostic duration profile + batched scan | 36.659 s | The same extra scan timeout remained. |
| Six workers, prepared DBs + diagnostic profile | 39.236 s | Worker 6 produced no report; only 6,998 results were collected. Cause not fully diagnosed. Coordinator correctly failed; this is incomplete, not a speedup. |
| Four workers, prepared DBs + diagnostic profile | 45.442 s | Two additional workflow/backfill assertions failed after regrouping; 21 failures. |
| Four workers, prepared DBs, original assignment | 45.133 s | One additional chat event-order assertion failed; 20 failures. No meaningful gain over the retained cold runs. |

A clean template DB was prepared by booting, migrating, and seeding with an
explicit no-match test selection; no test cases ran during preparation. Preparation
took 10.187 s, outside later timings. This was not a free removal of setup cost.
The diagnostic profile was generated from the earlier completed 8,515-test result,
not automatically promoted by a failing run. Production history promotion rules
were not changed. The snapshot/profile attempts were exploratory and are rejected
as a recommended retest configuration.

The host has 96 GiB RAM; Docker reported 12 CPUs and about 7.65 GiB VM memory.
Those limits and cross-VM queries may contribute to contention, but resource
settings were not changed and no causal claim was established. An exploratory
read-only client-latency probe accidentally enabled pgbench debug logging; those
measurements are invalid and are not used. No database relocation was adopted.

## Applying/retesting the code prototypes in the copy

The primary deliverables are the three independent patches above. They apply on
top of the initial copy-only isolation/SMTP patch. A combined
[copy-only-speed.patch](ats-validation/experiments/copy-only-speed.patch) is also
saved; use either the combined patch or the three individual patches, not both.

The existing local lab already contains the prototypes. For a fresh lab, first
follow [the base rebuild runbook](ATS_VALIDATION.md), then check/apply patches
**only in the copied app**:

```sh
cd /Users/simonkhalimonov/Projects/Code/japa-speed/runner
git -C .benchmarks/ats-validation/app apply --check ../../../benchmarks/ats-validation/experiments/copy-only-speed.patch
git -C .benchmarks/ats-validation/app apply ../../../benchmarks/ats-validation/experiments/copy-only-speed.patch
```

Use the base four-worker harness/Compose setup. Extra services or the
snapshot/profile harness are not required for the retained code result. Ensure
the fork packages are selected and the lab services are ready, as described in
the base runbook. Then:

```sh
node .benchmarks/ats-validation/reset_databases.mjs 4
JAPA_EXPERIMENT_FIXTURE_HASH_CACHE=1 JAPA_EXPERIMENT_VIRTUAL_LEASE_TIME=1 node .benchmarks/ats-validation/run_case.mjs code-retest-4 4 unit
node .benchmarks/ats-validation/compare.mjs baseline-unit-isolated fork-unit-parallel4-mail-reset code-retest-4
```

Use new labels on every run. Leave `JAPA_EXPERIMENT_DB_SNAPSHOT` and
`JAPA_EXPERIMENT_HISTORY` **unset**: the retained configuration starts with empty
DBs and the original managed assignments. The experimental environment flags are
private to these patches; they are not official Japa APIs. If rebuilding from a
new ATS snapshot, create new baseline labels rather than assuming the old 8,515
identities/19 failures still apply.

For a focused correctness check with the same flags, run serial unit
`--files=services/lease` or serial functional `--files=session_controller` after
resetting one DB. The fixture probe source and its raw logs remain local under
`.benchmarks/ats-validation/experiments/`; it was temporarily put in the unit
suite for the probe and removed before every full-suite comparison.

The existing lab has experiment edits; rebuild the base lab for an exact source
snapshot of the original phase. Backups of the changed test/factory files also
remain under `.benchmarks/ats-validation/experiments/original/`. Do not copy those
files into the original ATS checkout without a separate, deliberate integration.

## Code-focused next steps

1. Harden and integrate the two proven fixture/test changes into ATS, with the
   real-crypto path explicit and dedicated authentication tests retained.
2. Profile/batch the purge job's SQL work. Its test processes 500 users through
   many sequential queries and still takes about 9–10 s at four workers. This is
   actual app work: preserve per-user transaction, privacy, FK, and audit behavior;
   do not shrink the 500-row boundary test just to improve the benchmark.
3. Replace other retry/TTL sleeps with controlled clocks where that preserves
   real concurrency checks. One narration-fallback test still waits about 3 s.
4. Separate genuinely pure tests from app/DB bootstrap. A warm/reusable Japa worker
   lifecycle is another possible code project, but must reset module/plugin/global
   state reliably; it was not implemented or measured here.

This experiment did not modify the original ATS source, dependencies, or app database. All lab
services are stopped/removed after the experiments. Detailed per-attempt JSON,
logs, and the retained identity comparison stay local under ignored `.benchmarks/`.
