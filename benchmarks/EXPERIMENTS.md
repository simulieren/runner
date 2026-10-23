# Experiment history: what helped, what did not, and what shipped

This records the work on 22–23 October 2026, through fork commit `f2eebc1`
(runner `5.4.0-speed.4`, core `10.4.0-speed.2`). Results are from the user's
M2 Max Mac with Node 24.19.0. Synthetic medians and individual ATS runs are
identified separately; they should not be combined into one speedup claim.

The later [ATS code experiments](ATS_CODE_EXPERIMENTS.md) measured virtual time
and fixture-hash reuse, retaining a 46–48 s full-suite result and rejecting faster
but failing/incomplete configurations. The
[sub-30 s experiments](ATS_SUB30_EXPERIMENTS.md) then added a runner timing-history
change, startup, purge, cache and timeout changes in the ATS copy, and reached
26.8–28.1 s with six workers. The initial-phase account below remains as
historical context.

[Benchmark methods](README.md) contain the detailed workloads and raw samples.
The [ATS runbook](ATS_VALIDATION.md) contains the app setup and retest commands.

## Runner and core experiments

| Attempt | What happened | Decision |
| --- | --- | --- |
| Reuse one locale-aware `Intl.Collator` for file ordering | Retained ordered-list equality against upstream; avoided constructing locale comparison machinery repeatedly. Discovery median was 121.61 ms versus 143.00 ms on upstream 5.4, but ranges overlapped. | Shipped. Preserve numeric, case-insensitive ordering; do not claim a reliable whole-command gain from this alone. |
| Precompute file-filter segments | Six-filter median fell from 2.75 to 1.11 ms/call versus upstream 5.4, about 60% less time. Filter-result equality was checked. | Shipped. Clear improvement to this narrow operation. |
| Lazy-load reporters and the error printer | Fresh-process runner import fell from 59.47 to 44.10 ms; resolved startup modules fell from 92 to 59. Successful import did not load the error printer. | Shipped. This measures runner module import, not Adonis startup. |
| Skip empty core lifecycle/context/dataset stages | The speed.2 package reduced synthetic default-stack execution from 67.11 to 54.17 ms. That package includes several changes; there was no separate attribution to each empty-stage fast path. | Shipped, with the existing asynchronous skip-event boundary preserved. |
| Disable declaration-stack capture | Synthetic registration fell from 23.66 ms upstream default to 6.21 ms with capture disabled. | Shipped as `captureTestLocations: false`, **opt-in**. Default remains true because timeout/pinned diagnostics lose declaration callsites. The ATS comparison did not enable this option. |
| Buffer spec/dot progress output | In a 10,000-test pipe workload, buffered spec execution/reporting was 73.00 ms versus upstream 123.36 ms; dot was 72.36 versus 109.95 ms. Spec writes fell from 10,004 to about 27; dot from 10,005 to 7. Core changes also contribute to upstream comparisons. | Shipped as `bufferOutput: true`, **opt-in**. Application logs can appear ahead of earlier buffered progress; defaults stay immediate. Not enabled in the ATS comparison. |
| Balance shards by file-duration estimates | Four deliberately skewed synthetic files took 162.70 ms over two workers versus 229.86 ms with round-robin. Largest planned shard fell from 150 to 82 ms. | Shipped. This establishes scheduling behavior on an uneven fixture, not a universal app speedup. |
| Collect timings manually through a reporter and supply `shardDurations` | Worked as a low-level API, but required managing a map, shard indices, and merge coordination. The user correctly identified this as unnecessary manual work. | Retained for advanced use, superseded for ordinary use by automatic coordination. |
| Automatically launch workers, freeze timing input, collect and merge results | Synthetic cold/warm, failure, cancellation, cache-change, and installed-bin checks passed. Passing ATS slices also learned costs and changed later assignments without a manual map or app timing plugin. | Shipped as `japa-parallel`; serial training is an optional plugin. Failed/partial runs do not promote incomplete timing estimates. |
| Remove extra Promise work for primitive-returning synchronous callbacks | Final 100,000-test medians fell from 318.77 to 303.18 ms without listeners, and 338.30 to 320.47 ms with start/end listeners: about 5%. Promise-returning cases were essentially unchanged, 337.87 versus 336.50 ms. | Shipped as a narrow fast path. Timers still arm before user callbacks; objects/thenables use native assimilation; done/regression wrappers remain intact. |
| Learn file timings from runs that contain failing tests (after speed.4, uncommitted, version not bumped) | ATS always has 19 failing tests, so the cache had never learned the unit suite (3 unit files). The plugin now drops only the files with failures; suite/group hook failures, pinned and partial runs still reject the run. The first ATS full run printed `timings=updated`. Alone, learned balancing was noisy (40.5–52.5 s against 46.2–46.6 s stale) because of database contention. After the purge fix it contributed to the 26.8–28.1 s result. | Implemented, with synthetic tests. See [sub-30 s experiments](ATS_SUB30_EXPERIMENTS.md). |
| Bypass event-emitter work when nothing observes an event | A prototype was much faster in the no-listener workload, but the combined candidate regressed the listener-attached workload. See the ablation below. | **Rejected; not shipped.** Production emitter semantics and implementation were retained. |

