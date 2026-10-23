/*
 * @japa/runner
 *
 * (c) Japa
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { availableParallelism } from 'node:os'
import { filesAffectedBy, gitChangedPaths, readDependencyMap } from './dependencies.js'
import { dependencyFile } from './cache_paths.js'
import debug from './debug.js'
import { getFailedTests, cacheFailedTests } from './plugins/retry_cache.js'
import { baselineFile, updateBaseline, type BaselineEntry } from './failure_baseline.js'
import { withCacheLock } from './cache_lock.js'
import {
  blendDuration,
  historyFile,
  parseHistory,
  readHistory,
  writeHistory,
  type DurationMap,
} from './duration_history.js'

export type ParallelOptions = {
  command: string
  args?: string[]
  cwd?: string
  workers?: number | 'auto'
  historyFile?: string
  env?: NodeJS.ProcessEnv
  workerEnv?: (worker: number, total: number) => NodeJS.ProcessEnv
  signal?: AbortSignal
  stdio?: 'inherit' | 'ignore'
  /** Merge worker failures and write the baseline from the coordinator. */
  updateBaseline?: boolean
}

export type ParallelResult = {
  exitCode: number
  historyUpdated: boolean
  baselineUpdated: boolean
  baselineChanges?: { added: number; removed: number }
  workers: { worker: number; exitCode: number; signal?: NodeJS.Signals; error?: string }[]
}

function optionValue(args: string[], name: string) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
    if (arg === name) return args[index + 1]
  }
  return undefined
}

/** Freeze one changed-file selection for every worker. */
async function changedFiles(cwd: string, args: string[]) {
  const changed = optionValue(args, '--changed')
  if (!changed) return undefined
  const paths =
    changed === 'auto'
      ? await gitChangedPaths(cwd)
      : changed
          .split(',')
          .map((path) => path.trim())
          .filter(Boolean)
  const map = await readDependencyMap(dependencyFile(cwd, optionValue(args, '--cache-dir')))
  return filesAffectedBy(map, paths)
}

function replaceAgentFile(args: string[], file: string) {
  const replaced: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg.startsWith('--agent-file=')) {
      replaced.push(`--agent-file=${file}`)
    } else if (arg === '--agent-file') {
      replaced.push(`--agent-file=${file}`)
      index++
    } else {
      replaced.push(arg)
    }
  }
  return replaced
}

function sumField(records: Record<string, unknown>[], key: string) {
  return records.reduce(
    (total, record) => total + (typeof record[key] === 'number' ? record[key] : 0),
    0
  )
}

async function mergeAgentReports(files: string[], target: string) {
  const lines: string[] = []
  const summaries: Record<string, unknown>[] = []
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => '')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line) as Record<string, unknown>
        if (record.event === 'summary') summaries.push(record)
        else lines.push(line)
      } catch {
        // Ignore a malformed worker line; the rest of the report is still useful.
      }
    }
  }
  if (!lines.length && !summaries.length) return

  let summary: Record<string, unknown> | undefined
  if (summaries.length) {
    const selections = summaries
      .map((item) => item.selection)
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    const signatures = selections
      .map((item) => item.signature)
      .filter((item) => typeof item === 'string')
    const phases = summaries
      .map((item) => item.phases)
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    const baselines = summaries
      .map((item) => item.baseline)
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    const errorGroups = new Map<string, number>()
    for (const item of summaries) {
      const groups = Array.isArray(item.errorGroups) ? item.errorGroups : []
      for (const group of groups) {
        if (!group || typeof group !== 'object') continue
        const typed = group as Record<string, unknown>
        if (typeof typed.message !== 'string' || typeof typed.count !== 'number') continue
        errorGroups.set(typed.message, (errorGroups.get(typed.message) ?? 0) + typed.count)
      }
    }
    summary = {
      event: 'summary',
      ...Object.fromEntries(
        ['total', 'passed', 'failed', 'skipped', 'todo', 'regression'].map((key) => [
          key,
          sumField(summaries, key),
        ])
      ),
      durationMs: sumField(summaries, 'durationMs'),
      ok: summaries.every((item) => item.ok === true),
      ...(selections.length
        ? {
            selection: {
              mode: selections.every((item) => item.mode === selections[0].mode)
                ? selections[0].mode
                : 'mixed',
              planned: sumField(selections, 'planned'),
              skipped: sumField(selections, 'skipped'),
              ...(signatures.length === selections.length
                ? {
                    signature: createHash('sha256')
                      .update([...signatures].sort().join('\n'))
                      .digest('hex')
                      .slice(0, 16),
                  }
                : {}),
              ...(selections.some((item) => item.fallback === true) ? { fallback: true } : {}),
            },
          }
        : {}),
      ...(phases.length
        ? {
            phases: {
              bootMs: Math.max(
                ...phases.map((item) => (typeof item.bootMs === 'number' ? item.bootMs : 0))
              ),
              importMs: sumField(phases, 'importMs'),
              testMs: sumField(phases, 'testMs'),
            },
          }
        : {}),
      ...(baselines.length
        ? {
            baseline: {
              known: sumField(baselines, 'known'),
              new: sumField(baselines, 'new'),
              fixed: sumField(baselines, 'fixed'),
            },
          }
        : {}),
      ...(summaries.every((item) => item.knownOnly === true) ? { knownOnly: true } : {}),
      ...(summaries.some((item) => item.nonTestErrors === true) ? { nonTestErrors: true } : {}),
      ...(errorGroups.size
        ? {
            errorGroups: [...errorGroups].map(([message, count]) => ({ message, count })),
          }
        : {}),
    }
  }

  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(
    target,
    `${[...lines, ...(summary ? [JSON.stringify(summary)] : [])].join('\n')}\n`
  )
}

