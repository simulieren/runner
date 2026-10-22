# Performance fork

Runner `5.4.0-speed.3` uses the checked-in core fork `10.4.0-speed.2` in
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
- Supplying a nonempty `shardDurations` map enables duration-balanced sharding.
  Without estimates, upstream round-robin behavior remains unchanged.

## Collect and use file durations

```ts
import { configure } from '@japa/runner'
import { spec, fileDurations } from '@japa/runner/reporters'

configure({
  files: ['tests/**/*.spec.ts'],
  reporters: {
    activated: ['spec', 'file-durations'],
    list: [
      spec({ bufferOutput: true }),
      fileDurations({ output: './test-results/durations-worker-1.json' }),
    ],
  },
})
```

The duration reporter sums Japa's reported test durations per suite/file and
writes the map at runner end. Keys look like `unit:tests/unit/user.spec.ts` and
are relative to `cwd` (the process directory by default), using `/` separators.
It does not include file import time or suite/group hooks outside test timing.

Use the collected map in a subsequent run:

```ts
configure({
  files: ['tests/**/*.spec.ts'],
  filters: { shard: { current: 1, total: 4 } },
  shardDurations: {
    'default:tests/user.spec.ts': 420,
    'default:tests/billing.spec.ts': 1800,
  },
})
```

Read JSON estimates in your own test entrypoint when configuring the runner;
there is no new CLI history flag. Existing `--shard=1/4` flags also work with
configured estimates. A plain relative path key is accepted as a fallback after
a suite-qualified key.

Files are scheduled longest-estimate first onto the least-loaded shard. Ties
favor fewer assigned files, then the lower shard number. Import order within
each shard is preserved. File/suite filters are applied before assignment.
Unknown files use the median positive supplied estimate, or 1 ms if none exists.
Invalid negative or non-finite estimates fail validation.

Every worker must use the **same immutable estimate map**, selected suites,
file filters and file lists. Use distinct output paths for workers and merge
maps after they finish; never overwrite an estimate input while other workers
are still planning. Sharding creates no resource isolation itself.

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
mkdir -p .benchmarks
npm pack --workspace=@japa/core --ignore-scripts --pack-destination .benchmarks
npm pack --workspaces=false --ignore-scripts --pack-destination .benchmarks
```

The two tarballs are `japa-core-10.4.0-speed.2.tgz` and
`japa-runner-5.4.0-speed.3.tgz`. Install **both together** into an isolated test
project when ready. The runner depends on the unpublished core prerelease;
installing the runner tarball alone cannot resolve that version from npm.

Fresh production-only installation of both tarballs has been checked with the
same 56-case smoke matrix as the working checkout: all four reporters, pass/fail,
timeout, pinned listings, buffered and late unhandled exceptions/rejections,
and stack capture enabled/disabled. It also exercises datasets, done callbacks,
regression tests, throws assertions, active-test access and cleanup.

See [core provenance](packages/core/UPSTREAM.md), the preserved MIT license, and
[benchmark methods/results](benchmarks/README.md). Application integration and
external-resource isolation are intentionally deferred until requested.
