# ATS code experiment patches

See [results, limitations, and retesting](../../ATS_CODE_EXPERIMENTS.md), and
[the sub-30 s experiments](../../ATS_SUB30_EXPERIMENTS.md) for the later patches.

The recommended artifacts are `lease-virtual-time.patch`,
`fixture-hash-cache.patch`, and `dependency-scan.patch`, or their combined
`copy-only-speed.patch`. Apply them only in the isolated app after the base
`../copy-only.patch`. The existing local lab already has these edits.

The eight-worker Compose/launcher/reset/readiness templates in this directory
preserve unsuccessful diagnostics, **not the recommended setup**. If reproducing
those experiments, copy their `.mjs` files into `.benchmarks/ats-validation/` and
copy `compose-8.yaml` there as `compose.yaml`; paths are relative to that lab.
`wait_ready.mjs` accepts a worker count of 1–8. Snapshot mode additionally requires
creating `japa_speed_template` from a clean migrated/seeded, disconnected lab DB.
Do not use snapshot mode or `JAPA_EXPERIMENT_HISTORY` for the retained four-worker
comparison. No private app copy, results, environments, or credentials are included.

## Sub-30 s patches

Apply these after the patches above, only in the isolated app. Details and
measurements are in [the sub-30 s report](../../ATS_SUB30_EXPERIMENTS.md):

- `startup-exit-cache.patch`: phase logging (`JAPA_EXPERIMENT_PHASES`), skipping
  the teardown exit timer that races `runner.end()` (`JAPA_EXPERIMENT_EXIT_UNREF`),
  and skipping cache clears with no write since the last one
  (`JAPA_EXPERIMENT_CACHE_DIRTY`).
- `purge-batched.patch`: chunked set-based user purge with a per-user fallback.
  Production code; not behind a flag.
- `narration-backoff.patch`: `waitBeforeRetry()` seam plus a stubbed test
  (`JAPA_EXPERIMENT_FAKE_BACKOFF`).
- `fal-short-timeout.patch`: 50 ms hung-provider timeout
  (`JAPA_EXPERIMENT_SHORT_TIMEOUTS`).
- `dependency-walk.patch`: concurrent directory walk in the dependency scan.

The template database is prepared with `../probes/prepare_template.mjs` and used
through `JAPA_EXPERIMENT_DB_TEMPLATE=1` in `../reset_databases.mjs`. Six-worker
runs use `compose-8.yaml` with the base harness, which now accepts 1–8 workers.
The other `.mjs` files in this directory are the older eight-worker diagnostics.
