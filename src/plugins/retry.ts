/*
 * @japa/runner
 *
 * (c) Japa
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { readFile } from 'node:fs/promises'
import { colors } from '../helpers.js'
import type { PluginFn } from '../types.js'
import { failedTestsFile, getFailedTests, cacheFailedTests } from './retry_cache.js'
export { getFailedTests, cacheFailedTests, clearCache } from './retry_cache.js'

/**
 * Exposes the API to run failing tests using the "failed" CLI flag.
 */
export const retryPlugin: PluginFn = async function retry({ config, cliArgs }) {
  const managed = Boolean(process.env.JAPA_SPEED_SNAPSHOT || process.env.JAPA_SPEED_RUN_ID)
  if (!managed && !failedTestsFile(config.cwd)) {
    return
  }

  if (!managed) {
    config.teardown.push(async (runner) => {
      const summary = runner.getSummary()
      await cacheFailedTests(summary.failedTestsTitles, config.cwd)
    })
  }

  if (cliArgs.failed) {
    try {
      let tests: string[] | undefined
      if (managed) {
        const snapshot: unknown = JSON.parse(
          await readFile(process.env.JAPA_SPEED_SNAPSHOT!, 'utf8')
        )
        if (
          !snapshot ||
          typeof snapshot !== 'object' ||
          !('failedTests' in snapshot) ||
          !Array.isArray(snapshot.failedTests) ||
          !snapshot.failedTests.every((title) => typeof title === 'string')
        ) {
          throw new Error('Invalid parallel failed-test snapshot')
        }
        tests = snapshot.failedTests
      } else {
        const cached = await getFailedTests(config.cwd)
        tests = cached.tests
      }
      /**
       * With a committed baseline, `--failed-new` skips failures that are already
       * expected. Matching is by title, because the retry cache stores titles;
       * opt-in so the imprecise identity can never silently hide a regression.
       */
      if (cliArgs.failedNew && tests?.length) {
        const { readBaseline, baselineFile } = await import('../failure_baseline.js')
        const baseline = await readBaseline(baselineFile(config.cwd))
        const known = new Set(baseline.failures.map((entry) => entry.title))
        if (known.size) tests = tests.filter((title) => !known.has(title))
      }
      if (!tests || !tests.length) {
        console.log(colors.bgYellow().black(' No failing tests found. Running all the tests '))
        return
      }
      config.filters.tests = tests
    } catch (error) {
      console.log(colors.bgRed().black(' Unable to read failed tests. Running all the tests '))
      console.log(colors.red(error))
    }
  }
}
