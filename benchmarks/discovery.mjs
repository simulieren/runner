import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

import { loadLayout } from './layout.mjs'

// These fixtures contain filenames only, never application code or credentials.
const root = resolve('.benchmarks/discovery-fixture')
const paths = await loadLayout()
for (const file of paths) {
  const target = resolve(root, file)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, '')
}
const versions = [
  ['5.3', '.benchmarks/baseline-5.3'],
  ['5.4', '.benchmarks/baseline-5.4'],
  ['fork', '.'],
]
const managers = await Promise.all(
  versions.map(async ([name, directory]) => {
    const { FilesManager } = await import(pathToFileURL(resolve(directory, 'src/files_manager.ts')))
    return { name, manager: new FilesManager() }
  })
)
const patterns = [
  'tests/unit/**/*.spec.{ts,tsx,js}',
  'tests/modules/*/unit/**/*.spec.{ts,tsx,js}',
  'tests/functional/**/*.spec.{ts,tsx,js}',
  'tests/modules/*/functional/**/*.spec.{ts,tsx,js}',
  'tests/browser/**/*.spec.{ts,tsx,js}',
  'tests/modules/*/browser/**/*.spec.{ts,tsx,js}',
]
const files = await managers[0].manager.getFiles(root, patterns, [])
const filters = ['service', 'controller', 'unit/*', 'functional/user', 'not_present', 'browser/*']
const expected = managers[0].manager.grep(files, filters)
for (const { manager } of managers) {
  assert.deepEqual(await manager.getFiles(root, patterns, []), files)
  assert.deepEqual(manager.grep(files, filters), expected)
}
const samples = Object.fromEntries(
  managers.map(({ name }) => [name, { discovery: [], filtering: [] }])
)
// Rotate order to reduce systematic cache/thermal bias. First round is warm-up.
for (let round = 0; round < 8; round++) {
  for (let offset = 0; offset < managers.length; offset++) {
    const { name, manager } = managers[(round + offset) % managers.length]
    let start = performance.now()
    await manager.getFiles(root, patterns, [])
    const discovery = performance.now() - start
    start = performance.now()
    for (let i = 0; i < 100; i++) manager.grep(files, filters)
    const filtering = (performance.now() - start) / 100
    if (round) {
      samples[name].discovery.push(discovery)
      samples[name].filtering.push(filtering)
    }
  }
}
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return { medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1) }
}
const result = {
  node: process.version,
  fixtureFiles: paths.length,
  matchedFiles: files.length,
  filterMatches: expected.length,
  warmups: 1,
  repetitions: 7,
  versions: Object.fromEntries(
    Object.entries(samples).map(([name, rows]) => [
      name,
      {
        discovery: stats(rows.discovery),
        filtering: stats(rows.filtering),
        samples: rows,
      },
    ])
  ),
}
await writeFile('.benchmarks/discovery.json', JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
