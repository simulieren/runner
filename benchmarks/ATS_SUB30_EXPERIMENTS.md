# ATS sub-30-second experiments: timing history, startup, purge, six workers

Follow-up to [the ATS code experiments](ATS_CODE_EXPERIMENTS.md), 23 October 2026.
Same isolated lab, same 8,515-test unit suite, same 19-failure baseline
(`baseline-unit-isolated`). One runner change and several ATS-side changes. The
ATS changes exist **only in the isolated copy**. The original ATS checkout was not
modified.

## Result

| Full unit run | Wall time | Identities / failures |
| --- | ---: | --- |
| Original ATS serial reference | 247.094 s | 8,515 / 19 |
| Previous retained: four workers, lease clock + fixture hash | 46.174 s / 48.338 s | 8,515 / 19 |
| **Six workers, all changes below** (`w6-e`, `w6-f`, `w6-g`) | **26.809 / 27.768 / 28.056 s** | 8,515 / 16, 19, 19 |
| Four workers, all changes below (`full-m4`) | 33.766 s | 8,515 / 19 |

The three six-worker runs were sequential and consecutive. All three collected
every baseline identity, with no missing, extra or duplicate tests and **no failure
beyond the baseline**. In `w6-e`, three baseline failures passed: the two
backfill-runner tests and "advancing rows without reducing remaining is reported
stalled". Those tests flip in both directions across runs (see
[flaky tests](#flaky-tests-found)), so `w6-e` is not counted as a fix.

The median of 27.768 s is **8.9× faster than the serial reference** and about 1.7×
faster than the previous retained run. **The sub-30 s target is met for this
configuration. Sub-10 s and sub-3 s were not reached.** Earlier six-worker runs
(`w6-a` to `w6-d`) are excluded; see [not retained](#attempts-not-retained).

Time outside the timed command: preparing the migrated template database takes
8.06 s. It is needed again only when migrations change.

## Where the time went before this round

From the 48.338 s run (`experiment-clock-and-fixtures-parallel4-repeat`):

- Summed test execution was 104 s. Per-worker sums were 33.7 / 26.6 / 25.7 / 18.2 s.
- The 86 tests over 100 ms accounted for about 42 s. About 8,400 tests between
  1 and 100 ms accounted for the other 62 s.
- About 14 s per worker fell outside test execution: boot, migrations, seed, exit.
- The timing cache contained only 3 unit files. It never learned the full suite
  (next section).

## Change 1 (Japa): learn file timings from runs with failing tests

**Problem.** The coordinator promoted timings only when the whole run passed. ATS
always has 19 failures, so `timings=unchanged` on every run. Planning used the
median fallback for about 650 unknown files, and per-worker load ranged from 18.2
to 33.7 s.

**Change** (`src/duration_history.ts`, `src/parallel.ts`):

- The worker plugin no longer rejects a whole run because a test failed.
- A file containing any failed test is dropped from that run's estimates, so its
  previous estimate is kept.
- A failed suite or group hook (`suite:end` / `group:end` with `errors`) still
  rejects the whole run, because hooks can skip tests.
- Pinned runs and `--tests`/`--groups`/`--tags` selections still never train.
- The coordinator accepts nonzero worker exits when every report is valid and
  complete. A signal, a spawn error, a missing or tampered report, duplicate file
  keys or cancellation still leave the cache unchanged.
- Serial training through `durationHistory()` uses the same file-level rule.

**Tests.** One new synthetic test covers both paths: failing files keep the stale
5,000 ms estimate, passing files are learned, serial and parallel. The
cache-rejection test now uses a group-hook failure (`TEST_HOOK_FAIL`). The
rerun-from-failures test now expects `historyUpdated: true`.

`npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:core` (176),
`npm run bench:smoke` (56 cases) and `npm run bench:automatic` pass. `npm test`
passes 91/91 with `AI_AGENT`/`CLAUDECODE` unset. Inside the agent shell, three
config-manager/planner tests fail because Japa selects the `dot` reporter when
`AI_AGENT` is set. That is pre-existing and unrelated to this change.

The lab used a repacked `5.4.0-speed.4` runner tarball containing this uncommitted
change. **The package version was not bumped.** Bump it before publishing or
installing anywhere else.

**Measured effect.** These runs had virtual lease time + fixture hash on, with the
cache either stale or learned:

| Cache | Runs | Wall time |
| --- | --- | --- |
| Stale (3 unit files) | `timing-learn-a`, `timing-stale-c`, `timing-stale-d` | 46.306 / 46.595 / 46.159 s |
| Learned | `timing-learn-b`, `timing-learned-c`, `timing-learned-d`, `phases-learned-e` | 52.524 / 40.512 / 41.066 / 46.578 s |

On its own, learned balancing was **noisy and not a reliable win**. The first
learned run (`b`) had evenly balanced workers but 28 s more summed test time.
Purge alone went from 8.3 to 13.7 s on the same worker. The cause was database
contention: all four workers stayed busy with database-heavy files until the end.
Balancing paid off once the purge job stopped saturating Postgres (change 3).

## Startup and exit, measured by phase

Phase logging (`JAPA_EXPERIMENT_PHASES=1`) prints milliseconds since process start
at bootstrap load, each runner setup/teardown hook, suite start/end and exit.

| Phase | Serial, lease file | Per worker, four workers |
| --- | ---: | ---: |
| Process start → bootstrap loaded (TS loader, Adonis boot, imports) | 4.6 s | 5.4 s |
| `testUtils.db().migrate()` on an empty database (336 migrations) | 3.35 s | 4.0 s |
| Seed | 0.14 s | 0.2 s |
| Test-file import until first test | 0.05 s | 0.7 s |
| Teardown end → exit | 1.01 s | 1.01 s |

A loader probe (`JAPA_PROBE_LOADTIME=1`, `probes/load_timer.mjs`) counted 2,361
TypeScript files per process, with **0.8 s summed `ts-exec` load time**. SWC
transformation is therefore not the main boot cost. Module evaluation and provider
boot are. A transform cache was not pursued.

## Change 2 (ATS copy): template database and exit timer

**Template database.** `probes/prepare_template.mjs` migrates one scratch database
with `node ace migration:run --force` and then runs
`CREATE DATABASE japa_speed_template TEMPLATE japa_speed_worker1`. With
`JAPA_EXPERIMENT_DB_TEMPLATE=1`, `reset_databases.mjs` clones each worker DB from
that template. The suite's own `migrate()` then finds nothing pending: 0.44–0.75 s
instead of 3.3–4.0 s. Seed still runs normally.

The ownership guard keeps working because database comments are not copied by a
template clone, so each clone is claimed fresh. The template does not include seed
data. This differs from the rejected snapshot attempt, which included seed data,
used a learned profile and regrouped files.

**Exit timer.** The teardown hook armed `setTimeout(process.exit, 1000)` without
`unref()`, so every process waited a full second after teardown. Japa also runs
global teardown hooks **before** `runner.end()`, where reporters and the
coordinator timing report are written. The first version of this change called
`unref()`. The final version (still `JAPA_EXPERIMENT_EXIT_UNREF=1`) skips that
timer entirely and relies on the unref'd net that `bin/test.ts` already arms after
`run()` resolves. Exit now follows teardown by about 25 ms.

**Measured effect.** Same pinned learned cache before each run, sequential A/B:

| Variant | Runs | Wall | Wall minus slowest worker |
| --- | --- | ---: | ---: |
| Control | `control-x1`, `control-x2` | 45.437 / 46.320 s | 14.5 / 13.3 s |
| Template + exit | `startup-y1`, `startup-y2` | 46.451 / 39.289 s | 8.5 / 7.3 s |

Fixed overhead fell by about 5–6 s in both pairs. Wall time stayed noisy because
test execution varied by up to 9 s between runs, mostly purge (12–20 s).

## Change 3 (ATS copy): batched purge job

**Measurement first.**

- `EXPLAIN ANALYZE` of one user delete on a populated worker DB showed 134 FK
  triggers. 86 of the referencing columns have no index.
- Adding those indexes (inside a rolled-back transaction) changed the
  steady-state delete from 1.62 to 1.79 ms. The 75 ms first call is RI
  plan preparation, paid once per session. **Indexes rejected: no gain.**
- A temporary probe spec, kept out of all full runs, measured a `SELECT 1` round trip at 0.354 ms and the original purge at **25
  queries and 12.7–14.0 ms per user**. With 600 users in the boundary test, that is
  about 8 s while idle and 12–20 s under contention.

**Change** (`purge-batched.patch`):

- `PurgeSoftDeletedJob` purges users in chunks of 100. Each chunk runs the same
  statements in one transaction, matching every id in the chunk
  (`whereIn`/`any(?::uuid[])`).
- The per-user email hash for `admin_action_logs` is applied with
  `UPDATE … FROM unnest(ids, hashes)`.
- The documents `created_by_id` reassignment keeps the per-row condition: the
  creator is purged and is not the owner. The end state is the same whichever
  order the purged users would have been processed in.
- `AssistantRecordPurgeService.purgeUsers()` is the set-based twin of
  `purgeUser()`.
- **If a chunk fails, it rolls back and the original per-user `purgeUser()` runs
  for every user in that chunk.** One bad user still fails alone, with the same
  error count and log line.
- `BATCH_LIMIT` (500), the organization purge, and the retention/anonymisation
  rules are unchanged.

**Validation.**

- All 13 purge tests pass.
- Per user: 25 → 0.3 queries; 1.36–1.50 ms instead of 12.7–14.0 ms (probe).
- The 500-user boundary test: about 8–20 s in full runs → 0.74–0.85 s.
- A fallback probe (`probes/zz_purge_probe.spec.ts.txt`, copied into the app as
  `tests/unit/zz_purge_probe.spec.ts` only while probing; the earlier round-trip
  version of that file was not kept) adds a temporary trigger that rejects
  one user's delete. The batched and original jobs give identical results:
  `usersPurged=4, errors=1`, the blocked user remains, and its
  `admin_action_logs` row keeps `admin_user_id` without an anonymisation label.
- Targeted `oxlint --type-aware` and `tsc --noEmit` are clean for the changed files.

**Measured effect** (template + exit on, same pinned cache):

| Variant | Runs | Wall | Per-worker test time |
| --- | --- | ---: | --- |
| All so far | `all-a1`, `all-a2` | 39.724 / 40.275 s | 19.2/28.7/32.0/28.0, 18.3/29.1/31.0/28.0 |
| Control | `control-b1`, `control-b2` | 50.530 / 43.776 s | b1 added the dependency-scan timeout |

After the cache learned the cheaper purge (`all-learn-l1` to `l3`): 36.176 /
33.598 / 34.490 s. All complete. `l2` had one baseline failure pass; `l3` had the
timestamp-tie flake.

This is a production code change. Integrating it into ATS needs review of
lock duration (up to 100 users per transaction instead of 1) and of the
chunk-fallback logging.

## Change 4 (ATS copy): smaller per-test and sleep costs

| Change | Patch | Before → after | Flag |
| --- | --- | --- | --- |
| Skip `cache.clear()` when nothing was written since the last clear | `startup-exit-cache.patch` | about 2,100 clears per worker, about 0.8 ms each (1.66–1.90 s per worker) → 7–52 clears | `JAPA_EXPERIMENT_CACHE_DIRTY=1` |
| Narration retry backoff becomes an overridable `waitBeforeRetry()`; the test stubs it and asserts every wait is a multiple of the 500 ms base | `narration-backoff.patch` | 3,012 → 3 ms | `JAPA_EXPERIMENT_FAKE_BACKOFF=1` |
| fal "hung provider" test aborts after 50 ms instead of 1,500 ms, through the same abort path, and now also asserts the minimum wait | `fal-short-timeout.patch` | 1,504 → 51 ms | `JAPA_EXPERIMENT_SHORT_TIMEOUTS=1` |
| Dependency-scan directory walk reads sibling directories concurrently; output order unchanged (verified identical for 6,041 files) | `dependency-walk.patch` | walk 467–530 → 89–97 ms; test 1.2–1.6 s → 0.6 s | always on in the copy |

The cache-dirty rule relies on every bentocache store write going through
`stack.set`, which emits `cache:written`, and on `@adonisjs/cache` forwarding that
event to the app emitter. Remaining L1 refills come only from L2 entries, which
also exist only after a write. Any write in any store marks the cache dirty, so
the default store is still cleared at least as often as before for real writes.

On four workers these changes did not move wall time measurably (`full-m1` to
`m4`: 33.8–36.6 s). They matter at six workers, where the dependency scan
otherwise times out under CPU load.

## Change 5: six workers

The handoff advised against another worker-count matrix without new evidence.
The new evidence: the purge job no longer saturates Postgres, and startup is about
7 s per worker. The harness now supports up to 8 workers: `worker_env.mjs`,
`reset_databases.mjs`, and `wait_ready.mjs` with `JAPA_LAB_WORKERS`, together with
`experiments/compose-8.yaml`.

**Root cause of the earlier missing-worker result.** The rejected six-worker run in
the previous round lost one worker's report, and so did `w6-a`/`w6-b` here
(1,358 missing tests each). That worker printed every test and then exited before
its file reporter and timing report wrote anything. The ATS teardown hook's 1 s
`process.exit` timer fires during `runner.end()`, which Japa runs **after** global
teardown hooks. Under six-way CPU load, ending the run takes longer than one
second. Skipping that timer (change 2, final form) fixed it: every later
six-worker run was complete.

`w6-c` (29.491 s) and `w6-d` (30.926 s) were complete but had added flaky
failures, including the dependency-scan timeout. After the concurrent walk:
`w6-e`/`f`/`g` at 26.809 / 27.768 / 28.056 s, with no added failures.

## Flaky tests found

None were edited, except the dependency scan, which was made faster. Each one can
surface or hide depending on load and file placement:

- **Timestamp tie**: dashboard roster order, "a new outfit moves its client to the
  front at once". Two clients are created back to back and sorted by creation
  time. Seen in four-worker runs.
- **Generated-name substring**: receptionist prompt, "carries no price or deposit".
  The test asserts the prompt contains none of `1500`, `3500`, `9000`… The prompt
  includes generated names built from `Date.now()`, a per-process counter and
  random hex. Inferred cause; the exact matching name was not captured. Seen in
  six-worker runs.
- **Clock boundary**: notification log, "should handle entries at exact boundary
  times". The test captures `now`, then `getStats()` reads the clock again, so one
  elapsed millisecond moves the boundary entry out of the window.
- **CPU-bound timeout**: "every package imported for its value is declared". This
  timed out under load before the walk fix.
- **Baseline failures that sometimes pass**: both backfill-runner tests, the
  stalled-backfill test, and "two concurrent calls leave at most one pending row".

## Attempts not retained

- First learned-cache run at four workers (52.524 s): balanced, but test time rose
  under database contention. Learned balancing alone is not reported as a win.
- FK indexes for user deletes: no steady-state gain (see change 3).
- `ts-exec` transform cache: not attempted. The measured transform time (0.8 s per
  process) is too small to justify it.
- Welcome-workflow retry (1.7 s): the delay lives in the durable-workflow
  library's retry policy. Not attempted.
- Backfill-runner sleeps (2.0 / 1.4 s): these tests are baseline failures, so the
  results could not be validated. Not changed.
- Redis mutex and payment-link race waits: these exercise real concurrency, which
  the handoff says to keep. Not changed.
- First narration assertion: it required exactly `[500, 1000, 500, 1000]` and
  failed in full runs (`full-m1` to `m3`), because the number of attempts follows
  the configured provider chain. Relaxed to "non-empty, multiples of 500" before
  the six-worker runs.
- `w6-a`, `w6-b`: incomplete (see change 5). `w6-c`, `w6-d`: added flaky
  failures. None of these are counted as results.

## Incident: `database/schema.ts` regenerated in the copy

The first `prepare_template.mjs` run used `node ace migration:run`, which also
regenerates `apps/web/database/schema.ts` in the copied app. No earlier copy
existed, and the original checkout has changed since the snapshot (8,203 versus
10,880 lines), so the previous bytes cannot be restored. The regenerated file is
saved as `.benchmarks/ats-validation/experiments/original/schema.regenerated-2026-10-23.ts`.

At runtime, only `tests/unit/schema_no_any.spec.ts` reads this file. Both of its
tests still fail exactly as in the baseline: same `any` offenders
(`seasons`, `colors`, `seasons`) and the same missing `WorkflowRunSchema`. The
probe now saves and restores `schema.ts` around `migration:run`, verified by an
unchanged md5. The original ATS checkout was not touched.

## Reproducing

All of this happens in the lab copy, from the fork root. Patches apply **only in
the copy**, after `copy-only.patch` and `copy-only-speed.patch` (or the three
earlier patches):

```sh
for p in startup-exit-cache purge-batched narration-backoff fal-short-timeout dependency-walk; do
  git -C .benchmarks/ats-validation/app apply --check ../../../benchmarks/ats-validation/experiments/$p.patch
done
```

The local lab already contains all of them. Use `git apply --reverse --check` to
confirm before applying anything. Then:

```sh
cp benchmarks/ats-validation/*.mjs .benchmarks/ats-validation/
mkdir -p .benchmarks/ats-validation/probes && cp benchmarks/ats-validation/probes/* .benchmarks/ats-validation/probes/
cp benchmarks/ats-validation/experiments/compose-8.yaml .benchmarks/ats-validation/compose.yaml
docker compose -p japa-speed-atstest -f .benchmarks/ats-validation/compose.yaml up -d
JAPA_LAB_WORKERS=8 node .benchmarks/ats-validation/wait_ready.mjs
node .benchmarks/ats-validation/switch_runner.mjs fork      # needs the repacked runner with change 1
node .benchmarks/ats-validation/probes/prepare_template.mjs # once per migration change; 8.06 s here
export JAPA_EXPERIMENT_FIXTURE_HASH_CACHE=1 JAPA_EXPERIMENT_VIRTUAL_LEASE_TIME=1 \
  JAPA_EXPERIMENT_DB_TEMPLATE=1 JAPA_EXPERIMENT_EXIT_UNREF=1 JAPA_EXPERIMENT_CACHE_DIRTY=1 \
  JAPA_EXPERIMENT_FAKE_BACKOFF=1 JAPA_EXPERIMENT_SHORT_TIMEOUTS=1
node .benchmarks/ats-validation/reset_databases.mjs 6
node .benchmarks/ats-validation/run_case.mjs UNIQUE_LABEL 6 unit
node .benchmarks/ats-validation/probes/session_summary.mjs UNIQUE_LABEL
```

`session_summary.mjs` reports missing, extra, duplicate, added and
newly-passing failures against `baseline-unit-isolated`, plus per-worker test
time. Reject any run with missing tests or added failures. The first run after
`prepare_template.mjs` trains the cache. Later runs use the learned estimates,
and the cache keeps updating after every complete run.

The purge, dependency-walk and narration seam changes are not behind flags. For a
control run, swap in the originals from
`.benchmarks/ats-validation/experiments/original/`, as `control-b*` did.

## Toward 10 s and 3 s

At six workers, the slowest worker now has about 18–19 s of tests plus about 7–8 s
of startup and exit. Sub-10 s needs both of those cut further:

1. **Boot (5.2–5.4 s per worker).** About 2,361 modules are evaluated in every
   process. Lazy providers and preloads, or a pure-test lane that does not boot
   Adonis, are the main candidates.
2. **The per-test floor (about 55 s of tests between 5 and 100 ms).** Measure
   factory inserts and seed lookups per test. Transaction-rollback isolation is
   used by only 12 files.
3. **More workers.** This depends on database and CPU headroom. Eight workers have
   not been retested since the contention fixes.
4. **Japa: reusable warm workers** for watch-mode feedback. Report these separately
   from cold full runs. This is the only realistic route to about 3 s, and only for
   incremental runs.

## Lab state

At this checkpoint the lab app contains every patch listed here. The harness is
8-worker capable, with `compose-8.yaml` in use. The installed runner is the
repacked speed.4 with change 1, and the timing cache has learned estimates.
Session run records, logs and `experiments/session-2026-10-23-summary.jsonl` stay
under ignored `.benchmarks/`. The pre-session 8-worker diagnostic scripts are
preserved in `.benchmarks/ats-validation/diag-8worker-harness/`, and the committed
speed.4 runner in `fork-packages-runner-speed4-committed/`. After the
documentation pass, the Compose project `japa-speed-atstest` was stopped.

## Follow-up round (speed.5): boot profiling, 8 workers, and an environment drift

Session of 23 October 2026, same lab. This round attempted the handoff's boot,
per-test-floor, eight-worker and flake items. **No new wall-time win is claimed**,
and the sub-30 s result below could not be reproduced in this session.

### Runner: speed.5 timing-change packaging and smoothing

`src/duration_history.ts` and `src/parallel.ts` now blend a fresh measurement with
the previous estimate (`blendDuration`, half the distance) unless the file is
unknown. Rationale: `timing-learn-a` (52.524 s) showed one contended run inflating
estimates enough to unbalance the next plan. The runner version is now
`5.4.0-speed.5`; both tarballs pack, install production-only, and a failing
two-worker run prints `timings=updated` with the failing file's estimate preserved.

Checks: `typecheck` (runner and core), `lint`, `test` 91/91, `test:core` 176/176,
`build`, `bench:smoke` 56 cases, `bench:automatic`, and the new
`npm run bench:timing-cache` planner probes all pass.

An `overheadFor()` per-file planning penalty was prototyped and **dropped**: with a
capped-chunk design it did not change assignment, and the uncapped variant was not
validated, so `src/planner.ts` is unchanged.

### Boot: the cost is the synchronous ESM hook round-trip, not module evaluation

`probes/boot_sample.sh` boots the copied app with a non-matching file filter and
prints the `bootstrap-loaded` phase mark. Repeated samples:

| Variant | bootstrap-loaded |
| --- | --- |
| Default (`@poppinss/ts-exec` 1.5.0) | 4.38–4.69 s, four samples |
| `NODE_COMPILE_CACHE` warm (6,436 entries, 58 MB) | 4.14–4.37 s, six samples |
| Extra identity `registerHooks({ load })` | 4.45–4.53 s, three samples |

The V8 compile cache is a small, real gain (about 0.2 s per worker, about 6% of
boot) but it does not change the picture. Three `--cpu-prof` runs at 250 µs
sampling attribute about 1.17 s of the ~5.0 s boot to
`makeSyncRequest @ node:internal/modules/esm/hooks`, called from
`#loadSync`/`resolveSync`. That is Node marshalling every load and resolve through
its synchronous hook path because `ts-exec` installs synchronous hooks; a fourth
run measured 2.34 s. Summed `load()` time was only 149 ms across 4,397 modules, so
SWC transformation is negligible — consistent with the earlier finding.

The route this identifies is a **non-hook loader** (hook-free `--experimental-transform-types`
or a bundler pre-pass). Both were attempted in the copy and are **not viable**:
`--experimental-transform-types` plus a resolve shim fails on app syntax, and
plain TypeScript stripping rejects parameter properties and Adonis's
`.js`-extension import convention. Treat a hook-free boot as unsolved, not as a
cheap remaining win.

### Per-test floor: top files identified, not yet attacked

In the slowest session run, the largest summed file costs were
`referral_commission_service` (7.69 s / 57 tests),
`referral_payout_service` (5.05 s / 42), `gift_card_image_service` (4.75 s / 12),
`referral_models` (4.15 s / 91), `referral_service` (4.13 s / 62) and
`payment_link_race_conditions` (3.76 s / 15). The referral specs share a
`group.each.setup` that deletes `ReferralTier` rows and creates program settings
per test. No change was made: the cleanup is intentional isolation, and shrinking
it needs an isolation review, not a benchmark edit.

### Eight workers: one run, rejected

`w8-speed5-a`: 47.569 s, all 8,515 identities, 0 added failures, 1 fixed
("two concurrent calls leave at most one pending row"). Worker times were balanced
(28.4–31.7 s), but wall time tracked the host, not the worker count. Not retained
as an improvement.

### Environment drift: the 26.8 s result did not reproduce

| Run | Runner | Cache | Wall | Summed test time |
| --- | --- | --- | ---: | ---: |
| `w6-e` / `f` / `g` (11:55) | speed.4 + timing change | learned | 26.8 / 27.8 / 28.1 s | 103.9 / 109.9 / 109.0 s |
| `w6-speed4-pin-a` (12:55) | committed speed.4 | same pinned cache | 51.4 s | 203.2 s |
| `w6-speed5-pin-a/b` | speed.5 | same pinned cache | 53.3 / 58.3 s | 210.3 s |

Per-test comparison against the three `w6-e/f/g` runs shows the *same individual
tests* running about twice as slow now (median ratio 1.01–1.13 for speed.4/speed.5
against the reference), so this is not a scheduler or cache effect: the machine is
doing the same work more slowly. Host CPU during these runs measured 714% on a
12-CPU machine, and load averages reached 8–21 while the Docker VM and other
user processes competed. The runner change is therefore **not** implicated, but
**no new sub-30 s claim can be made from this session** — the retained sub-30 s
result stays the 11:55 runs, and every new number here must be labelled
load-affected.

### Reproduce

```sh
# runner work
npm run bench:timing-cache
npm run bench:smoke && npm run bench:automatic

# boot samples (no test executes)
.benchmarks/ats-validation/probes/boot_sample.sh
NODE_COMPILE_CACHE=$PWD/.benchmarks/ats-validation/compile-cache \
  .benchmarks/ats-validation/probes/boot_sample.sh
```

For a timed run, the commands are unchanged from "Reproducing" above. Compare only
runs taken under similar host load, and record load averages next to the label.

## Follow-up: agent features validated on ATS (23 October 2026)

The agent-facing selection features were validated in the isolated lab. These are
correctness results, not timing claims: the host carried load averages of 8–10 and
even the unmodified runner measured about 50 s for the full suite.

### Caches

`--prepare` (imports only, no tests) completed in **9.04–9.38 s** and wrote both
caches for 648 test files:

- selection index: 8,296 registered titles, 3 files flagged as building titles at
  run time (datasets);
- dependency map: 1,027 project modules and 23,563 test-file links, i.e. a
  transitive closure rather than 197 first-importer links.

The first attempt exposed two bugs that are now fixed:

1. The index recorded only executed tests, so a dataset-expanded title could be
   absent and its file skipped. Files containing `.with(` are now never pruned by
   a title filter.
2. Dependency attribution ran on load events, so a shared module was credited to
   the first test file that imported it. Attribution now records resolve edges and
   walks the graph, which raised the links from 197 to 23,563.

A third bug was in the reported selection size: `collected` counted post-filter
files, so the summary claimed `skipped: 0` while 644 files were actually pruned.

### Filtered selection

One test (`getCacheVersion is stable and namespaced`) in a 126-test file, serial:

| Variant | Planned files | Skipped | Import phase | Wall |
| --- | ---: | ---: | ---: | ---: |
| Index enabled | 4 (1 match + 3 runtime-title files) | 644 | 748 ms | 5.83 s |
| `JAPA_NO_SELECTION_INDEX=1` | 648 | 0 | 3,886 ms | 8.08 s |

Identical test identity in both runs. The import phase is load-independent and is
the number to quote: **5.2× less import time**; wall time still includes the ~4.9 s
Adonis boot.

### Change selection

Editing `app/exceptions/client_disconnect.ts` (one dependent test file) and running
`--changed=<path>` selected **1 file / 5 tests**, skipped 647, and produced exactly
the same identities as `--files=exceptions/client_disconnect`. The edit was
reverted; the copied app's working tree is unchanged by this probe.

### Baseline

Using `--files=schema_no_any` (two known failures):

- `--update-baseline` wrote both failures with suite, file and title;
- `--allow-known-failures` exited **0** and reported `baseline: {known: 2, new: 0}`;
- the same selection without the flag exited **1**.

### Full suite regression

One six-worker run with the selection features enabled: **49.437 s** (load-affected;
not a timing result), all **8,515** identities, no missing, extra or duplicate
tests. Failures were 22: the 19 baseline plus four
`admin_notification_channel_service` assertions that pass **49/49 in isolation**
and have appeared in earlier loaded runs. They are cross-file/load flakes, not a
regression from these features.

### Lab state

Caches were built by `--prepare` and updated by later runs. The full-run identity
comparison is `p1-full-w6`. Raw logs, JSONL and run records remain under ignored
`.benchmarks/ats-validation/`. The temporary baseline file was removed and the
Compose project was stopped after the probes.

### Later timing attempt, still load-affected

With load average 4.2–8.3 (not quiet), the same filtered selection was repeated:

| Variant | Import phase | Wall |
| --- | ---: | ---: |
| Index enabled | 860 ms | 5.645 s |
| `JAPA_NO_SELECTION_INDEX=1` | 3,342 ms | 8.432 s |

A full six-worker run at the same time took **48.105 s** with exactly the 19
baseline failures and all 8,515 identities. The 26.8–28.1 s range was **not**
reproduced; this run is recorded as load-affected, not as a regression. Import time
remains the only stable comparison: about 3.9× less with the index, and the wall
difference tracks it.

### Coordinator baseline ownership

`--update-baseline` under `japa-parallel` previously let each worker write a
partial baseline, so the last writer won. Workers now only report their failures;
the coordinator merges them and writes once, under the same validity gate as
timing promotion. A partial selection never writes.

### AdonisJS integration verification

The copied app is AdonisJS **7.5.0** (`@adonisjs/core`), with 25+ providers already
declared as lazy imports in `adonisrc.ts`, `Ignitor.testRunner()` in `bin/test.ts`,
and `@japa/plugin-adonisjs 5.2.0`. Against that copy:

- `japa-agent` from a production install ran `--prepare` and then a title filter:
  exit 0, `planned: 4`, `skipped: 644`, 739 ms import phase, one test.
- `--update-baseline` through the coordinator with six workers merged **23**
  failures (the 19 baseline plus four load flakes) into one file.
- The same six-worker run with `--allow-known-failures` exited **0**.
- A serial `--files=... --tests=... --update-baseline` run left the baseline
  byte-identical, as intended.

## Plan round: boot attribution and integration helpers

Short probes, no full-suite rerun.

**Boot attribution** (`probes/boot_breakdown.mjs`, sampled at 250 µs, `--prepare`):
`makeSyncRequest` in Node's ESM hook layer accounted for **4,397 ms** of sampled
CPU, `compileSourceTextModule` 1,175 ms, and all Adonis provider files together
only tens of milliseconds (`@adonisjs/lucid` 29.9 ms, app modules 33.8 ms). App
providers are therefore not the boot cost; the loader path is. This makes lazy
providers a poor lever and reinforces the loader experiment.

**Loader experiment (preliminary, not adopted).** With `tsx` installed only in the
copied app, `bootstrap-loaded` was **3,485–3,505 ms** through `npx tsx` versus
**4,982–5,075 ms** with `@poppinss/ts-exec` in the same app, and a filtered run
through `tsx` selected the same identity (planned 4, skipped 644). Direct
`node --import=tsx` samples were noisy (4.5–6.0 s), so this is a lead, not a
result. Decorator/metadata correctness across the full suite was not verified;
do not adopt without a full identity run.

### Plan round 2: setup-free prepare, locks, baseline history, gates

- `--prepare-caches` now skips global setup hooks. In the copy it took **9.68 s**
  at load 5.4: boot ~4.8 s plus the full import pass (~3.3 s). Setup was only
  ~0.6 s with the template DB, so imports, not setup, dominate prepare.
- Cache read-modify-write sequences (selection index, dependency map, duration
  history, baseline) now take a lock, with stale-lock recovery.
- Baselines store `consecutive`/`updatedAt`; entries that stop failing stay at
  `consecutive: 0`, are reported as `fixed`, and a run that both adds and removes
  entries prints a warning.
- The differential gate ran on ATS with one title: indexed and unindexed runs
  selected **the same identity**, both exit 0. Script:
  `probes/selection_gate.mjs`.
- `japa-agent` records loop metrics; `--report` prints runs, median run time,
  new/fixed totals and selection modes.
