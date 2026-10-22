# Performance fork

Runner `5.4.0-speed.4` uses the checked-in core fork `10.4.0-speed.2` in
`packages/core`. Both are local prereleases. No target application is modified
or run by the development or benchmark commands.

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
to Japa. Default concurrency is the smaller of four and the available CPU count;
`--workers` accepts 1–256. `--workers=4` and `--workers 4` are both accepted.

The default cache is a cwd-specific JSON file under
`node_modules/.cache/japa/`. Use `--history=path` to select another cache, or
`--cwd=path` to launch from another application directory. The coordinator cwd
must match Japa's configured cwd. Failed/cancelled jobs and partial test-title,
group, tag, or pinned selections do not promote new estimates. File filters can
update the selected complete files while retaining other known timings.

Existing cache entries are merged, including when another run has updated the
cache in the meantime. Concurrent jobs use separate snapshots, so changes to the
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
Target-app integration and resource configuration remain deferred until requested.

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
caches are ignored. It learns on complete runner-successful selections; filtered
file runs preserve estimates for other files. Independently launched `--shard`
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
`japa-runner-5.4.0-speed.4.tgz`. Install **both together** into an isolated test
project when ready. The runner depends on the unpublished core prerelease;
installing the runner tarball alone cannot resolve that version from npm.

Fresh production-only installation of both tarballs is checked with the
same 56-case smoke matrix as the working checkout, plus cold/warm installed-bin
automation checks: all four reporters, pass/fail,
timeout, pinned listings, buffered and late unhandled exceptions/rejections,
and stack capture enabled/disabled. It also exercises datasets, done callbacks,
regression tests, throws assertions, active-test access and cleanup.

See [core provenance](packages/core/UPSTREAM.md), the preserved MIT license, and
[benchmark methods/results](benchmarks/README.md). Application integration and
external-resource isolation are intentionally deferred until requested.
