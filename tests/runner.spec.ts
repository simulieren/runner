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
    assert.isTrue(failed.historyUpdated)
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

  test('apply title filtering after plugins mutate the filters', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { readFile, writeFile } = await import('node:fs/promises')
    for (let index = 0; index < 6; index++) await writeFile(`${cwd}/file${index}.spec.ts`, '')
    await serial(cwd, entry, loader, ['--prepare-caches'])
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)(
      process.execPath,
      [`--import=${loader}`, entry, '--agent', '--tests=case 3'],
      {
        cwd,
        env: {
          ...process.env,
          TEST_PLUGIN_FILTER: 'case 5',
          TEST_OBSERVED: `${cwd}/observed-serial.json`,
        },
      }
    )
    const observed = JSON.parse(await readFile(`${cwd}/observed-serial.json`, 'utf8'))
    assert.deepEqual(observed.executed, [5])
  })

  test('narrow imported files by title filter without changing the selection', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { readFile, writeFile } = await import('node:fs/promises')
    for (let index = 0; index < 6; index++) await writeFile(`${cwd}/file${index}.spec.ts`, '')
    const run = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      await promisify(execFile)(process.execPath, [`--import=${loader}`, entry, ...args], {
        cwd,
        env: { ...process.env, TEST_OBSERVED: `${cwd}/observed-serial.json`, ...env },
      }).catch(() => {})
      return JSON.parse(await readFile(`${cwd}/observed-serial.json`, 'utf8'))
    }

    // Build the index from a prepare run, then filter by title.
    await run(['--prepare-caches'])
    const filtered = await run(['--tests=case 3'])
    assert.deepEqual(filtered.executed, [3])
    assert.deepEqual(filtered.imported, ['file3.spec.ts'])

    // Disabling the index must select the same tests, importing every file.
    const unfiltered = await run(['--tests=case 3'], { JAPA_NO_SELECTION_INDEX: '1' })
    assert.deepEqual(unfiltered.executed, [3])
    assert.lengthOf(unfiltered.imported, 6)

    // A file that changed since indexing is always imported.
    await writeFile(`${cwd}/file5.spec.ts`, '// changed\n')
    const changed = await run(['--tests=case 3'])
    assert.deepEqual(changed.executed, [3])
    assert.sameMembers(changed.imported, ['file3.spec.ts', 'file5.spec.ts'])
  })

  test('learn passing files from a failing run and keep estimates of failing files', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { runParallel } = await import('../src/parallel.js')
    const { readHistory, writeHistory } = await import('../src/duration_history.js')
    const stale = {
      'default:file0.spec.ts': 5000,
      'default:file1.spec.ts': 5000,
      'default:file2.spec.ts': 5000,
    }
    await writeHistory(`${cwd}/history.json`, { version: 1, cwd, durations: stale })
    const options = {
      command: process.execPath,
      args: [`--import=${loader}`, entry],
      cwd,
      workers: 2,
      historyFile: 'history.json',
      stdio: 'ignore' as const,
    }
    const parallel = await runParallel({ ...options, env: { TEST_FAIL: '1' } })
    assert.notEqual(parallel.exitCode, 0)
    assert.isTrue(parallel.historyUpdated)
    const learned = await readHistory(`${cwd}/history.json`, cwd, true)
    assert.equal(learned.durations['default:file0.spec.ts'], 5000)
    assert.equal(learned.durations['default:file1.spec.ts'], 5000)
    assert.isBelow(learned.durations['default:file2.spec.ts'], 5000)
    assert.isAbove(learned.durations['default:file2.spec.ts'], 0)
    assert.lengthOf(Object.keys(learned.durations), 6)

    await writeHistory(`${cwd}/history.json`, { version: 1, cwd, durations: stale })
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)(process.execPath, [`--import=${loader}`, entry], {
      cwd,
      env: { ...process.env, TEST_FAIL: '1' },
    }).catch(() => {})
    const serialLearned = await readHistory(`${cwd}/history.json`, cwd, true)
    assert.equal(serialLearned.durations['default:file0.spec.ts'], 5000)
    assert.isBelow(serialLearned.durations['default:file2.spec.ts'], 5000)
  })

  test('leave the cache unchanged on hook failure and reject missing or tampered coordination', async (context) => {
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
      { TEST_HOOK_FAIL: '1' },
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

  test('run only files affected by changed paths, and fall back when unsure', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { readFile, writeFile } = await import('node:fs/promises')
    for (let index = 0; index < 6; index++) await writeFile(`${cwd}/file${index}.spec.ts`, '')
    const run = async (args: string[]) => {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      await promisify(execFile)(process.execPath, [`--import=${loader}`, entry, ...args], {
        cwd,
        env: { ...process.env, TEST_OBSERVED: `${cwd}/observed-serial.json` },
      }).catch(() => {})
      return JSON.parse(await readFile(`${cwd}/observed-serial.json`, 'utf8'))
    }

    // Agent/full runs record dependencies for the next one.
    await run(['--agent'])
    const { dependencyFile } = await import('../src/cache_paths.js')
    const depsRaw = await readFile(dependencyFile(cwd), 'utf8').catch(() => 'MISSING')
    const deps = JSON.parse(depsRaw)
    assert.equal(Object.keys(deps.files).length, 6, depsRaw.slice(0, 400))

    // A changed test file selects itself.
    const changed = await run(['--changed=file1.spec.ts'])
    assert.deepEqual(changed.executed, [1])

    // A path nothing imports falls back to the full suite.
    const unknown = await run(['--changed=an/unseen/module.ts'])
    assert.deepEqual(
      unknown.executed.sort((a: number, b: number) => a - b),
      [0, 1, 2, 3, 4, 5]
    )
  })

  test('apply one changed-file selection to managed workers', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { readFile, writeFile } = await import('node:fs/promises')
    for (let index = 0; index < 6; index++) await writeFile(`${cwd}/file${index}.spec.ts`, '')
    await serial(cwd, entry, loader, ['--prepare-caches'])
    const { runParallel } = await import('../src/parallel.js')
    const result = await runParallel({
      command: process.execPath,
      args: [`--import=${loader}`, entry, '--changed=file0.spec.ts'],
      cwd,
      workers: 1,
      historyFile: 'history.json',
      stdio: 'ignore' as const,
      env: { TEST_OBSERVED: `${cwd}/observed-serial.json` },
    })
    assert.equal(result.exitCode, 0)
    const observed = JSON.parse(await readFile(`${cwd}/observed-serial.json`, 'utf8'))
    assert.deepEqual(observed.executed, [0])
  })

  test('prepare ignores file filters and builds a complete dependency map', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { readFile, writeFile } = await import('node:fs/promises')
    for (let index = 0; index < 6; index++) await writeFile(`${cwd}/file${index}.spec.ts`, '')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)(
      process.execPath,
      [`--import=${loader}`, entry, '--prepare-caches', '--files=file0.spec.ts'],
      { cwd, env: { ...process.env, TEST_OBSERVED: `${cwd}/observed-serial.json` } }
    )
    const observed = JSON.parse(await readFile(`${cwd}/observed-serial.json`, 'utf8'))
    assert.lengthOf(observed.imported, 6)
    const { dependencyFile } = await import('../src/cache_paths.js')
    const map = JSON.parse(await readFile(dependencyFile(cwd), 'utf8'))
    assert.isTrue(map.complete)
    assert.lengthOf(Object.keys(map.files), 6)
  })

  test('prepare builds the caches without executing tests', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { readFile, readdir, writeFile } = await import('node:fs/promises')
    for (let index = 0; index < 6; index++) await writeFile(`${cwd}/file${index}.spec.ts`, '')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)(process.execPath, [`--import=${loader}`, entry, '--prepare-caches'], {
      cwd,
      env: { ...process.env, TEST_OBSERVED: `${cwd}/observed-serial.json` },
    })

    const observed = JSON.parse(await readFile(`${cwd}/observed-serial.json`, 'utf8'))
    assert.deepEqual(observed.executed, [])
    assert.lengthOf(observed.imported, 6)

    const cache = await readdir(`${cwd}/node_modules/.cache/japa`)
    const indexFiles = cache.filter((name) => name.startsWith('index-'))
    assert.lengthOf(indexFiles, 1)
    assert.equal(
      cache.some((name) => name.startsWith('dependencies-')),
      true
    )
    assert.isTrue(cache.some((name) => name.startsWith('dependencies-')))
  })

  test('--failed-new skips failures recorded in the baseline', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { readFile, writeFile } = await import('node:fs/promises')
    for (let index = 0; index < 6; index++) await writeFile(`${cwd}/file${index}.spec.ts`, '')
    const run = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      await promisify(execFile)(process.execPath, [`--import=${loader}`, entry, ...args], {
        cwd,
        env: { ...process.env, TEST_OBSERVED: `${cwd}/observed-serial.json`, ...env },
      }).catch(() => {})
      return JSON.parse(await readFile(`${cwd}/observed-serial.json`, 'utf8'))
    }

    // Populate the failed-test cache with the two fixture failures.
    await run([], { TEST_FAIL: '1' })
    await writeFile(
      `${cwd}/japa.baseline.json`,
      JSON.stringify({
        version: 1,
        failures: [
          { suite: 'default', file: 'file0.spec.ts', title: 'case 0' },
          { suite: 'default', file: 'file1.spec.ts', title: 'case 1' },
        ],
      })
    )

    const allFailures = await run(['--failed'], { TEST_FAIL: '1' })
    assert.deepEqual(allFailures.executed.sort(), [0, 1])

    const newOnly = await run(['--failed', '--failed-new'], { TEST_FAIL: '1' })
    assert.deepEqual(newOnly.executed, [])
  })

  test('write agent results to a file and reserve exit 2 for setup errors', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { readFile, writeFile } = await import('node:fs/promises')
    for (let index = 0; index < 6; index++) await writeFile(`${cwd}/file${index}.spec.ts`, '')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
      promisify(execFile)(process.execPath, [`--import=${loader}`, entry, ...args], {
        cwd,
        env: { ...process.env, ...env },
      }).then(
        (result) => ({ code: 0, stdout: result.stdout }),
        (error: { code?: number; stdout?: string }) => ({
          code: error.code ?? 1,
          stdout: error.stdout ?? '',
        })
      )

    const reported = await run(['--agent', '--agent-file=report.jsonl'], { TEST_FAIL: '1' })
    assert.equal(reported.code, 1)
    assert.equal(reported.stdout.includes('"event":"test"'), false)
    const raw = await readFile(`${cwd}/report.jsonl`, 'utf8')
    const lines = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(lines.at(-1).event, 'summary')
    assert.isAbove(lines.at(-1).selection.planned, 0)

    // An invalid shard fails during planning, which is an infrastructure error.
    const broken = await run(['--agent', '--shard=9/2'])
    assert.equal(broken.code, 2)
  })

  test('record source dependencies of an imported test file', async (context) => {
    const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
    const { pathToFileURL, fileURLToPath } = await import('node:url')
    const cwd = await mkdtemp(fileURLToPath(new URL('../.deps-', import.meta.url)))
    context.after(() => rm(cwd, { recursive: true, force: true }))
    await writeFile(`${cwd}/helper.mjs`, 'export const marker = 1\n')
    await writeFile(
      `${cwd}/thing.spec.mjs`,
      "import { marker } from './helper.mjs'\nexport default marker\n"
    )

    const { recordDependencies } = await import('../src/dependencies.js')
    const { dependencyFile } = await import('../src/cache_paths.js')
    const listeners = new Map<string, (payload?: unknown) => boolean | void>()
    const emitter = {
      on: (name: string, fn: (payload?: unknown) => boolean | void) => {
        listeners.set(name, fn)
        return () => listeners.delete(name)
      },
      once: (name: string, fn: (payload?: unknown) => boolean | void) => {
        listeners.set(name, fn)
      },
    }
    const config = {
      cwd,
      importer: async (url: URL) => {
        await import(url.href)
      },
    }
    await recordDependencies()({
      config,
      emitter,
    } as never)

    await config.importer(pathToFileURL(`${cwd}/thing.spec.mjs`))
    listeners.get('runner:end')?.()
    await new Promise((done) => setTimeout(done, 100))

    const map = JSON.parse(await readFile(dependencyFile(cwd), 'utf8'))
    assert.deepEqual(map.files['thing.spec.mjs'], ['helper.mjs', 'thing.spec.mjs'])
  })

  test('count only imports Node resolves when checking the graph', async () => {
    const { hasRuntimeRelativeImport } = await import('../src/dependencies.js')
    assert.isTrue(hasRuntimeRelativeImport("import { a } from './a.js'"))
    assert.isTrue(hasRuntimeRelativeImport("export { a } from '../a.js'"))
    assert.isTrue(hasRuntimeRelativeImport("import './side_effect.js'"))
    assert.isTrue(hasRuntimeRelativeImport("const m = await import('./lazy.js')"))
    assert.isTrue(hasRuntimeRelativeImport("const glob = 'tests/**/*.ts'\nimport('./later.js')"))
    assert.isFalse(hasRuntimeRelativeImport("import type { A } from './types.js'"))
    assert.isFalse(hasRuntimeRelativeImport("export type { A } from './types.js'"))
    assert.isFalse(hasRuntimeRelativeImport("/**\n * export { default } from './foo_job.js'\n */"))
    assert.isFalse(hasRuntimeRelativeImport("// import { a } from './a.js'"))
    assert.isFalse(hasRuntimeRelativeImport("import { a } from '#app/a'"))
  })

  test('complete the map for modules an app loads before configure', async (context) => {
    const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
    const { fileURLToPath, pathToFileURL } = await import('node:url')
    const cwd = await mkdtemp(fileURLToPath(new URL('../.deps-boot-', import.meta.url)))
    context.after(() => rm(cwd, { recursive: true, force: true }))
    await writeFile(`${cwd}/leaf.mjs`, 'export const leaf = 1\n')
    await writeFile(`${cwd}/booted.mjs`, "export { leaf } from './leaf.mjs'\n")
    await writeFile(
      `${cwd}/app.spec.mjs`,
      "import { leaf } from './booted.mjs'\nexport default leaf\n"
    )

    const { recordImportsFromStart, recordDependencies } = await import('../src/dependencies.js')
    const { dependencyFile } = await import('../src/cache_paths.js')
    assert.isTrue(recordImportsFromStart())
    // The framework boots, and imports booted.mjs, before Japa is configured.
    await import(pathToFileURL(`${cwd}/booted.mjs`).href)

    const listeners = new Map<string, () => void>()
    const emitter = { once: (name: string, fn: () => void) => listeners.set(name, fn) }
    const config = {
      cwd,
      importer: async (url: URL) => {
        await import(url.href)
      },
    }
    await recordDependencies()({ config, emitter, cliArgs: { prepareCaches: true } } as never)
    await config.importer(pathToFileURL(`${cwd}/app.spec.mjs`))
    listeners.get('runner:end')?.()
    await new Promise((done) => setTimeout(done, 100))

    const map = JSON.parse(await readFile(dependencyFile(cwd), 'utf8'))
    assert.deepEqual(map.files['app.spec.mjs'], ['app.spec.mjs', 'booted.mjs', 'leaf.mjs'])
    assert.isTrue(map.complete)
  })

  test('record a complete entry for every imported file, filtered or not', async (context) => {
    const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const cwd = await mkdtemp(fileURLToPath(new URL('../.index-', import.meta.url)))
    context.after(() => rm(cwd, { recursive: true, force: true }))
    await writeFile(`${cwd}/file.spec.ts`, '')

    const { writeSelectionIndex } = await import('../src/selection_index.js')
    const { indexFile } = await import('../src/cache_paths.js')
    // Importing registers every test in the file, whatever the filter is.
    const registered = {
      suites: [
        {
          name: 'default',
          stack: [
            {
              title: 'group',
              tests: [
                {
                  options: {
                    title: 'the title',
                    tags: [],
                    meta: { fileName: `${cwd}/file.spec.ts`, group: { title: 'group' } },
                  },
                },
                {
                  options: {
                    title: 'the other title',
                    tags: [],
                    meta: { fileName: `${cwd}/file.spec.ts`, group: { title: 'group' } },
                  },
                },
              ],
            },
          ],
        },
      ],
    }
    await writeSelectionIndex(registered as never, cwd)
    const index = JSON.parse(await readFile(indexFile(cwd), 'utf8'))
    assert.deepEqual(index.files['file.spec.ts'].tests, ['the title', 'the other title'])
    assert.deepEqual(index.files['file.spec.ts'].groups, ['group'])
  })

  test('use tracked cache files instead of the default cache directory', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { access, readFile, readdir, rm, writeFile } = await import('node:fs/promises')
    for (let index = 0; index < 6; index++) await writeFile(`${cwd}/file${index}.spec.ts`, '')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const flags = ['--cache-dir=.japa']

    await promisify(execFile)(
      process.execPath,
      [`--import=${loader}`, entry, '--prepare-caches', ...flags],
      {
        cwd,
      }
    )
    const tracked = await readdir(`${cwd}/.japa`)
    assert.equal(
      tracked.some((name) => name.startsWith('index-')),
      true
    )
    assert.equal(
      tracked.some((name) => name.startsWith('dependencies-')),
      true
    )
    // Preparing caches must not run application setup hooks.
    const setupRanDuringPrepare = await access(`${cwd}/setup-ran.json`).then(
      () => true,
      () => false
    )
    assert.isFalse(setupRanDuringPrepare)
    const defaultCache = await readdir(`${cwd}/node_modules/.cache/japa`).catch(() => [])
    assert.equal(
      defaultCache.some((name) => name.startsWith('index-') || name.startsWith('dependencies-')),
      false
    )

    // Removing the default cache must not lose selection: the tracked files are used.
    await rm(`${cwd}/node_modules/.cache/japa`, { recursive: true, force: true })
    await promisify(execFile)(
      process.execPath,
      [
        `--import=${loader}`,
        entry,
        '--tests=case 3',
        ...flags,
        '--agent',
        '--agent-file=report.jsonl',
      ],
      {
        cwd,
        env: {
          ...process.env,
          JAPA_AGENT_ALL: '1',
          TEST_OBSERVED: `${cwd}/observed-serial.json`,
        },
      }
    )
    await access(`${cwd}/setup-ran.json`)
    const observed = JSON.parse(await readFile(`${cwd}/observed-serial.json`, 'utf8'))
    assert.deepEqual(observed.executed, [3])
    const report = await readFile(`${cwd}/report.jsonl`, 'utf8')
    const summary = report
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .at(-1)
    assert.equal(summary.selection.skipped, 5)

    // The same filter without the index must select the same test.
    await promisify(execFile)(
      process.execPath,
      [
        `--import=${loader}`,
        entry,
        '--tests=case 3',
        ...flags,
        '--agent',
        '--agent-file=noindex.jsonl',
      ],
      {
        cwd,
        env: {
          ...process.env,
          JAPA_NO_SELECTION_INDEX: '1',
          JAPA_AGENT_ALL: '1',
          TEST_OBSERVED: `${cwd}/observed-noindex.json`,
        },
      }
    )
    const noIndex = JSON.parse(await readFile(`${cwd}/observed-noindex.json`, 'utf8'))
    assert.deepEqual(noIndex.executed, observed.executed)
  })

  test('japa-agent prepares caches and runs through the agent reporter', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { readFile, readdir, writeFile } = await import('node:fs/promises')
    for (let index = 0; index < 6; index++) await writeFile(`${cwd}/file${index}.spec.ts`, '')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { fileURLToPath } = await import('node:url')

    const wrapper = fileURLToPath(new URL('../bin/agent.ts', import.meta.url))
    const result = await promisify(execFile)(
      process.execPath,
      [
        `--import=${loader}`,
        wrapper,
        '--cwd',
        cwd,
        '--out',
        'report.jsonl',
        '--cache-dir',
        '.japa',
        '--',
        process.execPath,
        `--import=${loader}`,
        entry,
      ],
      { cwd }
    ).then(
      (value) => ({ code: 0, stderr: value.stderr }),
      (error: { code?: number; stderr?: string }) => ({
        code: error.code ?? 1,
        stderr: error.stderr,
      })
    )
    assert.equal(result.code, 0, result.stderr)

    const raw = await readFile(`${cwd}/report.jsonl`, 'utf8')
    const lines = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(lines.at(-1).event, 'summary')
    assert.equal(lines.at(-1).ok, true)
    // No git repository, so --changed=auto falls back to everything.
    assert.equal(lines.at(-1).selection.fallback, true)

    // The wrapper must honour --cache-dir for caches and metrics.
    const cache = await readdir(`${cwd}/.japa`)
    assert.equal(
      cache.some((name) => name.startsWith('index-')),
      true
    )
    assert.equal(
      cache.some((name) => name.startsWith('dependencies-')),
      true
    )
    assert.equal(cache.includes('agent-metrics.jsonl'), true)
  })

  test('never write a baseline from a partial serial selection', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { readFile, writeFile } = await import('node:fs/promises')
    for (let index = 0; index < 6; index++) await writeFile(`${cwd}/file${index}.spec.ts`, '')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = (args: string[]) =>
      promisify(execFile)(process.execPath, [`--import=${loader}`, entry, ...args], {
        cwd,
        env: { ...process.env, TEST_FAIL: '1' },
      }).catch(() => {})

    await run(['--update-baseline'])
    const full = JSON.parse(await readFile(`${cwd}/japa.baseline.json`, 'utf8'))
    assert.equal(full.failures.length, 2)

    // A title filter is a slice of the suite and must not replace the baseline.
    await run(['--update-baseline', '--tests=case 0'])
    const after = JSON.parse(await readFile(`${cwd}/japa.baseline.json`, 'utf8'))
    assert.deepEqual(after, full)
  })

  test('never write a baseline when global teardown fails', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { access, writeFile } = await import('node:fs/promises')
    for (let index = 0; index < 6; index++) await writeFile(`${cwd}/file${index}.spec.ts`, '')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const result = await promisify(execFile)(
      process.execPath,
      [`--import=${loader}`, entry, '--update-baseline'],
      {
        cwd,
        env: {
          ...process.env,
          TEST_FAIL: '1',
          TEST_GLOBAL_TEARDOWN_FAIL: '1',
        },
      }
    ).then(
      () => ({ code: 0 }),
      (error: { code?: number }) => ({ code: error.code })
    )
    assert.notEqual(result.code, 0)
    const exists = await access(`${cwd}/japa.baseline.json`).then(
      () => true,
      () => false
    )
    assert.isFalse(exists)
  })

  test('merge baseline failures once in the coordinator, not per worker', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { readFile } = await import('node:fs/promises')
    const { runParallel } = await import('../src/parallel.js')
    const options = {
      command: process.execPath,
      args: [`--import=${loader}`, entry, '--update-baseline'],
      cwd,
      workers: 2,
      historyFile: 'history.json',
      stdio: 'ignore' as const,
      updateBaseline: true,
    }
    const result = await runParallel({ ...options, env: { TEST_FAIL: '1' } })
    assert.notEqual(result.exitCode, 0)
    assert.isTrue(result.baselineUpdated)

    const baseline = JSON.parse(await readFile(`${cwd}/japa.baseline.json`, 'utf8'))
    assert.deepEqual(baseline.failures.map((failure: { file: string }) => failure.file).sort(), [
      'file0.spec.ts',
      'file1.spec.ts',
    ])

    // A partial selection must not replace the baseline with a slice.
    const { rm } = await import('node:fs/promises')
    await rm(`${cwd}/japa.baseline.json`)
    const partial = await runParallel({
      ...options,
      args: [...options.args, '--tests=case 0'],
      env: { TEST_FAIL: '1' },
    })
    assert.isFalse(partial.baselineUpdated)

    const changed = await runParallel({
      ...options,
      args: [...options.args, '--changed=file0.spec.ts'],
      env: { TEST_FAIL: '1' },
    })
    assert.isFalse(changed.baselineUpdated)
  })

  test('reject a parallel baseline update when a worker has a process error', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { writeFile } = await import('node:fs/promises')
    for (let index = 0; index < 6; index++) await writeFile(`${cwd}/file${index}.spec.ts`, '')
    const { runParallel } = await import('../src/parallel.js')
    const result = await runParallel({
      command: process.execPath,
      args: [`--import=${loader}`, entry, '--update-baseline'],
      cwd,
      workers: 2,
      historyFile: 'history.json',
      stdio: 'ignore' as const,
      updateBaseline: true,
      env: { TEST_FAIL: '1', TEST_LATE_UNHANDLED: '1' },
    })
    assert.notEqual(result.exitCode, 0)
    assert.isFalse(result.baselineUpdated)
  })

  test('merge agent reports from parallel workers', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { readFile, writeFile } = await import('node:fs/promises')
    for (let index = 0; index < 6; index++) await writeFile(`${cwd}/file${index}.spec.ts`, '')
    const { runParallel } = await import('../src/parallel.js')
    const result = await runParallel({
      command: process.execPath,
      args: [`--import=${loader}`, entry, '--agent-file=agent.jsonl'],
      cwd,
      workers: 2,
      historyFile: 'history.json',
      stdio: 'ignore' as const,
      env: { TEST_FAIL: '1' },
    })
    assert.notEqual(result.exitCode, 0)
    const report = await readFile(`${cwd}/agent.jsonl`, 'utf8')
    const lines = report
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.lengthOf(
      lines.filter((line) => line.event === 'test' && line.status === 'failed'),
      2
    )
    assert.equal(lines.at(-1).event, 'summary')
    assert.equal(lines.at(-1).total, 6)
    assert.equal(lines.at(-1).failed, 2)
  })

  test('do not let known failures suppress a late unhandled rejection', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { writeFile } = await import('node:fs/promises')
    for (let index = 0; index < 6; index++) await writeFile(`${cwd}/file${index}.spec.ts`, '')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = (env: NodeJS.ProcessEnv, args: string[] = []) =>
      promisify(execFile)(process.execPath, [`--import=${loader}`, entry, ...args], {
        cwd,
        env: { ...process.env, ...env },
      }).then(
        () => 0,
        (error: { code?: number }) => error.code ?? 1
      )
    await run({ TEST_FAIL: '1' }, ['--update-baseline'])
    assert.notEqual(
      await run({ TEST_FAIL: '1', TEST_LATE_UNHANDLED: '1' }, [
        '--allow-known-failures',
        '--agent',
      ]),
      0
    )
  })

  test('compare failures against a baseline and report agent-readable results', async (context) => {
    const { cwd, entry, loader } = await fixture(context)
    const { writeFile, readFile } = await import('node:fs/promises')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    for (let index = 0; index < 6; index++) await writeFile(`${cwd}/file${index}.spec.ts`, '')
    const run = async (
      args: string[],
      env: NodeJS.ProcessEnv = {}
    ): Promise<{ code: number; stdout: string }> => {
      try {
        const result = await promisify(execFile)(
          process.execPath,
          [`--import=${loader}`, entry, ...args],
          {
            cwd,
            env: { ...process.env, TEST_OBSERVED: `${cwd}/observed-serial.json`, ...env },
          }
        )
        return { code: 0, stdout: result.stdout }
      } catch (error) {
        const failed = error as { code?: number; stdout?: string }
        return { code: failed.code ?? 1, stdout: failed.stdout ?? '' }
      }
    }

    // No baseline: the failing run stays red.
    const red = await run(['--agent'], { TEST_FAIL: '1' })
    assert.equal(red.code, 1)
    const lines = String(red.stdout)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const failed = lines.filter((line) => line.event === 'test' && line.status === 'failed')
    assert.lengthOf(failed, 2)
    assert.include(failed[0].file, 'file0.spec.ts')
    assert.match(failed[0].errors[0].message, /Expected fixture failure/)
    assert.deepEqual(lines.at(-1).event, 'summary')
    assert.equal(lines.at(-1).ok, false)

    // A pathological error is clipped without turning the JSON line invalid.
    const long = await run(['--agent'], { TEST_LONG_ERROR: '1' })
    assert.equal(long.code, 1)
    const longLines = String(long.stdout).trim().split('\n')
    for (const line of longLines) {
      assert.isAtMost(line.length, 4000)
      assert.doesNotThrow(() => JSON.parse(line))
    }

    // Record those failures, then the same run is accepted as known.
    await run(['--update-baseline'], { TEST_FAIL: '1' })
    const baseline = JSON.parse(await readFile(`${cwd}/japa.baseline.json`, 'utf8'))
    assert.equal(baseline.failures.length, 2)
    assert.equal(baseline.failures[0].file, 'file0.spec.ts')

    const known = await run(['--allow-known-failures'], { TEST_FAIL: '1' })
    assert.equal(known.code, 0)

    // A setup/hook error is not a known test failure and must stay red.
    const hook = await run(['--allow-known-failures'], { TEST_FAIL: '1', TEST_HOOK_FAIL: '1' })
    assert.equal(hook.code, 1)

    // A test that fails for a different reason has a different identity, so it
    // is a regression even though the title matches nothing in the baseline.
    await writeFile(`${cwd}/japa.baseline.json`, JSON.stringify({ version: 1, failures: [] }))
    const different = await run(['--allow-known-failures'], { TEST_FAIL: '1' })
    assert.equal(different.code, 1)
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

test.describe('Agent loop safety', () => {
  test('never prune files for a negated tag filter', async () => {
    const { shouldSkipFile } = await import('../src/selection_index.js')
    const entry = { mtimeMs: 0, size: 0, tests: [], groups: [], tags: ['@github'] }
    assert.isFalse(shouldSkipFile(entry, { tags: ['~@github'] }))
    assert.isFalse(shouldSkipFile(entry, { tags: ['!slow'] }))
    assert.isTrue(shouldSkipFile(entry, { tags: ['@unit'] }))
  })

  test('treat a missing current summary as a non-comparable delta', async () => {
    const { diffReports } = await import('../src/agent_delta.js')
    const delta = diffReports({ summary: { total: 1 }, failures: [] }, { failures: [] })
    assert.isFalse(delta.comparable)
    assert.deepEqual(delta.counts, { previous: 0, current: 0, new: 0, fixed: 0 })
  })

  test('do not report fixed failures from a partial selection', async () => {
    const { diffFailures } = await import('../src/failure_baseline.js')
    const baseline = {
      version: 1 as const,
      failures: [
        { suite: 'default', file: 'a.spec.ts', title: 'a' },
        { suite: 'default', file: 'b.spec.ts', title: 'b' },
      ],
    }
    const observed = [baseline.failures[0]]
    assert.lengthOf(diffFailures(baseline, observed, { fullRun: false }).fixed, 0)
    assert.lengthOf(diffFailures(baseline, observed).fixed, 1)
  })

  test('treat file and failed filters as narrow selections', async () => {
    const { autoWorkerCount } = await import('../src/parallel.js')
    assert.equal(autoWorkerCount(['--files=user']), 1)
    assert.equal(autoWorkerCount(['--failed']), 1)
  })

  test('merge repeated retry failures once', async () => {
    const { diffFailures, mergeBaseline } = await import('../src/failure_baseline.js')
    const entry = { suite: 'default', file: 'a.spec.ts', title: 'a' }
    const merged = mergeBaseline({ version: 1, failures: [] }, [entry, entry])
    assert.lengthOf(merged.baseline.failures, 1)
    assert.equal(merged.baseline.failures[0].consecutive, 1)
    assert.lengthOf(merged.added, 1)

    const baseline = { version: 1 as const, failures: [entry] }
    const diff = diffFailures(baseline, [entry, entry])
    assert.lengthOf(diff.known, 1)
  })

  test('compare selection signatures and group identities in deltas', async () => {
    const { diffReports } = await import('../src/agent_delta.js')
    const selection = (signature: string) => ({
      mode: 'filtered',
      planned: 1,
      skipped: 1,
      signature,
    })
    const previous = {
      summary: { total: 1, selection: selection('a') },
      failures: [{ suite: 'unit', group: 'A', file: 'f.spec.ts', title: 'same' }],
    }
    const differentSelection = diffReports(previous, {
      summary: { total: 1, selection: selection('b') },
      failures: [{ suite: 'unit', group: 'B', file: 'f.spec.ts', title: 'same' }],
    })
    assert.isFalse(differentSelection.comparable)
    assert.lengthOf(differentSelection.fixed, 0)
    assert.lengthOf(differentSelection.newFailures, 1)

    const same = diffReports(previous, {
      summary: { total: 1, selection: selection('a') },
      failures: [{ suite: 'unit', group: 'A', file: 'f.spec.ts', title: 'same' }],
    })
    assert.isTrue(same.comparable)
    assert.lengthOf(same.newFailures, 0)
  })

  test('include groups in baseline identities', async () => {
    const { diffFailures } = await import('../src/failure_baseline.js')
    const baseline = {
      version: 2 as const,
      failures: [{ suite: 'default', group: 'A', file: 'a.spec.ts', title: 'same' }],
    }
    const observed = [{ suite: 'default', group: 'B', file: 'a.spec.ts', title: 'same' }]
    assert.lengthOf(diffFailures(baseline, observed).new, 1)
  })

  test('never prune a file that registers a pinned test', async () => {
    const { shouldSkipFile } = await import('../src/selection_index.js')
    const entry = {
      mtimeMs: 0,
      size: 0,
      tests: ['a'],
      groups: [],
      tags: [],
      pinned: true,
    }
    assert.isFalse(shouldSkipFile(entry, { tests: ['b'] }))
  })

  test('invalidate indexed freshness when a dependency changes', async () => {
    const { isFresh } = await import('../src/selection_index.js')
    const { mkdtemp, writeFile, stat, rm } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const cwd = await mkdtemp(fileURLToPath(new URL('../.fresh-', import.meta.url)))
    try {
      await writeFile(`${cwd}/test.spec.ts`, '')
      await writeFile(`${cwd}/helper.ts`, 'export const title = "old"\n')
      const testStats = await stat(`${cwd}/test.spec.ts`)
      const helper = await stat(`${cwd}/helper.ts`)
      const entry = {
        mtimeMs: testStats.mtimeMs,
        size: testStats.size,
        tests: ['old'],
        groups: [],
        tags: [],
        dependencies: {
          'helper.ts': { mtimeMs: helper.mtimeMs, size: helper.size },
        },
      }
      assert.isTrue(await isFresh(cwd, 'test.spec.ts', entry))
      await writeFile(`${cwd}/helper.ts`, 'export const title = "new"\n')
      assert.isFalse(await isFresh(cwd, 'test.spec.ts', entry))
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('reject malformed selection and dependency caches', async () => {
    const { emptyIndex, readIndex } = await import('../src/selection_index.js')
    const { parseDependencyMap } = await import('../src/dependencies.js')
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const cwd = await mkdtemp(fileURLToPath(new URL('../.cache-', import.meta.url)))
    try {
      await writeFile(`${cwd}/index.json`, JSON.stringify({ version: 1, files: null }))
      assert.deepEqual(await readIndex(`${cwd}/index.json`), emptyIndex())
      assert.deepEqual(parseDependencyMap({ version: 1, files: null }), {
        version: 1,
        complete: false,
        files: {},
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('reject an invalid japa-agent timeout', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { fileURLToPath } = await import('node:url')
    const wrapper = fileURLToPath(new URL('../bin/agent.ts', import.meta.url))
    const result = await promisify(execFile)(
      process.execPath,
      ['--import=@poppinss/ts-exec', wrapper, '--timeout=0', '--', process.execPath, '-e', '0'],
      { cwd: process.cwd() }
    ).then(
      () => ({ code: 0 }),
      (error: { code?: number }) => ({ code: error.code })
    )
    assert.equal(result.code, 2)
  })
})
