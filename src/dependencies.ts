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
import { FilesManager } from './files_manager.js'
import type { HeuristicRule, NormalizedConfig, PluginFn } from './types.js'

/**
 * Files each test file depends on, captured while it imports. Built by
 * `recordDependencies`, consumed by `changedSelection`.
 */
export type DependencyMap = {
  version: 2
  /** True only when every configured suite file was imported by this map. */
  complete?: boolean
  /** Test file (relative) -> project files its own imports and resolvers reach (relative). */
  files: Record<string, string[]>
  /**
   * Project files a package loaded before the first test file (config, providers,
   * preloads, routes) and the project files they import. A change to one that no test
   * reaches can affect any test.
   */
  boot: string[]
  /** Present when `selection.heuristic` is on; the rules it configured. */
  heuristic?: HeuristicRule[]
}

/** What `--changed` decided to run. */
export type ChangedSelection =
  | { kind: 'exact'; files: string[] }
  /** `guessed` are the changed paths placed by name or rule rather than by imports. */
  | { kind: 'heuristic'; files: string[]; guessed: string[] }
  | { kind: 'full'; reason: string }

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

/** What `--changed` decided, per run config; read into the agent summary. */
const outcomes = new WeakMap<object, ChangedSelection>()

export function changedOutcome(config: object) {
  return outcomes.get(config)
}

/** The agent-summary fields for a `--changed` outcome. */
export function selectionDetail(outcome: ChangedSelection | undefined) {
  if (outcome?.kind === 'full') return { fallbackReason: outcome.reason }
  if (outcome?.kind === 'heuristic')
    return { heuristic: true, guessed: outcome.guessed.slice(0, 20) }
  return {}
}

function sampleOf(paths: string[]) {
  return `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', ...' : ''}`
}

/** `app/modules/*\/` -> a regex capturing each `*` segment. */
function rulePattern(prefix: string) {
  const escaped = prefix.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '([^/]+)')
  return new RegExp(`^${escaped}`)
}

function stemOf(path: string) {
  const name = path.split('/').pop() ?? path
  return name.replace(/\.[^.]+$/, '').replace(/[._-](spec|test)$/, '')
}

/** Test files a path names: same stem, plus the prefixes the rules map it to. */
function guessTests(path: string, testFiles: string[], rules: HeuristicRule[]) {
  const stem = stemOf(path)
  const prefixes = rules.flatMap((rule) => {
    const match = rulePattern(rule.from).exec(path)
    if (!match) return []
    let index = 1
    return [rule.to.replace(/\*/g, () => match[index++] ?? '*')]
  })
  return testFiles.filter(
    (file) => stemOf(file) === stem || prefixes.some((prefix) => file.startsWith(prefix))
  )
}

/**
 * Pick the test files a set of changed paths can affect.
 *
 * A path reached through a test's imports (or a resolver) selects exactly those tests.
 * A changed test file the map has not recorded yet (`testFiles` are the configured
 * ones) selects itself. A path only boot code reaches, or one nothing reaches, runs
 * the full suite, unless the heuristic is on and can name tests for an unreached path.
 * Running too much is safe and running too little is not, so every doubt widens the run.
 */
