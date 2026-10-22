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

Run benchmarks sequentially with other CPU-heavy work stopped. `bench:prepare` extracts the upstream v5.3.0 and v5.4.0 tags into the ignored `.benchmarks` directory, then builds both using this checkout's dependency tree. These comparisons isolate runner changes; they do not reproduce historical transitive dependency versions. Tested dependencies include `@japa/core@10.4.0`, `@japa/errors-printer@4.1.4`, and `@poppinss/string@1.7.2`.

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

## Measured results (2026-10-22)

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

## Build artifact

The fork uses version `5.4.0-speed.1` to distinguish it from upstream. Build and create a local installable tarball with:

```sh
npm run build
npm pack --ignore-scripts --pack-destination .benchmarks
```

No registry publication or target-application installation is performed. The tarball exports the same package entrypoints and includes the existing upstream `--shard` support. Keep worker concurrency disabled when eventually testing it against shared application infrastructure.
