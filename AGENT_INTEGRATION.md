# Using Japa from an agent or harness

This page is for coding agents and the harnesses that drive them. It describes the
fast loop: run only what the change can affect, read bounded machine output, and
tell real regressions apart from known failures.

Everything here is opt-in. A plain `npm test` behaves exactly as before.

## One command for any harness

`japa-agent` wraps the loop and only composes Japa flags, so it works with any
command that forwards arguments to Japa — pi, Claude Code, Codex, CI, a shell
script, or a Makefile. It has no editor- or vendor-specific integration.

```sh
# app whose test entry is bin/test.ts
npx japa-agent -- node --import=@poppinss/ts-exec bin/test.ts

# TypeScript app with a suite argument, and a custom report path
npx japa-agent --cwd=apps/web --out=/tmp/japa.jsonl -- node bin/test.js unit
```

Behavior:

1. If the selection caches are missing, run the command once with `--prepare`
   (selection flags stripped) and stop if it fails.
2. Run the command with `--agent --agent-file=<out>` and, unless the forwarded
   arguments already contain a selection or `--full` is passed, `--changed=auto`.
3. Leave stdout to the application and print `japa-agent: exit=N report=<path>`
   on stderr.
4. Exit with the test command's code (0 / 1 / 2).

Options: `--cwd`, `--out` (default `node_modules/.cache/japa/agent.jsonl`),
`--full`, `--no-prepare`, `--timeout`.

If the harness wants to own selection, pass `--tests`/`--changed` itself; the
wrapper will not add `--changed=auto`.

## The loop

```sh
# once per checkout: build the selection and dependency caches without running tests
npx japa --prepare

# after an edit: run only files affected by the changed paths
npx japa --changed=auto --agent

# or target a test by title, importing only files that can contain it
npx japa --tests="returns 404" --agent

# after a red run, iterate on new failures only
npx japa --failed --failed-new --agent
```

Each of these still pays application boot (about 4–5 s for a large Adonis app).
Selection removes imports and test execution, not boot. Treat ~5 s as the floor for
a targeted cold run.

## Flags

| Flag | Effect |
| --- | --- |
| `--prepare` | Import every file, write the selection index and dependency map, run no tests. Application setup hooks still run; only test execution is skipped. Cheapest way to prime a fresh checkout. |
| `--tests` / `--groups` / `--tags` | Filter as before, but files that cannot match are no longer imported. |
| `--changed=auto` | Use `git diff --name-only HEAD` plus untracked files. |
| `--changed=a.ts,b.ts` | Explicit paths, relative to the app directory. |
| `--failed` | Re-run tests that failed last time (unchanged). |
| `--failed-new` | With `--failed`, skip titles already recorded in `japa.baseline.json`. |
| `--allow-known-failures` | Exit 0 when the only failures match the baseline. |
| `--update-baseline` | Rewrite `japa.baseline.json` from this run, awaited before exit. Only a full run writes: any test/file/group/tag/changed/failed filter or a shard leaves the file unchanged. |
| `--agent` | Replace reporters with bounded JSON lines on stdout. |
| `--agent-file=path` | Write that JSON to a file, keeping application stdout separate. |
| `--agent-all` | With the agent reporter, emit passing tests too (useful for identity diffs). |

## Tracked caches

Both caches default to `node_modules/.cache/japa/`. They can live in a tracked
path instead, so CI or a pre-commit hook ships them and a fresh checkout starts
fast:

```sh
npx japa --prepare --index-file=.japa/index.json --dependency-file=.japa/deps.json
npx japa --tests="..." --index-file=.japa/index.json --dependency-file=.japa/deps.json
```

Both are ordinary JSON with relative paths and are safe to commit.

## Faster boot

Set `NODE_COMPILE_CACHE` before Node starts. It is process-wide and saves roughly
0.2 s per worker on a large Adonis app; the directory is safe to delete.

```sh
NODE_COMPILE_CACHE=node_modules/.cache/node-compile npx japa-agent -- node bin/test.ts
```

## AdonisJS helpers

`@japa/runner/factories` exports `adonisWorkerResources`,
`applyAdonisWorkerEnv` and `assertAdonisWorkerIsolation`. They derive isolated
database, Redis, search, HTTP and mail values from `JAPA_WORKER_ID`:

