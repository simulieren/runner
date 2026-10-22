import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

const baseline =
  process.env.BENCH_BASELINE_CORE ?? '.benchmarks/baseline-core-speed.2/build/index.js'
const cases = ['no-stacks', 'no-stacks-observed', 'no-stacks-async-observed']
const scenarios = cases.flatMap((option) => [
  { name: `speed.2/${option}`, entry: baseline, option },
  { name: `speed.3/${option}`, entry: 'packages/core/build/index.js', option },
])
const repetitions = Number(process.env.BENCH_REPETITIONS ?? 7)
assert(Number.isInteger(repetitions) && repetitions > 0)
const samples = Object.fromEntries(scenarios.map((scenario) => [scenario.name, []]))
for (let round = 0; round <= repetitions; round++) {
  for (let offset = 0; offset < scenarios.length; offset++) {
    const scenario = scenarios[(round + offset) % scenarios.length]
    const child = spawnSync(
      process.execPath,
      ['benchmarks/features_child.mjs', 'core', scenario.entry, scenario.option],
      {
        encoding: 'utf8',
        env: { ...process.env, BENCH_TEST_COUNT: '100000' },
        timeout: 30000,
      }
    )
    assert.equal(child.status, 0, child.stderr + child.stdout)
    const result = JSON.parse(child.stdout.trim())
    if (round) samples[scenario.name].push(result)
  }
  console.log(`Completed ${round ? `round ${round}/${repetitions}` : 'warm-up'}`)
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const results = Object.fromEntries(
  Object.entries(samples).map(([name, rows]) => [
    name,
    {
      medianExecutionMs: median(rows.map((row) => row.executionMs)),
      minExecutionMs: Math.min(...rows.map((row) => row.executionMs)),
      maxExecutionMs: Math.max(...rows.map((row) => row.executionMs)),
      medianRegistrationMs: median(rows.map((row) => row.registrationMs)),
    },
  ])
)
await writeFile(
  '.benchmarks/core-paths.json',
  JSON.stringify(
    { node: process.version, count: 100000, warmups: 1, repetitions, results, samples },
    null,
    2
  ) + '\n'
)
console.log(JSON.stringify(results, null, 2))
