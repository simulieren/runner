/*
 * @japa/runner
 *
 * (c) Japa
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * AdonisJS test workers need their own database, cache, search, HTTP and mail
 * resources. This module derives the whole set from the worker id so an app does
 * not hand-roll port arithmetic in every project.
 *
 * It only produces values and environment variables; it does not create the
 * resources. Provisioning (creating databases, starting services) remains the
 * application's job, because only the app knows its services.
 */
export type AdonisWorkerResources = {
  worker: number
  database: string
  redisHost: string
  redisPort: number
  searchUrl: string
  searchPrefix: string
  httpHost: string
  httpPort: number
  appUrl: string
  smtpHost: string
  smtpPort: number
  mailpitUrl: string
  mailpitApiUrl: string
}

export type AdonisWorkerConfig = {
  databasePrefix?: string
  redisHost?: string
  redisBasePort?: number
  searchHost?: string
  searchBasePort?: number
  searchPrefix?: string
  httpHost?: string
  httpBasePort?: number
  smtpHost?: string
  smtpBasePort?: number
  mailpitBasePort?: number
}

function port(base: number, worker: number) {
  const value = base + worker
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Derived port ${value} is out of range for worker ${worker}`)
  }
  return value
}

/**
 * Build the isolated resource set for one worker.
 *
 * Worker ids start at 1. Ports are `base + worker`, so worker 1 on base 26380 is
 * 26381 and two workers never collide.
 */
export function adonisWorkerResources(
  worker: number,
  config: AdonisWorkerConfig = {}
): AdonisWorkerResources {
  if (!Number.isInteger(worker) || worker < 1 || worker > 64) {
    throw new Error('worker must be an integer between 1 and 64')
  }

  const redisHost = config.redisHost ?? '127.0.0.1'
  const httpHost = config.httpHost ?? '127.0.0.1'
  const smtpHost = config.smtpHost ?? '127.0.0.1'
  const searchHost = config.searchHost ?? '127.0.0.1'
  const databasePrefix = config.databasePrefix ?? 'japa_speed_worker'
  const searchPrefix = config.searchPrefix ?? 'japa_speed_validation'
  const httpPort = port(config.httpBasePort ?? 24330, worker)
  const mailpitPort = port(config.mailpitBasePort ?? 28024, worker)

  return {
    worker,
    database: `${databasePrefix}${worker}`,
    redisHost,
    redisPort: port(config.redisBasePort ?? 26380, worker),
    searchUrl: `http://${searchHost}:${port(config.searchBasePort ?? 28180, worker)}`,
    searchPrefix: `${searchPrefix}_${worker}`,
    httpHost,
    httpPort,
    appUrl: `http://${httpHost}:${httpPort}`,
    smtpHost,
    smtpPort: port(config.smtpBasePort ?? 21024, worker),
    mailpitUrl: `http://${smtpHost}:${mailpitPort}`,
    mailpitApiUrl: `http://${smtpHost}:${mailpitPort}/api/v1`,
  }
}

/**
 * Apply the resources to the standard AdonisJS/lab environment variable names.
 * Search variable names differ between providers, so the values are also
 * returned for the caller to map.
 */
export function applyAdonisWorkerEnv(
  resources: AdonisWorkerResources,
  env: NodeJS.ProcessEnv = process.env
) {
  env.DB_DATABASE = resources.database
  env.REDIS_HOST = resources.redisHost
  env.REDIS_PORT = String(resources.redisPort)
  env.TYPESENSE_NODE_URL = resources.searchUrl
  env.TYPESENSE_COLLECTION_PREFIX = resources.searchPrefix
  env.HOST = resources.httpHost
  env.PORT = String(resources.httpPort)
  env.APP_URL = resources.appUrl
  env.SMTP_HOST = resources.smtpHost
  env.SMTP_PORT = String(resources.smtpPort)
  env.MAILPIT_URL = resources.mailpitUrl
  env.MAILPIT_API_URL = resources.mailpitApiUrl
  return resources
}

/**
 * Fail fast when a worker is pointed at another worker's resources. Returns
 * normally when everything matches, otherwise throws naming the first mismatch.
 */
export function assertAdonisWorkerIsolation(input: {
  worker: number
  expected: AdonisWorkerResources
  actual: AdonisWorkerResources
}) {
  const { worker, expected, actual } = input
  if (worker !== expected.worker) {
    throw new Error(`Worker id ${worker} does not match resources for ${expected.worker}`)
  }

  const fields: (keyof AdonisWorkerResources)[] = [
    'database',
    'redisHost',
    'redisPort',
    'searchUrl',
    'searchPrefix',
    'httpHost',
    'httpPort',
    'appUrl',
    'smtpHost',
    'smtpPort',
    'mailpitUrl',
  ]
  for (const field of fields) {
    if (actual[field] !== expected[field]) {
      throw new Error(
        `Worker ${worker} resource mismatch for ${String(field)}: ` +
          `expected ${String(expected[field])}, received ${String(actual[field])}`
      )
    }
  }
}
