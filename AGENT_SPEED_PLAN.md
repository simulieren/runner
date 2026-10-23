# Agent speed and AdonisJS integration — implementation plan

Status: proposed. Baseline: runner `5.4.0-speed.5`, commits `07e8a2c`, `f2d7c81`,
`19f9d86`.

This plan is written so a worker with limited context can pick up one task at a
time. Every task lists the files, the steps, the tests, and what "done" means.
Do not start more than one task at once; run the checks at the end of the file
after each one.

## Where the time goes

A targeted agent run currently takes about **5.6 s**:

| Phase | Time | Notes |
| --- | ---: | --- |
| Application boot | ~4.8 s | Adonis boot + Node ESM hook marshalling |
| Import | 0.86 s | with the selection index; 3.3 s without |
| Test execution | ~0.005 s | one selected test |

The import phase is already ~4× cheaper. **Below ~5 s means shrinking boot.**
Everything else in this plan improves reliability, cold starts, or what the agent
has to read.

Measured constraints (do not re-litigate without new data):

- Japa's per-test overhead is ~3 µs. Do not micro-optimize the test path.
- Boot is ~1.2–2.3 s of Node synchronous ESM hook marshalling plus module and
  provider evaluation. `ts-exec` transforms are only ~150 ms.
- Hot reload is not viable: ESM cannot unload modules and the Adonis container is
  built at boot. Do not attempt it.
- Worker-count matrices and more workers on targeted runs are not useful.

## Rules for every task

- Keep all existing behaviour; new options are opt-in unless stated.
- Never make selection less safe. Running too much is fine; skipping a matching
  test is a bug.
- No harness-specific code. Anything added must work from a plain shell, pi,
  Claude Code, Codex, CI, or a Makefile.
- Add a test for every behavioural change. Prefer a focused unit/probe test over
  a full app run.
- Update `PERFORMANCE.md` and `AGENT_INTEGRATION.md` when user-visible behaviour
  changes.
- The lab app is private, under ignored `.benchmarks/`. Never modify the original
  ATS checkout. Never commit `.benchmarks/`, raw logs, or `AGENTS.md`.
- Use Node 24. In this repository, run tests with `AI_AGENT`/`CLAUDECODE` unset:
  `env -u AI_AGENT -u CLAUDECODE npm test`.

## Definition of done (all tasks)

```sh
npm run lint
npm run typecheck
npm run typecheck --workspace=@japa/core
env -u AI_AGENT -u CLAUDECODE npm test          # currently 102 passing
npm run test:core                                # currently 176 passing
npm run build
npm run bench:smoke                              # 56 cases
npm run bench:automatic
npm run bench:selection-index                    # 9 cases
npm run bench:changed-selection                  # 9 cases
npm run bench:timing-cache                       # 3 cases
```

If a task changes packaging or binaries, also repack and install both tarballs
production-only:

```sh
npm pack --workspace=@japa/core --ignore-scripts --pack-destination .benchmarks
npm pack --workspaces=false --ignore-scripts --pack-destination .benchmarks
# install both into a scratch project, then run the changed command
```

---

## Task A1 — Committed cache files (start here)

**Why.** A fresh checkout pays ~9 s of `--prepare` before the first fast run.
Allowing the index and dependency map to live in a tracked path lets CI or a
pre-commit hook ship them, so agents start fast immediately.

**Effort.** Small (1–2 hours).

**Current state.** `src/selection_index.ts` already accepts `options.file` via
`indexFile(cwd, file)`; `src/dependencies.ts` accepts `options.file` via
`dependencyFile(cwd, file)`. Neither has a CLI flag, and `run()` never passes one.

**Steps.**

1. Add CLI string flags in `src/cli_parser.ts`:
   - `--index-file` → `indexFile`
   - `--dependency-file` → `dependencyFile`
   Add them to `string`, `alias`, help text, and `CLIArgs` in `src/types.ts`.
2. Thread the values from `run()`:
   - `selectionIndex({ file: cliArgs.indexFile })`
   - `writeSelectionIndexFor(runner, cwd, { file: cliArgs.indexFile })`
   - `changedSelection({ file: cliArgs.dependencyFile })`
   - `recordDependencies({ file: cliArgs.dependencyFile })`
   - `prepare` path: pass the same options.
3. Make sure parent directories are created (already handled by `writeIndex`,
   `writeHistory`, and the dependency writer).
4. Document in `AGENT_INTEGRATION.md`:
   ```sh
   npx japa --prepare --index-file=.japa/index.json --dependency-file=.japa/deps.json
   git add .japa
   # later
   npx japa --tests="..." --index-file=.japa/index.json --dependency-file=.japa/deps.json
   ```
   Note that both files are ordinary JSON, contain relative paths, and are safe
   to commit; they are caches, not test data.
