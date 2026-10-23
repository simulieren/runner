#!/usr/bin/env node

/**
 * Boot attribution probe.
 *
 * Runs `bin/test.ts --prepare` once under --cpu-prof (so no test executes) and
 * aggregates self time by Node internals, Adonis packages, app providers,
 * modules and test files. This is how a boot cost gets a name instead of a
 * guess.
 *
 * Usage (from the lab copy):
 *   node .benchmarks/ats-validation/probes/boot_breakdown.mjs [--worker=1]
 *        [--profile-dir=.benchmarks/ats-validation/cpuprof-boot] [--json=path]
 */

import { spawn } from 'node:child_process'
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))
  if (index < 0) return fallback
  const arg = args[index]
  return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : (args[index + 1] ?? fallback)
}

const worker = Number(option('worker', '1'))
const lab = resolve(import.meta.dirname, '..')
const web = join(lab, 'app/apps/web')
const profileDir = resolve(option('profile-dir', join(lab, 'cpuprof-boot')))
const jsonPath = resolve(option('json', join(lab, 'boot-breakdown.json')))

process.env.JAPA_WORKER_ID = String(worker)
await import('../worker_env.mjs')

/** Click into the largest bucket for a script URL. */
function bucket(url) {
  if (!url) return 'native'
  if (url.startsWith('node:')) return 'node internals'
  if (url.includes('/node_modules/@adonisjs/')) {
    return `adonis: ${url.split('/node_modules/')[1].split('/').slice(0, 2).join('/')}`
  }
  if (url.includes('/node_modules/@')) {
    return `package: @${url.split('/node_modules/@')[1].split('/')[0]}`
  }
  if (url.includes('/node_modules/')) {
    return `package: ${url.split('/node_modules/')[1].split('/')[0]}`
  }
  if (url.includes('/app/providers/')) return 'app providers'
  if (url.includes('/app/modules/')) return 'app modules'
  if (url.includes('/start/')) return 'app start'
  if (url.includes('/tests/')) return 'tests'
  if (url.includes('/app/')) return 'app other'
  return 'other'
}

function aggregate(profiles) {
  const byBucket = new Map()
  const byFunction = new Map()
  const byFile = new Map()
  let total = 0

  for (const profile of profiles) {
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
    const deltas = profile.timeDeltas ?? []

    for (let index = 0; index < profile.samples.length; index++) {
      const node = nodes.get(profile.samples[index])
      if (!node) continue
      const ms = (deltas[index] ?? 0) / 1000
      total += ms
      const frame = node.callFrame
      const name = `${frame.functionName || '(anonymous)'} @ ${frame.url || 'native'}`
      const file = frame.url || 'native'

      byBucket.set(bucket(frame.url), (byBucket.get(bucket(frame.url)) ?? 0) + ms)
      byFunction.set(name, (byFunction.get(name) ?? 0) + ms)
      byFile.set(file, (byFile.get(file) ?? 0) + ms)
    }
  }

  const top = (map, count) =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([name, ms]) => ({ name, ms: Math.round(ms * 10) / 10 }))

  return {
    totalMs: Math.round(total),
    buckets: top(byBucket, 12),
    functions: top(byFunction, 25),
    files: top(byFile, 15),
  }
}

await mkdir(profileDir, { recursive: true })
const started = performance.now()
const startedAt = Date.now()
const child = spawn(
  process.execPath,
  [
    '--cpu-prof',
    `--cpu-prof-dir=${profileDir}`,
    '--cpu-prof-interval=250',
    '--import=@poppinss/ts-exec',
    'bin/test.ts',
    'unit',
    '--prepare',
  ],
  {
    cwd: web,
    env: { ...process.env, JAPA_EXPERIMENT_PHASES: '1', NO_COLOR: '1' },
    stdio: 'inherit',
  }
)
const code = await new Promise((done) => child.once('close', (code) => done(code ?? 1)))
if (code !== 0) {
  console.error(`boot_breakdown: prepare exited ${code}`)
  process.exit(code)
}

const { stat } = await import('node:fs/promises')
const all = (await readdir(profileDir)).filter((name) => name.endsWith('.cpuprofile'))
const fresh = []
for (const name of all) {
  const info = await stat(join(profileDir, name))
  // Loader hooks run on a worker thread with their own profile; keep them all.
  if (info.mtimeMs >= startedAt - 1) fresh.push(join(profileDir, name))
}
if (!fresh.length) {
  console.error(`boot_breakdown: no profile found in ${profileDir}`)
  process.exit(1)
}

const profiles = []
for (const path of fresh) profiles.push(JSON.parse(await readFile(path, 'utf8')))
const result = {
  worker,
  profiles: fresh,
  wallMs: Math.round(performance.now() - started),
  ...aggregate(profiles),
}
await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`)

console.log(`boot_breakdown: ${result.totalMs} ms sampled, wall ${result.wallMs} ms`)
console.log('buckets:')
for (const row of result.buckets) console.log(`  ${String(row.ms).padStart(8)} ms  ${row.name}`)
console.log('files:')
for (const row of result.files.slice(0, 10)) {
  console.log(`  ${String(row.ms).padStart(8)} ms  ${row.name.replace(web, '.')}`)
}
console.log(`written: ${jsonPath}`)
