/*
 * @japa/adonis
 *
 * (c) Japa
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * AdonisJS helpers for isolated Japa test workers.
 *
 * Derive the whole resource set from a worker id instead of hand-rolling port
 * arithmetic in every app. The helpers only produce and validate values; they do
 * not create databases or start services, because only the application knows its
 * infrastructure.
 */

export type WorkerResources = {
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

export type WorkerConfig = {
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

/** Environment variable names used by AdonisJS and common test services. */
export type WorkerEnvNames = {
  database: string
  redisHost: string
  redisPort: string
  searchUrl: string
  searchPrefix: string
  httpHost: string
  httpPort: string
  appUrl: string
  smtpHost: string
  smtpPort: string
  mailpitUrl: string
  mailpitApiUrl: string
}

const DEFAULT_ENV_NAMES: WorkerEnvNames = {
  database: 'DB_DATABASE',
  redisHost: 'REDIS_HOST',
  redisPort: 'REDIS_PORT',
  searchUrl: 'TYPESENSE_NODE_URL',
  searchPrefix: 'TYPESENSE_COLLECTION_PREFIX',
  httpHost: 'HOST',
  httpPort: 'PORT',
  appUrl: 'APP_URL',
  smtpHost: 'SMTP_HOST',
  smtpPort: 'SMTP_PORT',
  mailpitUrl: 'MAILPIT_URL',
  mailpitApiUrl: 'MAILPIT_API_URL',
}

function derivedPort(base: number, worker: number) {
  const value = base + worker
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Derived port ${value} is out of range for worker ${worker}`)
  }
  return value
}

/**
 * Build the isolated resource set for one worker.
 *
 * Ports are `base + worker`, so worker 1 with a Redis base of 26380 uses 26381
 * and two workers never collide.
 */
export function workerResources(worker: number, config: WorkerConfig = {}): WorkerResources {
  if (!Number.isInteger(worker) || worker < 1 || worker > 64) {
    throw new Error('worker must be an integer between 1 and 64')
  }

  const redisHost = config.redisHost ?? '127.0.0.1'
  const httpHost = config.httpHost ?? '127.0.0.1'
  const smtpHost = config.smtpHost ?? '127.0.0.1'
  const searchHost = config.searchHost ?? '127.0.0.1'
  const databasePrefix = config.databasePrefix ?? 'japa_test_'
  const searchPrefix = config.searchPrefix ?? 'japa_validation'
  const httpPort = derivedPort(config.httpBasePort ?? 24330, worker)
  const mailpitPort = derivedPort(config.mailpitBasePort ?? 28024, worker)

  return {
    worker,
    database: `${databasePrefix}${worker}`,
    redisHost,
    redisPort: derivedPort(config.redisBasePort ?? 26380, worker),
    searchUrl: `http://${searchHost}:${derivedPort(config.searchBasePort ?? 28180, worker)}`,
    searchPrefix: `${searchPrefix}_${worker}`,
    httpHost,
    httpPort,
    appUrl: `http://${httpHost}:${httpPort}`,
    smtpHost,
    smtpPort: derivedPort(config.smtpBasePort ?? 21024, worker),
    mailpitUrl: `http://${smtpHost}:${mailpitPort}`,
    mailpitApiUrl: `http://${smtpHost}:${mailpitPort}/api/v1`,
  }
}

/**
 * Return the environment variables for a worker without mutating `process.env`.
 * The caller decides whether to apply them, which keeps this testable.
 */
export function workerEnv(
  resources: WorkerResources,
  names: Partial<WorkerEnvNames> = {}
): NodeJS.ProcessEnv {
  const keys = { ...DEFAULT_ENV_NAMES, ...names }
  return {
    [keys.database]: resources.database,
    [keys.redisHost]: resources.redisHost,
    [keys.redisPort]: String(resources.redisPort),
    [keys.searchUrl]: resources.searchUrl,
    [keys.searchPrefix]: resources.searchPrefix,
    [keys.httpHost]: resources.httpHost,
    [keys.httpPort]: String(resources.httpPort),
    [keys.appUrl]: resources.appUrl,
    [keys.smtpHost]: resources.smtpHost,
    [keys.smtpPort]: String(resources.smtpPort),
    [keys.mailpitUrl]: resources.mailpitUrl,
    [keys.mailpitApiUrl]: resources.mailpitApiUrl,
  }
}

/**
 * Fail fast when the environment points at another worker's resources. Reads the
 * environment directly; pass `env` only in tests.
 */
export function assertWorkerIsolation(
  resources: WorkerResources,
  env: NodeJS.ProcessEnv = process.env,
  names: Partial<WorkerEnvNames> = {}
) {
  const expected = workerEnv(resources, names)
  for (const [key, value] of Object.entries(expected)) {
    if (env[key] !== value) {
      throw new Error(
        `Worker ${resources.worker} resource mismatch for ${key}: ` +
          `expected ${String(value)}, received ${String(env[key])}`
      )
    }
  }
}
