/*
 * @japa/runner
 *
 * (c) Japa
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import * as nodeModule from 'node:module'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { join, relative, resolve } from 'node:path'
import { cacheDir, dependencyFile } from './cache_paths.js'
import { fileURLToPath } from 'node:url'
import debug from './debug.js'
import { withCacheLock } from './cache_lock.js'
import { setSelectionPlan } from './planning_state.js'
import { warn } from './helpers.js'
import type { PluginFn } from './types.js'

/**
 * Files each test file depends on, captured while it imports. Built by
 * `recordDependencies`, consumed by `changedSelection`.
 */
export type DependencyMap = {
  version: 1
  /** True only when every configured suite file was imported by this map. */
  complete?: boolean
  /** Test file (relative) -> source files it imported (relative). */
  files: Record<string, string[]>
}

// Only comments that open a line: a `/*` or `//` inside a string (a glob, a URL)
// must never hide a real import, or the graph would be marked complete too early.
const COMMENTS = /^\s*\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm
const TYPE_ONLY = /\b(?:import|export)\s+type\b[^;]*?\bfrom\s*['"][^'"]+['"]/g
const RELATIVE_IMPORT = /(?:\bfrom\s+|\bimport\s*\(|\brequire\s*\(|\bimport\s+)['"]\.{1,2}\//

/**
 * Relative imports that should have produced a resolve edge. Type-only imports
 * and specifiers inside comments are erased before Node resolves anything, so
 * counting them would mark a fully recorded graph incomplete.
 */
export function hasRuntimeRelativeImport(source: string) {
  return RELATIVE_IMPORT.test(source.replace(COMMENTS, '').replace(TYPE_ONLY, ''))
}

async function hasRelativeImports(path: string) {
  return hasRuntimeRelativeImport(await readFile(path, 'utf8').catch(() => ''))
}

type ImportEdges = Map<string, Set<string>>

/** Importer -> imported URLs seen by the resolve hook, once it is registered. */
let processEdges: ImportEdges | undefined
/** Stays true when this Node has no `module.registerHooks`. */
let hookUnavailable = true

const RECORD_EARLY_HINT =
  'If your framework imports app code before configure() (AdonisJS boots providers and ' +
  'preloads first), call recordImportsFromStart() at the top of the test entrypoint, then ' +
  'rerun with --prepare-caches.'

/** Why `--changed` ran the full suite, per run config; read into the agent summary. */
const fallbackReasons = new WeakMap<object, string>()

export function changedFallbackReason(config: object) {
  return fallbackReasons.get(config)
}

/**
 * Why `filesAffectedBy` could not answer, worded as what to do about it.
 * `undefined` when it can.
 */
export function explainChangedFallback(map: DependencyMap, changed: string[]) {
  if (!Object.keys(map.files).length) {
    return 'no dependency map yet. Run once with --prepare-caches (or a full run).'
  }
  if (map.complete !== true) {
    return `the dependency map is incomplete. ${RECORD_EARLY_HINT}`
  }
  if (!changed.length) return 'no changed paths were found.'
  const known = new Set<string>()
  for (const [testFile, dependencies] of Object.entries(map.files)) {
    known.add(testFile)
    for (const dependency of dependencies) known.add(dependency)
  }
  const unknown = changed.filter((path) => !known.has(path.split('\\').join('/')))
  if (!unknown.length) return undefined
  const sample = unknown.slice(0, 3).join(', ')
  return (
    `${unknown.length} changed path(s) no test file imports (${sample}${unknown.length > 3 ? ', ...' : ''}). ` +
    'Configs, new modules and files loaded lazily (routes, controllers) are not in the map; ' +
    'a new test file needs --prepare-caches.'
  )
}

function registerResolveHook(): ImportEdges | undefined {
  // Node 22.15+/23.5+ ship registerHooks. On older supported versions the
  // dependency map is simply unavailable; --changed then runs everything.
  const hooks = nodeModule as { registerHooks?: typeof nodeModule.registerHooks }
  if (typeof hooks.registerHooks !== 'function') {
    debug('node:module registerHooks is unavailable; dependency recording disabled')
    return undefined
  }
  hookUnavailable = false

  const edges: ImportEdges = new Map()
  hooks.registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context)
      const parent = context.parentURL?.split('?')[0]
      const child = result?.url?.split('?')[0]
      if (parent?.startsWith('file:') && child?.startsWith('file:')) {
        let set = edges.get(parent)
        if (!set) edges.set(parent, (set = new Set()))
        set.add(child)
      }
      return result
    },
  })
  return edges
}