/**
 * A narrow selection usually costs less than the extra application boots a pool
 * would pay. Title/file/tag/group/change/failed filters therefore run on one
 * worker unless the caller asked for a specific count.
 */
export function autoWorkerCount(args: string[]) {
  const narrow = args.some(
    (arg) =>
      arg.startsWith('--tests') ||
      arg.startsWith('--groups') ||
      arg.startsWith('--tags') ||
      arg.startsWith('--files') ||
      arg.startsWith('--failed') ||
      arg.startsWith('--changed')
  )
  return narrow ? 1 : Math.min(4, availableParallelism())
}

/** Launch shards against one frozen history snapshot and promote results together. */
export async function runParallel(options: ParallelOptions): Promise<ParallelResult> {
  const count =
    options.workers === 'auto'
      ? autoWorkerCount(options.args ?? [])
      : (options.workers ?? Math.min(4, availableParallelism()))
  if (!Number.isInteger(count) || count < 1 || count > 256)
    throw new Error('workers must be an integer between 1 and 256')
  if (!options.command) throw new Error('A test command is required')
  if (options.args?.some((arg) => arg === '--shard' || arg.startsWith('--shard='))) {
    throw new Error('The coordinator assigns --shard automatically; remove it from the command')
  }
  const cwd = await realpath(options.cwd ?? process.cwd())
  const file = historyFile(cwd, options.historyFile)
  const history = await readHistory(file, cwd)
  const failed = await getFailedTests(cwd).catch(() => ({}) as { tests?: string[] })
  const only = await changedFiles(cwd, options.args ?? [])
  const agentReport = optionValue(options.args ?? [], '--agent-file')
  if (agentReport) await writeFile(resolve(cwd, agentReport), '').catch(() => {})
  const runId = randomUUID()
  // Evaluate environment callbacks before spawning anything, so a configuration
  // error cannot leave a partially launched pool behind.
  const environments = Array.from(
    { length: count },
    (_, i) => options.workerEnv?.(i + 1, count) ?? {}
  )
  await mkdir(dirname(file), { recursive: true })
  const directory = await mkdtemp(join(dirname(file), 'run-'))
  const snapshot = join(directory, 'snapshot.json')
  const children: ChildProcess[] = []
  let aborted = false
  let escalation: Promise<void> | undefined
  const kill = (child: ChildProcess, signal: NodeJS.Signals) => {
    if (!child.pid) return
    try {
      if (process.platform === 'win32') child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch (error) {
      debug('unable to signal worker: %O', error)
    }
  }
  const abort = () => {
    if (aborted) return
    aborted = true
    for (const child of children) kill(child, 'SIGTERM')
    if (!children.length) return
    escalation = new Promise((done) =>
      setTimeout(() => {
        for (const child of children) kill(child, 'SIGKILL')
        done()
      }, 1000)
    )
  }

  try {
    await writeHistory(snapshot, { ...history, runId, failedTests: failed.tests ?? [] })
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    const workers = await Promise.all(
      Array.from(
        { length: count },
        (
          _,
          index
        ): ParallelResult['workers'][number] | Promise<ParallelResult['workers'][number]> => {
          const worker = index + 1
          if (aborted)
            return {
              worker,
              exitCode: 130,
              error: 'Cancelled',
            } satisfies ParallelResult['workers'][number]
          return new Promise<ParallelResult['workers'][number]>((done) => {
            let child: ChildProcess
            try {
              const agentFile = agentReport ? join(directory, `agent-${worker}.jsonl`) : undefined
              child = spawn(
                options.command,
                [
                  ...(agentFile
                    ? replaceAgentFile(options.args ?? [], agentFile)
                    : (options.args ?? [])),
                  `--shard=${worker}/${count}`,
                ],
                {
                  cwd,
                  detached: process.platform !== 'win32',
                  stdio: options.stdio ?? 'inherit',
                  env: {
                    ...process.env,
                    ...options.env,
                    ...environments[index],
                    JAPA_WORKER_ID: String(worker),
                    JAPA_WORKER_COUNT: String(count),
                    JAPA_SPEED_RUN_ID: runId,
                    JAPA_SPEED_SNAPSHOT: snapshot,
                    JAPA_SPEED_OUTPUT: join(directory, `${worker}.json`),
                    ...(only ? { JAPA_SPEED_ONLY: JSON.stringify(only) } : {}),
                    ...(options.updateBaseline ? { JAPA_SPEED_COLLECT_FAILURES: '1' } : {}),
                  },
                }
              )
              children.push(child)
            } catch (error) {
              done({ worker, exitCode: 1, error: String(error) })
              return
            }
            child.once('error', (error) => done({ worker, exitCode: 1, error: error.message }))
            child.once('close', (code, signal) =>
              done({ worker, exitCode: code ?? 1, ...(signal ? { signal } : {}) })
            )
          })
        }
      )
    )
    if (escalation) await escalation
    if (agentReport) {
      await mergeAgentReports(
        Array.from({ length: count }, (_, index) => join(directory, `agent-${index + 1}.jsonl`)),
        resolve(cwd, agentReport)
      ).catch((error) => debug('unable to merge agent reports: %O', error))
    }
    let exitCode = aborted ? 130 : (workers.find((worker) => worker.exitCode !== 0)?.exitCode ?? 0)
    let historyUpdated = false
    let baselineUpdated = false
    let baselineChanges: { added: number; removed: number } | undefined
    const baselineFailures: BaselineEntry[] = []
    const estimates: DurationMap = Object.create(null)
    let complete = true
    let fullRun = true
    let validReports = true
    const failures = new Set<string>()
    if (!aborted) {
      for (const worker of workers) {
        try {
          const raw: unknown = JSON.parse(
            await readFile(join(directory, `${worker.worker}.json`), 'utf8')
          )
          const result = parseHistory(raw, cwd)
          if (
            !raw ||
            typeof raw !== 'object' ||
            !('worker' in raw) ||
            raw.worker !== worker.worker ||
            !('total' in raw) ||
            raw.total !== count ||
            !('complete' in raw) ||
            typeof raw.complete !== 'boolean' ||
            result.runId !== runId
          )
            throw new Error('Invalid coordinated worker result')
          if (!result.failedTests) throw new Error('Missing failed-test worker report')
          for (const title of result.failedTests) failures.add(title)
          if (result.failures) baselineFailures.push(...result.failures)
          complete &&= raw.complete
          fullRun &&= result.fullRun === true
          for (const [key, duration] of Object.entries(result.durations)) {
            if (Object.hasOwn(estimates, key))
              throw new Error(`Workers reported the same file: ${key}`)
            estimates[key] = duration
          }
        } catch (error) {
          validReports = false
          worker.exitCode = 1
          worker.error = `Unable to collect worker timings; use this runner fork and a test execution command: ${String(error)}`
          exitCode = 1
        }
      }
      if (validReports && !aborted) {
        await cacheFailedTests([...failures], cwd).catch((error) =>
          debug('unable to update failed-test cache: %O', error)
        )
      }
      // Test failures exit nonzero but still report complete file costs; a
      // signal or missing report does not.
      const finished = workers.every((worker) => !worker.signal && !worker.error)
      if (validReports && finished && complete && !aborted) {
        try {
          await withCacheLock(file, async () => {
            const latest = await readHistory(file, cwd)
            const merged: DurationMap = { ...latest.durations }
            for (const [key, measured] of Object.entries(estimates)) {
              merged[key] = blendDuration(merged[key], measured)
            }
            await writeHistory(file, {
              version: 1,
              cwd,
              durations: merged,
            })
          })
          historyUpdated = true
        } catch {
          // The test result remains authoritative when a best-effort cache fails.
          historyUpdated = false
        }
      }

      // Same gate as timings: a cancelled, partial or unreported run must not
      // replace a committed baseline with a slice of the suite.
      if (options.updateBaseline && validReports && finished && complete && fullRun && !aborted) {
        try {
          const update = await updateBaseline(baselineFile(cwd), baselineFailures)
          baselineChanges = {
            added: update.added.length,
            removed: update.removed.length,
          }
          baselineUpdated = true
        } catch (error) {
          debug('unable to write the failure baseline: %O', error)
        }
      }
    }
    if (escalation) await escalation
    return {
      exitCode: aborted ? 130 : exitCode,
      historyUpdated,
      baselineUpdated,
      ...(baselineChanges ? { baselineChanges } : {}),
      workers,
    }
  } finally {
    options.signal?.removeEventListener('abort', abort)
    await rm(directory, { recursive: true, force: true })
  }
}
