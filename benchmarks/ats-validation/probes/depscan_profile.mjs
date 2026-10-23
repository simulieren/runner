// Lab probe: time the declared-dependency scan's phases outside Japa.
import { readFile, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
const WEB_ROOT = process.argv[2]
const SKIP_DIRS = new Set([
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
const VALUE_IMPORT = /^[ \t]*(?:import|export)\s+(?!type\s)([\s\S]*?)\s+from\s*['"]([^'"\n]+)['"]/gm
const SIDE_EFFECT_IMPORT = /^[ \t]*import\s*['"]([^'"\n]+)['"]/gm
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g
async function walk(dir) {
  const found = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) found.push(...(await walk(p)))
    else if (EXT.has(extname(e.name))) found.push(p)
  }
  return found
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
let t = performance.now()
const files = await walk(WEB_ROOT)
const walkMs = performance.now() - t
t = performance.now()
const contents = []
for (let o = 0; o < files.length; o += 32)
  contents.push(...(await Promise.all(files.slice(o, o + 32).map((f) => readFile(f, 'utf8')))))
const readMs = performance.now() - t
const bytes = contents.reduce((a, c) => a + c.length, 0)
t = performance.now()
const cleaned = contents.map(strip)
const stripMs = performance.now() - t
const time = (re, i) => {
  const s = performance.now()
  let n = 0
  for (const c of cleaned) for (const m of c.matchAll(re)) n += m[i] ? 1 : 0
  return [performance.now() - s, n]
}
const [valueMs, vn] = time(VALUE_IMPORT, 2),
  [sideMs] = time(SIDE_EFFECT_IMPORT, 1),
  [dynMs] = time(DYNAMIC_IMPORT, 1)
console.log(
  JSON.stringify({
    files: files.length,
    MB: (bytes / 1e6).toFixed(1),
    walkMs: walkMs | 0,
    readMs: readMs | 0,
    stripMs: stripMs | 0,
    valueMs: valueMs | 0,
    sideMs: sideMs | 0,
    dynMs: dynMs | 0,
    matches: vn,
  })
)
