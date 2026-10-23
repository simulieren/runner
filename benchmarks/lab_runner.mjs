#!/usr/bin/env node

/**
 * Sequential lab runner with load hygiene.
 *
 * Wraps any command, records wall time and system load, and refuses to present
 * the sample as a valid timing when the machine was busy. Use it instead of
 * hand-running benchmarks during agent work.
 *
 *   node benchmarks/lab_runner.mjs --label=filtered --reps=3 --max-load=4 -- \
 *     node .benchmarks/ats-validation/run_case.mjs label serial unit --tests=...
 */

import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { loadavg } from 'node:os'
import { resolve } from 'node:path'

const argv = process.argv.slice(2)
const separator = argv.indexOf('--')
const head = separator < 0 ? argv : argv.slice(0, separator)
const command = separator < 0 ? [] : argv.slice(separator + 1)

const option = (name, fallback) => {
  const index = head.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))
  if (index < 0) return fallback
  const arg = head[index]
  return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : (head[index + 1] ?? fallback)
}

const label = option('label', 'lab')
const reps = Number(option('reps', '1'))
const maxLoad = Number(option('max-load', '4'))
const expectExit = option('expect-exit')
const out = resolve(option('out', `.benchmarks/lab-${label}.json`))

if (!command.length) {
  console.error('Usage: lab_runner.mjs [options] -- <command...>')
  process.exit(2)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function once(index) {
  const loadBefore = loadavg()[0]
  const started = performance.now()
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit' })
  let peak = loadBefore
  const timer = setInterval(() => {
    peak = Math.max(peak, loadavg()[0])
  }, 500)
  timer.unref?.()
  const code = await new Promise((done) => child.once('close', (code) => done(code ?? 1)))
  clearInterval(timer)
  const wallMs = performance.now() - started
  return {
    index,
    code,
    wallMs: Math.round(wallMs),
    loadBefore,
    loadAfter: loadavg()[0],
    peakLoad: peak,
  }
}

const samples = []
for (let index = 1; index <= reps; index++) {
  samples.push(await once(index))
  if (index < reps) await sleep(300)
}

const sorted = samples.map((sample) => sample.wallMs).sort((a, b) => a - b)
const median = sorted.length
  ? sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
  : 0
const peakLoad = Math.max(...samples.map((sample) => sample.peakLoad))
const loadAffected = peakLoad > maxLoad
const expected = expectExit === undefined ? undefined : Number(expectExit)
const unexpected = samples.filter((sample) => expected !== undefined && sample.code !== expected)

const result = {
  label,
  command,
  reps,
  maxLoad,
  peakLoad: Math.round(peakLoad * 100) / 100,
  loadAffected,
  medianWallMs: median,
  samples,
  ...(unexpected.length ? { unexpectedExits: unexpected.map((sample) => sample.code) } : {}),
}
await writeFile(out, `${JSON.stringify(result, null, 2)}\n`)

console.log(
  `lab ${label}: median ${median} ms, peak load ${result.peakLoad}, ` +
    `${loadAffected ? 'LOAD-AFFECTED' : 'load within budget'} -> ${out}`
)
process.exitCode = loadAffected ? 3 : unexpected.length ? 1 : 0
