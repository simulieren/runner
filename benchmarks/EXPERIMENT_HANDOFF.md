# Handoff: the next ATS and Japa speed experiments

Checkpoint: 23 October 2026, after the speed.5 packaging round. **Read the
[follow-up round](ATS_SUB30_EXPERIMENTS.md#follow-up-round-speed5-boot-profiling-8-workers-and-an-environment-drift)
before scheduling any timed run**: on a loaded host the same suite took 47–58 s
instead of 26.8–28.1 s, with per-test times roughly doubled, so new numbers must be
compared only against runs taken under similar load. The user's priority is
improvements in ATS or Japa-related code, with targets of under 30 s, under 10 s
and under 3 s for the full suite. **Under 30 s has been met in the isolated
lab: 26.809 / 27.768 / 28.056 s with six workers.** Under 10 s and under 3 s
have not. Do not promise either without measuring the same complete suite.

## Start with these artifacts

- [Sub-30 s experiments](ATS_SUB30_EXPERIMENTS.md): latest result, every change,
  measurements, flakes found, rejected attempts, reproduction commands.
- [ATS code experiments](ATS_CODE_EXPERIMENTS.md): lease virtual time and fixture
  hash reuse (46–48 s round).
- [ATS validation runbook](ATS_VALIDATION.md): isolation, provisioning, original
  baseline, command setup and cleanup.
- [Experiment history](EXPERIMENTS.md): runner optimizations and earlier failures.
- [Harness templates](ats-validation/README.md),
  [prototype patches](ats-validation/experiments/README.md) and
  [probes](ats-validation/probes/).
- [Fork behavior](../PERFORMANCE.md): what is implemented in Japa versus opt-in.

Repository: `/Users/simonkhalimonov/Projects/Code/japa-speed/runner`.
Private local lab: `.benchmarks/ats-validation/` inside that repository.
Raw records are `<run-label>.json` and `.log`. Additional evidence is under
`experiments/`, including `session-2026-10-23-summary.jsonl` for this round.
These ignored local artifacts are not available from a fresh Git clone. Rebuild
from the runbook and templates when they are absent, and do not invent measurements.

## What is established

| Complete unit run | Wall time | Result |
| --- | ---: | --- |
| Original serial reference | 247.094 s | 8,515 tests, 19 failures, 1 skipped |
| Fork, four workers, SMTP fixture correction | 86.453 s | Same identities and failures |
| Four workers, lease virtual time + fixture hash | 46.174 / 48.338 s | Same identities and failures |
| Four workers, all sub-30 changes (`full-m4`) | 33.766 s | Same identities and failures |
| **Six workers, all sub-30 changes** (`w6-e/f/g`) | **26.809 / 27.768 / 28.056 s** | All identities; no added failures (in `e`, three baseline failures passed) |

What produced the last rows:

- **Japa runner (uncommitted, version still `5.4.0-speed.4`):** the timing cache
  now learns from runs with failing tests, skipping files that contain one.
  Before, ATS never trained, because it always has failures.
- **ATS copy, startup:** worker DBs cloned from a migrated template (migrate
  3.3–4.0 s → 0.4–0.75 s). The teardown exit timer is skipped: it cost 1 s per
  worker and raced `runner.end()`, which caused the old six-worker missing-report
  failure.
- **ATS copy, purge:** batched set-based user purge with a per-user fallback.
  25 → 0.3 queries per user; the 600-user test went from 8–20 s to under 1 s.
- **ATS copy, smaller costs:** cache clears skipped when nothing was written;
  narration backoff stubbed; fal hung-provider timeout cut to 50 ms; the
  dependency scan walks directories concurrently.

The six-worker results are three consecutive single runs, not a large
repeated-median study. Template preparation (8.06 s) is outside the timed command
and is needed once per migration change.

The lab is up to date. The app contains all patches. The harness accepts 1–8
workers, with `compose-8.yaml` as `compose.yaml`. The runner in the copy is the
repacked speed.4 with the timing change. The timing cache holds learned
estimates, which change after every complete run. `JAPA_EXPERIMENT_HISTORY` and
`JAPA_EXPERIMENT_DB_SNAPSHOT` belong to the old diagnostics and stay unset. **Do not
apply the patches twice.** `git apply --reverse --check PATCH` confirms a patch is
present. The Compose project was stopped after the documentation pass.

## Boundaries and coordination

The original ATS checkout is
`/Users/simonkhalimonov/Projects/ATS/code/ats-app-mono`. Do not modify its source,
dependencies, environment, generated files or services. Work in the isolated
copy. Do not reset or stash unrelated original-checkout changes: it has other
active user work, and its status need not match an old audit.

Keep raw results, copies, credentials and logs in ignored `.benchmarks/`.
The fork's `AGENTS.md` is local-only and excluded by `.git/info/exclude`; never
stage or publish it. This handoff and the sanitized harness documentation may be
included in a future PR. Do not publish packages or install them into the original
ATS without explicit authorization.

`node ace migration:run` regenerates `apps/web/database/schema.ts`.
`probes/prepare_template.mjs` restores it afterwards. Do not run other ace
migration commands in the copy without the same protection. The incident from
this round is recorded in the sub-30 s report.

One agent owns the existing lab at a time. Agree on ownership before editing its
app, switching packages, resetting databases or starting services. Other agents
can inspect code or prepare separate patches. Independent executable experiments
need distinct app and dependency copies, Compose project names, ports,
DB/cache/search resources, histories and result paths; audit hard-coded isolation
checks first. Timed benchmarks must run sequentially, even with independent labs.
Use unique result labels, never overwrite historical evidence, and stop only your
own services.

If investigating a repository with `.codegraph/`, use CodeGraph before locating
or reading code. Do not create an index. The fork and isolated app had no index
at this checkpoint; recheck before assuming that remains true.

## Candidate experiments

Choose one hypothesis, measure its targeted path, then consider a full run. These
are ideas to investigate, not established wins or instructions to weaken tests.

| Priority | Experiment and starting point | Evidence to collect / constraints |
| --- | --- | --- |
| 1 | ~~Commit and package the runner timing change.~~ **Done as `5.4.0-speed.5`**, including half-distance estimate blending. Still uncommitted. Remaining work: commit, and confirm `timings=updated` on a failing ATS run in a quiet window. | Full check list in `AGENTS.md` passes, both tarballs install production-only, and a failing two-worker run trains its passing files. |
| 2 | Boot cost. **Attributed this round:** `bootstrap-loaded` is 4.4–4.7 s, of which roughly 1.2–2.3 s is Node's synchronous ESM hook round-trip triggered by `ts-exec`. Module `load()` is only 149 ms across 4,397 modules. `NODE_COMPILE_CACHE` saves about 0.2 s. | The remaining lever is a hook-free boot; plain `--experimental-transform-types` and TypeScript stripping both fail on app syntax and Adonis `.js` imports. A pure-test lane without Adonis boot is the other option. |
| 3 | Per-test floor. **Top files identified:** `referral_commission_service` (7.7 s / 57 tests), `referral_payout_service` (5.1 / 42), `gift_card_image_service` (4.8 / 12), `referral_models` (4.2 / 91), `referral_service` (4.1 / 62). The referral specs share a `group.each.setup` deleting `ReferralTier` rows and creating program settings per test. | Needs an isolation review before any edit; do not shrink it as a benchmark tweak. Only 12 files use transaction-rollback isolation. |
| 4 | Eight workers. **Done once:** `w8-speed5-a` 47.569 s, all identities, 0 added failures, workers balanced at 28.4–31.7 s. | Rejected as a win; wall time tracked host load, not worker count. Do not start another matrix until the host is quiet. |
| 5 | Fix the flaky tests found (timestamp tie, generated-name substring, clock boundary) and the baseline failures that flip. | They decide whether a fast run counts. Diagnose each one before editing the test. Keep the assertions' intent. |
| 6 | Integrate the proven changes into ATS. | Needs explicit authorization for the original checkout. Purge batching is production code: review lock duration and fallback logging. Test-only flags should become plain code or test helpers. |
| 7 | Japa: warm reusable workers or watch mode. **Investigated and deferred**: Node's ESM cache cannot unload modules and the Adonis container is built at boot, so this needs a custom module runner. The agent-facing alternatives (selection index, `--changed`, result reuse) are shipped instead. | Only revisit with framework support for reloading; do not attempt ESM-cache unloading. |
| 8 | Measure the agent features against a real workload. **Functionally verified** in a production-only install: `--prepare` writes both caches without running tests, a filtered run skips non-matching files (proved with a file that throws on import), `--changed=<source file>` and `--changed=auto` import only dependent test files, `--failed-new` skips baseline titles, and `--agent-file` isolates JSON from app output. The contract is in `AGENT_INTEGRATION.md`. | Still no wall-time number: the host was too loaded. Record import counts and wall time for a one-test selection with and without `JAPA_NO_SELECTION_INDEX=1`, and require identical identities. Do not quote a speedup without both. |

## Do not repeat these as accepted wins

- Learned shard balancing alone at four workers: 40.5–52.5 s against 46.2–46.6 s
  with a stale cache. Database contention dominated until the purge fix.
- FK indexes for user deletes: steady-state delete went from 1.62 to 1.79 ms.
  The 75 ms first call is RI plan preparation.
- `ts-exec` transform caching: transforms are 0.8 s summed per process. Not worth it.
- Six-worker runs `w6-a`/`w6-b` (incomplete) and `w6-c`/`w6-d` (added flaky
  failures). They predate the exit-timer and dependency-walk fixes.
- Earlier rejected items still stand: the eight-worker run from before these
  fixes, snapshot plus learned-profile variants, passing precomputed hashes to the
  user model, the invalid `pgbench -d` probe, and the no-observer emitter prototype.

## Validation and retest contract

Follow "Reproducing" in [the sub-30 s report](ATS_SUB30_EXPERIMENTS.md). In short:
start `compose-8.yaml`, wait for readiness with `JAPA_LAB_WORKERS=8`, prepare the
template, export the experiment flags, reset 6 databases, run with a new label,
and run `probes/session_summary.mjs LABEL`.

The test command exits 1 because of the known failures. Do not use `&&` or
abort-on-error to skip the comparison. Require all 8,515 identities, with no
missing, extra or duplicate tests and no added failures. Report baseline failures
that passed as observations, not fixes. Reject incomplete or timed-out runs.

For a new change, start with focused correctness checks and one targeted timing.
If promising, compare flags off and on with the same setup, clean resets and the
same pinned timing cache (copy a saved cache file in before each run). Use
sequential repetitions and report the variability. A faster failing or partial run
is a diagnostic, not a speedup. Do not widen timeouts or drop assertions to
manufacture a win. Follow the local `AGENTS.md` for runner checks.

## Leave the next agent a usable checkpoint

Record the hypothesis, changed files or patch, flags, exact commands and run
labels, package versions, setup state, whole-process and targeted timings,
correctness comparison, failed attempts, uncertainty and cleanup. Put sanitized
findings in a focused report linked from here, and keep private raw evidence
under `.benchmarks/`. Update this handoff when the recommended setup, retained
result or next priority changes. Leave the local `AGENTS.md` pointing here, and
explicitly note any services or processes still running.