5. Update the CLI parser test dataset and help test in
   `tests/cli_parser.spec.ts`. There are 15 dataset entries; add the new keys to
   each (`'indexFile': ''`, `'index-file': ''`, `'dependencyFile': ''`,
   `'dependency-file': ''`). Use a script rather than hand-editing if possible.

**Test.** Extend `tests/runner.spec.ts` (selection-index area):

1. Create a fixture, write six files.
2. Run `--prepare --index-file=.japa/index.json --dependency-file=.japa/deps.json`.
3. Assert both files exist and `node_modules/.cache/japa` does **not** contain
   `index-*` or `dependencies.json`.
4. Remove `node_modules/.cache/japa` entirely.
5. Run `--tests="case 3" --index-file=.japa/index.json --dependency-file=.japa/deps.json`
   with `--agent --agent-all --agent-file=...`.
6. Assert exactly one test ran and `selection.skipped > 0`.

**Acceptance.** The filtered run above still prunes files after the default
cache directory is deleted, using only the tracked files.

---

## Task A2 — Enable the V8 compile cache in the lab

**Why.** Measured at ~0.2 s per worker (~4–5% of boot) with no behaviour change.

**Effort.** Very small (30 minutes, lab-only measurement).

**Steps.**

1. In `.benchmarks/ats-validation/run_case.mjs`, add to the spawn env:
   ```js
   NODE_COMPILE_CACHE: join(cwd, 'node_modules/.cache/node-compile'),
   ```
   and in `worker.mjs`/`boot_sample.sh` for focused probes.
2. Run `--prepare` five times cold and five times warm; record
   `bootstrap-loaded` and wall time. Keep raw output under `.benchmarks/`.
3. Add a short note to `AGENT_INTEGRATION.md`: compile cache is safe to enable,
   directory can be deleted, measured effect ~0.2 s/worker.

**Acceptance.** Documented numbers from at least 5 samples each, or an explicit
"no measurable difference" if that is what the data shows.

---

## Task A3 — Delta reporting in `japa-agent`

**Why.** Agents re-run the same selection often. Reporting only what changed
(new failures and fixed tests) reduces reading and makes the loop feel faster.

**Effort.** Small–medium (2–3 hours).

**Files.** `bin/agent.ts`, new `src/agent_delta.ts`, tests.

**Design.**

- Pure function in `src/agent_delta.ts`:
  ```ts
  export type AgentTestRow = { file?: string; title: string }
  export type AgentSummary = {
    total: number
    selection?: { mode: string; planned: number; skipped: number; fallback?: boolean }
  }
  export function diffReports(
    previous: { summary: AgentSummary; failures: AgentTestRow[] } | undefined,
    current: { summary: AgentSummary; failures: AgentTestRow[] }
  ): { newFailures: AgentTestRow[]; fixed: AgentTestRow[]; comparable: boolean }
  ```
- `comparable` is false when there is no previous report or when the selection
  signature (`mode`, `planned`, `skipped`) or `total` differs. In that case do not
  emit fixed tests: a test can be absent because it was not selected.
- In `bin/agent.ts`:
  1. Before running, read the previous report at the resolved `--out` path, if it
     exists. Parse JSON lines; collect `t === "summary"` and failed `t === "test"`
     rows.
  2. After the run, parse the new file and call `diffReports`.
  3. Write `<out>.delta.json` with `{ comparable, newFailures, fixed, counts }`.
     Cap each list (for example 50 entries) and include a `truncated` flag.
  4. Print on stderr:
     `japa-agent: exit=N new=K fixed=M report=<out> delta=<out>.delta.json`
     Keep the existing fields; only append.
- Never change the test command's exit code based on the delta.

**Tests.**

- Unit-test `diffReports` in `benchmarks/agent_delta.mjs` (new probe, add
  `bench:agent-delta` script):
  - first run: `comparable: false`
  - same selection, one new failure: `newFailures` has it
  - same selection, failure disappeared: `fixed` has it
  - different `total` or selection: `comparable: false`, `fixed` empty
- Extend the existing `japa-agent` integration test in `tests/runner.spec.ts`:
  run the wrapper twice, assert `.delta.json` exists and `comparable` is true on
  the second run.

**Acceptance.** Second run of the same selection emits a delta file; a different
selection does not claim fixed tests.

---

## Task B1 — Boot attribution by provider/module (lab)

**Why.** The 4.8 s boot has never been attributed per Adonis provider. This is
the only task likely to produce a 1–2 s reduction.

**Effort.** Medium (half day), lab-only.

**Deliverable.** `benchmarks/ats-validation/probes/boot_breakdown.mjs` (committed),
which:

1. Spawns the copied app for worker 1 with `--cpu-prof` and `--cpu-prof-dir`
   under `.benchmarks/`, using the same env as `worker_env.mjs`, with
   `--prepare` so no tests run.
