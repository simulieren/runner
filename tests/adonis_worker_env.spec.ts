/*
 * @japa/runner
 *
 * (c) Japa
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { assert } from 'chai'
import { test } from 'node:test'
import { workerResources, workerEnv, assertWorkerIsolation } from '../packages/adonis/index.js'

test.describe('Adonis worker resources', () => {
  test('derive distinct resources for each worker', () => {
    const first = workerResources(1)
    const second = workerResources(2)

    assert.equal(first.database, 'japa_test_1')
    assert.equal(second.database, 'japa_test_2')
    assert.equal(first.redisPort, 26381)
    assert.equal(second.redisPort, 26382)
    assert.equal(first.searchUrl, 'http://127.0.0.1:28181')
    assert.equal(first.searchPrefix, 'japa_validation_1')
    assert.equal(first.httpPort, 24331)
    assert.equal(first.appUrl, 'http://127.0.0.1:24331')
    assert.equal(first.smtpPort, 21025)
    assert.equal(first.mailpitUrl, 'http://127.0.0.1:28025')
    assert.equal(first.mailpitApiUrl, 'http://127.0.0.1:28025/api/v1')
  })

  test('honor custom bases and prefixes', () => {
    const resources = workerResources(3, {
      databasePrefix: 'acme_test_',
      redisBasePort: 30_000,
      searchPrefix: 'acme',
      httpBasePort: 40_000,
      smtpBasePort: 50_000,
      mailpitBasePort: 60_000,
    })

    assert.equal(resources.database, 'acme_test_3')
    assert.equal(resources.redisPort, 30_003)
    assert.equal(resources.searchPrefix, 'acme_3')
    assert.equal(resources.httpPort, 40_003)
    assert.equal(resources.smtpPort, 50_003)
    assert.equal(resources.mailpitUrl, 'http://127.0.0.1:60003')
  })

  test('reject invalid worker ids and ports', () => {
    assert.throws(() => workerResources(0), /worker must be an integer/)
    assert.throws(() => workerResources(1.5), /worker must be an integer/)
    assert.throws(() => workerResources(1, { redisBasePort: 65_535 }), /out of range for worker 1/)
  })

  test('apply the standard environment names', () => {
    const env: NodeJS.ProcessEnv = {}
    Object.assign(env, workerEnv(workerResources(4)))

    assert.equal(env.DB_DATABASE, 'japa_test_4')
    assert.equal(env.REDIS_PORT, '26384')
    assert.equal(env.TYPESENSE_NODE_URL, 'http://127.0.0.1:28184')
    assert.equal(env.TYPESENSE_COLLECTION_PREFIX, 'japa_validation_4')
    assert.equal(env.PORT, '24334')
    assert.equal(env.APP_URL, 'http://127.0.0.1:24334')
    assert.equal(env.SMTP_PORT, '21028')
    assert.equal(env.MAILPIT_API_URL, 'http://127.0.0.1:28028/api/v1')
  })

  test('accept matching resources and name the first mismatch', () => {
    const expected = workerResources(5)
    const env = workerEnv(expected)
    assert.doesNotThrow(() => assertWorkerIsolation(expected, env))

    const wrong = { ...env, REDIS_PORT: '1' }
    assert.throws(
      () => assertWorkerIsolation(expected, wrong),
      /resource mismatch for REDIS_PORT: expected 26385, received 1/
    )
  })
})
