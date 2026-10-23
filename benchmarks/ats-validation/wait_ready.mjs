import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const deadline = Date.now() + 120_000
while (true) {
  try {
    execFileSync(
      'docker',
      [
        'compose',
        '-p',
        'japa-speed-atstest',
        '-f',
        join(import.meta.dirname, 'compose.yaml'),
        'exec',
        '-T',
        'postgres',
        'pg_isready',
        '-U',
        'postgres',
      ],
      { stdio: 'pipe' }
    )
    for (let id = 1; id <= Number(process.env.JAPA_LAB_WORKERS ?? 4); id++) {
      execFileSync(
        'docker',
        [
          'compose',
          '-p',
          'japa-speed-atstest',
          '-f',
          join(import.meta.dirname, 'compose.yaml'),
          'exec',
          '-T',
          `redis${id}`,
          'redis-cli',
          'PING',
        ],
        { stdio: 'pipe' }
      )
      const search = await fetch(`http://127.0.0.1:${28180 + id}/collections`, {
        headers: { 'X-TYPESENSE-API-KEY': 'japa-speed-test' },
        signal: AbortSignal.timeout(2000),
      })
      if (!search.ok) throw new Error(`Search worker ${id}: HTTP ${search.status}`)
      const mail = await fetch(`http://127.0.0.1:${28024 + id}/api/v1/messages`, {
        signal: AbortSignal.timeout(2000),
      })
      if (!mail.ok) throw new Error(`Mail worker ${id}: HTTP ${mail.status}`)
    }
    break
  } catch (error) {
    if (Date.now() >= deadline)
      throw new Error('Isolated test services did not become ready within 120 seconds', {
        cause: error,
      })
    await new Promise((done) => setTimeout(done, 1000))
  }
}
console.log('All isolated validation services are ready')
