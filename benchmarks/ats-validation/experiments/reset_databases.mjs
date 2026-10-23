import { execFileSync } from 'node:child_process'
const count = Number(process.argv[2] ?? 1)
if (!Number.isInteger(count) || count < 1 || count > 8)
  throw new Error('Choose 1–8 isolated workers')
for (let id = 1; id <= count; id++) {
  const name = `japa_speed_worker${id}`
  for (const statement of [
    `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`,
    `CREATE DATABASE ${name}${process.env.JAPA_EXPERIMENT_DB_SNAPSHOT === '1' ? ' TEMPLATE japa_speed_template' : ''}`,
  ])
    execFileSync(
      'docker',
      [
        'compose',
        '-p',
        'japa-speed-atstest',
        '-f',
        `${import.meta.dirname}/compose.yaml`,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        statement,
      ],
      { stdio: 'pipe' }
    )
  execFileSync(
    'docker',
    [
      'compose',
      '-p',
      'japa-speed-atstest',
      '-f',
      `${import.meta.dirname}/compose.yaml`,
      'exec',
      '-T',
      `redis${id}`,
      'redis-cli',
      'FLUSHALL',
    ],
    { stdio: 'pipe' }
  )
  const url = `http://127.0.0.1:${28180 + id}/collections`
  const headers = { 'X-TYPESENSE-API-KEY': 'japa-speed-test' }
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`Isolated search not ready: ${response.status}`)
  for (const collection of await response.json()) {
    const removed = await fetch(`${url}/${encodeURIComponent(collection.name)}`, {
      headers,
      method: 'DELETE',
    })
    if (!removed.ok) throw new Error('Unable to clear isolated search collection')
  }
  await fetch(`http://127.0.0.1:${28024 + id}/api/v1/messages`, { method: 'DELETE' })
}
console.log(`Reset ${count} isolated databases, Redis stores, and search nodes`)
