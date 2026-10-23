# Agent and CI test loop

Optional commands for running only the tests a change can affect and reading
bounded, machine-readable results. Default behaviour is unchanged.

## Quick start

```sh
# once per checkout (use your test entrypoint)
node bin/test.js --prepare-caches --cache-dir=.japa

# after an edit
node bin/test.js --changed=auto --agent --agent-file=report.jsonl

# or through the wrapper
npx japa-agent -- node --import=@poppinss/ts-exec bin/test.ts

# parallel coordinator, with automatic narrow-selection detection
npx japa-parallel --workers=auto -- node --import=@poppinss/ts-exec bin/test.ts
```

## Flags

| Flag | Effect |
| --- | --- |
| `--prepare-caches` | Import every file and write the selection index and dependency map. Runs no tests and skips global setup hooks. `--files` still limits imports; other selection flags are ignored. |
| `--tests`, `--groups`, `--tags` | Filter as before. `--tests` matches exact test titles. Files that cannot match are no longer imported. |
| `--changed=auto` | Derive changed paths from `git diff --name-only HEAD` plus untracked files. |
| `--changed=path,path` | Explicit paths, relative to the application directory. |
| `--cache-dir=path` | Directory for both caches. Defaults to `node_modules/.cache/japa`. |
| `--agent` | Emit bounded JSON lines for failures, skipped and todo tests, plus a summary. |
| `--agent-file=path` | Write that JSON to a file. Without `--agent`, the configured reporters keep running alongside it. |
| `--allow-known-failures` | Exit 0 when the only failures match `japa.baseline.json`. |
| `--update-baseline` | Record this run's failures. Only a full run writes. |
| `--failed-new` | With `--failed`, skip titles already in the baseline. |
| `--workers=auto` | Coordinator flag (`japa-parallel`): use one worker for narrow selections. |
| `JAPA_WORKERS=4` | Same as `--workers` for `japa-parallel`; the flag wins when both are set. |

`japa-agent` accepts `--cwd`, `--out`, `--cache-dir`, `--full`, `--no-prepare`,
`--timeout`, `--report` and `--no-metrics`.
It writes the report with `--agent-file`, so the command's configured reporters still
run; add `--agent` to the command to also print the JSON on stdout.

`--update-baseline` does not delete entries that stop failing. They stay in the
file with `consecutive: 0`, so `--allow-known-failures` still recognises them if
they fail again.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | All selected tests passed, or only baseline-known failures occurred. |
| 1 | At least one new test failure. |
| 2 | Setup, configuration or planning failed under the agent reporter. |

## Output

One JSON object per line, keyed by `event`:

```json
{"event":"test","status":"failed","file":"tests/user.spec.ts","group":"user","title":"creates a user","durationMs":4.2,"errors":[{"name":"AssertionError","message":"expected 1 to equal 2","location":{"file":"tests/user.spec.ts","line":31}}]}
{"event":"summary","total":2,"failed":1,"passed":1,"regression":0,"skipped":0,"todo":0,"durationMs":12.4,"ok":false,"selection":{"mode":"filtered","planned":1,"skipped":12},"phases":{"bootMs":4310,"importMs":180,"testMs":12},"baseline":{"known":1,"new":0,"fixed":0}}
```

`japa-agent` also writes `<report>.delta.json` with new and fixed failures and a
`comparable` flag, plus `agent-metrics.jsonl` in the cache directory. Summarise
the loop with `japa-agent --report`.

With `--allow-known-failures`, a summary may include `"knownOnly": true`. The
`ok` field still describes the raw test result; `knownOnly` says the run is green
because every failure was already in the baseline and no setup error occurred.
`"processError": true` marks setup, teardown, or unhandled errors separately from
test failures.

## AdonisJS

AdonisJS runs Japa through `Ignitor.testRunner()` in `bin/test.ts`. One line is needed:
Adonis loads providers, preloads and config before `configure()`, so without it the
dependency map never completes and `--changed` always runs the full suite.

```ts
// bin/test.ts
import { configure, processCLIArgs, recordImportsFromStart, run } from '@japa/runner'

process.env.NODE_ENV = 'test'
recordImportsFromStart() // before new Ignitor(...)
```

Ace forwards the new flags unchanged:

```sh
node ace test unit functional --prepare-caches
node ace test unit --changed=auto --agent-file=tests/results/agent.jsonl
node ace test unit --tests="returns 404" --agent-file=tests/results/agent.jsonl
```

Run `japa-parallel` against the entrypoint directly; each worker then skips Ace's boot:

```sh
JAPA_WORKERS=6 npx japa-parallel -- node --import=@poppinss/ts-exec bin/test.ts unit
```

Parallel runs need per-worker resources from the application. Japa supplies
`JAPA_WORKER_ID` and `JAPA_WORKER_COUNT`; set the rest in `bin/test.ts` before the
Ignitor boots, because Adonis never overwrites a variable already in `process.env`:

```ts
const worker = Number(process.env.JAPA_WORKER_ID)
if (Number.isInteger(worker) && worker > 0) {
  process.env.DB_DATABASE = `myapp_test_w${worker}` // create it here: providers query it during boot
  process.env.REDIS_DB = String(worker) // read it in config/redis.ts
  process.env.PORT = String(24_330 + worker)
}
```

Things that broke a real app under `japa-parallel` and how they show up:

- A test that times out while its work keeps running. Japa moves on, but the work still
  holds a database transaction, so `app.terminate()` waits in the database provider's
  shutdown and the worker never writes its report. This was the cause in practice.
- A teardown hook that calls `process.exit()` on a short timer can cut the end phase off
  the same way, since Japa writes the worker report after teardown. Exit only after
  `run()` resolves.
- Vite's WebSocket server. Each worker opens one; set `server.ws: false` under test.
- Shared process state (`mail.fake()`, sinon stubs, fake clocks). Sharding changes which
  files share a process, so a leak that serial order hid becomes a failure.

## Warnings

Japa warns on stderr, so agent JSON on stdout stays parseable.

| Warning | Fix |
| --- | --- |
| `--changed is running the full suite: no dependency map yet` | Run once with `--prepare-caches`. |
| `... the dependency map is incomplete` | Call `recordImportsFromStart()` at the top of the entrypoint, then `--prepare-caches`. |
| `... N changed path(s) no test file imports` | Expected for configs and lazily loaded files (routes, controllers). A new spec needs `--prepare-caches`. |
| `... this Node has no module.registerHooks` | Use Node 22.15+ or 23.5+. |
| `The dependency map is incomplete: N file(s) imported other files before Japa could record them` | Printed by `--prepare-caches`; same fix as above. |
| `[japa-parallel] N workers on M CPUs` | Use fewer workers or `--workers=auto`. |
| `worker N: exited with code C before writing its report` | See the parallel list above. |

The agent summary carries the same reason as `selection.fallbackReason`.

## Safety rules

- A changed test file is always imported; changed source files select their dependants.
- A file the index has never seen is always imported.
- A file with runtime-built titles (datasets) is never skipped by a title filter.
- `--changed` falls back to the full suite for any unknown path.
- A partial selection never rewrites a baseline.
- Cache failures never fail a test run.

## Limitations

- Dependency recording uses `module.registerHooks`. On older Node the map is
  unavailable and `--changed` runs the full suite.
- An app that loads modules before `configure()` (AdonisJS boots providers and
  preloads first) must call `recordImportsFromStart()` at the top of its test
  entrypoint. Otherwise those modules' imports are never seen and the map stays
  incomplete, so `--changed` always runs the full suite.
- Application boot remains the floor for targeted runs.
- Caches are per application directory and are safe to delete.
