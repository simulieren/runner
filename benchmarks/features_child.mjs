import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const [mode, entry, option = 'default'] = process.argv.slice(2)
const loaded = []
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context)
    loaded.push(result.url)
    return result
  },
})
const start = performance.now()
if (mode === 'startup') {
  await import(pathToFileURL(resolve(entry)))
  const elapsedMs = performance.now() - start
  const printerLoaded = loaded.some((url) => url.includes('/@japa/errors-printer/'))
  if (option === 'lazy') assert.equal(printerLoaded, false)
  console.log(JSON.stringify({ elapsedMs, modules: new Set(loaded).size, printerLoaded }))
} else if (mode === 'core') {
  const { Test, Emitter, Refiner } = await import(pathToFileURL(resolve(entry)))
  const emitter = new Emitter()
  const refiner = new Refiner()
  const count = Number(process.env.BENCH_TEST_COUNT ?? 10000)
  let notifications = 0
  if (option.includes('observed')) {
    emitter.on('test:start', () => {})
    emitter.on('test:end', () => {
      notifications++
    })
  }
  let executed = 0
  const tests = []
  const registering = performance.now()
  for (let i = 0; i < count; i++) {
    const instance = new Test(`test ${i}`, {}, emitter, refiner)
    instance.timeout(2000)
    instance.run(
      () => {
        executed++
        if (option.includes('async')) return Promise.resolve()
      },
      option.includes('no-stacks') ? null : undefined
    )
    tests.push(instance)
  }
  const registrationMs = performance.now() - registering
  const executing = performance.now()
  for (const instance of tests) await instance.exec()
  const executionMs = performance.now() - executing
  assert.equal(executed, count)
  if (option.includes('observed')) assert.equal(notifications, count)
  assert(tests.every((instance) => !instance.failed))
  console.log(
    JSON.stringify({ count, registrationMs, executionMs, elapsedMs: registrationMs + executionMs })
  )
} else if (mode === 'reporter') {
  const { Runner, Suite, Test, Emitter, Refiner, TestContext } = await import(
    pathToFileURL(resolve(entry, 'build/modules/core/main.js'))
  )
  const { spec, dot } = await import(pathToFileURL(resolve(entry, 'build/src/reporters/main.js')))
  const count = Number(process.env.BENCH_TEST_COUNT ?? 10000)
  const emitter = new Emitter()
  const runner = new Runner(emitter)
  const refiner = new Refiner()
  const suite = new Suite('unit', emitter, refiner)
  runner.add(suite)
  const buffered = option.endsWith('-buffered')
  runner.registerReporter((option.startsWith('spec') ? spec : dot)({ bufferOutput: buffered }))
  for (let i = 0; i < count; i++) {
    const instance = new Test(`test ${i}`, (t) => new TestContext(t), emitter, refiner)
    instance.run(() => {})
    suite.add(instance)
  }
  let writes = 0
  let bytes = 0
  const originalWrite = process.stdout.write.bind(process.stdout)
  // Forward real writes to the parent's draining pipe, not a no-op sink.
  process.stdout.write = (...args) => {
    writes++
    bytes += Buffer.byteLength(String(args[0]))
    return originalWrite(...args)
  }
  const running = performance.now()
  await runner.start()
  await runner.exec()
  await runner.end()
  const elapsedMs = performance.now() - running
  process.stdout.write = originalWrite
  assert.equal(runner.getSummary().aggregates.passed, count)
  console.log('\nBENCH_RESULT ' + JSON.stringify({ elapsedMs, writes, bytes, count }))
} else if (mode === 'balanced') {
  const { configure, run, test } = await import(pathToFileURL(resolve(entry)))
  const [strategy, current] = option.split(':')
  const delays = [80, 4, 70, 8]
  const files = delays.map((_, i) =>
    pathToFileURL(resolve(`.benchmarks/balanced/file${i}.spec.mjs`))
  )
  const durations = Object.fromEntries(
    delays.map((ms, i) => [`.benchmarks/balanced/file${i}.spec.mjs`, ms])
  )
  let summary
  configure({
    files: () => files,
    filters: { shard: { current: Number(current), total: 2 } },
    shardDurations: strategy === 'duration' ? durations : {},
    importer(url) {
      const index = files.findIndex((file) => file.href === url.href)
      test(`file ${index}`, () => new Promise((done) => setTimeout(done, delays[index])))
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
  assert.equal(summary.aggregates.passed, strategy === 'duration' ? (current === '1' ? 1 : 3) : 2)
  console.log(
    JSON.stringify({ elapsedMs: performance.now() - start, executed: summary.aggregates.total })
  )
} else throw new Error(`Unknown mode: ${mode}`)
