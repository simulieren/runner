import { performance } from 'node:perf_hooks'

const start = performance.now()
const { configure, run } = await import(process.env.BENCH_RUNNER_URL)
const loaded = performance.now()
globalThis.benchmarkExecuted = 0
let importsMs = 0
let imports = 0
let summary
const current = Number(process.env.BENCH_SHARD)
const total = Number(process.env.BENCH_SHARDS)
const filters = {}
if (total > 1) filters.shard = { current, total }
if (process.env.BENCH_FILTER) filters.files = [process.env.BENCH_FILTER]
configure({
  cwd: process.env.BENCH_FIXTURE,
  files: ['tests/**/*.spec.mjs'],
  filters,
  importer: async (url) => {
    const started = performance.now()
    await import(url.href)
    importsMs += performance.now() - started
    imports++
  },
  reporters: {
    activated: ['benchmark'],
    list: [
      {
        name: 'benchmark',
        handler(runner, emitter) {
          emitter.on('runner:end', () => {
            summary = runner.getSummary()
          })
        },
      },
    ],
  },
})
await run()
if (!summary || summary.hasError || summary.aggregates.total !== globalThis.benchmarkExecuted) {
  throw new Error('Benchmark test execution or summary mismatch')
}
console.log(
  'BENCH_RESULT ' +
    JSON.stringify({
      current,
      total,
      imports,
      executed: globalThis.benchmarkExecuted,
      failed: summary.aggregates.failed,
      importMs: importsMs,
      moduleLoadMs: loaded - start,
      runMs: performance.now() - loaded,
      executionMs: summary.duration,
      maxRssKiB: process.resourceUsage().maxRSS,
    })
)
