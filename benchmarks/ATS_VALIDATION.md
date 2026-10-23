# ATS setup, findings, and retest runbook

Follow-up: [ATS code experiments and the 46–48 s result](ATS_CODE_EXPERIMENTS.md).
Latest: [sub-30 s experiments, 26.8–28.1 s with six workers](ATS_SUB30_EXPERIMENTS.md).

Validated on 23 October 2026, on the user's Mac, with Node 24.19.0. The fork
commit was `f2eebc1`; packaged versions were runner `5.4.0-speed.4` and core
`10.4.0-speed.2`. ATS used runner `5.3.0` and core `10.4.0`.

For the full sequence of successful and unsuccessful attempts, including runner
prototypes and setup mistakes, see [the experiment history](EXPERIMENTS.md).

## Findings

| Full unit suite | Wall time | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Existing ATS runner | 247.094 s | 8,495 | 19 | 1 |
| Fork, serial | 242.671 s | 8,495 | 19 | 1 |
| Fork, four workers, SMTP fixture reset | 86.453 s | 8,495 | 19 | 1 |

The validated parallel run was **2.86× faster**, reducing wall time by 65%.
Every run collected the same 8,515 identities (suite, file, group, title), with no
missing, extra, or duplicated tests. The final fork runs had exactly the same 19
failing tests as the baseline. These were failing runs, not a green full suite.

The serial difference was only 1.8%. These are single local runs, including app
boot, imports, migrations, seeds, test execution, reporting, and shutdown. They
are not repeated medians, and do not establish a reliable serial speedup.

| Passing slice | Existing runner | Fork serial | Fork parallel |
| --- | ---: | ---: | ---: |
| CMS functional, 94 tests | 21.761 s | 24.934 s | 22.733 s, two workers |
| CMS unit, 180 tests | 10.655 s | Not measured | 11.233 s cold / 11.188 s warm, two workers |

All slice identities matched. Small suites did not benefit: repeated app boot and
migration costs consumed the parallel gain. The entire functional and browser
suites were **not** tested.

Timing collection worked without an app timing plugin or manual timing map.
Passing managed runs populated eight suite-qualified file estimates. The next
CMS unit run changed worker test counts from 117/63 to 69/111 using learned file
costs. Failing full runs correctly left the timing cache unchanged. The fastest
full run before the SMTP fix took 80.604 s but had an extra failure; it is not the
validated comparison above.

The largest baseline file costs were about 34 s in `tests/unit/services/lease.spec.ts`
and 12 s in `tests/unit/jobs/purge_soft_deleted_job.spec.ts`. These app-level costs
are larger targets than small runner optimizations.

## Isolation issue that parallelism exposed

The real-SMTP test in
`apps/web/tests/modules/scheduling/unit/reminder_delivery_service.spec.ts`
timed out only in full parallel runs. Separate Mailpit inboxes alone did not fix it.

`apps/web/app/jobs/base_email_job.ts` calls `mail.fake()` in test mode without
restoring it. Another test file happens to restore mail state in serial order;
sharding changes which files share a process. Instrumentation confirmed a
`FakeMailer` was still active when the real-SMTP test began.

The copied test imports `mail` from `@adonisjs/mail/services/main` and calls
`mail.restore()` after the availability check, before creating/sending the real
SMTP scenario. It then passed in 131 ms with its original two-second timeout.
The final four-worker run matched the baseline failures exactly.

**This correction exists only in the copied app.** Fix this test's mail-state
isolation before enabling parallel runs in the original ATS checkout. No test
assertions or timeouts were relaxed. The baseline itself still needs its 19
failures investigated separately. They were observed in this isolated configuration;
some may depend on fixtures or environment values rather than production behavior.

## Lab layout and resource assignment

Run all shell examples from the runner repository:

```sh
cd /Users/simonkhalimonov/Projects/Code/japa-speed/runner
```

