# Performance fork

Follow-up: [ATS code experiments and the 46–48 s result](benchmarks/ATS_CODE_EXPERIMENTS.md).
Latest: [sub-30 s experiments, 26.8–28.1 s with six workers](benchmarks/ATS_SUB30_EXPERIMENTS.md).

Runner `5.4.0-speed.5` uses the checked-in core fork `10.4.0-speed.2` in
`packages/core`. Both are local prereleases. speed.5 includes the timing-history
change (failing runs train their passing files) and smoothed estimate updates.
Default development and synthetic benchmark commands do not modify or run the
target application. Separate isolated ATS validation is documented in the
[ATS runbook](benchmarks/ATS_VALIDATION.md).

For what was tried, what helped, and what was rejected or inconclusive, see the
[experiment history](benchmarks/EXPERIMENTS.md).

## Changes and defaults

- File discovery reuses a locale-aware collator; filtering reuses path segments.
- Built-in reporters load when activated. Error printers load only when needed.
- Synchronous callbacks returning primitive values avoid a redundant async wrapper
  and Promise race. Timeout timers still arm before user code so resets and
  cancellation retain their behavior. Objects/functions use native Promise
  assimilation; done/regression tests retain their existing wrappers.
- Core skips empty lifecycle/cleanup stages and absent dataset/context callbacks.
  The original asynchronous skip-event boundary remains intact.
- Declaration-stack capture remains enabled. Set `captureTestLocations: false`
  to avoid capturing an Error for every test registration. Ordinary thrown errors
  still retain their own stacks; runner-generated timeout errors and pinned-test
  listings lose their declaration callsite in this mode.
- `spec({ bufferOutput: true })` and `dot({ bufferOutput: true })` opt into
  batching. Batches flush at 8,192 characters, within 25 ms, immediately on a
  failed test, and before the end hook/summary. Buffering defaults to false to
  preserve output timing and console-log ordering. When enabled, application
  logs can appear before earlier buffered progress. NDJSON stays unbuffered.
- `japa-parallel` launches workers, learns file timings and balances later runs
  automatically. Supplying `shardDurations` manually remains an advanced override.

## Faster iteration for agents and harnesses

See [Using Japa from an agent or harness](AGENT_INTEGRATION.md) for the command
loop, JSON schema, exit codes and cache-trust rules. `japa-agent` packages that
loop behind one harness-neutral command: it prepares missing caches, runs the
affected files, and writes the agent stream.

An agent does not run a suite once. It runs part of it, many times, and pays for
both the wall time and the output it has to read. Four optional features target
that loop. All are best-effort and all fall back to the previous behaviour rather
than changing which tests run.

### Prepare caches (`--prepare-caches`, alias `--prepare`)

Imports every file, writes the selection index and the dependency map, and exits
without running a test. It is the cheap way to prime a fresh checkout; the two
caches otherwise stay empty until a full run finishes.

### Selection index (`--tests`, `--groups`, `--tags`)

Title, group and tag filters are normally applied *after* import, so selecting one
test still imports every file. The first unfiltered run records what each file
contains under `node_modules/.cache/japa/index-<hash>.json`; later filtered runs
drop files that cannot match before importing them.

- A file is dropped only when the index proves no test inside it can match.
- A file whose size or mtime changed since indexing is always imported.
- A file the index has never seen is always imported, so a new test file cannot
  be missed by a filter.
- `JAPA_NO_SELECTION_INDEX=1` disables it; results are identical either way.
- Entries are written from registration, not execution: importing a file
  registers all of its tests whatever the filter is, so filtered runs keep entries
  complete for every file they imported.

Effect: a single-test run imports one file instead of the whole suite. Boot cost
remains, because the application still has to start.

### Failure baseline (`--allow-known-failures`, `--update-baseline`)

A suite with known-failing tests always exits nonzero, so a harness must work out
which failures are expected. Commit a `japa.baseline.json` and run with
`--allow-known-failures` to exit 0 when the only failures are recorded there. Any
failure not in the baseline still exits 1.

`--update-baseline` records the current failures, sorted, with a consecutive-run
count; entries that stop failing stay with `consecutive: 0` and are reported as
fixed., so the file is stable in
review. It is a deliberate action, not part of a normal run; the write finishes
before the process exits or any comparison reads the file back. Only a full run
writes it: a filtered, changed or sharded selection leaves the existing baseline
untouched, and under the coordinator the workers report failures while the
coordinator merges and writes once.