2. Parses the `.cpuprofile` JSON:
   - aggregate **self time** (`timeDeltas` aligned with `samples`) by URL prefix;
   - bucket into `node:@node`, `node_modules/@adonisjs`, `app/providers`,
     `app/modules`, `app/*`, and `other`;
   - print the top 25 functions and the top 15 files by self time.
3. Writes a JSON summary next to the raw profile.

**Steps.**

1. Copy the profile aggregation logic already used during the boot investigation
   (it lives in the session notes, not the repo). Reimplement it in the probe;
   ~80 lines.
2. Run it at least twice and confirm the ranking is stable.
3. Record findings in `benchmarks/ATS_SUB30_EXPERIMENTS.md` under a new
   "Boot attribution" heading: provider names, milliseconds, and total.
4. Do not change app source in this task.

**Acceptance.** A committed script, two stable runs, and a written ranking of the
top boot costs with numbers.

---

## Task B2 — Lazy or trim the heaviest providers (lab experiment)

**Why.** Follow-up to B1. If two or three providers dominate, deferring them may
save 1–2 s per worker.

**Effort.** Medium, depends on B1.

**Steps.**

1. Pick the top provider(s) from B1. For each candidate, check whether tests use
   it; if not, try deferring it in the **copied** app only:
   - AdonisJS supports lazy provider imports in recent versions; if not, guard
     its registration behind an env flag for the experiment.
2. Measure `--prepare` wall time and `bootstrap-loaded` five times with and
   without the change, same DB template, sequential runs.
3. Run a focused slice that exercises the provider (if any) and then one full
   six-worker run; require all 8,515 identities and no added failures.
4. Record the delta, the provider, and any risk in
   `benchmarks/ATS_SUB30_EXPERIMENTS.md`.

**Acceptance.** Either a measured saving with intact identities, or a documented
"provider cannot be deferred because X".

**Do not** change the original ATS checkout or remove providers tests need.

---

## Task B3 — Loader experiment: can boot avoid the sync hook path?

**Why.** ~1.2–2.3 s is Node ESM hook marshalling triggered by `ts-exec`. A loader
with asynchronous hooks may reduce it without touching app code.

**Effort.** Medium (half day), experiment only.

**Steps.**

1. In the copied app only, install `tsx` (or another ESM loader with async hooks)
   as a dev dependency. Do not touch the original checkout.
2. Run the boot probe (`--prepare`, no tests) five times with:
   - `--import=@poppinss/ts-exec` (control),
   - `--import=tsx`,
   - Node `NODE_COMPILE_CACHE` plus each loader.
3. If a loader is faster and boots correctly, run one filtered test and compare
   identities. Do not run the full suite unless boot and one filtered run pass.
4. Record results. If nothing wins, write that down and stop; do not add the
   dependency to the product or the original app.

**Acceptance.** Numbers for at least three samples per variant, or a documented
failure mode (syntax, resolution, decorators).

---

## Task C1 — Shared Adonis worker-isolation helper

**Why.** Every Adonis app hand-rolls worker DB/Redis/search/mail ports. ATS's
`worker_env.mjs` is ~30 lines of this, and the mail-leak incident came from
missing cross-file cleanup. Shipping a small helper removes a whole class of
parallel-test incidents.

**Effort.** Medium (1 day). This is the first Adonis integration deliverable.

**Where.** New private workspace package `packages/adonis`, or a documented module
under `factories/` if a package is too heavy. Prefer `packages/adonis` only if
the workspace build supports another package without publishing it.

**API sketch.**

```ts
export type AdonisWorkerResources = {
  database: string
  redisPort: number
  searchUrl: string
  searchPrefix: string
  httpPort: number
  smtpPort: number
  mailpitUrl: string
}

export function workerResources(input: {
  worker: number
  base: {
    databasePrefix: string
    redisBasePort: number
    searchBasePort: number
    httpBasePort: number
    smtpBasePort: number
    mailpitBasePort: number
    searchPrefix: string
  }
}): AdonisWorkerResources

export function applyWorkerEnv(resources: AdonisWorkerResources, env?: NodeJS.ProcessEnv): void

export function assertIsolation(input: {
  worker: number
  resources: AdonisWorkerResources
  expected: AdonisWorkerResources
}): void
```

- `applyWorkerEnv` writes the standard Adonis env names (`DB_DATABASE`,
  `REDIS_PORT`, `TYPESENSE_*`/`MEILISEARCH_*`? keep it generic with a name map,
  `HOST`, `PORT`, `APP_URL`, `SMTP_*`, `MAILPIT_*`).
- `assertIsolation` throws with the same field-by-field message the ATS copy
  uses, so failures are obvious.
- Add `restoreMailState()`? Do not guess provider APIs; keep this package to env
  generation and validation. Mail cleanup is task C3.

