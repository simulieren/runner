#!/usr/bin/env node

/**
 * Differential selection gate.
 *
 * Runs the same filter twice: once with the selection index and once with it
 * disabled. The set of test identities and the exit code must match. This is the
 * correctness gate for "fewer imports, same tests".
 *
 * Usage (from the lab copy):
 *   node .benchmarks/ats-validation/probes/selection_gate.mjs --worker=1 \
 *     -- --tests="some title"
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const separator = argv.indexOf('--')
const head = separator < 0 ? argv : argv.slice(0, separator)
const testArgs = separator < 0 ? [] : argv.slice(separator + 1)
const option = (name, fallback) => {
  const index = head.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))
  if (index < 0) return fallback
  const arg = head[index]
  return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : (head[index + 1] ?? fallback)
}

const worker = Number(option('worker', '1'))
const label = option('label', 'selection-gate')
const lab = resolve(import.meta.dirname, '..')
const web = join(lab, 'app/apps/web')

process.env.JAPA_WORKER_ID = String(worker)
await import('../worker_env.mjs')

async function runVariant(name, env) {
  const report = join(lab, `${label}-${name}.jsonl`)
  await mkdir(join(lab, 'gate'), { recursive: true })
  const child = spawn(
    process.execPath,
    [
      join(lab, 'worker.mjs'),
      'unit',
      ...testArgs,
      '--agent',
      '--agent-all',
      `--agent-file=${report}`,
    ],
    {
      cwd: web,
      env: { ...process.env, NO_COLOR: '1', JAPA_AGENT_ALL: '1', ...env },
      stdio: ['ignore', 'ignore', 'inherit'],
    }
  )
  const code = await new Promise((done) => child.once('close', (code) => done(code ?? 1)))

  let identities = []
  const text = await readFile(report, 'utf8').catch(() => '')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line)
      if (record.event === 'test') {
        identities.push({ file: record.file, title: record.title, status: record.status })
      }
    } catch {
      // Application logs can share the stream; ignore unparseable lines.
    }
  }
  identities = identities.sort((a, b) =>
    `${a.file}\u0000${a.title}`.localeCompare(`${b.file}\u0000${b.title}`)
  )
  return { name, code, identities, report }
}

const indexed = await runVariant('indexed', {})
const unindexed = await runVariant('unindexed', { JAPA_NO_SELECTION_INDEX: '1' })

const key = (rows) =>
  rows.map((row) => `${row.file}\u0000${row.title}\u0000${row.status}`).join('\n')
const equal = key(indexed.identities) === key(unindexed.identities)
const result = {
  label,
  args: testArgs,
  equal,
  indexedExit: indexed.code,
  unindexedExit: unindexed.code,
  tests: indexed.identities.length,
  missing: indexed.identities.filter(
    (row) =>
      !unindexed.identities.some((other) => other.file === row.file && other.title === row.title)
  ),
  extra: unindexed.identities.filter(
    (row) =>
      !indexed.identities.some((other) => other.file === row.file && other.title === row.title)
  ),
}
const output = join(lab, 'gate', `${label}.json`)
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({ ...result, output }))
if (!equal || indexed.code !== unindexed.code) process.exitCode = 1
