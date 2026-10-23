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
| `--agent-file=path` | Write that JSON to a file, keeping application stdout separate. |
| `--allow-known-failures` | Exit 0 when the only failures match `japa.baseline.json`. |
| `--update-baseline` | Record this run's failures. Only a full run writes. |
| `--failed-new` | With `--failed`, skip titles already in the baseline. |
| `--workers=auto` | Use one worker for narrow selections. |

`japa-agent` accepts `--cwd`, `--out`, `--cache-dir`, `--full`, `--no-prepare`,
`--timeout`, `--report` and `--no-metrics`.

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

## AdonisJS

AdonisJS already runs Japa through `Ignitor.testRunner()` in `bin/test.ts`, so no
integration code is required. Pass flags through Ace:

```sh
node ace test -- --prepare-caches --cache-dir=.japa
node ace test -- --changed=auto --agent --agent-file=report.jsonl
node ace test -- --tests="returns 404" --agent
```

Parallel runs need per-worker database, Redis, search and port isolation from the
application. Japa supplies `JAPA_WORKER_ID` and `JAPA_WORKER_COUNT`; derive the
rest from them in the test bootstrap.

## Safety rules

- A changed file is always imported.
- A file the index has never seen is always imported.
- A file with runtime-built titles (datasets) is never skipped by a title filter.
- `--changed` falls back to the full suite for any unknown path.
- A partial selection never rewrites a baseline.
- Cache failures never fail a test run.

## Limitations

- Dependency recording uses `module.registerHooks`. On older Node the map is
  unavailable and `--changed` runs the full suite.
- Application boot remains the floor for targeted runs.
- Caches are per application directory and are safe to delete.
