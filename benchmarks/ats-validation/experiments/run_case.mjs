import { spawn } from 'node:child_process'
import {
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
const [name, mode = 'serial', suite = 'unit', ...filters] = process.argv.slice(2)
const root = import.meta.dirname
const cwd = join(root, 'app/apps/web')
const results = join(cwd, 'tests/results')
if (existsSync(results)) rmSync(results, { recursive: true, force: true })
const cacheDirectory = join(cwd, 'node_modules/.cache/japa')
const history = () => {
  if (process.env.JAPA_EXPERIMENT_HISTORY) {
    const file = process.env.JAPA_EXPERIMENT_HISTORY
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
  }
  if (!existsSync(cacheDirectory)) return undefined
  const file = readdirSync(cacheDirectory).find(
    (x) => x.startsWith('durations-') && x.endsWith('.json')
  )
  return file ? JSON.parse(readFileSync(join(cacheDirectory, file), 'utf8')) : undefined
}
const historyBefore = history()
const output = openSync(join(root, `${name}.log`), 'w')
const started = performance.now()
const entry = join(root, 'worker.mjs')
const args =
  mode === 'serial'
    ? [entry, suite, ...filters]
    : [
        join(root, 'app/node_modules/@japa/runner/build/bin/parallel.js'),
        `--workers=${mode}`,
        ...(process.env.JAPA_EXPERIMENT_HISTORY
          ? [`--history=${process.env.JAPA_EXPERIMENT_HISTORY}`]
          : []),
        '--',
        process.execPath,
        entry,
        suite,
        ...filters,
      ]
await import('./worker_env.mjs')
const child = spawn(process.execPath, args, {
  cwd,
  stdio: ['ignore', output, output],
  detached: true,
  env: { ...process.env, NO_COLOR: '1', VITE_CJS_IGNORE_WARNING: 'true' },
})
let timedOut = false
const timeout = setTimeout(() => {
  timedOut = true
  process.kill(-child.pid, 'SIGTERM')
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }, 3000).unref()
}, 600000)
const code = await new Promise((done) =>
  child.on('close', (code, signal) => done({ code, signal }))
)
clearTimeout(timeout)
closeSync(output)
const summaries = []
if (existsSync(results))
  for (const dir of readdirSync(results)) {
    const folder = join(results, dir)
    for (const file of readdirSync(folder).filter((x) => x.endsWith('-latest.json'))) {
      const report = JSON.parse(readFileSync(join(folder, file), 'utf8'))
      summaries.push({ worker: dir, ...report })
    }
  }
const summary = {
  name,
  mode,
  suite,
  wallMs: performance.now() - started,
  ...code,
  timedOut,
  summaries,
  historyBefore,
  historyAfter: history(),
}
writeFileSync(join(root, `${name}.json`), JSON.stringify(summary, null, 2) + '\n')
console.log(
  JSON.stringify({
    name,
    wallMs: summary.wallMs,
    ...code,
    timedOut,
    counts: summaries.map((x) => ({
      worker: x.worker,
      ...x.summary,
      slowestTests: undefined,
      failedTestsTitles: undefined,
    })),
  })
)
process.exitCode = code.code ?? 1
