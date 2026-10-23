/*
 * @japa/runner
 *
 * (c) Japa
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import debug from './debug.js'
import type { PluginFn } from './types.js'
import type { BaselineEntry } from './failure_baseline.js'
import { withCacheLock } from './cache_lock.js'

const REGISTERED = new WeakSet<object>()

/**
 * How a freshly measured file cost is combined with the previous estimate.
 *
 * A single contended run (another worker hammering the database) can inflate a
 * file's cost by seconds and poison the next assignment. A plain move toward
 * the new value dampens that: cheap when the estimate was far off, cautious when
 * it already matched.
 */
export const HISTORY_ALPHA = 0.5

export type DurationMap = Record<string, number>
export type History = {
  version: 1
  cwd: string
  durations: DurationMap
  runId?: string
  failedTests?: string[]
  /** Managed worker ran the whole suite, not a selection. */
  fullRun?: boolean
  /** Only written by managed workers when the coordinator collects a baseline. */
  failures?: BaselineEntry[]
}
export type WorkerHistory = History & {
  worker: number
  total: number
  complete: boolean
  /** Present when the coordinator asked for baseline collection. */
  failures?: BaselineEntry[]
}

export function historyFile(cwd: string, file?: string) {
  if (file) return resolve(cwd, file)
  const id = createHash('sha256').update(cwd).digest('hex').slice(0, 16)
  return join(cwd, 'node_modules', '.cache', 'japa', `durations-${id}.json`)
}

/** Smoothed estimate: keep most of a known cost, fully adopt an unknown one. */
export function blendDuration(previous: number | undefined, measured: number) {
  if (previous === undefined || !Number.isFinite(previous)) return measured
  return Math.round((previous + HISTORY_ALPHA * (measured - previous)) * 1000) / 1000
}

export function parseHistory(value: unknown, cwd: string): History {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('cwd' in value) ||
    value.cwd !== cwd ||
    !('durations' in value) ||
    !value.durations ||
    typeof value.durations !== 'object' ||
    Array.isArray(value.durations)
  ) {
    throw new Error('Invalid duration history or application directory')
  }
  const durations: DurationMap = Object.create(null)
  for (const [file, duration] of Object.entries(value.durations)) {
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
      throw new Error(`Invalid duration history entry: ${file}`)
    }
    durations[file] = duration
  }
  let failures: BaselineEntry[] | undefined
  if ('failures' in value && Array.isArray(value.failures)) {
    failures = value.failures.filter((entry): entry is BaselineEntry =>
      Boolean(
        entry &&
        typeof entry === 'object' &&
        typeof entry.suite === 'string' &&
        typeof entry.file === 'string' &&
        typeof entry.title === 'string'
      )
    )
  }
  let fullRun: boolean | undefined
  if ('fullRun' in value) {
    if (typeof value.fullRun !== 'boolean') throw new Error('Invalid full-run history')
    fullRun = value.fullRun
  }
  let failedTests: string[] | undefined
  if ('failedTests' in value) {
    if (
      !Array.isArray(value.failedTests) ||
      !value.failedTests.every((title) => typeof title === 'string')
    )
      throw new Error('Invalid failed-test history')
    failedTests = value.failedTests
  }
  return {
    version: 1,
    cwd,
    durations,
    ...(failedTests ? { failedTests } : {}),
    ...(fullRun !== undefined ? { fullRun } : {}),
    ...(failures ? { failures } : {}),
    ...('runId' in value && typeof value.runId === 'string' ? { runId: value.runId } : {}),
  }
}

export async function readHistory(file: string, cwd: string, strict = false): Promise<History> {
  try {
    return parseHistory(JSON.parse(await readFile(file, 'utf8')), cwd)
  } catch (error) {
    if (strict) throw error
    debug('ignoring unavailable duration history %s: %O', file, error)
    return { version: 1, cwd, durations: Object.create(null) }
  }
}

export async function writeHistory(file: string, data: History | WorkerHistory) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

/**
 * Learn file costs on complete runs and load them before planning. Files with a
 * failing test keep their previous estimate, so an always-red suite still trains.
 */
