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

const REGISTERED = new WeakSet<object>()

export type DurationMap = Record<string, number>
export type History = {
  version: 1
  cwd: string
  durations: DurationMap
  runId?: string
  failedTests?: string[]
}
export type WorkerHistory = History & { worker: number; total: number; complete: boolean }

export function historyFile(cwd: string, file?: string) {
  if (file) return resolve(cwd, file)
  const id = createHash('sha256').update(cwd).digest('hex').slice(0, 16)
  return join(cwd, 'node_modules', '.cache', 'japa', `durations-${id}.json`)
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

/** Learn file costs on complete runs and load them before planning. */
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
    let suite = 'default'
    let pinned = false
    const offSuite = emitter.on('suite:start', (payload) => {
      suite = payload.name
    })
    const offTest = emitter.on('test:end', (payload) => {
      if (payload.isPinned) pinned = true
      const file = payload.meta.fileName
      if (typeof file !== 'string') return
      const path = relative(cwd, file).split('\\').join('/')
      const key = `${suite}:${path}`
      durations[key] = (durations[key] ?? 0) + payload.duration
    })
    const offEnd = emitter.on('runner:end', async (payload) => {
      offSuite()
      offTest()
      offEnd()
      const partial =
        pinned ||
        (['tests', 'groups', 'tags'] as const).some((filter) => config.filters[filter]?.length)
      const complete = !partial && !payload.hasError
      if (managed) {
        await writeHistory(output!, {
          version: 1,
          cwd,
          runId,
          worker: Number(process.env.JAPA_WORKER_ID),
          total: Number(process.env.JAPA_WORKER_COUNT),
          complete,
          failedTests: runner.getSummary().failedTestsTitles,
          durations: complete ? durations : {},
        })
      } else if (complete) {
        try {
          const file = historyFile(cwd, options.file)
          const latest = await readHistory(file, cwd)
          await writeHistory(file, {
            version: 1,
            cwd,
            durations: { ...latest.durations, ...durations },
          })
        } catch (error) {
          // A performance cache must not turn a passing serial run into a failure.
          debug('unable to update duration history: %O', error)
        }
      }
    })
  }
}
