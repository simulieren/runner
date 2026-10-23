/*
 * @japa/runner
 *
 * (c) Japa
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import debug from './debug.js'
import { withCacheLock } from './cache_lock.js'
import { setSelectionPlan } from './planning_state.js'
import { indexFile } from './cache_paths.js'
import type { PluginFn } from './types.js'

/**
 * What the index remembers about one test file. `mtimeMs` and `size` invalidate
 * an entry cheaply. A rewrite that preserves both can still slip through, which
 * is why an indexed file is only skipped when it is provably unable to match.
 */
export type IndexedFile = {
  mtimeMs: number
  size: number
  tests: string[]
  groups: string[]
  tags: string[]
  /**
   * The file builds titles at run time (datasets). Its registered titles are not
   * the titles that will run, so a title filter must never skip it.
   */
  dynamic?: boolean
}

export type SelectionIndex = {
  version: 1
  files: Record<string, IndexedFile>
}

export function emptyIndex(): SelectionIndex {
  return { version: 1, files: Object.create(null) }
}

export async function readIndex(file: string): Promise<SelectionIndex> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as SelectionIndex).version !== 1 ||
      typeof (parsed as SelectionIndex).files !== 'object'
    ) {
      return emptyIndex()
    }
    return parsed as SelectionIndex
  } catch (error) {
    debug('ignoring unavailable selection index %s: %O', file, error)
    return emptyIndex()
  }
}

