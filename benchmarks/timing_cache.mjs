/**
 * Planning probes for duration-history smoothing and the per-file overhead.
 *
 * These drive the built planner through the source TypeScript, so they establish
 * assignment behavior only. Any wall-time claim still needs a full application run.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { Planner } = await import('../src/planner.ts')
const { ConfigManager } = await import('../src/config_manager.ts')

const files = ['tests/planner.spec.ts', 'tests/runner.spec.ts', 'tests/core.spec.ts']

/** Plan one shard and return the file basenames it selected. */
async function planShard(shardDurations, shard) {
  const config = new ConfigManager({ files }, {}).hydrate()
  config.filters.shard = shard
  config.shardDurations = shardDurations
  const { suites } = await new Planner(config).plan()
  return suites.flatMap((suite) => suite.filesURLs.map((url) => url.pathname.split('/').pop()))
}

const estimates = {
  'default:tests/planner.spec.ts': 5000,
  'default:tests/runner.spec.ts': 1000,
  'default:tests/core.spec.ts': 10,
}

test('balanced planning gives the longest file its own shard', async () => {
  const first = await planShard(estimates, { current: 1, total: 2 })
  const second = await planShard(estimates, { current: 2, total: 2 })
  assert.deepEqual(first, ['planner.spec.ts'])
  assert.deepEqual(second.sort(), ['core.spec.ts', 'runner.spec.ts'])
})

test('every file is planned exactly once across shards', async () => {
  const seen = []
  for (let current = 1; current <= 3; current++) {
    seen.push(...(await planShard(estimates, { current, total: 3 })))
  }
  assert.deepEqual(seen.sort(), files.map((file) => file.split('/').pop()).sort())
})

test('an empty estimate map falls back to round-robin', async () => {
  const seen = []
  for (let current = 1; current <= 2; current++) {
    seen.push(...(await planShard({}, { current, total: 2 })))
  }
  assert.equal(seen.length, files.length)
})