export function selectChanged(
  map: DependencyMap,
  changed: string[],
  testFiles: string[] = []
): ChangedSelection {
  if (!Object.keys(map.files).length) {
    return {
      kind: 'full',
      reason: 'no dependency map yet. Run once with --prepare-caches (or a full run).',
    }
  }
  if (map.complete !== true) {
    return { kind: 'full', reason: `the dependency map is incomplete. ${RECORD_EARLY_HINT}` }
  }
  const wanted = [...new Set(changed.map((path) => path.split('\\').join('/')))]
  if (!wanted.length) return { kind: 'full', reason: 'no changed paths were found.' }

  const reachedBy = new Map<string, string[]>()
  for (const [testFile, dependencies] of Object.entries(map.files)) {
    for (const path of [testFile, ...dependencies]) {
      const tests = reachedBy.get(path)
      if (tests) tests.push(testFile)
      else reachedBy.set(path, [testFile])
    }
  }

  const configured = new Set(testFiles)
  const selected = new Set<string>()
  const unreached: string[] = []
  for (const path of wanted) {
    const tests = reachedBy.get(path)
    if (tests) tests.forEach((file) => selected.add(file))
    else if (configured.has(path)) selected.add(path)
    else unreached.push(path)
  }
  if (!unreached.length) return { kind: 'exact', files: [...selected] }

  const boot = new Set(map.boot)
  const atBoot = unreached.filter((path) => boot.has(path))
  if (atBoot.length) {
    return {
      kind: 'full',
      reason:
        `${atBoot.length} changed path(s) are loaded at boot and reached by no test's imports ` +
        `(${sampleOf(atBoot)}), so any test can depend on them.`,
    }
  }

  const unplaced = map.heuristic
    ? unreached.filter((path) => {
        const guesses = guessTests(path, Object.keys(map.files), map.heuristic!)
        guesses.forEach((file) => selected.add(file))
        return !guesses.length
      })
    : unreached
  if (unplaced.length) {
    return {
      kind: 'full',
      reason:
        `${unplaced.length} changed path(s) no test file imports (${sampleOf(unplaced)}). ` +
        'Files loaded lazily (controllers, jobs) need a selection resolver.',
    }
  }
  return { kind: 'heuristic', files: [...selected], guessed: unreached }
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

const emptyMap = (): DependencyMap => ({
  version: 2,
  complete: false,
  files: Object.create(null),
  boot: [],
})

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isRules = (value: unknown): value is HeuristicRule[] =>
  Array.isArray(value) &&
  value.every(
    (rule) =>
      rule &&
      typeof (rule as HeuristicRule).from === 'string' &&
      typeof (rule as HeuristicRule).to === 'string'
  )

/** Version 1 maps walked through packages and selected every test; they are discarded. */
export function parseDependencyMap(value: unknown): DependencyMap {
  if (!value || typeof value !== 'object' || (value as DependencyMap).version !== 2) {
    return emptyMap()
  }
  const { files, boot, heuristic, complete } = value as DependencyMap
  if (!files || typeof files !== 'object' || Array.isArray(files) || !isStrings(boot)) {
    return emptyMap()
  }
  const parsed: Record<string, string[]> = Object.create(null)
  for (const [key, dependencies] of Object.entries(files)) {
    if (!isStrings(dependencies)) return emptyMap()
    parsed[key] = dependencies
  }
  return {
    version: 2,
    complete: complete === true,
    files: parsed,
    boot,
    ...(isRules(heuristic) ? { heuristic } : {}),
  }
}

export async function readDependencyMap(file: string): Promise<DependencyMap> {
  try {
    return parseDependencyMap(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    debug('ignoring unavailable dependency map %s: %O', file, error)
    return emptyMap()
  }
}

const isPackageUrl = (url: string) => url.includes('/node_modules/')

/** Project files reachable from `roots` without walking through a package. */
function projectClosure(edges: ImportEdges, roots: Iterable<string>) {
  const visited = new Set<string>()
  const queue = [...roots]
  while (queue.length) {
    const current = queue.pop()!
    if (visited.has(current) || isPackageUrl(current)) continue
    visited.add(current)
    for (const next of edges.get(current) ?? []) {
      if (!visited.has(next)) queue.push(next)
    }
  }
  return visited
}

/**
 * Project files a package or the entry script loaded so far. Called before the first
 * test file is imported, this is what the framework loaded at boot.
 */
function bootRoots(edges: ImportEdges, cwd: string) {
  const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
  const project = pathToFileURL(`${cwd}/`).href
  const roots = new Set<string>()
  for (const [parent, children] of edges) {
    if (!isPackageUrl(parent) && parent !== entry) continue
    for (const child of children) {
      if (child.startsWith(project) && !isPackageUrl(child)) roots.add(child)
    }
  }
  return roots
}

function toFileUrl(cwd: string, path: string) {
  return path.startsWith('file:') ? path : pathToFileURL(resolve(cwd, path)).href
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
    let boot: Set<string> | undefined
    const resolvers = config.selection?.resolvers ?? []
    const heuristic = config.selection?.heuristic
    const toPath = (url: string) => relative(cwd, fileURLToPath(url)).split('\\').join('/')
    const inProject = (path: string) => !path.startsWith('..') && !path.includes('node_modules')

    // Edges are importer -> imported, walked from each test file below. Load
    // events alone would miss shared modules, which ESM loads only once.
    const importer = config.importer
    config.importer = async (fileURL) => {
      // Everything loaded so far is boot code; later lazy loads are not.
      boot ??= projectClosure(edges, bootRoots(edges, cwd))
      testFiles.add(relative(cwd, fileURLToPath(fileURL)).split('\\').join('/'))
      try {
        return await importer(fileURL)
      } catch (error) {
        importFailed = true
        throw error
      }
    }

    /**
     * Files a resolver names are often loaded only on demand (a controller behind a
     * route), so `--prepare-caches` never sees their imports. Importing them here
     * records those edges; a file that fails to import still counts as a dependency.
     */
    const unloadable = new Set<string>()
    const resolveExtra = async (testFile: string) => {
      const urls: string[] = []
      for (const resolver of resolvers) {
        try {
          for (const path of await resolver(testFile)) urls.push(toFileUrl(cwd, path))
        } catch (error) {
          debug('selection resolver failed for %s: %O', testFile, error)
        }
      }
      for (const url of urls) {
        if (!edges.has(url)) await import(url).catch(() => unloadable.add(toPath(url)))
      }
      return urls
    }

    const write = async () => {
      if (!testFiles.size) return
      for (const testFile of testFiles) {
        const root = pathToFileURL(join(cwd, testFile)).href
        const reached = projectClosure(edges, [root, ...(await resolveExtra(testFile))])
        const project = new Set(map.files[testFile] ?? [])
        for (const url of reached) {
          const path = toPath(url)
          if (inProject(path)) project.add(path)
        }
        map.files[testFile] = [...project].sort()
      }
      const testFileSet = new Set(testFiles)
      const bootFiles = [...(boot ?? [])]
        .map(toPath)
        .filter((path) => inProject(path) && !testFileSet.has(path))

      const unrecorded = new Set<string>()
      if (completeRun && !importFailed) {
        for (const testFile of testFiles) {
          const root = pathToFileURL(join(cwd, testFile)).href
          if (await hasRelativeImports(join(cwd, testFile))) {
            const recorded = edges.get(root)?.size ?? 0
            if (!recorded) unrecorded.add(testFile)
          }
          for (const dependency of map.files[testFile] ?? []) {
            if (dependency === testFile || unrecorded.has(dependency) || unloadable.has(dependency))
              continue
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
          // A complete run saw the whole boot; a slice can only add to it.
          latest.boot =
            completeRun && !importFailed
              ? bootFiles.sort()
              : [...new Set([...latest.boot, ...bootFiles])].sort()
          if (heuristic) latest.heuristic = heuristic === true ? [] : heuristic
          else delete latest.heuristic
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

/** Every test file the config names, relative to `cwd`, before any filter. */
async function configuredTestFiles(config: NormalizedConfig, cwd: string) {
  const manager = new FilesManager()
  const groups = 'suites' in config ? config.suites.map((suite) => suite.files) : [config.files]
  const urls = await Promise.all(
    groups.map((files) => manager.getFiles(cwd, files, config.exclude).catch(() => []))
  )
  return urls.flat().map((url) => relative(cwd, fileURLToPath(url)).split('\\').join('/'))
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
    let outcome = selectChanged(map, changed, await configuredTestFiles(config, cwd))
    if (outcome.kind === 'full' && hookUnavailable && !processEdges) {
      outcome = {
        kind: 'full',
        reason: 'this Node has no module.registerHooks (22.15+ or 23.5+ needed).',
      }
    }
    outcomes.set(config, outcome)
    if (outcome.kind === 'full') {
      warn(`--changed is running the full suite: ${outcome.reason}`)
      return
    }
    if (outcome.kind === 'heuristic') {
      warn(
        `--changed guessed tests by name for ${outcome.guessed.length} path(s) no test imports ` +
          `(${sampleOf(outcome.guessed)}). Run the full suite before relying on it.`
      )
    }
    // Restrict only the test files the map has recorded. One it has never seen (added
    // or pulled since the map was written) has no record to rule it out, so it runs.
    setSelectionPlan(config, {
      only: Object.freeze(outcome.files),
      onlyWithin: Object.freeze(Object.keys(map.files)),
    })
  }
}