/**
 * Record import edges from now on, for applications that load modules before
 * Japa is configured. A framework that boots first (AdonisJS loads providers,
 * preloads and config before `configure()`) resolves those modules before the
 * recorder exists, so their own imports are never seen and the map can never be
 * marked complete. Call this at the top of the test entrypoint, before booting.
 */
export function recordImportsFromStart(): boolean {
  processEdges ??= registerResolveHook()
  return processEdges !== undefined
}

/** Per-run writers, so two runs in one process cannot clobber each other. */
const writers = new WeakMap<object, () => Promise<void>>()

export async function flushDependencies(emitter: object) {
  await writers.get(emitter)?.()
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
function isIgnoredPath(path: string, ignored: string[]) {
  const value = path.replace(/^\.\//, '')
  return ignored.some((entry) => value === entry || value.startsWith(`${entry}/`))
}

export async function gitChangedPaths(cwd: string, ignored: string[] = []): Promise<string[]> {
  const run = promisify(execFile)
  try {
    const [modified, untracked] = await Promise.all([
      run('git', ['diff', '--name-only', 'HEAD'], { cwd, timeout: 5000 }),
      run('git', ['ls-files', '--others', '--exclude-standard'], { cwd, timeout: 5000 }),
    ])
    const lines = `${modified.stdout}\n${untracked.stdout}`
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !isBuildNoise(line) && !isIgnoredPath(line, ignored))
    return [...new Set(lines)]
  } catch (error) {
    debug('unable to read changed paths from git: %O', error)
    return []
  }
}

export function parseDependencyMap(value: unknown): DependencyMap {
  const empty = (): DependencyMap => ({ version: 1, complete: false, files: Object.create(null) })
  if (!value || typeof value !== 'object' || (value as DependencyMap).version !== 1) return empty()
  const files = (value as DependencyMap).files
  if (!files || typeof files !== 'object' || Array.isArray(files)) return empty()
  const parsed: Record<string, string[]> = Object.create(null)
  for (const [key, dependencies] of Object.entries(files)) {
    if (!Array.isArray(dependencies) || !dependencies.every((item) => typeof item === 'string')) {
      return empty()
    }
    parsed[key] = dependencies
  }
  return { version: 1, complete: (value as DependencyMap).complete === true, files: parsed }
}

export async function readDependencyMap(file: string): Promise<DependencyMap> {
  try {
    return parseDependencyMap(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    debug('ignoring unavailable dependency map %s: %O', file, error)
    return { version: 1, complete: false, files: Object.create(null) }
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
  if (map.complete !== true || !wanted.size || !Object.keys(map.files).length) return undefined

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

/** Record each test file's transitive imports for `--changed`. */
export function recordDependencies(options: { file?: string; dir?: string } = {}): PluginFn {
  return async ({ config, emitter, cliArgs }) => {
    const edges = processEdges ?? registerResolveHook()
    if (!edges) return

    const cwd = await realpath(config.cwd)
    const target = options.file ? resolve(cwd, options.file) : dependencyFile(cwd, options.dir)
    const map = await readDependencyMap(target)
    const testFiles = new Set<string>()
    const filters = config.filters
    const completeRun =
      Boolean(cliArgs?.prepareCaches) ||
      (!cliArgs?.changed &&
        !cliArgs?.failed &&
        !cliArgs?.bail &&
        !filters?.tests?.length &&
        !filters?.groups?.length &&
        !filters?.tags?.length &&
        !filters?.files?.length &&
        !filters?.suites?.length &&
        !filters?.shard)
    let importFailed = false
    let graphComplete = true

    // Edges are importer -> imported, walked from each test file below. Load
    // events alone would miss shared modules, which ESM loads only once.
    const importer = config.importer
    config.importer = async (fileURL) => {
      testFiles.add(relative(cwd, fileURLToPath(fileURL)).split('\\').join('/'))
      try {
        return await importer(fileURL)
      } catch (error) {
        importFailed = true
        throw error
      }
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

      const unrecorded = new Set<string>()
      if (completeRun && !importFailed) {
        for (const testFile of testFiles) {
          const root = pathToFileURL(join(cwd, testFile)).href
          if (await hasRelativeImports(join(cwd, testFile))) {
            const recorded = edges.get(root)?.size ?? 0
            if (!recorded) unrecorded.add(testFile)
          }
          for (const dependency of map.files[testFile] ?? []) {
            if (dependency === testFile || unrecorded.has(dependency)) continue
            const url = pathToFileURL(join(cwd, dependency)).href
            if (
              (edges.get(url)?.size ?? 0) === 0 &&
              (await hasRelativeImports(join(cwd, dependency)))
            ) {
              unrecorded.add(dependency)
            }
          }
        }
      }
      if (unrecorded.size) {
        graphComplete = false
        if (cliArgs?.prepareCaches) {
          const sample = [...unrecorded].slice(0, 3).join(', ')
          warn(
            `The dependency map is incomplete: ${unrecorded.size} file(s) imported other files ` +
              `before Japa could record them (${sample}). --changed will run the full suite. ` +
              RECORD_EARLY_HINT
          )
        }
      }

      try {
        const { mkdir, rename, writeFile } = await import('node:fs/promises')
        await withCacheLock(target, async () => {
          // Another agent may have written since this run started.
          const latest = await readDependencyMap(target)
          for (const [testFile, dependencies] of Object.entries(map.files)) {
            const merged = new Set([...(latest.files[testFile] ?? []), ...dependencies])
            latest.files[testFile] = [...merged].sort()
          }
          latest.complete =
            latest.complete === true || (completeRun && !importFailed && graphComplete)
          const temporary = `${target}.${process.pid}.tmp`
          await mkdir(resolve(target, '..'), { recursive: true })
          await writeFile(temporary, `${JSON.stringify(latest)}\n`)
          await rename(temporary, target)
        })
      } catch (error) {
        debug('unable to record dependencies: %O', error)
        await import('node:fs/promises')
          .then(({ rm }) => rm(`${target}.${process.pid}.tmp`, { force: true }))
          .catch(() => {})
      }
    }
    writers.set(emitter, write)

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
export function changedSelection(options: { file?: string; dir?: string } = {}): PluginFn {
  return async ({ config, cliArgs }) => {
    const raw = cliArgs.changed
    if (!raw) return
    const cwd = await realpath(config.cwd)
    const map = await readDependencyMap(
      options.file ? resolve(cwd, options.file) : dependencyFile(cwd, options.dir)
    )
    const ignored: string[] = []
    const relativeCache = relative(cwd, cacheDir(cwd, options.dir)).split('\\').join('/')
    if (relativeCache && relativeCache !== '.' && !relativeCache.startsWith('..')) {
      ignored.push(relativeCache)
    }
    if (cliArgs.agentFile) {
      const report = relative(cwd, resolve(cwd, cliArgs.agentFile)).split('\\').join('/')
      if (report && !report.startsWith('..')) ignored.push(report, `${report}.delta.json`)
    }
    const changed =
      raw === 'auto'
        ? await gitChangedPaths(cwd, ignored)
        : raw
            .split(',')
            .map((path) => path.trim())
            .filter(Boolean)
    const affected = filesAffectedBy(map, changed)
    if (!affected) {
      const reason = explainChangedFallback(map, changed) ?? 'the dependency map cannot answer.'
      const why =
        hookUnavailable && !processEdges
          ? 'this Node has no module.registerHooks (22.15+ or 23.5+ needed).'
          : reason
      fallbackReasons.set(config, why)
      warn(`--changed is running the full suite: ${why}`)
      return
    }
    // The map names the complete set of known test files, so restricting to the
    // affected ones is safe. A brand-new, unrecorded test file would be missed,
    // which is why the map is only used after a full recorded run.
    setSelectionPlan(config, { only: Object.freeze(affected) })
  }
}