export function durationHistory(options: { file?: string } = {}): PluginFn {
  return async ({ config, cliArgs, runner, emitter }) => {
    if (cliArgs.listPinned || REGISTERED.has(runner)) return
    const cwd = await realpath(config.cwd)
    const snapshot = process.env.JAPA_SPEED_SNAPSHOT
    const runId = process.env.JAPA_SPEED_RUN_ID
    const output = process.env.JAPA_SPEED_OUTPUT
    const managed = Boolean(snapshot || runId || output)
    let history: History
    if (managed) {
      if (!snapshot || !runId || !output)
        throw new Error('Incomplete Japa parallel worker environment')
      history = await readHistory(snapshot, cwd, true)
      const shard = config.filters.shard
      if (
        history.runId !== runId ||
        !shard ||
        shard.current !== Number(process.env.JAPA_WORKER_ID) ||
        shard.total !== Number(process.env.JAPA_WORKER_COUNT)
      ) {
        throw new Error('Parallel worker must use its supplied snapshot and --shard flag')
      }
      // The coordinator owns this immutable map. Per-worker overrides could
      // otherwise disagree about which worker should import a file.
      Object.defineProperty(config, 'shardDurations', {
        value: Object.freeze(history.durations),
        writable: false,
        configurable: false,
        enumerable: true,
      })
      Object.defineProperty(config.filters, 'shard', {
        value: Object.freeze(shard),
        writable: false,
        configurable: false,
        enumerable: true,
      })
    } else {
      // Independently launched shards cannot safely agree on a mutable cache.
      // Preserve explicit caller-supplied estimates and the upstream fallback.
      if (config.filters.shard) return
      history = await readHistory(historyFile(cwd, options.file), cwd)
      config.shardDurations = { ...history.durations, ...config.shardDurations }
    }

    REGISTERED.add(runner)
    const durations: DurationMap = Object.create(null)
    const failedFiles = new Set<string>()
    const failures: BaselineEntry[] = []
    const collectFailures = process.env.JAPA_SPEED_COLLECT_FAILURES === '1'
    let suite = 'default'
    let pinned = false
    // A failed suite/group hook can skip tests, leaving file costs incomplete.
    let hookFailed = false
    const offSuite = emitter.on('suite:start', (payload) => {
      suite = payload.name
    })
    const offSuiteEnd = emitter.on('suite:end', (payload) => {
      if (payload.errors.length) hookFailed = true
    })
    const offGroupEnd = emitter.on('group:end', (payload) => {
      if (payload.errors.length) hookFailed = true
    })
    const offTest = emitter.on('test:end', (payload) => {
      if (payload.isPinned) pinned = true
      const file = payload.meta.fileName
      if (typeof file !== 'string') return
      const path = relative(cwd, file).split('\\').join('/')
      const key = `${suite}:${path}`
      durations[key] = (durations[key] ?? 0) + payload.duration
      if (payload.hasError) {
        failedFiles.add(key)
        if (collectFailures) {
          failures.push({ suite, file: path, title: payload.title.expanded })
        }
      }
    })
    const offEnd = emitter.on('runner:end', async () => {
      offSuite()
      offSuiteEnd()
      offGroupEnd()
      offTest()
      offEnd()
      const partial =
        pinned ||
        (['tests', 'groups', 'tags'] as const).some((filter) => config.filters[filter]?.length)
      const fullRun =
        !partial &&
        !hookFailed &&
        !cliArgs.listPinned &&
        !cliArgs.failed &&
        !cliArgs.changed &&
        !cliArgs.bail &&
        !config.filters.files?.length &&
        !config.filters.suites?.length
      const complete = !partial && !hookFailed
      for (const key of failedFiles) delete durations[key]
      if (managed) {
        try {
          await writeHistory(output!, {
            version: 1,
            cwd,
            runId,
            worker: Number(process.env.JAPA_WORKER_ID),
            total: Number(process.env.JAPA_WORKER_COUNT),
            complete,
            fullRun,
            failedTests: runner.getSummary().failedTestsTitles,
            ...(collectFailures ? { failures } : {}),
            durations: complete ? durations : {},
          })
        } catch (error) {
          // A result that cannot be written is a lost timing sample, not a test failure.
          debug('unable to write worker timings: %O', error)
        }
      } else if (complete) {
        try {
          const file = historyFile(cwd, options.file)
          await withCacheLock(file, async () => {
            const latest = await readHistory(file, cwd)
            const merged: DurationMap = { ...latest.durations }
            for (const [key, measured] of Object.entries(durations)) {
              merged[key] = blendDuration(merged[key], measured)
            }
            await writeHistory(file, {
              version: 1,
              cwd,
              durations: merged,
            })
          })
        } catch (error) {
          // A performance cache must not turn a passing serial run into a failure.
          debug('unable to update duration history: %O', error)
        }
      }
    })
  }
}
