# Runner performance experiment

This fork reduces discovery and file-filtering overhead while retaining upstream 5.4's sharding behavior. It reuses an `Intl.Collator` for numeric, case-insensitive file ordering and computes filter segments once per call and file segments once per file. Test imports remain sequential because registration uses shared current-file/current-suite state.

## Reproduce

From this repository, with Node 24 or newer:

```sh
npm install --ignore-scripts
npm run build
npm run bench:prepare
npm run bench:discovery
npm run bench:runner
```

Run benchmarks sequentially with other CPU-heavy work stopped. `bench:prepare` extracts the upstream v5.3.0 and v5.4.0 tags into the ignored `.benchmarks` directory, then builds both against a separate registry dependency tree under `.benchmarks/upstream-deps`, pinned to `@japa/core@10.4.0`. The reference runners do not use the workspace core fork. Other transitive versions are resolved at preparation time; these are not historical lockfile reproductions. Tested dependencies include `@japa/core@10.4.0`, `@japa/errors-printer@4.1.4`, and `@poppinss/string@1.7.2`.

The portable fixture generates 1,064 filenames across unit, functional, and browser layouts. Optionally supply a directory of tests to reproduce another layout:

```sh
npm run bench:prepare -- /absolute/path/to/application/tests
```

That optional directory is accessed only with `readdir`. No file contents or application environment are read, no tests from it are imported, and nothing is written there. The filename manifest stays in `.benchmarks/ats-layout.json`, which is ignored by Git. All generated fixtures, reference copies, and raw measurements stay inside `.benchmarks`. Layout paths are checked before fixture generation.

## Method

- Discovery: exact ordered file-list and filter-result equality against both upstream versions, one warm-up, seven measured rounds, rotating version order. Filtering averages 100 calls per round.
- Whole process: fresh Node processes using production JavaScript builds, one warm-up, five measured rounds, rotating case order. Measures parent-observed time through child exit, alongside child module-load, import, execution and RSS measurements.
- Workloads: one filtered filename, one no-op test per file, and one test per file awaiting a synthetic 2 ms timer.
- Workers: upstream file sharding with 1, 2, 4 and 6 separate processes for the synthetic asynchronous workload. Each sample checks aggregate import/test counts and failures. Upstream shard tests separately cover deterministic distribution.
- Reporting: a minimal benchmark reporter, no terminal rendering or application reporter.

The synthetic workers use no database, Redis, search, HTTP server, migrations, seeds, or Adonis boot. Their scaling is not evidence of application test scaling. A file represents one test here; real files may contain many tests and have uneven cost.

## Applying to an Adonis application later

Application integration is intentionally deferred. No target application's source, lockfile, dependency tree, generated files, databases or services were changed, and its tests were not run.

Before enabling concurrent application tests, arrange per-worker database ownership and migration/seed setup, Redis/cache/queue isolation, search collection prefixes, HTTP ports, external resource isolation, and result paths. Audit hard-coded database/service addresses and cleanup operations as well as environment configuration. The application reporter must avoid workers overwriting or pruning one another's result files. Preserve cache cleanup, ownership checks, unknown-file-filter checks and zero-test protection.

Start at two workers, compare four and six, and require unchanged test selection, expected failures/exit codes, cleanup and repeated outcomes. The application-level profiler should measure boot, plugins, discovery/imports, migration/seed hooks, execution, reporting and process exit separately. Avoid assigning a speedup from these runner measurements to those unmeasured phases.

## Initial speed.1 results (2026-10-22)

Apple M2 Max, 12 logical CPUs, 96 GiB RAM, Node 24.19.0. The locally captured layout contained 1,066 files by benchmark time. No other target repository activity was stopped or changed. Shared-machine load varied substantially; the ranges overlap, so whole-process improvements are inconclusive. The earlier low-load pilot showed approximately 15–20 ms saved in a filtered process, but the final measured rounds do not establish that as a reliable improvement.

| Workload | Upstream 5.3 median | Upstream 5.4 median | Fork median |
| --- | ---: | ---: | ---: |
| Discovery (ms) | 128.68 | 143.00 | 121.61 |
| Filtering, six filters (ms/call) | 2.55 | 2.75 | 1.11 |
| Filtered whole process (ms) | 183.19 | 210.88 | 274.56 |
| 1,066 no-op tests, whole process (ms) | 394.08 | 358.27 | 349.13 |
| 1,066 synthetic async tests, whole process (ms) | 2,783.82 | 2,865.43 | 3,089.11 |

Filtering took about 57% less time than 5.3 and 60% less than 5.4 in the final samples. Discovery ranges were 108.73–146.64 ms (5.3), 97.93–153.45 ms (5.4), and 93.25–143.76 ms (fork). Filtered whole-process ranges were 136.44–252.64 ms, 140.74–381.42 ms, and 117.76–340.12 ms respectively: the slower fork median illustrates why a whole-command speedup cannot be claimed from this run.

| Fork async workers | Whole-process median | Range |
| --- | ---: | ---: |
| 1 | 3,089 ms | 2,835–3,212 ms |
| 2 | 1,577 ms | 1,469–1,863 ms |
| 4 | 1,100 ms | 839–1,367 ms |
| 6 | 1,091 ms | 608–1,261 ms |