```ts
import { adonisWorkerResources, applyAdonisWorkerEnv } from '@japa/runner/factories'

const resources = adonisWorkerResources(Number(process.env.JAPA_WORKER_ID ?? 1), {
  databasePrefix: 'myapp_test_',
  redisBasePort: 26_380,
  httpBasePort: 24_330,
})
applyAdonisWorkerEnv(resources)
```

Provisioning the database and services is still the app's job; the helpers only
derive and validate names and ports. An Ace command can wrap the whole loop:

```ts
// commands/test.ts (illustrative; depends on your @adonisjs/core version)
import { spawn } from 'node:child_process'
const child = spawn('npx', ['japa-agent', '--', process.execPath, '--import=@poppinss/ts-exec', 'bin/test.ts', ...this.parsed.args], { stdio: 'inherit' })
```

## Delta reports

`japa-agent` writes `<report>.delta.json` next to the report with `newFailures`,
`fixed`, counts and a `comparable` flag. "Fixed" is only reported when the
selection signature and test total match the previous run; otherwise a missing
test may simply not have been selected.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Every selected test passed, or only baseline-known failures occurred. |
| 1 | At least one test failed that is not in the baseline. |
| 2 | Setup, configuration or planning failed (invalid shard, missing reporter, import error) — only under `--agent` / `--agent-file`. |

Code 2 is what lets a harness stop retrying a command that cannot succeed.

## Output

One JSON object per line:

```json
{"t":"test","status":"failed","file":"tests/user.spec.ts","group":"user","title":"creates a user","durationMs":4.2,"errors":[{"name":"AssertionError","message":"expected 1 to equal 2","location":{"file":"tests/user.spec.ts","line":31},"repeated":true}]}
{"t":"summary","total":2,"failed":1,"passed":1,"regression":0,"skipped":0,"todo":0,"durationMs":12.4,"ok":false,"selection":{"mode":"filtered","planned":1,"skipped":12},"phases":{"bootMs":4310,"importMs":180,"testMs":12},"baseline":{"known":1,"new":0},"errorGroups":[{"message":"expected 1 to equal 2","count":3}]}
```

- `--agent` emits failing, skipped and todo tests only. Use
  `agent({ onlyFailures: false })` for every test.
- `compact` (on for `--agent`) omits stacks after the first occurrence of an error
  and reports `errorGroups` in the summary.
- `errors[].location` is the first stack frame outside `node_modules`.
- `selection.skipped > 0` means files were pruned. `selection.fallback: true`
  means a filter was requested but could not narrow the import list, so the whole
  suite ran. A harness can warn or escalate on that field.
- Every line is capped at 4000 characters.

## Trust rules

The selection features are built to run too much rather than too little:

- A file whose size or mtime changed since indexing is always imported.
- A file the index has never seen is always imported.
- A file with runtime-built titles (datasets) is never skipped by a title filter,
  because its registered titles are not the titles that will run.
- `--changed` falls back to the whole suite if any changed path is unknown.
- `--failed-new` matches by title only, so it is opt-in; a title that is both
  known-failing and newly failing elsewhere cannot be distinguished.
- `--prepare` and normal runs only write cache entries from files they imported;
  files skipped by the index keep their previous entries.

Caches live under `node_modules/.cache/japa/` and are safe to delete.

## Parallel runs

```sh
npx japa-parallel --workers=auto -- node bin/test.js
```

`--workers=auto` uses one worker when the command carries `--tests`, `--groups`,
`--tags` or `--changed`, because a narrow selection costs less than the extra
application boots. Other selections use the previous default of
`min(4, cpus)`. Pass `--workers=N` to override.

## Recommended harness policy

1. Run `--prepare` once per checkout, not per edit.
2. Prefer `--changed=auto` for edits; fall back to `--tests` for targeted debugging.
3. Use `--agent-file` when tests log to stdout.
4. Treat exit 2 as "do not retry"; exit 1 as "read the failures".
5. Never run the full suite to answer a question a selection can answer, and never
   run a selection when a changed file is not in the dependency map.
