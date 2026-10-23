/*
 * @japa/runner
 *
 * (c) Japa
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { withCacheLock } from './cache_lock.js'
import { dirname, relative, resolve } from 'node:path'
import debug from './debug.js'

/**
 * A known-failing test, keyed by suite, file and expanded title. The key is
 * stable across runs and across worker assignment, so a baseline committed to a
 * repository still matches after the suite is sharded.
 */
export type BaselineEntry = {
  suite: string
  file: string
  title: string
  /** Consecutive full runs in which this failure appeared. */
  consecutive?: number
  /** Last time the entry was observed failing. */
  updatedAt?: string
}

export type Baseline = {
  version: 1
  failures: BaselineEntry[]
}

export function baselineFile(cwd: string, file?: string) {
  return resolve(cwd, file ?? 'japa.baseline.json')
}

function keyOf(entry: BaselineEntry) {
  return `${entry.suite}\u0000${entry.file}\u0000${entry.title}`
}

export function parseBaseline(value: unknown): Baseline {
  if (!value || typeof value !== 'object' || (value as Baseline).version !== 1) {
    return { version: 1, failures: [] }
  }
  const failures = (value as Baseline).failures
  if (!Array.isArray(failures)) return { version: 1, failures: [] }
  return {
    version: 1,
    failures: failures.filter((entry): entry is BaselineEntry =>
      Boolean(
        entry &&
        typeof entry === 'object' &&
        typeof entry.suite === 'string' &&
        typeof entry.file === 'string' &&
        typeof entry.title === 'string'
      )
    ),
  }
}

export async function readBaseline(file: string): Promise<Baseline> {
  try {
    return parseBaseline(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    debug('ignoring unavailable failure baseline %s: %O', file, error)
    return { version: 1, failures: [] }
  }
}

export async function writeBaseline(file: string, baseline: Baseline) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  const failures = [...baseline.failures].sort((a, b) => keyOf(a).localeCompare(keyOf(b)) || 0)
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, failures }, null, 2)}\n`)
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

/**
 * Collect this run's failing tests in baseline form. Attach before the run
 * starts; the returned function detaches the listener.
 */
export function collectFailures(
  emitter: { on(event: 'test:end', handler: (payload: any) => void): () => void },
  cwd: string
) {
  const failures: BaselineEntry[] = []
  const stop = emitter.on('test:end', (payload) => {
    if (!payload.hasError) return
    const file = payload.meta?.fileName
    if (typeof file !== 'string') return
    failures.push({
      suite: String(payload.meta?.suite?.name ?? 'default'),
      file: relative(cwd, file).split('\\').join('/'),
      title: payload.title.expanded,
    })
  })
  return { failures, stop }
}

/**
 * Merge this run's failures into the previous baseline.
 *
 * Entries that fail again gain a consecutive count; entries that passed stay in
 * the file with `consecutive: 0` so a later run can still recognise them and so
 * the UI can report them as passing. `added` and `removed` describe the
 * disagreement in both directions, which is the signal that a run may be noisy.
 */
export function mergeBaseline(
  previous: Baseline,
  observed: BaselineEntry[],
  now = new Date().toISOString()
): { baseline: Baseline; added: BaselineEntry[]; removed: BaselineEntry[] } {
  const existing = new Map(previous.failures.map((entry) => [keyOf(entry), entry]))
  const seen = new Set<string>()
  const failures: BaselineEntry[] = []
  const added: BaselineEntry[] = []

  for (const entry of observed) {
    const key = keyOf(entry)
    seen.add(key)
    const old = existing.get(key)
    const merged: BaselineEntry = {
      suite: entry.suite,
      file: entry.file,
      title: entry.title,
      consecutive: (old?.consecutive ?? 0) + 1,
      updatedAt: now,
    }
    if (!old) added.push(merged)
    failures.push(merged)
  }

  const removed = previous.failures.filter((entry) => !seen.has(keyOf(entry)))
  for (const entry of removed) {
    failures.push({ ...entry, consecutive: 0 })
  }

  return { baseline: { version: 1, failures }, added, removed }
}

/** Read, merge and write a baseline under an exclusive lock. */
export async function updateBaseline(file: string, observed: BaselineEntry[]) {
  return withCacheLock(file, async () => {
    const previous = await readBaseline(file)
    const result = mergeBaseline(previous, observed)
    await writeBaseline(file, result.baseline)
    return result
  })
}

/**
 * Separate tests this run failed from failures the baseline already knows.
 *
 * `new` is what a caller acts on; `known` and `fixed` are informational. A test
 * missing from this run is never reported as fixed, because partial selections
 * and shards only ever see a slice of the suite.
 */
export function diffFailures(
  baseline: Baseline,
  failures: BaselineEntry[]
): { new: BaselineEntry[]; known: BaselineEntry[]; fixed: BaselineEntry[] } {
  const expected = new Set(baseline.failures.map(keyOf))
  const seen = new Set(failures.map(keyOf))
  const fresh: BaselineEntry[] = []
  const known: BaselineEntry[] = []
  for (const failure of failures) {
    ;(expected.has(keyOf(failure)) ? known : fresh).push(failure)
  }
  const fixed = baseline.failures.filter((entry) => !seen.has(keyOf(entry)))
  return { new: fresh, known, fixed }
}
