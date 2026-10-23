#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  diffReports,
  parseAgentReport,
  type AgentSummary,
  type ParsedAgentReport,
} from '../src/agent_delta.js'

/**
 * Harness-agnostic test loop for agents.
 *
 * It only composes existing Japa flags, so it works with any command that
 * forwards CLI arguments to Japa:
 *
 *   japa-agent -- node bin/test.js
 *   japa-agent --cwd=apps/web -- node --import=@poppinss/ts-exec bin/test.ts unit
 *
 * On first use it builds the selection caches, then runs only the files affected
 * by git changes and writes bounded JSON lines for the harness to read. Stdout is
 * left to the application; the wrapper reports on stderr.
 */

type Options = {
  cwd?: string
  out?: string
  full: boolean
  prepare: boolean
  timeout?: number
  report: boolean
  metrics: boolean
  cacheDir?: string
}

const SELECTION_FLAGS = /^--(tests|groups|tags|files|failed|changed|shard)(=|$)/
const SELECTION_VALUE = /^--(tests|groups|tags|files|changed|shard)$/

/** Remove selection flags and their separate values before preparing caches. */
function withoutSelectionFlags(args: string[]) {
  const kept: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (!SELECTION_FLAGS.test(arg)) {
      kept.push(arg)
      continue
    }
    if (SELECTION_VALUE.test(arg) && args[index + 1] && !args[index + 1].startsWith('--')) {
      index++
    }
  }
  return kept
}

function agentFile(args: string[]) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg.startsWith('--agent-file=')) return arg.slice('--agent-file='.length)
    if (arg === '--agent-file') return args[index + 1]
  }
  return undefined
}

function parse(argv: string[]): { options: Options; command: string[] } {
  const separator = argv.indexOf('--')
  const head = separator < 0 ? argv : argv.slice(0, separator)
  const command = separator < 0 ? [] : argv.slice(separator + 1)
  const options: Options = { full: false, prepare: true, report: false, metrics: true }
  for (let index = 0; index < head.length; index++) {
    const arg = head[index]
    if (arg === '--full') options.full = true
    else if (arg === '--no-prepare') options.prepare = false
    else if (arg === '--report') options.report = true
    else if (arg === '--no-metrics') options.metrics = false
    else if (arg.startsWith('--cache-dir=')) options.cacheDir = arg.slice('--cache-dir='.length)
    else if (arg === '--cache-dir') options.cacheDir = head[++index]
    else if (arg.startsWith('--cwd=')) options.cwd = arg.slice('--cwd='.length)
    else if (arg === '--cwd') options.cwd = head[++index]
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length)
    else if (arg === '--out') options.out = head[++index]
    else if (arg.startsWith('--timeout=')) options.timeout = Number(arg.slice('--timeout='.length))
    else if (arg === '--timeout') options.timeout = Number(head[++index])
    else throw new Error(`Unknown japa-agent option: ${arg}`)
  }
  if (
    options.timeout !== undefined &&
    (!Number.isFinite(options.timeout) || options.timeout <= 0)
  ) {
    throw new Error('--timeout must be a positive number of milliseconds')
  }
  return { options, command }
}

function run(command: string, args: string[], cwd: string, timeout?: number) {
  return new Promise<number>((done, fail) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    })
    let timer: NodeJS.Timeout | undefined
    let escalation: NodeJS.Timeout | undefined
    const stopTimers = () => {
      if (timer) clearTimeout(timer)
      if (escalation) clearTimeout(escalation)
    }
    const signalTree = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        if (process.platform === 'win32') child.kill(signal)
        else process.kill(-child.pid, signal)
      } catch {
        // The process may have exited between the timeout and the signal.
      }
    }
    if (timeout) {
      timer = setTimeout(() => {
        signalTree('SIGTERM')
        escalation = setTimeout(() => signalTree('SIGKILL'), 1000)
      }, timeout)
    }
    child.once('error', (error) => {
      stopTimers()
      fail(error)
    })
    child.once('close', (code, signal) => {
      stopTimers()
      done(signal ? 130 : (code ?? 1))
    })
  })
}

/** Japa's cache directory, honouring --cache-dir in either the wrapper or the command. */
function cacheDirectory(cwd: string, args: string[], explicit?: string) {
  let dir = explicit
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg.startsWith('--cache-dir=')) dir = arg.slice('--cache-dir='.length)
    else if (arg === '--cache-dir') dir = args[++index]
  }
  return dir ? resolve(cwd, dir) : join(cwd, 'node_modules/.cache/japa')
}

async function hasCaches(directory: string) {
  const names = await readdir(directory).catch(() => [] as string[])
  return (
    names.some((name) => name.startsWith('index-')) &&
    names.some((name) => name.startsWith('dependencies-'))
  )
}

function metricsFile(directory: string) {
  return join(directory, 'agent-metrics.jsonl')
}

type Metric = {
  at: string
  exit: number
  totalMs: number
  prepareMs: number
  runMs: number
  selection?: AgentSummary['selection']
  phases?: { bootMs?: number; importMs?: number; testMs?: number }
  newFailures: number
  fixed: number
}

