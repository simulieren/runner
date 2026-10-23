/*
 * @japa/runner
 *
 * (c) Japa
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import debug from './debug.js'
import type { PluginFn } from './types.js'

/**
 * Files each test file depends on, captured while it imports. Built by
 * `recordDependencies`, consumed by `changedSelection`.
 */
export type DependencyMap = {
  version: 1
  /** Test file (relative) -> source files it imported (relative). */
  files: Record<string, string[]>
}

/** Set while a run is recording; `--prepare` flushes without waiting for the end. */
let activeWriter: (() => Promise<void>) | undefined

export async function flushDependencies() {
  await activeWriter?.()
}

/** Files that cannot be a test dependency worth rerunning for. */
function isBuildNoise(path: string) {
  const segments = path.split('/')
  if (
    segments.some((part) => ['node_modules', '.git', 'coverage', 'dist', 'build'].includes(part))
  ) {
    return true
  }
  return /\.(log|map)$/.test(path)
}

/**
 * Resolve the changed paths for `--changed=auto`: tracked changes against HEAD
 * plus untracked files. Returns an empty list when git cannot answer, which the
 * caller treats as "run everything".
 */
export async function gitChangedPaths(cwd: string): Promise<string[]> {
  const run = promisify(execFile)
  try {
    const [modified, untracked] = await Promise.all([
      run('git', ['diff', '--name-only', 'HEAD'], { cwd, timeout: 5000 }),
      run('git', ['ls-files', '--others', '--exclude-standard'], { cwd, timeout: 5000 }),
    ])
    const lines = `${modified.stdout}\n${untracked.stdout}`
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !isBuildNoise(line))
    return [...new Set(lines)]
  } catch (error) {
    debug('unable to read changed paths from git: %O', error)
    return []
  }
}

export function dependencyFile(cwd: string, file?: string) {
  // CLI flags default to an empty string, which must not resolve to the cwd.
  if (file) return resolve(cwd, file)
  const id = createHash('sha256').update(cwd).digest('hex').slice(0, 16)
  return resolve(cwd, 'node_modules', '.cache', 'japa', `dependencies-${id}.json`)
}

export function parseDependencyMap(value: unknown): DependencyMap {
  if (!value || typeof value !== 'object' || (value as DependencyMap).version !== 1) {
    return { version: 1, files: Object.create(null) }
  }
  const files = (value as DependencyMap).files
  if (!files || typeof files !== 'object') return { version: 1, files: Object.create(null) }
  return { version: 1, files }
}

export async function readDependencyMap(file: string): Promise<DependencyMap> {
  try {
    return parseDependencyMap(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    debug('ignoring unavailable dependency map %s: %O', file, error)
    return { version: 1, files: Object.create(null) }
  }
}

/**
 * Pick the test files affected by a set of changed paths.
 *
 * Returns `undefined` when the answer cannot be trusted — no map, or a changed
 * path that no test file is known to import. The caller then runs everything,
 * because running too much is safe and running too little is not.
 */
export function filesAffectedBy(map: DependencyMap, changed: string[]): string[] | undefined {
  const wanted = new Set(changed.map((path) => path.split('\\').join('/')))
  if (!wanted.size || !Object.keys(map.files).length) return undefined

  const matches = new Set<string>()
  for (const [testFile, dependencies] of Object.entries(map.files)) {
    if (wanted.has(testFile) || dependencies.some((dependency) => wanted.has(dependency))) {
      matches.add(testFile)
    }
  }

  // A changed file nobody imports (a new module, a config, an untracked file)
  // means the map is incomplete for this change, so fall back to the full run.
  const known = new Set<string>()
  for (const [testFile, dependencies] of Object.entries(map.files)) {
    known.add(testFile)
    for (const dependency of dependencies) known.add(dependency)
  }
  for (const path of wanted) {
    if (!known.has(path)) return undefined
  }

  return [...matches]
}

/**
 * Record which source files each test file imported, so a later `--changed` run
 * can pick files without guessing.
 */
export function recordDependencies(options: { file?: string } = {}): PluginFn {
  return async ({ config, emitter }) => {
    const cwd = config.cwd
    const target = dependencyFile(cwd, options.file)
    const map = await readDependencyMap(target)
    const testFiles = new Set<string>()
    const edges = new Map<string, Set<string>>()

    const addEdge = (parent: string, child: string) => {
      let set = edges.get(parent)
      if (!set) edges.set(parent, (set = new Set()))
      set.add(child)
    }

    /**
     * ESM loads a shared module once, so attributing loads to whichever test file
     * happened to import it first would miss every later importer. Record the
     * resolution edge (importer -> imported) instead, then walk the graph from
     * each test file. Resolve runs per parent URL, so shared modules keep every
     * incoming edge even when the module itself is cached.
     */
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const result = nextResolve(specifier, context)
        const parent = context.parentURL?.split('?')[0]
        const child = result?.url?.split('?')[0]
        if (parent?.startsWith('file:') && child?.startsWith('file:')) addEdge(parent, child)
        return result
      },
    })

    const importer = config.importer
    config.importer = async (fileURL) => {
      testFiles.add(relative(cwd, fileURLToPath(fileURL)).split('\\').join('/'))
      return importer(fileURL)
    }

    const write = async () => {
      if (!testFiles.size) return
      for (const testFile of testFiles) {
        const root = pathToFileURL(join(cwd, testFile)).href
        const visited = new Set<string>()
        const queue = [root]
        while (queue.length) {
          const current = queue.pop()!
          if (visited.has(current)) continue
          visited.add(current)
          for (const next of edges.get(current) ?? []) {
            if (!visited.has(next)) queue.push(next)
          }
        }

        const project = new Set(map.files[testFile] ?? [])
        for (const url of visited) {
          const path = relative(cwd, fileURLToPath(url)).split('\\').join('/')
          if (path.startsWith('..') || path.includes('node_modules')) continue
          project.add(path)
        }
        map.files[testFile] = [...project].sort()
      }

      try {
        const { mkdir, rename, writeFile } = await import('node:fs/promises')
        const temporary = `${target}.${process.pid}.tmp`
        await mkdir(resolve(target, '..'), { recursive: true })
        await writeFile(temporary, `${JSON.stringify(map)}\n`)
        await rename(temporary, target)
      } catch (error) {
        debug('unable to record dependencies: %O', error)
        await import('node:fs/promises')
          .then(({ rm }) => rm(`${target}.${process.pid}.tmp`, { force: true }))
          .catch(() => {})
      }
    }
    activeWriter = write

    emitter.once('runner:end', (): boolean => {
      void write()
      return true
    })
  }
}

/**
 * Narrow the run to files affected by `--changed` paths. Falls back to the full
 * suite whenever the dependency map cannot answer confidently.
 */
export function changedSelection(options: { file?: string } = {}): PluginFn {
  return async ({ config, cliArgs }) => {
    const raw = cliArgs.changed
    if (!raw) return
    const cwd = config.cwd
    const map = await readDependencyMap(dependencyFile(cwd, options.file))
    const changed =
      raw === 'auto'
        ? await gitChangedPaths(cwd)
        : raw
            .split(',')
            .map((path) => path.trim())
            .filter(Boolean)
    const affected = filesAffectedBy(map, changed)
    if (!affected) {
      debug('unable to narrow --changed; running the full suite')
      return
    }
    // The map names the complete set of known test files, so restricting to the
    // affected ones is safe. A brand-new, unrecorded test file would be missed,
    // which is why the map is only used after a full recorded run.
    config.selectionIndex = Object.freeze({ only: Object.freeze(affected) })
  }
}
