/*
 * @japa/runner
 *
 * (c) Japa
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { availableParallelism } from 'node:os'
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
  /**
   * Milliseconds between launching one worker and the next. Zero launches the
   * whole pool at once; a small stagger stops every process from compiling and
   * resolving its module graph at the same instant.
   */
  startStaggerMs?: number
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

/**
 * A narrow selection usually costs less than the extra application boots a pool
 * would pay. Title/tag/group/change filters therefore run on one worker unless
 * the caller asked for a specific count.
 */
export function autoWorkerCount(args: string[]) {
  const narrow = args.some(
    (arg) =>
      arg.startsWith('--tests') ||
      arg.startsWith('--groups') ||
      arg.startsWith('--tags') ||
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
  if (options.updateBaseline) process.env.JAPA_SPEED_COLLECT_FAILURES = '1'
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
    const stagger = Math.max(
      0,
      options.startStaggerMs ?? Number(process.env.JAPA_START_STAGGER_MS ?? 0)
    )
    const workers = await Promise.all(
      Array.from({ length: count }, async (_, index) => {
        const worker = index + 1
        if (stagger && !aborted) {
          await new Promise((done) => setTimeout(done, stagger * index))
        }
        if (aborted)
          return {
            worker,
            exitCode: 130,
            error: 'Cancelled',
          } satisfies ParallelResult['workers'][number]
        if (aborted)
          return Promise.resolve<ParallelResult['workers'][number]>({
            worker,
            exitCode: 130,
            error: 'Cancelled',
          })
        return new Promise<ParallelResult['workers'][number]>((done) => {
          let child: ChildProcess
          try {
            child = spawn(
              options.command,
              [...(options.args ?? []), `--shard=${worker}/${count}`],
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
      })
    )
    if (escalation) await escalation
    let exitCode = aborted ? 130 : (workers.find((worker) => worker.exitCode !== 0)?.exitCode ?? 0)
    let historyUpdated = false
    let baselineUpdated = false
    let baselineChanges: { added: number; removed: number } | undefined
    const baselineFailures: BaselineEntry[] = []
    const estimates: DurationMap = Object.create(null)
    let complete = true
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
      if (options.updateBaseline && validReports && finished && complete && !aborted) {
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