async function readMetrics(directory: string): Promise<Metric[]> {
  const text = await readFile(metricsFile(directory), 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Metric]
      } catch {
        return []
      }
    })
}

function summarize(metrics: Metric[]) {
  const runMs = metrics.map((metric) => metric.runMs).sort((a, b) => a - b)
  const median = runMs.length
    ? runMs.length % 2
      ? runMs[(runMs.length - 1) / 2]
      : Math.round((runMs[runMs.length / 2 - 1] + runMs[runMs.length / 2]) / 2)
    : 0
  const byMode: Record<string, number> = {}
  for (const metric of metrics) {
    const mode = metric.selection?.mode ?? 'unknown'
    byMode[mode] = (byMode[mode] ?? 0) + 1
  }
  return {
    runs: metrics.length,
    medianRunMs: median,
    totalRunMs: runMs.reduce((total, value) => total + value, 0),
    newFailures: metrics.reduce((total, metric) => total + metric.newFailures, 0),
    fixed: metrics.reduce((total, metric) => total + metric.fixed, 0),
    byMode,
    last: metrics.at(-1) ?? null,
  }
}

async function main() {
  const { options, command } = parse(process.argv.slice(2))
  if (options.report) {
    const cwd = await realpath(options.cwd ? resolve(options.cwd) : process.cwd())
    const directory = cacheDirectory(cwd, command, options.cacheDir)
    console.log(JSON.stringify(summarize(await readMetrics(directory)), null, 2))
    return 0
  }
  if (!command.length) {
    console.error(
      'Usage: japa-agent [--cwd=path] [--out=path] [--full] [--no-prepare] -- <test command...>'
    )
    return 1
  }

  const cwd = await realpath(options.cwd ? resolve(options.cwd) : process.cwd())
  const [executable, ...args] = command
  const startedAt = performance.now()
  let prepareMs = 0
  const directory = cacheDirectory(cwd, args, options.cacheDir)
  const cacheArgs =
    options.cacheDir && !args.some((arg) => arg === '--cache-dir' || arg.startsWith('--cache-dir='))
      ? [`--cache-dir=${options.cacheDir}`]
      : []
  const selectionGiven = args.some((arg) => SELECTION_FLAGS.test(arg))

  if (options.prepare && !(await hasCaches(directory))) {
    // Build both caches once. Selection flags are stripped so the index covers
    // every file rather than only the ones a filter would have imported.
    const prepareStarted = performance.now()
    const prepareArgs = [
      ...withoutSelectionFlags(args),
      ...cacheArgs,
      '--prepare-caches',
      '--force-exit',
    ]
    const prepared = await run(executable, prepareArgs, cwd, options.timeout)
    prepareMs = Math.round(performance.now() - prepareStarted)
    if (prepared !== 0) {
      console.error(`japa-agent: prepare failed with exit ${prepared}`)
      return prepared
    }
  }

  const explicitReport = agentFile(args)
  const reportPath = explicitReport
    ? resolve(cwd, explicitReport)
    : options.out
      ? resolve(cwd, options.out)
      : join(cwd, 'node_modules/.cache/japa/agent.jsonl')
  const previous = await readReport(reportPath)
  // A crash before the reporter starts must not turn the previous report into
  // this run's result.
  await writeFile(reportPath, '').catch(() => {})
  // --agent-file without --agent keeps the app's own reporters (result files,
  // guards) running. Pass --agent in the command to get JSON on stdout too.
  const runArgs = [...args, ...cacheArgs]
  if (!explicitReport) runArgs.push(`--agent-file=${reportPath}`)
  if (!options.full && !selectionGiven) runArgs.push('--changed=auto')

  const runStarted = performance.now()
  const exit = await run(executable, runArgs, cwd, options.timeout)
  const runMs = Math.round(performance.now() - runStarted)

  const current = await readReport(reportPath)
  const delta = diffReports(previous, current ?? { failures: [] })
  const deltaPath = `${reportPath}.delta.json`
  await writeFile(deltaPath, `${JSON.stringify(delta, null, 2)}\n`).catch(() => {})

  if (options.metrics) {
    const metric = {
      at: new Date().toISOString(),
      exit,
      totalMs: Math.round(performance.now() - startedAt),
      prepareMs,
      runMs,
      ...(current?.summary?.selection ? { selection: current.summary.selection } : {}),
      ...(current?.summary?.phases ? { phases: current.summary.phases } : {}),
      newFailures: delta.counts.new,
      fixed: delta.counts.fixed,
    }
    await mkdir(directory, { recursive: true }).catch(() => {})
    await appendFile(metricsFile(directory), `${JSON.stringify(metric)}\n`).catch(() => {})
  }

  process.stderr.write(
    `japa-agent: exit=${exit} new=${delta.counts.new} fixed=${delta.counts.fixed} ` +
      `run=${runMs}ms report=${reportPath} delta=${deltaPath}\n`
  )
  return exit
}

async function readReport(path: string): Promise<ParsedAgentReport | undefined> {
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  return parseAgentReport(text)
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
}