| Blend timing estimates instead of overwriting them (speed.5) | `timing-learn-a` reached 52.524 s on a *balanced* plan because one contended run inflated file costs. A fresh measurement now moves halfway toward the previous estimate; unknown files adopt it directly. | Shipped in speed.5. Proven as a build/test/smoke change and as planner behavior; no isolated wall-time win was measured under the loaded host (see the sub-30 s follow-up round). |
| Skip the `ts-exec` loader hooks for boot | Three CPU profiles put ~1.2–2.3 s of a ~5 s boot in `makeSyncRequest` (Node's synchronous hook marshalling), with only 149 ms of summed `load()` across 4,397 modules. A hook-free boot via `--experimental-transform-types` or plain TypeScript stripping was attempted and fails on app syntax and Adonis's `.js`-extension imports. | **Rejected as a cheap win**; the direction is identified but unsolved. `NODE_COMPILE_CACHE` alone saves about 0.2 s per worker. |

| Skip importing files that cannot match a title/group/tag filter | Filters are applied after import, so `--tests` imported the whole suite. An index built by a normal run now prunes files before import, guarded by mtime+size freshness and "unknown files are always imported". | Shipped. Verified to select identical tests with and without the index; a changed file is always imported. Measured as behaviour and import count, not wall time. |
| Compare failures against a committed baseline | A suite with known red tests always exits nonzero, which forces every agent and CI job to re-derive what is expected. `--allow-known-failures` exits 0 when the only failures match `japa.baseline.json`; identity is suite + file + title so it survives sharding. | Shipped. Tests cover unknown-failure detection and deliberate baseline updates. |
| Machine-readable reporter for agents | Terminal output is expensive to read and unbounded. `--agent` emits one capped JSON object per line and replaces the terminal reporters entirely. | Shipped. Verified through a production-only install of both tarballs. |
| Change-aware selection (`--changed`) | Selecting tests by hand is the slowest part of an agent's loop. The loader records which project files each test file imports; `--changed` then runs only dependent files. | Shipped with a deliberate whole-suite fallback whenever a changed path is not in the map. Verified: a changed test file selects itself, an unseen path runs everything. |
| Stagger worker startup | All workers boot at once, so every process compiles and resolves its module graph simultaneously. `startStaggerMs` delays each launch. | Implemented and tested for start order and identical results. **No wall-time claim**: the host was too loaded to attribute a gain. |
| Persistent / hot-reload workers | Considered as the only route below the per-process boot floor. Node's ESM cache cannot unload modules, and the Adonis container holds boot-time instances, so reloading app code without rebuilding the container is unsound. | **Rejected before building.** Would require a custom module runner; the fork's own history shows cross-run state leaks are the expensive failure mode here. |

| Selection-index and dependency review fixes | A self-review found two correctness bugs before any timing claim: the index was rewritten by filtered runs, so a later filter could skip a matching file, and dependency capture attributed modules at `test:start`, which is after import, so only test files (never source files) were mapped. Both are fixed; mutation checks confirm the new tests fail against the old behaviour. | Fixed. The selection features now do what the design promised: over-select, never under-select. |
| Prepare caches without a run (`--prepare`) | A fresh checkout got no selection benefit until a full suite ran. Registration knows every test without executing any, so the index and dependency map are now written after imports. | Shipped. Verified: no test executes, both cache files are written. |
| Git-backed `--changed=auto` | Harnesses had to compute changed paths themselves. `auto` reads tracked changes against HEAD plus untracked files, filtering build output, and keeps the unknown-path fallback. | Shipped. Verified in a temporary git repository and in a production-only install. |
| Baseline-aware `--failed-new` | Always-red suites rerun their known failures forever. `--failed-new` drops baseline titles before selecting. | Shipped as opt-in: the retry cache stores titles, not file-qualified identities, so filtering cannot be exact. |
| `--workers=auto` and stagger | Four workers on a one-file selection pay four boots. Narrow filters now default to one worker. `startStaggerMs` delays each launch. | Shipped. `autoWorkerCount` is unit-tested; **no wall-time claim**, the host was loaded. |
| Agent stream, metadata and exit codes | App logs on stdout corrupt JSON; harnesses could not distinguish a failed test from a broken command; summaries hid whether a selection fell back. `--agent-file` isolates the stream, `location`/`errorGroups` compress failures, the summary reports selection and phase timings, and planning errors exit 2 under the agent reporter. | Shipped, with `AGENT_INTEGRATION.md` as the contract. |
| Agent selection validated on ATS | `--prepare` built both caches in ~9.2 s for 648 files; a filtered run planned 4 files instead of 648 with identical identities and 748 ms instead of 3,886 ms of import time; `--changed` selected one dependent spec; baseline update/allow-known worked; a six-worker full run kept all 8,515 identities. | Correctness retained. Two selection bugs and one reporting bug were found and fixed first: dataset titles, shared-module attribution, and the collected/planned count. Wall-clock remains unmeasured while the host is loaded. |
| Harness-neutral `japa-agent` wrapper | Each harness would otherwise reimplement prepare-then-changed. The wrapper composes existing flags for any command that forwards CLI args: prepare missing caches, run `--changed=auto` with the agent stream, pass through exit codes, leave stdout to the app. | Shipped as `bin/agent.ts`. Verified from a production-only install. Reports `selection.fallback` when a filter could not narrow. |
| Coordinator-owned baseline writes | `--update-baseline` under parallel workers let each shard write a partial baseline; the last writer won. Workers now report failures in their result files and the coordinator merges once under the timing-promotion validity gate. | Shipped with a two-worker test and a partial-selection rejection test. |
| Tracked cache paths (`--index-file`, `--dependency-file`) | A fresh checkout paid ~9 s of `--prepare` before any fast run. Both caches can now live in a tracked path that CI or a pre-commit hook ships. | Shipped with an integration test that deletes `node_modules/.cache` and still prunes. |
| Delta reports in `japa-agent` | Re-running the same selection re-reported everything. The wrapper now writes `<report>.delta.json` with new/fixed failures and counts, and refuses to claim fixes when the selection changed. | Shipped with five unit probes and a wrapper integration check. |
| Adonis worker-resource helpers | Every app hand-rolls per-worker DB/Redis/search/HTTP/mail ports; that boilerplate produced the mail-leak and missing-report incidents. `adonisWorkerResources`, `applyAdonisWorkerEnv` and `assertAdonisWorkerIsolation` ship from `@japa/runner/factories`. | Shipped with tests; provisioning remains app-owned. |
| Boot attribution | Boot had never been attributed. A committed `boot_breakdown.mjs` probe showed 4.4 s in Node's synchronous ESM hook path and negligible time in Adonis providers. | Recorded; lazy providers are not the lever, loader replacement is. |
| `tsx` loader experiment | `bootstrap-loaded` measured 3.49 s through `tsx` versus 4.98–5.08 s through `ts-exec` in the copied app, same selection. Direct-loader samples were noisy and full-suite decorator correctness was not verified. | **Not adopted**; needs a full identity run before any claim. |
| Setup-free prepare, cache locks, baseline history | Prepare ran app setup it did not need; concurrent agents could overwrite each other's caches; baselines baked flakes in silently. Prepare now skips global hooks, all cache read-modify-write sequences take a lock with stale recovery, and baselines track consecutive runs and report fixed entries. | Shipped with lock and baseline probes. Prepare remains import-bound (~4.8 s boot + ~3.3 s imports on ATS). |
| Differential selection gate | The safety promise needs an executable check, not review. `selection_gate.mjs` runs the same filter with and without the index and compares identities and exit codes. | Shipped; passed on ATS for one title. |
| Loop metrics and lab runner | Single-run timings kept being mistaken for loop speed. `japa-agent` appends per-run metrics and `--report` summarises them; `lab_runner.mjs` records load and marks samples LOAD-AFFECTED above a budget. | Shipped; wrapper integration test covers the metrics file. |
Feature medians: [features.json](results/features.json).
Discovery/filter samples: [discovery.json](results/discovery.json).
Final synchronous-path samples: [core-paths.json](results/core-paths.json).

## Results that did not support a broader speed claim

The initial whole-process synthetic measurements were noisy. For a filtered
command, the fork's median was **274.56 ms**, slower than upstream 5.4's
**210.88 ms**, despite a low-load pilot suggesting a 15–20 ms saving. The final
ranges overlapped substantially. The full synthetic async workload was also
slower in the fork's one-worker median: **3,089 ms versus 2,865 ms** on upstream
5.4. These results were kept in the report rather than selecting the pilot as
proof of improvement.

Synthetic async worker medians were 3,089 / 1,577 / 1,100 / 1,091 ms for
1 / 2 / 4 / 6 workers. Six workers offered little extra median benefit over four
under that load. **Six-worker ATS performance was not tested.**

The core Promise-returning benchmark did not materially improve. The shipped
synchronous fast path is not an optimization of database, HTTP, timer, or other
external I/O waits. Its roughly 5% synthetic improvement did not translate into
a comparable ATS serial speedup.

Full ATS serial time was 242.671 s versus the baseline's 247.094 s, just 1.8%
apart in single runs. That difference is too small to assign confidently to
runner changes. Small ATS slices also did not get faster with parallelism:
CMS unit was 10.655 s baseline versus about 11.2 s with two workers, and CMS
functional was 21.761 s baseline versus 22.733 s with two workers. Startup and
migration overhead dominated those small selections.

## Rejected emitter prototype and why profiling was not enough

A 200,000-test profile showed substantial sampled self-time in Emittery debug
checks, producer bookkeeping, event emission, Promise work, and garbage
collection. That motivated trying an unobserved-event fast path. The profile
itself used no listeners and included registration/startup/GC; it was a lead for
an experiment, not evidence that the change would help normal reporter/plugin use.

In the exploratory 100,000-test ablation:

| Variant | No listeners | Start/end listeners attached |
| --- | ---: | ---: |
| Previous speed.2 | 322.844 ms | 352.983 ms |
| Combined candidate: emitter + synchronous changes | 248.001 ms | 379.558 ms |
| Synchronous change only | 307.816 ms | 326.305 ms |
| Emitter change only | 247.592 ms | 358.504 ms |

The combined candidate improved the bare case by about 23%, but slowed the
observed case by about 7.5%. The emitter-only observed median also moved in the
wrong direction, with noisy overlapping ranges. The synchronous-only change
was the part worth retaining; a separate final benchmark measured the shipped
version. The candidate/combined numbers are **not** shipping performance claims.

Artifacts retained for review:

- [Sampled profile summary](results/core-profile-summary.json)
- [Separate-change ablation and samples](results/core-path-ablation.json)
- [Rejected prototype patch](results/unobserved-emitter-prototype.patch)

## ATS attempts, including unsuccessful setup runs

All app execution was intended for a filesystem/dependency copy under
`.benchmarks/ats-validation/app/`. The original ATS source, installed packages,
and app database were not modified. The original Git status matched before and
after. The shared-Mailpit setup incident below is recorded separately.

| Attempt | Outcome | What changed next |
| --- | --- | --- |
| Initial copied environment | ATS's ownership guard detected that the configured database belonged to the original checkout and refused the run before migrations/tests. This was not a benchmark result. | Replaced copied environments with example/test values and dedicated lab services; added resource assertions in the copy. |
| Start with an empty dedicated database | Some providers queried the database during app boot, before Japa's setup hook could create it. Boot failed and left open handles. | Create dedicated worker databases before launching the app; bound later runs with a process-group timeout. |
| Initial three-minute full-unit run limit | The suite exceeded the limit and was killed without a complete summary. | Raised the harness limit to ten minutes. Excluded incomplete runs from comparisons. |
| Shared default Mailpit helper URL | An early baseline may have cleared messages in the existing local Mailpit inbox, even though SMTP used a lab service. A further in-progress baseline was stopped while isolation was corrected. | Redirected both SMTP and the Mailpit HTTP helper, including its fallback. Later runs used dedicated inboxes. |
| App/Vite's default WebSocket port | The copied app reported the default HMR port was already in use by the running original app. | Assigned a separate `VITE_HMR_PORT` per worker and recorded the copied Vite configuration edit. Did not stop or reconfigure the original server. |
| Baseline full unit suite | Completed in 247.094 s: 8,495 passed, 19 failed, one skipped. | Used these exact test identities and failures as the regression reference. These are failures in the isolated setup, not proof of production defects. |
| Fork serial full suite | Completed in 242.671 s with the same test identities and same 19 failures. | Confirmed compatibility; did not claim a reliable serial speedup. |
| Four workers, shared lab Mailpit | Completed in 80.604 s but added a real-SMTP reminder-test timeout: 20 failures. No tests were missing or duplicated. | Investigated infrastructure contention first; did not accept this run as the validated speedup. |
| Separate Mailpit inbox for each worker | Completed in 87.884 s, but the same additional SMTP timeout remained. | Rejected shared-inbox contention as a sufficient explanation. Inspected app mail state. |
| Reset the leaked mail fake before the real-SMTP test, in the copy only | Instrumentation printed `FakeMailer` before reset. `mail.restore()` made the test pass in 131 ms without increasing its timeout. The full run took 86.453 s, matching all 8,515 identities and exactly the 19 baseline failures. | Accepted this conditional result: **2.86× faster**, provided the app's mail-state isolation is fixed before real integration. |
| Passing CMS unit and HTTP slices, cold/warm coordinator runs | All 180 unit and 94 functional tests passed; identities matched. Automatic timing cache updates and changed assignments were observed. | Confirmed learning and HTTP/resource setup. Did not use these small slices to claim speed improvement. |

The explanation for the extra SMTP failure was app state leaking across tests:
`BaseEmailJob` calls `mail.fake()` in test mode without restoring it. Serial file
order happened to run a later restoration before the real-SMTP test; sharding
changed that order. Separate inboxes could not fix an in-process fake mailer.
The correction remains confined to the copied fixture.

Raw ATS attempts, complete results, baseline failure inventory, and comparison
JSON remain local under `.benchmarks/ats-validation/`. See the
[retest runbook](ATS_VALIDATION.md) for filenames, preserved wrappers, isolation
ports, the copy-only patch, and commands. The templates and patch are in
[ats-validation/](ats-validation/README.md); the private app and raw results are
not committed.

## Coordination bugs corrected before shipping speed.4

These were correctness fixes during implementation, not extra performance wins:

- The first CLI implementation parsed `--cwd` without forwarding it to the
  coordinator. Corrected it and added checks that launch from a different cwd,
  including through the installed executable.
- Independent workers writing Japa's shared failed-test cache could overwrite
  one another and disagree on `--failed` selection. Moved ownership to the
  coordinator: freeze one previous-failure snapshot, then merge worker failures.
  Multi-worker failure/rerun checks passed before the push.
- Independently reading a changing timing cache risks duplicate or omitted file
  assignments. Managed workers instead share one immutable snapshot, and reports
  are checked for run/worker identity and duplicate file keys before promotion.
- Cancellation needed to handle children that ignore SIGTERM. POSIX cancellation
  signals process groups and escalates to SIGKILL; synthetic checks verified the
  worker was no longer running. Windows support signals immediate children only;
  that behavior was not exercised on this Mac.

## Choices deliberately not attempted or not enabled

These are constraints or deferred work, **not failed measured experiments**:

- Concurrent imports inside one runner process were not enabled: test registration
  uses shared current-file/current-suite state. Parallelism uses separate processes.
- Timeout timers were not removed to gain speed. Reset/clear behavior and timeouts
  remain active, including during the new synchronous callback path.
- Stack-capture disabling and reporter buffering stayed opt-in and were not used
  to inflate the ATS result.
- No original ATS package install, source edit, broad baseline-failure fix, or full
  functional/browser run was performed. Six/eight-worker follow-up attempts are
  recorded in the later code-experiment report; they were not retained.
- The initial phase did not benchmark database preparation, virtual lease clocks,
  or faster fixture hashing. Those were tried in the later
  [ATS code experiments](ATS_CODE_EXPERIMENTS.md); they are ATS-side prototypes,
  not new runtime features of the published runner fork.

The retained result is therefore specific: lower overhead in several measured
runner operations, modest synthetic synchronous execution gains, and a large
full-unit ATS gain from isolated process parallelism after correcting one
app-test state leak. It is not evidence that every test command becomes faster.