Identity is suite + relative file + expanded title, so it survives sharding and
worker reassignment. A test that did not run is never reported as fixed.
`--failed-new` additionally drops titles already in the baseline before rerunning,
for always-red suites; it is opt-in because the retry cache stores titles only.

### Agent reporter (`--agent`)

Replaces the terminal reporters with one JSON object per line: `t: "test"` with
status, file, group, title, duration and bounded errors, plus a final
`t: "summary"`. No ANSI, no progress output, and every line is capped so one
pathological stack cannot flood the reader.

`--agent` emits failing, skipped and todo tests only, because a large suite would
otherwise produce thousands of passing lines. Use `--agent-all` or
`agent({ onlyFailures: false })` from `@japa/runner/reporters` for the full
stream. `--agent-file=path` writes the same lines to a file, so application output
on stdout cannot corrupt the stream. Under the agent reporter, setup and planning
failures exit 2, while test failures exit 1.

### Change-aware selection (`--changed=path1,path2`)

While a run imports test files, a resume hook records the resolution edge from
each module to the modules it imports, and the importer marks the test files
being loaded. The map is written to
`node_modules/.cache/japa/dependencies.json` as the transitive closure of each
test file over those edges.

Edges, not load events, are what make this correct: ESM loads a shared module
only once, so attributing loads would assign it to whichever test file imported
it first and miss every later importer. A later `--changed=<edited files>` run
imports the test files whose closure reaches them, including shared modules.

If any given path is not in the map (a new module, a config file, a lockfile),
Japa runs the full suite instead, because running too much is safe and running too
little is not. Dependencies accumulate across runs, so a module is not forgotten
when a later run does not touch it. `--changed=auto` reads the paths from
`git diff --name-only HEAD` plus untracked files, ignoring build output.

## Automatic parallel runs

Run the existing test command through the coordinator, from the application's
working directory:

```sh
npx --no-install japa-parallel --workers=4 -- node bin/test.js unit
```

For a TypeScript entrypoint:

```sh
npx --no-install japa-parallel --workers=4 -- node --import=@poppinss/ts-exec bin/test.ts unit
```

No timing map, duration reporter, shard number, merge script, or application-config
edit is required. The coordinator:

1. Loads cached file costs, or uses round-robin on a cold/corrupt cache.
2. Freezes one snapshot and supplies it to every worker.
3. Launches the command with `--shard=1/4` through `--shard=4/4` automatically.
4. Collects per-worker timings and atomically updates the cache after all workers
   finish successfully. Later runs use the learned estimates.

The coordinator also freezes the previous failed-test selection for `--failed`
and merges failure reports once all workers finish, avoiding competing worker
writes to Japa’s failed-test cache.

The fork automatically activates timing collection when launched by this
coordinator. Commands must use this fork and forward their appended shard flag
to Japa. `--workers=auto` uses one worker when the command carries a title, group, tag or
changed-path filter, where extra application boots cost more than they save.
Default concurrency is otherwise the smaller of four and the available CPU count;
`--workers` accepts 1–256. `--workers=4` and `--workers 4` are both accepted.

The default cache is a cwd-specific JSON file under
`node_modules/.cache/japa/`. Use `--history=path` to select another cache, or
`--cwd=path` to launch from another application directory. The coordinator cwd
must match Japa's configured cwd. A run with failing tests still trains: each
file that contains a failed test keeps its previous estimate, and the other files
are learned. A failed suite or group hook, a cancelled job, a signal-terminated or
unreported worker, and partial test-title, group, tag or pinned selections do not
promote new estimates. File filters can update the selected complete files while
retaining other known timings.

A new measurement is blended with the previous estimate (half the distance)
rather than replacing it, so one contended run cannot fully rewrite the next
assignment. Unknown files adopt the measurement directly.

Existing cache entries are merged, including when another run has updated the
cache in the meantime. Cache read-modify-write sequences take a lock, so
concurrent agents no longer overwrite one another's learned entries. Concurrent jobs use separate snapshots, so changes to the
shared cache cannot change an in-progress worker's assignment. Cache updates are
best-effort; there is no cross-job cache lock, so last-writer-wins can lose some
training updates in an overlapping write. Each resulting cache is valid JSON,
and this does not affect an in-progress job's frozen assignments.

