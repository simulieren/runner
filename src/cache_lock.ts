/*
 * @japa/runner
 *
 * (c) Japa
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { mkdir, open, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import debug from './debug.js'

const RETRY_MS = 25
const STALE_MS = 30_000
const TIMEOUT_MS = 5_000

/** Exclusive lock for a cache read-modify-write sequence. */
export async function withCacheLock<T>(
  file: string,
  callback: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number } = {}
): Promise<T> {
  const lock = `${file}.lock`
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  const staleMs = options.staleMs ?? STALE_MS
  const started = Date.now()

  await mkdir(dirname(lock), { recursive: true })
  while (true) {
    try {
      const handle = await open(lock, 'wx')
      try {
        return await callback()
      } finally {
        await handle.close()
        await rm(lock, { force: true }).catch(() => {})
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

      // A crashed process can leave the lock behind; age it out.
      const info = await stat(lock).catch(() => null)
      if (info && Date.now() - info.mtimeMs > staleMs) {
        debug('removing stale cache lock %s', lock)
        await rm(lock, { force: true }).catch(() => {})
        continue
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for cache lock ${lock}`)
      }
      // Must not be unref'd: the lock waiter has no other handle to keep the loop alive.
      await new Promise((done) => setTimeout(done, RETRY_MS))
    }
  }
}
