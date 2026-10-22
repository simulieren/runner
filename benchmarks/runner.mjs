import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { loadLayout } from './layout.mjs'

const root = resolve('.benchmarks/runner-fixture')
const paths = (await loadLayout()).map((file) => file.replace(/\.(ts|tsx|js)$/, '.mjs'))
for (const file of paths) {
  const target = resolve(root, file)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(
    target,
    `const { test } = await import(process.env.BENCH_RUNNER_URL)
test(${JSON.stringify(file)}, async () => {
  if (process.env.BENCH_DELAY === '1') await new Promise((done) => setTimeout(done, 2))
  globalThis.benchmarkExecuted++
})\n`
  )
}
const versions = [
  ['5.3', '.benchmarks/baseline-5.3/build/index.js'],
  ['5.4', '.benchmarks/baseline-5.4/build/index.js'],
  ['fork', 'build/index.js'],
]
const samples = []
const repetitions = Number(process.env.BENCH_REPETITIONS || 5)
assert(Number.isInteger(repetitions) && repetitions > 0)
const filter = basename(paths[0]).replace('.spec.mjs', '')
function child(entry, current, total, workload) {
  return new Promise((done, reject) => {
    const proc = spawn(process.execPath, ['benchmarks/runner_child.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BENCH_RUNNER_URL: pathToFileURL(resolve(entry)).href,
        BENCH_FIXTURE: root,
        BENCH_SHARD: String(current),
        BENCH_SHARDS: String(total),
        BENCH_DELAY: workload === 'async' ? '1' : '',
        BENCH_FILTER: workload === 'filtered' ? filter : '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '',
      stderr = ''
    proc.stdout.on('data', (data) => {
      stdout += data
    })
    proc.stderr.on('data', (data) => {
      stderr += data
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${stderr}\n${stdout}`))
      const line = stdout.split('\n').find((row) => row.startsWith('BENCH_RESULT '))
      if (!line) return reject(new Error(`Missing child result: ${stdout}`))
      done(JSON.parse(line.slice('BENCH_RESULT '.length)))
    })
  })
}
const cases = ['filtered', 'noop', 'async'].flatMap((workload) =>
  versions.map(([version, entry]) => ({ workload, version, entry, workers: 1 }))
)
for (const workers of [2, 4, 6]) {
  cases.push({ workload: 'async', version: 'fork', entry: 'build/index.js', workers })
}
for (let round = 0; round <= repetitions; round++) {
  for (let offset = 0; offset < cases.length; offset++) {
    const scenario = cases[(round + offset) % cases.length]
    const start = performance.now()
    const children = await Promise.all(
      Array.from({ length: scenario.workers }, (_, i) =>
        child(scenario.entry, i + 1, scenario.workers, scenario.workload)
      )
    )
    const wallMs = performance.now() - start
    const expected =
      scenario.workload === 'filtered'
        ? paths.filter((p) => basename(p).replace('.spec.mjs', '').endsWith(filter)).length
        : paths.length
    assert.equal(
      children.reduce((sum, row) => sum + row.executed, 0),
      expected
    )
    assert.equal(
      children.reduce((sum, row) => sum + row.imports, 0),
      expected
    )
    assert.equal(
      children.reduce((sum, row) => sum + row.failed, 0),
      0
    )
    if (round) samples.push({ ...scenario, round, wallMs, children })
  }
  console.log(`Completed ${round === 0 ? 'warm-up' : `round ${round}/${repetitions}`}`)
}
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return { medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1) }
}
const results = cases.map((scenario) => {
  const rows = samples.filter(
    (s) =>
      s.version === scenario.version &&
      s.workload === scenario.workload &&
      s.workers === scenario.workers
  )
  return {
    ...scenario,
    wall: stats(rows.map((s) => s.wallMs)),
    maxWorkerRssKiB: Math.max(...rows.flatMap((s) => s.children.map((c) => c.maxRssKiB))),
  }
})
const report = {
  node: process.version,
  fixtureFiles: paths.length,
  warmups: 1,
  repetitions,
  note: 'Synthetic no-op/2ms async tests. No Adonis boot or external services.',
  results,
  samples,
}
await writeFile('.benchmarks/runner.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(results, null, 2))