Four and six workers had similar medians under this load. This suggests testing four before six on an isolated application copy; it is not a worker-count recommendation for shared application resources. Raw per-round measurements and child-process metrics are in [results/discovery.json](results/discovery.json) and [results/runner.json](results/runner.json).

## Initial build artifact (speed.1)

The fork uses version `5.4.0-speed.1` to distinguish it from upstream. Build and create a local installable tarball with:

```sh
npm run build
npm pack --ignore-scripts --pack-destination .benchmarks
```

No registry publication or target-application installation is performed. The tarball exports the same package entrypoints and includes the existing upstream `--shard` support. Keep worker concurrency disabled when eventually testing it against shared application infrastructure.


## Additional speed.2 features (2026-10-22)

Run `npm run build`, `npm run bench:prepare`, and `npm run bench:features`
sequentially. The feature benchmark uses one warm-up and five measured rounds,
rotating scenario order, with fresh Node processes. Reporter writes are forwarded
to a real pipe drained by the parent. Registration, execution, and reporter
workloads use 10,000 synthetic tests; core timers stay enabled at 2,000 ms.
Startup measures module import inside a fresh process, with a resolve hook counting
loaded modules; it does not include process launch or Adonis startup.

| Measurement | Upstream/reference median | Fork median |
| --- | ---: | ---: |
| Runner import vs 5.4 | 59.47 ms | 44.10 ms |
| Resolved startup modules | 92 | 59 |
| Core execution, default stacks | 67.11 ms | 54.17 ms |
| Core registration, stacks disabled vs upstream default | 23.66 ms | 6.21 ms |
| Spec reporter + execution, buffered vs 5.4 | 123.36 ms | 73.00 ms |
| Dot reporter + execution, buffered vs 5.4 | 109.95 ms | 72.36 ms |
| Skewed workload, two workers, round-robin vs duration estimates | 229.86 ms | 162.70 ms |

The same fork with immediate output took 116.37 ms (spec) and 96.07 ms (dot),
so the differences against upstream also include core execution changes. Spec
writes fell from 10,004 to a median of 27; dot writes from 10,005 to 7.

The skewed workload has four files awaiting 80, 4, 70 and 8 ms. Both scenarios run
all four tests across two processes, including parent-observed process launch
and exit. Duration estimates reduce the planned largest shard from 150 to 82 ms.
This demonstrates scheduling on a deliberately uneven synthetic workload, not
application throughput.

The startup check confirms that errors-printer is absent from successful module
imports. The core benchmark compares published `@japa/core@10.4.0` with the local
fork; default registration retains stacks, while the explicit no-stacks variant
trades runner-generated declaration diagnostics for lower allocation cost.
Numbers describe individual workloads and must not be added together as a total
application speedup. Full samples/ranges are in [results/features.json](results/features.json).

`npm run bench:smoke` separately checks all reporter and error paths. See
[PERFORMANCE.md](../PERFORMANCE.md) for opt-ins, history collection, defaults,
validation, and the two-package installation requirement. No target app was
accessed or run for these feature experiments.

## Synchronous paths (speed.3)

Runner `5.4.0-speed.3` and core `10.4.0-speed.2` keep a narrow improvement:
primitive-returning synchronous callbacks bypass an async executor wrapper and
Promise race. Timeout timers remain armed before user code. Promise-returning
callbacks and thenables retain native assimilation, while done/regression tests
retain the previous wrappers. No additional configuration is required.

A 200,000-test CPU profile identified Emittery debug checks, producer bookkeeping,
Promise work and GC as costs alongside test execution. The sanitized sampled
self-time summary is in [results/core-profile-summary.json](results/core-profile-summary.json).
This includes startup/registration/GC and is diagnostic, not a throughput estimate.

A no-observer emitter prototype reduced no-listener workload time, but added
cost when listeners were attached. The separate-change experiment is preserved
in [results/core-path-ablation.json](results/core-path-ablation.json) and the
[prototype patch](results/unobserved-emitter-prototype.patch). The combined and
emitter-only variants in that experiment are **not shipped**. The production
emitter and its subscription/debug/iterator behavior are unchanged.

Reproduce the final comparison with:

```sh
npm run build
npm run bench:prepare
npm run bench:core-paths
```

Preparation builds the previous core from commit `8c5e2d5` into
`.benchmarks/baseline-core-speed.2`, using the current dependency tree. Each sample
uses a fresh Node process and 100,000 tests, timeout timers set to 2,000 ms, and
stack capture disabled to focus on execution. There is one warm-up, seven measured
rounds, rotating version/workload order. The observed cases attach one start and
one end listener and verify the end-notification count. Registration is timed
separately; execution measurements exclude verification. The Promise case returns
an already-resolved Promise and represents no external I/O.

| Execution workload | Previous core median | New core median |
| --- | ---: | ---: |
| Synchronous, no listeners | 318.77 ms | 303.18 ms |
| Synchronous, start/end listeners | 338.30 ms | 320.47 ms |
| Promise-returning, start/end listeners | 337.87 ms | 336.50 ms |

Synchronous medians fell about 5%; the Promise-returning difference is negligible.
Shared-machine noise produced long outliers and overlapping ranges, so these are
modest synthetic median improvements, not a guaranteed application speedup. Full
samples and ranges are in [results/core-paths.json](results/core-paths.json).
The direct core benchmark omits runner-level active-test hooks and application
bootstrap. ATS remains unmodified and untested.