| Path | Purpose |
| --- | --- |
| `benchmarks/ats-validation/` | Preserved harness templates, Compose definition, copy-only app patch |
| `.benchmarks/ats-validation/app/` | Private ATS filesystem snapshot and independent dependency copies |
| `.benchmarks/ats-validation/baseline-packages/` | Original installed runner/core copied before replacement |
| `.benchmarks/ats-validation/fork-packages/` | Unpacked runner/core fork tarballs |
| `.benchmarks/ats-validation/<label>.log` | Child stdout/stderr |
| `.benchmarks/ats-validation/<label>.json` | Wall time, exit code, worker summaries, complete test records |
| `.benchmarks/ats-validation/comparison.json` | Most recent identity and failure comparison |
| `.benchmarks/ats-validation/REPORT.md` | Detailed original session report |

The local `BASELINE_FAILURES.md` beside `REPORT.md` lists all 19 baseline failures
and their first error messages. The private snapshot and raw results are ignored by Git. Keep them to reproduce
the historical snapshot; rebuilding from the live ATS tree tests its current code.
Use fresh run labels so the historical logs and JSON are retained.

Docker Compose project: **`japa-speed-atstest`**. All published ports bind to
`127.0.0.1`; no existing app services are reused.

| Resource | Worker 1 | Worker 2 | Worker 3 | Worker 4 |
| --- | --- | --- | --- | --- |
| PostgreSQL, shared isolated server | 25432 | 25432 | 25432 | 25432 |
| Database | `japa_speed_worker1` | `japa_speed_worker2` | `japa_speed_worker3` | `japa_speed_worker4` |
| Redis | 26381 | 26382 | 26383 | 26384 |
| Typesense | 28181 | 28182 | 28183 | 28184 |
| App HTTP | 24331 | 24332 | 24333 | 24334 |
| Vite HMR | 24431 | 24432 | 24433 | 24434 |
| SMTP | 21025 | 21026 | 21027 | 21028 |
| Mailpit HTTP API | 28025 | 28026 | 28027 | 28028 |

Images: `postgres:16-alpine`, `redis:7-alpine`, `typesense/typesense:30.2`,
`axllent/mailpit:latest`. These tags can change; record image IDs/digests for a
future comparison if exact image reproduction matters. Database/search data is
disposable. The service password/API key `japa-speed-test` is a lab-only value.

`worker_env.mjs` assigns resources from `JAPA_WORKER_ID` (serial uses worker 1).
`worker.mjs` applies those overrides **before** registering the TypeScript loader,
then imports the app's real `bin/test.ts`. `run_case.mjs` launches that entrypoint
serially or through the installed fork's actual parallel CLI. It has a ten-minute
process-group timeout and captures each worker's results separately.

The copy-only patch also:

- Rejects unexpected DB/Redis/search/HTTP/SMTP/Mailpit assignments before test hooks.
- Writes file-reporter output into worker-specific result folders and retains all
  test records for identity comparisons. The original reporter normally retains
  only non-passing tests; sharing its result path would overwrite workers' output.
- Redirects the Mailpit helper's fallback URL into the lab.
- Disables legacy HMR configuration in the copied Vite config; per-worker
  `VITE_HMR_PORT` overrides handle the current Vite WebSocket listener.
- Applies the SMTP fixture reset described above.

The runner assigns shards and manages timing history; it does **not** provision
application infrastructure or make custom app reporters worker-safe.

## Retest the preserved lab

The snapshot, original package copies, and unpacked fork packages already exist
on this machine. No app source copy or package installation is needed for this path.
Copy updated harness templates into the lab; this does not touch the copied app:

```sh
cp benchmarks/ats-validation/*.mjs .benchmarks/ats-validation/
cp benchmarks/ats-validation/compose.yaml .benchmarks/ats-validation/
docker compose -p japa-speed-atstest -f .benchmarks/ats-validation/compose.yaml up -d
node .benchmarks/ats-validation/wait_ready.mjs
```

