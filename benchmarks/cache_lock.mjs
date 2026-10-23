/**
 * Cache lock probes: mutual exclusion and stale-lock recovery.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withCacheLock } from '../src/cache_lock.js'

test('two writers serialize their read-modify-write sequence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'japa-lock-'))
  try {
    const file = join(dir, 'value.json')
    await writeFile(file, '0')
    const bump = () =>
      withCacheLock(file, async () => {
        const value = Number(await readFile(file, 'utf8'))
        await new Promise((done) => setTimeout(done, 50))
        await writeFile(file, String(value + 1))
      })
    await Promise.all([bump(), bump()])
    assert.equal(await readFile(file, 'utf8'), '2')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a stale lock is removed instead of blocking forever', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'japa-lock-'))
  try {
    const file = join(dir, 'value.json')
    await writeFile(file, '0')
    await writeFile(`${file}.lock`, '')
    const old = new Date(Date.now() - 60_000)
    await utimes(`${file}.lock`, old, old)

    await withCacheLock(file, async () => {
      await writeFile(file, '1')
    })
    assert.equal(await readFile(file, 'utf8'), '1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
