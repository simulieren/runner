import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const entry = process.argv[2] ?? 'build/index.js'
let cases = 0
for (const reporter of ['spec', 'dot', 'ndjson', 'github']) {
  for (const mode of [
    'pass',
    'fail',
    'timeout',
    'pinned',
    'unhandled',
    'rejection',
    'late-rejection',
  ]) {
    for (const capture of ['true', 'false']) {
      const result = spawnSync(
        process.execPath,
        ['benchmarks/smoke_child.mjs', entry, reporter, mode, capture],
        { encoding: 'utf8', timeout: 15000 }
      )
      const expected = ['fail', 'timeout', 'unhandled', 'rejection', 'late-rejection'].includes(
        mode
      )
        ? 1
        : 0
      assert.equal(
        result.status,
        expected,
        `${reporter}/${mode}/${capture}: ${result.stderr}\n${result.stdout}`
      )
      assert(
        result.stdout.includes(mode === 'pinned' ? 'SMOKE_PINNED' : 'SMOKE_OK'),
        result.stdout + result.stderr
      )
      if (mode === 'pinned') assert(result.stdout.includes('pinned declaration'))
      if (mode === 'fail' && reporter === 'spec')
        assert((result.stdout + result.stderr).includes('smoke failure'))
      cases++
    }
  }
}
console.log(`Passed ${cases} isolated reporter/lifecycle/exit-code/diagnostic smoke cases`)
