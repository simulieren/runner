import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const names = process.argv.slice(2)
const rows = names.map((name) => {
  const data = JSON.parse(readFileSync(join(import.meta.dirname, `${name}.json`), 'utf8'))
  const aggregates = { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0, regression: 0 }
  const tests = data.summaries.flatMap((report) => report.tests)
  for (const report of data.summaries)
    for (const key of Object.keys(aggregates)) aggregates[key] += report.summary[key] ?? 0
  const key = (test) => JSON.stringify([test.suite, test.file, test.group, test.title])
  const counts = new Map()
  for (const test of tests) counts.set(key(test), (counts.get(key(test)) ?? 0) + 1)
  return {
    name,
    wallSeconds: Number((data.wallMs / 1000).toFixed(3)),
    exit: data.code,
    timedOut: data.timedOut,
    ...aggregates,
    collected: tests.length,
    duplicates: [...counts].filter(([, n]) => n > 1),
    failedTests: tests
      .filter((t) => t.status === 'failed')
      .map((t) => ({ key: key(t), errors: t.errors })),
    keys: [...counts.entries()].flatMap(([key, n]) => Array(n).fill(key)).sort(),
  }
})
const first = rows[0]
for (const row of rows.slice(1)) {
  const base = new Map(),
    current = new Map()
  for (const key of first.keys) base.set(key, (base.get(key) ?? 0) + 1)
  for (const key of row.keys) current.set(key, (current.get(key) ?? 0) + 1)
  row.missing = [...base].flatMap(([key, n]) =>
    Array(Math.max(0, n - (current.get(key) ?? 0))).fill(key)
  )
  row.extra = [...current].flatMap(([key, n]) =>
    Array(Math.max(0, n - (base.get(key) ?? 0))).fill(key)
  )
  row.speedup = Number((first.wallSeconds / row.wallSeconds).toFixed(3))
  const baseFailures = new Set(first.failedTests.map((t) => t.key))
  row.additionalFailures = row.failedTests.filter((t) => !baseFailures.has(t.key))
}
writeFileSync(join(import.meta.dirname, 'comparison.json'), JSON.stringify(rows, null, 2) + '\n')
for (const { keys, failedTests, duplicates, ...row } of rows)
  console.log(
    JSON.stringify({
      ...row,
      failedTitles: failedTests.map((t) => JSON.parse(t.key)[3]),
      duplicateCount: duplicates.length,
    })
  )