Run cases sequentially. Reset before each case to avoid inheriting database,
Redis, search, or inbox state. Resets drop/recreate only the named databases in
the isolated Compose PostgreSQL container and clear only its lab services.
Do not run the old `continue.mjs` session driver; use these explicit commands.

Full baseline:

```sh
node .benchmarks/ats-validation/switch_runner.mjs baseline
node .benchmarks/ats-validation/reset_databases.mjs 1
node .benchmarks/ats-validation/run_case.mjs retest-baseline serial unit
```

Fork serial:

```sh
node .benchmarks/ats-validation/switch_runner.mjs fork
node .benchmarks/ats-validation/reset_databases.mjs 1
node .benchmarks/ats-validation/run_case.mjs retest-fork-serial serial unit
```

Fork with four workers:

```sh
node .benchmarks/ats-validation/reset_databases.mjs 4
node .benchmarks/ats-validation/run_case.mjs retest-fork-parallel4 4 unit
node .benchmarks/ats-validation/compare.mjs retest-baseline retest-fork-serial retest-fork-parallel4
```

The historical unit runs exit **1** because of the 19 baseline failures. Execute
the next case after reviewing its result; do not chain cases with `&&` or run a
whole matrix under `set -e`. A missing result summary or `timedOut: true` means an
incomplete run and must not be used for performance claims.

In `comparison.json`, verify `missing`, `extra`, `additionalFailures`, and
`duplicates` are empty; `collected` and `total` must match the baseline. Read
failure identities/errors, rather than assuming equal failure counts are enough.
The comparator writes findings; its successful process exit alone is not a
regression assertion.

Passing unit/HTTP slices, with the fork selected:

```sh
node .benchmarks/ats-validation/reset_databases.mjs 2
node .benchmarks/ats-validation/run_case.mjs retest-cms-unit-cold 2 unit '--files=cms/unit/services/*'
node .benchmarks/ats-validation/reset_databases.mjs 2
node .benchmarks/ats-validation/run_case.mjs retest-cms-unit-warm 2 unit '--files=cms/unit/services/*'
node .benchmarks/ats-validation/reset_databases.mjs 2
node .benchmarks/ats-validation/run_case.mjs retest-cms-functional 2 functional '--files=cms/functional/*'
```

Quote `--files` so the shell does not expand `*`. Use `serial` as the mode and
reset one worker when comparing serial slices; switch to `baseline` first for an
upstream comparison. The baseline runner has no parallel coordinator.

The labels `cold`/`warm` do not clear the history automatically. To measure an
actually cold run, first move the `durations-*.json` cache out of
`.benchmarks/ats-validation/app/apps/web/node_modules/.cache/japa/` into a backup
folder, while no run is active. Normal resets preserve this cache intentionally.
Check `historyBefore`, `historyAfter`, worker assignments, and the CLI's
`timings=updated` output. A filtered passing file run can learn those whole files;
a failed run or partial test-title/group/tag selection does not promote timings.

Stop and remove only the lab containers when finished:

```sh
docker compose -p japa-speed-atstest -f .benchmarks/ats-validation/compose.yaml down
```

The copied app and logs remain. Do not run these wrappers in the original ATS
checkout; `npx japa-parallel` alone would not provide the app isolation above.

## Rebuild the lab if the snapshot is gone

Use an empty `.benchmarks/ats-validation/` lab directory. Preserve an existing lab
by moving it aside first; do not overlay a new source snapshot onto old results or
old dependency copies. The following copy commands are for macOS/APFS (`cp -cR`
creates independent copy-on-write files, not hard links).

