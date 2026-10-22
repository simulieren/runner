import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [entry, reporterName, mode = 'pass', capture = 'true'] = process.argv.slice(2)
const { configure, run, test, getActiveTest, processCLIArgs } = await import(
  pathToFileURL(resolve(entry))
)
const reporters = await import(pathToFileURL(resolve(dirname(entry), 'src/reporters/main.js')))
let summary
const stack = []
if (mode === 'pinned') processCLIArgs(['--list-pinned'])
configure({
  files: () => [pathToFileURL(resolve('.benchmarks/virtual.spec.js'))],
  captureTestLocations: capture !== 'false',
  importer() {
    if (['unhandled', 'rejection', 'late-rejection'].includes(mode)) {
      test('unhandled error', async () => {
        setTimeout(
          () => {
            if (mode === 'unhandled') throw new Error('smoke unhandled')
            void Promise.reject(new Error('smoke rejection'))
          },
          mode === 'late-rejection' ? 10 : 0
        )
        if (mode !== 'late-rejection') await new Promise((done) => setTimeout(done, 5))
      })
      return
    }
    if (mode === 'fail') {
      test('expected failure', () => {
        throw new Error('smoke failure')
      })
      return
    }
    if (mode === 'timeout') {
      test('expected timeout', () => new Promise(() => {})).timeout(5)
      return
    }
    if (mode === 'pinned') {
      test('pinned declaration', () => {}).pin()
      return
    }
    test.group('lifecycle', (group) => {
      group.each.setup(() => {
        stack.push('setup')
        return () => {
          stack.push('setup:cleanup')
        }
      })
      group.each.teardown(() => {
        stack.push('teardown')
      })
      test('plain', (context) => {
        assert.equal(getActiveTest().title, 'plain')
        context.cleanup(() => {
          assert.equal(getActiveTest().title, 'plain')
          stack.push('cleanup')
        })
      })
      test('done', (_, done) => {
        setTimeout(() => done(), 1)
      }).waitForDone()
      test('dataset', (_, value) => {
        assert([1, 2].includes(value))
      }).with([1, 2])
      test('skip', () => {
        throw new Error('must not run')
      }).skip()
      test('todo')
      test('regression', () => {
        throw new Error('expected')
      }).fails()
      test('throws', () => {
        throw new Error('expected')
      }).throws('expected')
    })
  },
  reporters: {
    activated: [reporterName, 'smoke'],
    list: [
      reporters[reporterName]({ bufferOutput: true }),
      {
        name: 'smoke',
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
if (mode === 'late-rejection') await new Promise((done) => setTimeout(done, 100))
if (mode === 'pinned') {
  console.log('SMOKE_PINNED')
  process.exit(0)
}
assert(summary)
if (mode === 'pass') {
  assert.equal(summary.aggregates.total, 8)
  assert.equal(summary.hasError, false)
  assert(stack.includes('cleanup'))
  assert.equal(
    stack.filter((v) => v === 'setup').length,
    stack.filter((v) => v === 'setup:cleanup').length
  )
} else {
  assert.equal(
    summary.aggregates.failed,
    ['unhandled', 'rejection', 'late-rejection'].includes(mode) ? 0 : 1
  )
  assert.equal(process.exitCode, 1)
}
console.log(
  'SMOKE_OK ' + JSON.stringify({ reporterName, mode, capture, total: summary.aggregates.total })
)
