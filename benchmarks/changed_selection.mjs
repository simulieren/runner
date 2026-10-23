/**
 * Change-aware selection probes.
 *
 * The contract these protect: `--changed` may run more than necessary, never
 * less. Every uncertain case must return `undefined` so the caller runs
 * everything.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filesAffectedBy, gitChangedPaths, parseDependencyMap } from '../src/dependencies.js'
import { autoWorkerCount } from '../src/parallel.js'

const map = parseDependencyMap({
  version: 1,
  files: {
    'tests/user.spec.ts': ['app/models/user.ts', 'app/services/auth.ts'],
    'tests/billing.spec.ts': ['app/services/billing.ts'],
    'tests/shared.spec.ts': ['app/services/auth.ts'],
  },
})

test('a changed imported module selects every test that imports it', () => {
  assert.deepEqual(filesAffectedBy(map, ['app/services/auth.ts'])?.sort(), [
    'tests/shared.spec.ts',
    'tests/user.spec.ts',
  ])
})

test('a changed test file selects itself', () => {
  assert.deepEqual(filesAffectedBy(map, ['tests/billing.spec.ts']), ['tests/billing.spec.ts'])
})

test('several changed paths are combined', () => {
  assert.deepEqual(
    filesAffectedBy(map, ['app/services/billing.ts', 'app/services/auth.ts'])?.sort(),
    ['tests/billing.spec.ts', 'tests/shared.spec.ts', 'tests/user.spec.ts']
  )
})

test('an unknown changed path falls back to the whole suite', () => {
  assert.equal(filesAffectedBy(map, ['app/something/new.ts']), undefined)
})

test('an empty map or empty change list falls back to the whole suite', () => {
  assert.equal(filesAffectedBy(map, []), undefined)
  assert.equal(filesAffectedBy(parseDependencyMap({}), ['app/models/user.ts']), undefined)
})

test('backslashes in changed paths are normalized', () => {
  assert.deepEqual(filesAffectedBy(map, ['app\\services\\billing.ts']), ['tests/billing.spec.ts'])
})

test('a malformed map is treated as empty', () => {
  assert.equal(Object.keys(parseDependencyMap({ version: 9, files: { a: ['b'] } }).files).length, 0)
  assert.equal(parseDependencyMap('nope').version, 1)
})

test('--changed=auto reads tracked and untracked paths from git', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'japa-git-'))
  try {
    const git = (...args) => execFileSync('git', args, { cwd, stdio: 'ignore' })
    git('init')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await writeFile(join(cwd, 'committed.ts'), 'export const a = 1\n')
    await writeFile(join(cwd, 'stable.ts'), 'export const b = 1\n')
    git('add', '.')
    git('commit', '-m', 'initial')

    await writeFile(join(cwd, 'committed.ts'), 'export const a = 2\n')
    await writeFile(join(cwd, 'untracked.ts'), 'export const c = 1\n')

    const changed = await gitChangedPaths(cwd)
    assert.deepEqual(changed.sort(), ['committed.ts', 'untracked.ts'])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('auto worker count collapses a narrow selection to one worker', () => {
  assert.equal(autoWorkerCount(['--tests=case 1']), 1)
  assert.equal(autoWorkerCount(['--changed=auto']), 1)
  assert.equal(autoWorkerCount(['--groups=billing']), 1)
  assert.ok(autoWorkerCount([]) >= 1)
})
