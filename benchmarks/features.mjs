import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

const scenarios = [
  { name: 'shards-round-robin', args: ['balanced-pair', 'build/index.js', 'round-robin'] },
  { name: 'shards-duration', args: ['balanced-pair', 'build/index.js', 'duration'] },
  { name: 'startup-5.4', args: ['startup', '.benchmarks/baseline-5.4/build/index.js'] },
  { name: 'startup-speed.1', args: ['startup', '.benchmarks/baseline-speed.1/build/index.js'] },
  { name: 'startup-speed.2', args: ['startup', 'build/index.js', 'lazy'] },
  {
    name: 'core-upstream',
    args: ['core', '.benchmarks/upstream-deps/node_modules/@japa/core/build/index.js'],
  },
  { name: 'core-fork', args: ['core', 'packages/core/build/index.js'] },
  { name: 'core-fork-no-stacks', args: ['core', 'packages/core/build/index.js', 'no-stacks'] },
  ...['spec', 'dot'].flatMap((reporter) => [
    { name: `${reporter}-5.4`, args: ['reporter', '.benchmarks/baseline-5.4', reporter] },
    { name: `${reporter}-fork-immediate`, args: ['reporter', '.', reporter] },
    { name: `${reporter}-fork-buffered`, args: ['reporter', '.', `${reporter}-buffered`] },
  ]),
]
async function sample(args) {
  if (args[0] === 'balanced-pair') {
    const start = performance.now()
    const children = await Promise.all(
      [1, 2].map((current) => sample(['balanced', args[1], `${args[2]}:${current}`]))
    )
    assert.equal(
      children.reduce((sum, child) => sum + child.executed, 0),
      4
    )
    return {
      elapsedMs: performance.now() - start,
      executed: children.reduce((sum, child) => sum + child.executed, 0),
    }
  }
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ['benchmarks/features_child.mjs', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (data) => {
      stdout += data
    })
    child.stderr.on('data', (data) => {
      stderr += data
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code) return reject(new Error(`child exited ${code}: ${stderr}\n${stdout.slice(-2000)}`))
      const result =
        args[0] === 'reporter'
          ? stdout
              .split('\n')
              .find((line) => line.startsWith('BENCH_RESULT '))
              .slice(13)
          : stdout.trim()
      done(JSON.parse(result))
    })
  })
}
const samples = Object.fromEntries(scenarios.map((scenario) => [scenario.name, []]))
for (let round = 0; round < 6; round++) {
  for (let offset = 0; offset < scenarios.length; offset++) {
    const scenario = scenarios[(round + offset) % scenarios.length]
    const result = await sample(scenario.args)
    if (round) samples[scenario.name].push(result)
  }
  console.log(`Completed ${round ? `round ${round}/5` : 'warm-up'}`)
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const results = Object.fromEntries(
  Object.entries(samples).map(([name, rows]) => [
    name,
    {
      medianMs: median(rows.map((row) => row.elapsedMs)),
      minMs: Math.min(...rows.map((row) => row.elapsedMs)),
      maxMs: Math.max(...rows.map((row) => row.elapsedMs)),
      ...(rows[0].writes === undefined
        ? {}
        : { medianWrites: median(rows.map((row) => row.writes)) }),
      ...(rows[0].modules === undefined
        ? {}
        : { modules: rows[0].modules, printerLoaded: rows[0].printerLoaded }),
      ...(rows[0].registrationMs === undefined
        ? {}
        : {
            medianRegistrationMs: median(rows.map((row) => row.registrationMs)),
            medianExecutionMs: median(rows.map((row) => row.executionMs)),
          }),
    },
  ])
)
await writeFile(
  '.benchmarks/features.json',
  JSON.stringify(
    { node: process.version, warmups: 1, repetitions: 5, testCount: 10000, results, samples },
    null,
    2
  ) + '\n'
)
console.log(JSON.stringify(results, null, 2))
