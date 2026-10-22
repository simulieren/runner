/*
 * @japa/runner
 *
 * (c) Japa
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { assert } from 'chai'
import { test, type TestContext as NodeTestContext } from 'node:test'
import { rejects } from 'node:assert/strict'

import { runner } from '../factories/main.js'
import { GlobalHooks } from '../src/hooks.js'
import { ConfigManager } from '../src/config_manager.js'
import { pEvent, wrapAssertions } from './helpers.js'
import { createTest, createTestGroup } from '../src/create_test.js'
import { Emitter, Refiner, Runner, Suite } from '../modules/core/main.js'
import { disallowPinnedTests } from '../src/plugins/disallow_pinned_tests.js'
import { clearCache, getFailedTests, retryPlugin } from '../src/plugins/retry.js'

test.describe('Runner | create tests and groups', () => {
  test('raise error when defining nested groups', async () => {
    const emitter = new Emitter()
    const refiner = new Refiner()
    const group = createTestGroup('', emitter, refiner, {})

    await wrapAssertions(() => {
      assert.throws(
        () => createTestGroup('', emitter, refiner, { group }),
        'Nested groups are not supported by Japa'
      )
    })
  })

  test('add group to the suite when defined', async () => {
    const emitter = new Emitter()
    const refiner = new Refiner()
    const suite = new Suite('', emitter, refiner)
    const group = createTestGroup('', emitter, refiner, { suite })

    await wrapAssertions(() => {
      assert.deepEqual(suite.stack, [group])
    })
  })

  test('add test to the suite when defined', async () => {
    const emitter = new Emitter()
    const refiner = new Refiner()
    const suite = new Suite('', emitter, refiner)
    const t = createTest('', emitter, refiner, new Error(), { suite })

    await wrapAssertions(() => {
      assert.deepEqual(suite.stack, [t])
    })
  })

  test('add test to the group when group and suite both are defined', async () => {
    const emitter = new Emitter()
    const refiner = new Refiner()
    const suite = new Suite('', emitter, refiner)

    const group = createTestGroup('', emitter, refiner, { suite })
    const t = createTest('', emitter, refiner, new Error(), { suite, group })

    await wrapAssertions(() => {
      assert.deepEqual(suite.stack, [group])
      assert.deepEqual(group.tests, [t])
    })
  })

  test('define test timeout from global options', async () => {
    const emitter = new Emitter()
    const refiner = new Refiner()
    const t = createTest('', emitter, refiner, new Error(), { timeout: 1000 })

    await wrapAssertions(() => {
      assert.equal(t.options.timeout, 1000)
    })
  })

  test('define test retries from global options', async () => {
    const emitter = new Emitter()
    const refiner = new Refiner()
    const t = createTest('', emitter, refiner, new Error(), { retries: 4 })

    await wrapAssertions(() => {
      assert.equal(t.options.retries, 4)
    })
  })

  test('execute test', async () => {
    const stack: string[] = []
    const emitter = new Emitter()
    const refiner = new Refiner()
    const t = createTest('', emitter, refiner, new Error(), { retries: 4 })
    t.run(() => {
      stack.push('executed')
    })

    await t.exec()
    await wrapAssertions(() => {
      assert.deepEqual(stack, ['executed'])
    })
  })

  test('assert test throws an exception', async () => {
    const emitter = new Emitter()
    const refiner = new Refiner()
    const t = createTest('', emitter, refiner, new Error(), {})
    t.run(() => {
      throw new Error('Failed')
    }).throws('Failed')

    const [event] = await Promise.all([pEvent(emitter, 'test:end'), t.exec()])

    await wrapAssertions(() => {
      assert.equal(event!.hasError, false)
    })
  })

  test('assert error matches the regular expression', async () => {
    const emitter = new Emitter()
    const refiner = new Refiner()
    const t = createTest('', emitter, refiner, new Error(), {})
    t.run(() => {
      throw new Error('Failed')
    }).throws(/ed?/)

    const [event] = await Promise.all([pEvent(emitter, 'test:end'), t.exec()])

    await wrapAssertions(() => {
      assert.equal(event!.hasError, false)
    })
  })

  test('throw error when test does not have a callback defined', async () => {
    const emitter = new Emitter()
    const refiner = new Refiner()
    const t = createTest('', emitter, refiner, new Error(), {})

    await wrapAssertions(() => {
      assert.throws(
        () => t.throws(/ed?/),
        'Cannot use "test.throws" method without a test callback'
      )
    })
  })

  test('assert test throws an instance of a given class', async () => {
    const emitter = new Emitter()
    const refiner = new Refiner()
    const t = createTest('', emitter, refiner, new Error(), {})
    t.run(() => {
      throw new Error('Failed')
    }).throws('Failed', Error)

    const [event] = await Promise.all([pEvent(emitter, 'test:end'), t.exec()])
    await wrapAssertions(() => {
      assert.equal(event!.hasError, false)
    })
  })

  test('fail when test does not throw an exception', async () => {
    const emitter = new Emitter()
    const refiner = new Refiner()
    const t = createTest('', emitter, refiner, new Error(), {})
    t.run(() => {}).throws('Failed', Error)

    const [event] = await Promise.all([pEvent(emitter, 'test:end'), t.exec()])
    await wrapAssertions(() => {
      assert.equal(event!.hasError, true)
      assert.equal(event!.errors[0].error.message, 'Expected test to throw an exception')
    })
  })

  test('fail when error constructor mismatch', async () => {
    class Exception {}
    const emitter = new Emitter()
    const refiner = new Refiner()
    const t = createTest('', emitter, refiner, new Error(), {})
    t.run(() => {
      throw new Error('Failed')
    }).throws('Failed', Exception)

    const [event] = await Promise.all([pEvent(emitter, 'test:end'), t.exec()])
    await wrapAssertions(() => {
      assert.equal(event!.hasError, true)
      assert.equal(event!.errors[0].error.message, 'Expected test to throw "[class Exception]"')
    })
  })

  test('fail when error message mismatch', async () => {
    const emitter = new Emitter()
    const refiner = new Refiner()
    const t = createTest('', emitter, refiner, new Error(), {})
    t.run(() => {
      throw new Error('Failed')
    }).throws('Failure')

    const [event] = await Promise.all([pEvent(emitter, 'test:end'), t.exec()])
    await wrapAssertions(() => {
      assert.equal(event!.hasError, true)
      assert.equal(
        event!.errors[0].error.message,
        'Expected test to throw "Failure". Instead received "Failed"'
      )
    })
  })

  test('fail when error does not match the regular expression', async () => {
    const emitter = new Emitter()
    const refiner = new Refiner()
    const t = createTest('', emitter, refiner, new Error(), {})
    t.run(() => {
      throw new Error('Failed')
    }).throws(/lure?/)

    const [event] = await Promise.all([pEvent(emitter, 'test:end'), t.exec()])
    await wrapAssertions(() => {
      assert.equal(event!.hasError, true)
      assert.equal(
        event!.errors[0].error.message,
        'Expected test error to match "/lure?/" regular expression'
      )
    })
  })
})

test.describe('Runner | global hooks', () => {
  test('do not run teardown hooks when setup hooks were not executed', async () => {
    const hooks = new GlobalHooks()
    const stack: string[] = []

    hooks.apply(
      new ConfigManager(
        {
          files: [],
          setup: [
            () => {
              stack.push('setup')
            },
          ],
          teardown: [
            () => {
              stack.push('teardown')
            },
          ],
        },
        {}
      ).hydrate()
    )

    const emitter = new Emitter()
    await hooks.teardown(null, new Runner(emitter))

    await wrapAssertions(() => {
      assert.deepEqual(stack, [])
    })
  })

  test('run teardown hooks when setup hooks were executed', async () => {
    const hooks = new GlobalHooks()
    const stack: string[] = []

    hooks.apply(
      new ConfigManager(
        {
          files: [],
          setup: [
            () => {
              stack.push('setup')
            },
          ],
          teardown: [
            () => {
              stack.push('teardown')
            },
          ],
        },
        {}
      ).hydrate()
    )

    const emitter = new Emitter()
    await hooks.setup(new Runner(emitter))
    await hooks.teardown(null, new Runner(emitter))

    await wrapAssertions(() => {
      assert.deepEqual(stack, ['setup', 'teardown'])
    })
  })

  test('do not run teardown hooks in case of error', async () => {
    const hooks = new GlobalHooks()
    const stack: string[] = []

    hooks.apply(
      new ConfigManager(
        {
          files: [],
          setup: [
            () => {
              stack.push('setup')
            },
          ],
          teardown: [
            () => {
              stack.push('teardown')
            },
          ],
        },
        {}
      ).hydrate()
    )

    const emitter = new Emitter()
    await hooks.setup(new Runner(emitter))
    await hooks.teardown(new Error('foo'), new Runner(emitter))

    await wrapAssertions(() => {
      assert.deepEqual(stack, ['setup'])
    })
  })

  test('run teardown cleanup methods when teardown hook raises error', async () => {
    const hooks = new GlobalHooks()
    const stack: string[] = []

    hooks.apply(
      new ConfigManager(
        {
          files: [],
          setup: [
            () => {
              stack.push('setup')
            },
          ],
          teardown: [
            () => {
              stack.push('teardown')
              return () => {
                stack.push('teardown cleanup')
              }
            },
            () => {
              throw new Error('blowup')
            },
          ],
        },
        {}
      ).hydrate()
    )

    const emitter = new Emitter()
    await hooks.setup(new Runner(emitter))
    try {
      await hooks.teardown(null, new Runner(emitter))
    } catch (error) {
      await hooks.teardown(error, new Runner(emitter))
    }

    await wrapAssertions(() => {
      assert.deepEqual(stack, ['setup', 'teardown', 'teardown cleanup'])
    })
  })
})

test.describe('Runner | retryPlugin', () => {
  test('store failing tests inside the cache dir', async () => {
    const stack: string[] = []

    const emitter = new Emitter()
    const refiner = new Refiner()

    const suite = new Suite('same', emitter, refiner)
    createTest('failing test', emitter, refiner, new Error(), { suite }).run(() => {
      stack.push('executing failing test')
      throw new Error('Failing')
    })
    createTest('passing test', emitter, refiner, new Error(), { suite }).run(() => {
      stack.push('executing passing test')
    })

    await runner()
      .configure({
        files: [],
        refiner,
        reporters: {
          activated: [],
          list: [],
        },
        plugins: [retryPlugin],
      })
      .useEmitter(emitter)
      .runSuites(() => [suite])

    await wrapAssertions(async () => {
      assert.deepEqual(await getFailedTests(), { tests: ['failing test'] })
      assert.deepEqual(stack, ['executing failing test', 'executing passing test'])
    })

    await clearCache()
  })

  test('run only failed tests when failed flag is used', async () => {
    const stack: string[] = []

    const emitter = new Emitter()
    const refiner = new Refiner()

    function getSuite() {
      const suite = new Suite('same', emitter, refiner)
      createTest('failing test', emitter, refiner, new Error(), { suite }).run(() => {
        stack.push('executing failing test')
        throw new Error('Failing')
      })
      createTest('passing test', emitter, refiner, new Error(), { suite }).run(() => {
        stack.push('executing passing test')
      })

      return suite
    }

    function getExecutor(argv?: string[]) {
      return runner()
        .configure(
          {
            files: [],
            refiner,
            reporters: {
              activated: [],
              list: [],
            },
            plugins: [retryPlugin],
          },
          argv
        )
        .useEmitter(emitter)
    }

    await getExecutor().runSuites(() => [getSuite()])
    await wrapAssertions(async () => {
      assert.deepEqual(await getFailedTests(), { tests: ['failing test'] })
      assert.deepEqual(stack, ['executing failing test', 'executing passing test'])
    })

    await getExecutor(['--failed']).runSuites(() => [getSuite()])
    await wrapAssertions(async () => {
      assert.deepEqual(await getFailedTests(), { tests: ['failing test'] })
      assert.deepEqual(stack, [
        'executing failing test',
        'executing passing test',
        'executing failing test',
      ])
    })

    await clearCache()
  })

  test('run all tests when failed flag is not used', async () => {
    const stack: string[] = []

    const emitter = new Emitter()
    const refiner = new Refiner()

    function getSuite() {
      const suite = new Suite('same', emitter, refiner)
      createTest('failing test', emitter, refiner, new Error(), { suite }).run(() => {
        stack.push('executing failing test')
        throw new Error('Failing')
      })
      createTest('passing test', emitter, refiner, new Error(), { suite }).run(() => {
        stack.push('executing passing test')
      })

      return suite
    }

    function getExecutor(argv?: string[]) {
      return runner()
        .configure(
          {
            files: [],
            refiner,
            reporters: {
              activated: [],
              list: [],
            },
            plugins: [retryPlugin],
          },
          argv
        )
        .useEmitter(emitter)
    }

    await getExecutor().runSuites(() => [getSuite()])
    await wrapAssertions(async () => {
      assert.deepEqual(await getFailedTests(), { tests: ['failing test'] })
      assert.deepEqual(stack, ['executing failing test', 'executing passing test'])
    })

    await getExecutor([]).runSuites(() => [getSuite()])
    await wrapAssertions(async () => {
      assert.deepEqual(await getFailedTests(), { tests: ['failing test'] })
      assert.deepEqual(stack, [
        'executing failing test',
        'executing passing test',
        'executing failing test',
        'executing passing test',
      ])
    })

    await clearCache()
  })

  test('run all tests when there are no failing tests', async () => {
    const stack: string[] = []

    const emitter = new Emitter()
    const refiner = new Refiner()

    function getSuite() {
      const suite = new Suite('same', emitter, refiner)
      createTest('passing test', emitter, refiner, new Error(), { suite }).run(() => {
        stack.push('executing passing test')
      })

      return suite
    }

    function getExecutor(argv?: string[]) {
      return runner()
        .configure(
          {
            files: [],
            refiner,
            reporters: {
              activated: [],
              list: [],
            },
            plugins: [retryPlugin],
          },
          argv
        )
        .useEmitter(emitter)
    }

    await getExecutor().runSuites(() => [getSuite()])
    await wrapAssertions(async () => {
      assert.deepEqual(await getFailedTests(), { tests: [] })
      assert.deepEqual(stack, ['executing passing test'])
    })

    await getExecutor(['--failed']).runSuites(() => [getSuite()])
    await wrapAssertions(async () => {
      assert.deepEqual(await getFailedTests(), { tests: [] })
      assert.deepEqual(stack, ['executing passing test', 'executing passing test'])
    })

    await clearCache()
  })
})

test.describe('Runner | bail', () => {
  test('stop after a failing test', async () => {
    const stack: string[] = []

    const emitter = new Emitter()
    const refiner = new Refiner()

    const suite = new Suite('same', emitter, refiner)
    createTest('failing test', emitter, refiner, new Error(), { suite }).run(() => {
      stack.push('executing failing test')
      throw new Error('Failing')
    })
    createTest('passing test', emitter, refiner, new Error(), { suite }).run(() => {
      stack.push('executing passing test')
    })

    await runner()
      .bail()
      .configure({
        files: [],
        refiner,
        reporters: {
          activated: [],
          list: [],
        },
      })
      .useEmitter(emitter)
      .runSuites(() => [suite])

    await wrapAssertions(async () => {
      assert.deepEqual(stack, ['executing failing test'])
    })
  })

  test('run all suites when bailLayer is set to suite', async () => {
    const stack: string[] = []

    const emitter = new Emitter()
    const refiner = new Refiner()

    const unit = new Suite('unit', emitter, refiner)
    unit.bail()
    const functional = new Suite('functional', emitter, refiner)
    functional.bail()

    createTest('failing unit test', emitter, refiner, new Error(), { suite: unit }).run(() => {
      stack.push('executing failing unit test')
      throw new Error('Failing')
    })
    createTest('passing unit test', emitter, refiner, new Error(), { suite: unit }).run(() => {
      stack.push('executing passing unit test')
    })

    createTest('failing functional test', emitter, refiner, new Error(), { suite: functional }).run(
      () => {
        stack.push('executing failing functional test')
        throw new Error('Failing')
      }
    )
    createTest('passing functional test', emitter, refiner, new Error(), { suite: functional }).run(
      () => {
        stack.push('executing passing functional test')
      }
    )

    await runner()
      .configure({
        files: [],
        refiner,
        reporters: {
          activated: [],
          list: [],
        },
      })
      .useEmitter(emitter)
      .runSuites(() => [unit, functional])

    await wrapAssertions(async () => {
      assert.deepEqual(stack, ['executing failing unit test', 'executing failing functional test'])
    })
  })

  test('run all groups when bailLayer is set to group', async () => {
    const stack: string[] = []

    const emitter = new Emitter()
    const refiner = new Refiner()

    const unit = new Suite('unit', emitter, refiner)

    const group1 = createTestGroup('group 1', emitter, refiner, { suite: unit })
    group1.bail()

    const group2 = createTestGroup('group 2', emitter, refiner, { suite: unit })
    group2.bail()

    createTest('failing group 1 test', emitter, refiner, new Error(), {
      suite: unit,
      group: group1,
    }).run(() => {
      stack.push('executing failing group 1 test')
      throw new Error('Failing')
    })
    createTest('passing group 1 test', emitter, refiner, new Error(), {
      suite: unit,
      group: group1,
    }).run(() => {
      stack.push('executing passing group 1 test')
    })

    createTest('failing group 2 test', emitter, refiner, new Error(), {
      suite: unit,
      group: group2,
    }).run(() => {
      stack.push('executing failing group 2 test')
      throw new Error('Failing')
    })
    createTest('passing group 1 test', emitter, refiner, new Error(), {
      suite: unit,
      group: group2,
    }).run(() => {
      stack.push('executing passing group 2 test')
    })

    await runner()
      .configure({
        files: [],
        refiner,
        reporters: {
          activated: [],
          list: [],
        },
      })
      .useEmitter(emitter)
      .runSuites(() => [unit])

    await wrapAssertions(async () => {
      assert.deepEqual(stack, ['executing failing group 1 test', 'executing failing group 2 test'])
    })
  })
})

test.describe('Runner | disallowPinnedTests plugin', () => {
  test('fail when one or more tests are pinned', async () => {
    const stack: string[] = []
    let fatalError: Error

    const emitter = new Emitter()
    const refiner = new Refiner()

    const suite = new Suite('same', emitter, refiner)
    createTest('pinned test', emitter, refiner, new Error(), { suite })
      .run(() => {
        stack.push('executing pinned test')
      })
      .pin()

    createTest('passing test', emitter, refiner, new Error(), { suite }).run(() => {
      stack.push('executing passing test')
    })

    try {
      await runner()
        .configure({
          files: [],
          refiner,
          reporters: {
            activated: [],
            list: [],
          },
          plugins: [disallowPinnedTests()],
        })
        .useEmitter(emitter)
        .runSuites(() => [suite])
    } catch (error) {
      fatalError = error
    }

    await wrapAssertions(async () => {
      assert.equal(
        fatalError.message,
        'Pinning tests are disallowed by the "disallowPinnedTests" plugin. Use the "--list-pinned" flag to list pinned tests'
      )
      assert.deepEqual(stack, [])
    })
  })

  test('use custom error message', async () => {
    const stack: string[] = []
    let fatalError: Error

    const emitter = new Emitter()
    const refiner = new Refiner()

    const suite = new Suite('same', emitter, refiner)
    createTest('pinned test', emitter, refiner, new Error(), { suite })
      .run(() => {
        stack.push('executing pinned test')
      })
      .pin()

    createTest('passing test', emitter, refiner, new Error(), { suite }).run(() => {
      stack.push('executing passing test')
    })

    try {
      await runner()
        .configure({
          files: [],
          refiner,
          reporters: {
            activated: [],
            list: [],
          },
          plugins: [
            disallowPinnedTests({
              errorMessage: '{{test}} cannot be pinned',
            }),
          ],
        })
        .useEmitter(emitter)
        .runSuites(() => [suite])
    } catch (error) {
      fatalError = error
    }

    await wrapAssertions(async () => {
      assert.equal(fatalError.message, 'pinned test cannot be pinned')
      assert.deepEqual(stack, [])
    })
  })

  test('do not fail when disallow option is disabled', async () => {
    const stack: string[] = []
    let fatalError: Error

    const emitter = new Emitter()
    const refiner = new Refiner()

    const suite = new Suite('same', emitter, refiner)
    createTest('pinned test', emitter, refiner, new Error(), { suite })
      .run(() => {
        stack.push('executing pinned test')
      })
      .pin()

    createTest('passing test', emitter, refiner, new Error(), { suite }).run(() => {
      stack.push('executing passing test')
    })

    try {
      await runner()
        .configure({
          files: [],
          refiner,
          reporters: {
            activated: [],
            list: [],
          },
          plugins: [
            disallowPinnedTests({
              disallow: false,
              errorMessage: '{{test}} cannot be pinned',
            }),
          ],
        })
        .useEmitter(emitter)
        .runSuites(() => [suite])
    } catch (error) {
      fatalError = error
    }

    await wrapAssertions(async () => {
      assert.isUndefined(fatalError)
      assert.deepEqual(stack, ['executing pinned test'])
    })
  })
})

test.describe('Automatic duration history and worker coordination', () => {
  async function fixture(context: NodeTestContext) {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const cwd = await mkdtemp(fileURLToPath(new URL('../.automatic-', import.meta.url)))
    context.after(() => rm(cwd, { recursive: true, force: true }))
    await writeFile(`${cwd}/package.json`, JSON.stringify({ private: true }))
    return {
      cwd,
      entry: fileURLToPath(new URL('../tests_helpers/automatic_worker.mjs', import.meta.url)),
      loader: import.meta.resolve('@poppinss/ts-exec'),
    }
  }
  async function serial(cwd: string, entry: string, loader: string, args: string[] = []) {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)(process.execPath, [`--import=${loader}`, entry, ...args], { cwd })
  }
  async function json(file: string): Promise<unknown> {
    const { readFile } = await import('node:fs/promises')
    return JSON.parse(await readFile(file, 'utf8'))
  }

  test('learn and reload timings automatically, recover corrupt history, and avoid partial updates', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { readHistory } = await import('../src/duration_history.js')
    const { readFile, writeFile } = await import('node:fs/promises')
    await serial(cwd, entry, loader)
    const history = await readHistory(`${cwd}/history.json`, cwd, true)
    assert.lengthOf(Object.keys(history.durations), 6)
    const saved = await readFile(`${cwd}/history.json`, 'utf8')
    await serial(cwd, entry, loader, ['--tests=case 0'])
    assert.equal(await readFile(`${cwd}/history.json`, 'utf8'), saved)
    assert.containSubset(await json(`${cwd}/observed-serial.json`), {
      estimates: history.durations,
      executed: [0],
    })
    await writeFile(`${cwd}/history.json`, '{broken')
    await serial(cwd, entry, loader)
    const recovered = await readHistory(`${cwd}/history.json`, cwd, true)
    assert.lengthOf(Object.keys(recovered.durations), 6)
  })

  test('merge failed tests from workers and rerun the same frozen failure selection', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { runParallel } = await import('../src/parallel.js')
    const options = {
      command: process.execPath,
      args: [`--import=${loader}`, entry],
      cwd,
      workers: 2,
      historyFile: 'history.json',
      stdio: 'ignore' as const,
    }
    const failed = await runParallel({ ...options, env: { TEST_FAIL: '1' } })
    assert.notEqual(failed.exitCode, 0)
    assert.isFalse(failed.historyUpdated)
    const cached = await getFailedTests(cwd)
    assert.deepEqual(cached.tests?.sort(), ['case 0', 'case 1'])
    const rerun = await runParallel({ ...options, args: [...options.args, '--failed'] })
    assert.equal(rerun.exitCode, 0)
    assert.isFalse(rerun.historyUpdated)
    const observed = await Promise.all([1, 2].map((id) => json(`${cwd}/observed-${id}.json`)))
    assert.containSubset(observed, [{ executed: [0] }, { executed: [1] }])
    const cleared = await getFailedTests(cwd)
    assert.deepEqual(cleared.tests, [])
  })

  test('assign shards, merge learned timings, and reuse one snapshot for every worker', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { runParallel } = await import('../src/parallel.js')
    const { readHistory } = await import('../src/duration_history.js')
    const options = {
      command: process.execPath,
      args: [`--import=${loader}`, entry],
      cwd,
      workers: 2,
      historyFile: 'history.json',
      stdio: 'ignore' as const,
    }
    const first = await runParallel(options)
    assert.equal(first.exitCode, 0)
    assert.isTrue(first.historyUpdated)
    const cold = await Promise.all([1, 2].map((id) => json(`${cwd}/observed-${id}.json`)))
    assert.containSubset(cold, [
      { executed: [0, 2, 4], estimates: {} },
      { executed: [1, 3, 5], estimates: {} },
    ])
    const history = await readHistory(`${cwd}/history.json`, cwd, true)
    assert.lengthOf(Object.keys(history.durations), 6)
    const second = await runParallel(options)
    assert.equal(second.exitCode, 0)
    assert.isTrue(second.historyUpdated)
    const warm = (await Promise.all([1, 2].map((id) => json(`${cwd}/observed-${id}.json`)))) as {
      executed: number[]
      estimates: Record<string, number>
    }[]
    assert.deepEqual(warm[0].estimates, history.durations)
    assert.deepEqual(warm[1].estimates, history.durations)
    assert.deepEqual(
      warm.flatMap((row) => row.executed).sort((a, b) => a - b),
      [0, 1, 2, 3, 4, 5]
    )
    assert.notDeepEqual(
      warm.map((row) => row.executed),
      [
        [0, 2, 4],
        [1, 3, 5],
      ]
    )
  })

  test('leave the cache unchanged on test failure and reject missing or tampered coordination', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { runParallel } = await import('../src/parallel.js')
    const { readFile, readdir } = await import('node:fs/promises')
    await serial(cwd, entry, loader)
    const saved = await readFile(`${cwd}/history.json`, 'utf8')
    const options = {
      command: process.execPath,
      args: [`--import=${loader}`, entry],
      cwd,
      workers: 2,
      historyFile: 'history.json',
      stdio: 'ignore' as const,
    }
    for (const env of [
      { TEST_FAIL: '1' },
      { TEST_NO_HISTORY: '1' },
      { TEST_TAMPER: '1' },
      { TEST_DUPLICATE_OUTPUT: '1' },
    ]) {
      const result = await runParallel({ ...options, env })
      assert.notEqual(result.exitCode, 0)
      assert.isFalse(result.historyUpdated)
      assert.equal(await readFile(`${cwd}/history.json`, 'utf8'), saved)
      const names = await readdir(cwd)
      assert.deepEqual(
        names.filter((name) => name.startsWith('run-')),
        []
      )
    }
  })

  test('propagate spawn errors and cancellation without leaving workers running', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { runParallel } = await import('../src/parallel.js')
    const { readFile } = await import('node:fs/promises')
    const failed = await runParallel({
      command: `${cwd}/missing-command`,
      cwd,
      workers: 1,
      stdio: 'ignore',
    })
    assert.equal(failed.exitCode, 1)
    const controller = new AbortController()
    const pending = runParallel({
      command: process.execPath,
      args: [`--import=${loader}`, entry],
      cwd,
      workers: 1,
      historyFile: 'history.json',
      stdio: 'ignore',
      signal: controller.signal,
      env: { TEST_HANG: '1' },
    })
    let pid: number | undefined
    for (let attempt = 0; attempt < 500; attempt++) {
      try {
        pid = (JSON.parse(await readFile(`${cwd}/started-1.json`, 'utf8')) as { pid: number }).pid
        break
      } catch {
        await new Promise((done) => setTimeout(done, 10))
      }
    }
    controller.abort()
    const stopped = await pending
    assert.isDefined(pid)
    assert.equal(stopped.exitCode, 130)
    assert.throws(() => process.kill(pid!, 0))
  })

  test('keep the planning snapshot stable when another run updates the cache', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { runParallel } = await import('../src/parallel.js')
    const { readHistory, writeHistory } = await import('../src/duration_history.js')
    const { readFile, writeFile } = await import('node:fs/promises')
    await serial(cwd, entry, loader)
    const history = await readHistory(`${cwd}/history.json`, cwd, true)
    const saved = await readFile(`${cwd}/history.json`, 'utf8')
    const controller = new AbortController()
    const pending = runParallel({
      command: process.execPath,
      args: [`--import=${loader}`, entry],
      cwd,
      workers: 2,
      historyFile: 'history.json',
      stdio: 'ignore',
      signal: controller.signal,
      workerEnv: (id) => (id === 2 ? { TEST_START_GATE: 'release-worker-2' } : {}),
    })
    context.after(async () => {
      controller.abort()
      await pending
    })
    let finishedFirst = false
    for (let attempt = 0; attempt < 500; attempt++) {
      try {
        await readFile(`${cwd}/observed-1.json`, 'utf8')
        finishedFirst = true
        break
      } catch {
        await new Promise((done) => setTimeout(done, 10))
      }
    }
    assert.isTrue(finishedFirst)
    assert.equal(await readFile(`${cwd}/history.json`, 'utf8'), saved)
    await writeHistory(`${cwd}/history.json`, {
      ...history,
      durations: { 'default:future.spec.ts': 9999 },
    })
    await writeFile(`${cwd}/release-worker-2`, '')
    const result = await pending
    assert.equal(result.exitCode, 0)
    const second = (await json(`${cwd}/observed-2.json`)) as { estimates: Record<string, number> }
    assert.deepEqual(second.estimates, history.durations)
    const merged = await readHistory(`${cwd}/history.json`, cwd, true)
    assert.equal(merged.durations['default:future.spec.ts'], 9999)
    assert.lengthOf(Object.keys(merged.durations), 7)
  })

  test('validate coordinator options and run the CLI without handwritten shard arguments', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { runParallel } = await import('../src/parallel.js')
    for (const workers of [0, -1, 1.5, 257]) {
      await rejects(runParallel({ command: process.execPath, cwd, workers }), /workers/)
    }
    await rejects(
      runParallel({ command: process.execPath, args: ['--shard=1/2'], cwd }),
      /automatically/
    )
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { fileURLToPath } = await import('node:url')
    const cli = fileURLToPath(new URL('../bin/parallel.ts', import.meta.url))
    const result = await promisify(execFile)(
      process.execPath,
      [
        `--import=${loader}`,
        cli,
        '--workers',
        '2',
        '--history=history.json',
        `--cwd=${cwd}`,
        '--',
        process.execPath,
        `--import=${loader}`,
        entry,
      ],
      { env: { ...process.env, TEST_NO_PLUGIN: '1' } }
    )
    assert.include(result.stdout, 'workers=2 exit=0 timings=updated')
    const { readHistory } = await import('../src/duration_history.js')
    const history = await readHistory(`${cwd}/history.json`, cwd, true)
    assert.lengthOf(Object.keys(history.durations), 6)
  })
})