CTRL-C/SIGTERM stops the worker pool; on POSIX the coordinator signals worker
process groups and escalates to SIGKILL after one second. Missing or incompatible
worker reports cause a nonzero coordinator result. On Windows cancellation
signals the immediate child processes. The existing spec/dot/NDJSON output is
inherited from workers and can interleave.

Japa does not provision database, Redis, search, or HTTP-port isolation.
`JAPA_WORKER_ID` and `JAPA_WORKER_COUNT` are supplied for application configuration.
ATS has been validated in an isolated copy; see the [setup, findings, and retest runbook](benchmarks/ATS_VALIDATION.md). Installation into the original app remains deferred.

## Optional training from ordinary serial runs

Add this plugin once if normal serial runs should also train the cache:

```ts
import { durationHistory } from '@japa/runner/plugins'

configure({
  files: ['tests/**/*.spec.ts'],
  plugins: [durationHistory()],
})
```

The plugin loads and saves timings automatically. Missing, corrupt or foreign-cwd
caches are ignored. It learns on complete selections without suite or group hook
failures, skipping files that contain a failed test. Filtered file runs preserve
estimates for other files. Independently launched `--shard`
commands do not read/write the automatic cache, since they cannot coordinate a
snapshot. They retain the existing explicit-estimate/round-robin behavior.
The parallel command does not require this plugin in app configuration.

## Programmatic worker configuration

```ts
import { runParallel } from '@japa/runner/parallel'

const result = await runParallel({
  command: process.execPath,
  args: ['bin/test.js', 'unit'],
  workers: 4,
  cwd: '/path/to/test-project',
  // Supply application-specific environment values here when integrating.
  workerEnv: (worker) => ({ TEST_WORKER: String(worker) }),
})
process.exitCode = result.exitCode
```

`runParallel` also accepts `historyFile`, a shared `env`, an `AbortSignal`, and
`stdio: 'inherit' | 'ignore'`. Environment callbacks are evaluated before any
worker is launched. Managed planning inputs cannot be replaced by later plugins.

## Advanced duration APIs

`fileDurations({ output })` remains available from `@japa/runner/reporters` for
custom exports, and `shardDurations` accepts an explicit estimate map. These
APIs are optional. Keys are suite-qualified relative paths, for example
`unit:tests/unit/user.spec.ts`; plain relative paths are accepted as a fallback.

Collected estimates sum Japa's reported test durations; they exclude imports and
suite/group hooks outside test timing. The planner assigns longest estimates to
the least-loaded worker, breaking ties by file count and worker number, while
preserving import order within each shard. Filters apply first. Unknown files
use the median positive supplied estimate, or 1 ms if none exists. Invalid
negative/non-finite explicit estimates fail validation.

## Build, validate and package

Requires Node 24 or newer. From this repository:

```sh
npm install --ignore-scripts
npm run build
npm test
npm run test:core
npm run typecheck
npm run typecheck --workspace=@japa/core
npm run bench:smoke
npm run bench:automatic
mkdir -p .benchmarks
npm pack --workspace=@japa/core --ignore-scripts --pack-destination .benchmarks
npm pack --workspaces=false --ignore-scripts --pack-destination .benchmarks
```

The two tarballs are `japa-core-10.4.0-speed.2.tgz` and
`japa-runner-5.4.0-speed.5.tgz`. Install **both together** into an isolated test
project when ready. The runner depends on the unpublished core prerelease;
installing the runner tarball alone cannot resolve that version from npm.

`--index-file` and `--dependency-file` let both caches live in a tracked path, so
a fresh checkout can start with them. Cache files use one naming convention:
`index-<hash>.json`, `durations-<hash>.json` and `dependencies-<hash>.json`. `japa-agent` also writes a delta report
beside the agent stream. See [the harness guide](AGENT_INTEGRATION.md).

Benchmark probes are available as `npm run bench:timing-cache`,
`npm run bench:selection-index`, `npm run bench:changed-selection` and
`npm run bench:agent-delta`.

Fresh production-only installation of both tarballs is checked with the
same 56-case smoke matrix as the working checkout, plus cold/warm installed-bin
automation checks: all four reporters, pass/fail,
timeout, pinned listings, buffered and late unhandled exceptions/rejections,
and stack capture enabled/disabled. It also exercises datasets, done callbacks,
regression tests, throws assertions, active-test access and cleanup.

See [core provenance](packages/core/UPSTREAM.md), the preserved MIT license, and
[benchmark methods/results](benchmarks/README.md). Application integration and
external-resource isolation are intentionally deferred until requested.