**Tests** (no Adonis boot needed):

- worker 1..8 produce distinct database/ports/prefixes;
- `assertIsolation` passes for matching values and throws naming the first
  mismatch;
- `applyWorkerEnv` sets only the configured keys.

**Acceptance.** Unit tests pass, and the helper is used in a committed example
under `examples/adonis/worker-env.ts` (not in the product runner).

---

## Task C2 — `ace test` wrapper (documentation + template, app-side)

**Why.** Adonis users should not need to know Japa flags or `ts-exec`. The runner
cannot ship an Ace command, but it can ship a copy-paste command and document the
contract.

**Effort.** Small (2 hours).

**Steps.**

1. Add `examples/adonis/commands/test.ts`, an Ace command that:
   - forwards its arguments to `node ace test`? No — it should spawn
     `japa-agent` with the app's test entry:
     ```ts
     const command = process.execPath
     const args = ['--import=@poppinss/ts-exec', 'bin/test.ts', ...this.parsed.args]
     spawn('npx', ['japa-agent', '--', command, ...args], { stdio: 'inherit' })
     ```
   - supports `--changed`, `--prepare`, `--full`, `--workers=auto`, and passes
     unknown args through.
   - returns the child's exit code.
2. Add a section to `AGENT_INTEGRATION.md` showing the command, including
   `node ace test --changed` and `node ace test --prepare`.
3. Do not add an Ace dependency to `@japa/runner`. The example is illustrative and
   must compile with the app's own `@adonisjs/core` version.

**Acceptance.** The example is reviewed for API accuracy; no automated test is
required unless the example is turned into a workspace package.

---

## Task C3 — Transaction rollback / snapshot helper (stretch)

**Why.** Only 12 ATS files use rollback isolation; the rest insert and delete per
test. This is app-side per-test cost, not Japa overhead.

**Effort.** Large and risky. Do not start until A1–B2 are done and the host is
quiet.

**Steps.**

1. Prototype in the copied ATS app only: wrap one factory-heavy spec in a
   transaction and roll back after each test.
2. Prove committed-state assertions still work or are explicitly opted out.
3. Measure the file's summed test time before/after.
4. Only if the pattern generalises, add a documented helper to the Adonis
   package; never make rollback the default.

**Acceptance.** A measured per-file gain with unchanged assertions, or a
documented reason the pattern does not apply.

---

## Explicitly out of scope

- Hot reload / persistent module runner.
- Per-test micro-optimizations in `@japa/core`.
- More workers for targeted runs.
- Committing app credentials or the private lab.
- Changing the original ATS checkout.
- Any harness-specific (pi/Claude/Codex) integration inside this repository.

## Suggested order

1. **A1** committed cache files.
2. **A3** delta reporting.
3. **A2** compile cache (small, measured).
4. **B1** boot attribution, then **B2** lazy providers if it finds a target.
5. **B3** loader experiment.
6. **C1** Adonis worker-isolation helper, then **C2** Ace example.
7. **C3** only with new evidence.

## Reporting format

Every completed task should leave:

- the commit hash and a one-line summary;
- the exact commands run and their labels;
- measured numbers with sample count and host load average;
- what was rejected and why;
- any new cache/flag documented in `PERFORMANCE.md` and `AGENT_INTEGRATION.md`;
- confirmation that no services were left running and the original ATS checkout
  was untouched.

Never add percentage gains from separate measurements into one claim. If a number
came from a loaded host, label it load-affected.

---

## Progress (first implementation round)

| Task | State | Where |
| --- | --- | --- |
| A1 committed caches | Done | `--index-file`, `--dependency-file`; test deletes the default cache and still prunes |
| A2 compile cache | Measured, documented | ~0.2 s/worker; see `AGENT_INTEGRATION.md` |
| A3 delta reporting | Done | `src/agent_delta.ts`, `<report>.delta.json`, 5 probes |
| B1 boot attribution | Done | `benchmarks/ats-validation/probes/boot_breakdown.mjs` |
| B2 lazy providers | **Stopped based on B1** | Adonis provider files are tens of ms; the cost is Node's ESM hook path |
| B3 loader experiment | Preliminary only | `tsx`: 3.49 s bootstrap vs 4.98–5.08 s for `ts-exec`; direct-loader samples noisy; full-suite correctness unverified |
| C1 Adonis helpers | Done | `factories/adonis.ts` + `tests/adonis_worker_env.spec.ts` |
| C2 Ace wrapper | Documented | Snippet in `AGENT_INTEGRATION.md`; no Ace dependency added |
| C3 rollback helper | Not started | Stretch; needs a quiet host and an isolation review |

Remaining high-value work: verify `tsx` (or a compiled test run) across the full
8,515 identities; if it holds, measure a six-worker run. Then adopt the wrapper in
each harness. C3 only with new evidence.
