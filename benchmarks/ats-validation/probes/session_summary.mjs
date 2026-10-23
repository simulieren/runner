// Lab probe: summarize session runs against the isolated baseline (identities, failures, worker test time).
import { readFileSync, existsSync } from 'node:fs'
const load = (n) => JSON.parse(readFileSync(new URL(`../${n}.json`, import.meta.url), 'utf8'))
const key = (t) => JSON.stringify([t.suite, t.file, t.group, t.title])
const base = load('baseline-unit-isolated')
const baseKeys = new Set(base.summaries.flatMap((s) => s.tests).map(key))
const baseFail = new Set(
  base.summaries
    .flatMap((s) => s.tests)
    .filter((t) => t.status === 'failed')
    .map(key)
)
for (const n of process.argv.slice(2)) {
  if (!existsSync(new URL(`../${n}.json`, import.meta.url))) {
    console.log(n, 'missing')
    continue
  }
  const r = load(n),
    tests = r.summaries.flatMap((s) => s.tests)
  const keys = tests.map(key),
    set = new Set(keys)
  const fail = new Set(tests.filter((t) => t.status === 'failed').map(key))
  const missing = [...baseKeys].filter((k) => !set.has(k)).length
  const extra = keys.filter((k) => !baseKeys.has(k)).length
  const dup = keys.length - set.size
  const added = [...fail].filter((k) => !baseFail.has(k)).map((k) => JSON.parse(k)[3].slice(0, 60))
  const fixed = [...baseFail]
    .filter((k) => set.has(k) && !fail.has(k))
    .map((k) => JSON.parse(k)[3].slice(0, 60))
  const workers = r.summaries.map((s) => (s.summary.duration / 1000).toFixed(1)).join('/')
  console.log(
    JSON.stringify({
      n,
      wall: +(r.wallMs / 1000).toFixed(3),
      collected: tests.length,
      missing,
      extra,
      dup,
      failed: fail.size,
      added,
      fixed,
      workers,
    })
  )
}
