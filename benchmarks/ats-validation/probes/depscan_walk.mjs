// Lab probe: compare sequential and concurrent directory walks (same output order).
import { readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
const SKIP = new Set([
  'node_modules',
  'build',
  'public',
  '.adonisjs',
  'dist',
  'tmp',
  'logs',
  'coverage',
])
const EXT = new Set(['.ts', '.tsx', '.mts'])
async function sequential(dir) {
  const found = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) found.push(...(await sequential(p)))
    else if (EXT.has(extname(e.name))) found.push(p)
  }
  return found
}
async function concurrent(dir) {
  const entries = (await readdir(dir, { withFileTypes: true })).filter(
    (e) => !SKIP.has(e.name) && !e.name.startsWith('.')
  )
  const parts = await Promise.all(
    entries.map((e) => {
      const p = join(dir, e.name)
      if (e.isDirectory()) return concurrent(p)
      return EXT.has(extname(e.name)) ? [p] : []
    })
  )
  return parts.flat()
}
const root = process.argv[2]
for (const [name, fn] of [
  ['sequential', sequential],
  ['concurrent', concurrent],
  ['sequential', sequential],
  ['concurrent', concurrent],
]) {
  const t = performance.now()
  const files = await fn(root)
  console.log(name, (performance.now() - t).toFixed(0), 'ms', files.length)
}
const a = await sequential(root),
  b = await concurrent(root)
console.log('identical order:', a.length === b.length && a.every((x, i) => x === b[i]))