export async function writeIndex(file: string, index: SelectionIndex) {
  const next = `${JSON.stringify(index)}\n`
  const previous = await readFile(file, 'utf8').catch(() => undefined)
  if (previous === next) return

  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  try {
    await writeFile(temporary, next)
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

function normalizeTitle(title: string) {
  return title.toLowerCase()
}

function matchesFilter(needle: string, haystack: string[]) {
  const lower = normalizeTitle(needle)
  return haystack.some((value) => normalizeTitle(value).includes(lower))
}

/**
 * Decide whether an indexed file can be skipped for the active filters.
 *
 * The answer is deliberately conservative: a file is only dropped when the
 * index proves no test inside it can match. Any doubt (unknown file, changed
 * file, negated tags) keeps the file.
 */
export function shouldSkipFile(
  entry: IndexedFile,
  filters: { tests?: string[]; groups?: string[]; tags?: string[] }
): boolean {
  const has = (values?: string[]) => Boolean(values && values.length)

  if (has(filters.tests)) {
    // Registered titles cannot represent dataset rows, so keep such files.
    if (entry.dynamic) return false
    const matched = filters.tests!.some(
      (needle) => matchesFilter(needle, entry.tests) || matchesFilter(needle, entry.groups)
    )
    if (!matched) return true
  }
  if (
    has(filters.groups) &&
    !filters.groups!.some((needle) => matchesFilter(needle, entry.groups))
  ) {
    return true
  }
  if (has(filters.tags)) {
    // Negated tags (`!slow`, `~slow`) cannot be proved from the union of tags in
    // a file, so only positive tags may drop a file.
    const positive = filters.tags!.filter((tag) => !tag.startsWith('!') && !tag.startsWith('~'))
    if (positive.length && !positive.some((needle) => matchesFilter(needle, entry.tags))) {
      return true
    }
  }
  return false
}

/** True when the on-disk file still matches what the index recorded. */
export async function isFresh(cwd: string, path: string, entry: IndexedFile) {
  const stats = await stat(join(cwd, path)).catch(() => null)
  return Boolean(stats && stats.size === entry.size && stats.mtimeMs === entry.mtimeMs)
}

/**
 * Drop files that cannot contain a matching test, before they are imported.
 *
 * Title, group and tag filters are otherwise applied after import, so selecting
 * one test by name still imports every file in the suite. The index is optional
 * and best-effort: a stale, missing or unreadable index keeps every file.
 */
export function selectionIndex(options: { file?: string; dir?: string } = {}): PluginFn {
  return async ({ config, cliArgs }) => {
    if (cliArgs.listPinned) return
    const filters = {
      tests: config.filters.tests?.length ? config.filters.tests : undefined,
      groups: config.filters.groups?.length ? config.filters.groups : undefined,
      tags: config.filters.tags?.length ? config.filters.tags : undefined,
    }
    if (!filters.tests && !filters.groups && !filters.tags) return

    const cwd = await realpath(config.cwd)
    const index = await readIndex(
      options.file ? resolve(cwd, options.file) : indexFile(cwd, options.dir)
    )
    const paths = Object.keys(index.files)
    if (!paths.length) return

    const keep: string[] = []
    for (const path of paths) {
      const entry = index.files[path]
      if (!(await isFresh(cwd, path, entry))) continue
      keep.push(path)
    }
    if (!keep.length) return

    // The planner prunes with this before importing. Files without a fresh
    // entry are neither listed as seen nor skipped, so they are always imported.
    const skip = keep.filter((path) => shouldSkipFile(index.files[path], filters))
    setSelectionPlan(config, {
      skipWithin: Object.freeze(keep),
      skip: Object.freeze(skip),
    })
  }
}

type RegisteredTest = {
  options?: {
    title?: string
    tags?: string[]
    meta?: { fileName?: string; group?: { title?: string } }
  }
}

type RegisteredGroup = { title?: string; tests?: RegisteredTest[] }

/**
 * Datasets expand one registration into many titles at execution time. Array
 * datasets are visible on the registered test; function datasets are not, so the
 * file's source is checked conservatively. Keeping the file costs an import;
 * dropping it would silently skip tests.
 */
async function hasRuntimeTitles(path: string, entry: IndexedFile) {
  if (entry.tests.length) {
    const source = await readFile(path, 'utf8').catch(() => '')
    if (/\.with\s*\(/.test(source)) return true
  }
  return false
}

/**
 * Record every registered test per file. Importing registers all tests whatever
 * the filter is, so a filtered run still writes complete entries for the files it
 * imported; skipped files keep their previous entries.
 */
async function collectIndex(
  runner: { suites: Array<{ name: string; stack: Array<unknown> }> },
  cwd: string,
  index: SelectionIndex
) {
  const seen = new Map<string, IndexedFile>()

  const record = (test: RegisteredTest, groupTitle?: string) => {
    const file = test.options?.meta?.fileName
    const title = test.options?.title
    if (typeof file !== 'string' || typeof title !== 'string') return
    const path = relative(cwd, file).split('\\').join('/')
    const entry = seen.get(path) ?? { mtimeMs: 0, size: 0, tests: [], groups: [], tags: [] }
    entry.tests.push(title)
    const group = groupTitle ?? test.options?.meta?.group?.title
    if (typeof group === 'string') entry.groups.push(group)
    for (const tag of test.options?.tags ?? []) entry.tags.push(tag)
    seen.set(path, entry)
  }

  for (const suite of runner.suites) {
    for (const item of suite.stack) {
      const group = item as RegisteredGroup
      if (Array.isArray(group.tests)) {
        for (const test of group.tests) record(test, group.title)
      } else {
        record(item as RegisteredTest)
      }
    }
  }

  for (const [path, entry] of seen) {
    const stats = await stat(join(cwd, path)).catch(() => null)
    if (!stats) continue
    const previous = index.files[path]
    const unchanged = previous && previous.mtimeMs === stats.mtimeMs && previous.size === stats.size
    const dynamic =
      unchanged && previous.dynamic !== undefined
        ? previous.dynamic
        : await hasRuntimeTitles(join(cwd, path), entry)
    index.files[path] = {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      tests: [...new Set(entry.tests)],
      groups: [...new Set(entry.groups)],
      tags: [...new Set(entry.tags)],
      ...(dynamic ? { dynamic: true } : {}),
    }
  }
  return seen.size
}

/**
 * Write the index from what was imported. Called after the import phase, whether
 * or not tests will run, so `--prepare` can build it without executing anything.
 */
export async function writeSelectionIndex(
  runner: { suites: Array<{ name: string; stack: Array<unknown> }> },
  cwd: string,
  options: { file?: string; dir?: string } = {}
) {
  const target = options.file ? resolve(cwd, options.file) : indexFile(cwd, options.dir)
  return withCacheLock(target, async () => {
    const index = await readIndex(target)
    const count = await collectIndex(runner, cwd, index)
    if (count) await writeIndex(target, index)
    return count
  })
}
