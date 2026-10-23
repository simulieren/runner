// Lab probe: migrate one scratch database once, then freeze it as japa_speed_template.
// Worker databases can then be cloned with JAPA_EXPERIMENT_DB_TEMPLATE=1 node reset_databases.mjs N.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const root = join(import.meta.dirname, '..')
const psql = (sql) =>
  execFileSync(
    'docker',
    [
      'compose',
      '-p',
      'japa-speed-atstest',
      '-f',
      join(root, 'compose.yaml'),
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { stdio: 'pipe' }
  )
const started = performance.now()
psql('DROP DATABASE IF EXISTS japa_speed_template WITH (FORCE)')
psql('DROP DATABASE IF EXISTS japa_speed_worker1 WITH (FORCE)')
psql('CREATE DATABASE japa_speed_worker1')
process.env.JAPA_WORKER_ID = '1'
await import(join(root, 'worker_env.mjs'))
// migration:run regenerates database/schema.ts; keep the copied source unchanged.
const schemaFile = join(root, 'app/apps/web/database/schema.ts')
const schema = readFileSync(schemaFile)
try {
  execFileSync(process.execPath, ['ace.js', 'migration:run', '--force'], {
    cwd: join(root, 'app/apps/web'),
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' },
  })
} finally {
  writeFileSync(schemaFile, schema)
}
psql('CREATE DATABASE japa_speed_template TEMPLATE japa_speed_worker1')
console.log(
  `Prepared japa_speed_template in ${((performance.now() - started) / 1000).toFixed(3)} s`
)
