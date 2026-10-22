import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const packageRoot = resolve(process.argv[2] ?? '.')
await mkdir('.benchmarks', { recursive: true })
const cwd = await mkdtemp(resolve('.benchmarks/automatic-smoke-'))
await writeFile(`${cwd}/package.json`, JSON.stringify({ private: true }))
const worker = resolve('tests_helpers/automatic_worker.mjs')
const installed = Boolean(process.argv[2])
const executable = installed ? resolve(packageRoot, '../../.bin/japa-parallel') : process.execPath
const prefix = installed ? [] : [resolve(packageRoot, 'build/bin/parallel.js')]
const env = {
  ...process.env,
  TEST_RUNNER_ENTRY: pathToFileURL(resolve(packageRoot, 'build/index.js')).href,
  TEST_PLUGINS_ENTRY: pathToFileURL(resolve(packageRoot, 'build/src/plugins/main.js')).href,
  TEST_NO_PLUGIN: '1',
}
try {
  const invoke = (extraArgs = [], extraEnv = {}) =>
    execFileSync(
      executable,
      [
        ...prefix,
        '--workers=2',
        '--history=history.json',
        `--cwd=${cwd}`,
        '--',
        process.execPath,
        worker,
        ...extraArgs,
      ],
      { encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 15000 }
    )
  assert(invoke().includes('workers=2 exit=0 timings=updated'))
  const history = JSON.parse(await readFile(`${cwd}/history.json`, 'utf8'))
  assert.equal(Object.keys(history.durations).length, 6)
  const cold = await Promise.all(
    [1, 2].map(async (id) => JSON.parse(await readFile(`${cwd}/observed-${id}.json`, 'utf8')))
  )
  assert.deepEqual(
    cold.map((row) => row.executed),
    [
      [0, 2, 4],
      [1, 3, 5],
    ]
  )
  assert(invoke().includes('workers=2 exit=0 timings=updated'))
  const warm = await Promise.all(
    [1, 2].map(async (id) => JSON.parse(await readFile(`${cwd}/observed-${id}.json`, 'utf8')))
  )
  assert.deepEqual(
    warm.flatMap((row) => row.executed).sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5]
  )
  for (const row of warm) assert.deepEqual(row.estimates, history.durations)
  assert.notDeepEqual(
    warm.map((row) => row.executed),
    [
      [0, 2, 4],
      [1, 3, 5],
    ]
  )
  assert.throws(
    () => invoke([], { TEST_FAIL: '1' }),
    (error) => error.status === 1
  )
  assert(invoke(['--failed']).includes('workers=2 exit=0 timings=unchanged'))
  const retried = await Promise.all(
    [1, 2].map(async (id) => JSON.parse(await readFile(`${cwd}/observed-${id}.json`, 'utf8')))
  )
  assert.deepEqual(
    retried.flatMap((row) => row.executed).sort((a, b) => a - b),
    [0, 1]
  )
  console.log(
    `Automatic ${installed ? 'installed-package' : 'build'} CLI: cold/warm/failed-rerun checks passed without app plugins or manual estimates`
  )
} finally {
  await rm(cwd, { recursive: true, force: true })
}