```sh
mkdir -p .benchmarks/ats-validation
cp benchmarks/ats-validation/*.mjs .benchmarks/ats-validation/
cp benchmarks/ats-validation/compose.yaml .benchmarks/ats-validation/
rsync -a --exclude=node_modules --exclude=.git --exclude=.codegraph --exclude=logs --exclude=results --exclude=build --exclude=.next --exclude=.expo --exclude='.env*' /Users/simonkhalimonov/Projects/ATS/code/ats-app-mono/ .benchmarks/ats-validation/app/
cp -cR /Users/simonkhalimonov/Projects/ATS/code/ats-app-mono/node_modules .benchmarks/ats-validation/app/node_modules
cp -cR /Users/simonkhalimonov/Projects/ATS/code/ats-app-mono/apps/web/node_modules .benchmarks/ats-validation/app/apps/web/node_modules
```

Copy nested workspace dependencies as well:

```sh
for ats_workspace in /Users/simonkhalimonov/Projects/ATS/code/ats-app-mono/packages/*; do
  if [ -d "$ats_workspace/node_modules" ]; then
    cp -cR "$ats_workspace/node_modules" ".benchmarks/ats-validation/app/packages/$(basename "$ats_workspace")/node_modules"
  fi
done
```

Retain any required compiled workspace outputs if
the current app depends on them; the historical snapshot used source workspace
exports. Do not symlink dependencies or workspaces back to the original app.

Initialize an independent repository marker so app helpers resolve the copied
repo root. Apply the validation patch **only to the copy**. `--check` must pass;
if the app has changed, adapt the listed isolation edits manually in the copy.
Do not force a mismatching patch.

```sh
git -C .benchmarks/ats-validation/app init -q
git -C .benchmarks/ats-validation/app apply --check ../../../benchmarks/ats-validation/copy-only.patch
git -C .benchmarks/ats-validation/app apply ../../../benchmarks/ats-validation/copy-only.patch
cp /Users/simonkhalimonov/Projects/ATS/code/ats-app-mono/apps/web/.env.test.example .benchmarks/ats-validation/app/apps/web/.env.test
cp .benchmarks/ats-validation/app/apps/web/.env.test .benchmarks/ats-validation/app/apps/web/.env
```

The wrapper supplies all lab resource overrides. Use example environments, not
the original app's `.env` or `.env.test`. Before running anything, inspect symlinks
in the copy and ensure none resolve into the original ATS checkout.

Save both original packages before switching versions:

```sh
mkdir -p .benchmarks/ats-validation/baseline-packages
cp -cR .benchmarks/ats-validation/app/node_modules/@japa/runner .benchmarks/ats-validation/baseline-packages/runner
cp -cR .benchmarks/ats-validation/app/node_modules/@japa/core .benchmarks/ats-validation/baseline-packages/core
npm run build
npm pack --workspace=@japa/core --ignore-scripts --pack-destination .benchmarks
npm pack --workspaces=false --ignore-scripts --pack-destination .benchmarks
mkdir -p .benchmarks/ats-validation/fork-packages/runner .benchmarks/ats-validation/fork-packages/core
tar -xzf .benchmarks/japa-runner-5.4.0-speed.4.tgz --strip-components=1 -C .benchmarks/ats-validation/fork-packages/runner
tar -xzf .benchmarks/japa-core-10.4.0-speed.2.tgz --strip-components=1 -C .benchmarks/ats-validation/fork-packages/core
```

For later fork versions, update the tarball names and record the actual versions
printed by `switch_runner.mjs`. Its changes are restricted to the copied app's
`node_modules/@japa/{runner,core}`. Start services and follow the retest steps above.

## Original session setup incidents and limits

The original ATS Git status was unchanged before/after validation; its source,
installed packages, and app database were not modified by this work.

Two early incomplete runs are excluded from results. One used the copied original
environment and was refused by ATS's database-ownership guard before migrations
or tests. Another used a Mailpit helper's shared local fallback and may have
cleared messages in that local inbox. The preserved setup prevents those paths
by using example environments, loader-time overrides, resource assertions, and
an isolated Mailpit fallback.

No claim is made that installing this runner alone makes the original app safe
to shard. Infrastructure, result reporting, and the leaked mail fake all need
app-level integration. This runbook reproduces the isolated validation without
making those changes in the original checkout.
