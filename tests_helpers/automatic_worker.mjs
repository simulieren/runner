import { access, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const worker = process.env.JAPA_WORKER_ID ?? 'serial'
if (process.env.TEST_START_GATE) {
  let ready = false
  for (let attempt = 0; attempt < 1000; attempt++) {
    try {
      await access(resolve(process.env.TEST_START_GATE))
      ready = true
      break
    } catch {
      await new Promise((done) => setTimeout(done, 10))
    }
  }
  if (!ready) throw new Error('Fixture start gate was not released')
}
if (process.env.TEST_NO_HISTORY === '1') {
  // Simulate a command that ignores the coordinator, like an older runner.
  delete process.env.JAPA_SPEED_SNAPSHOT
  delete process.env.JAPA_SPEED_RUN_ID
  delete process.env.JAPA_SPEED_OUTPUT
}
if (process.env.TEST_START_DELAY)
  await new Promise((done) => setTimeout(done, Number(process.env.TEST_START_DELAY)))
if (process.env.TEST_HANG === '1') {
  process.on('SIGTERM', () => {})
  await writeFile(resolve(`started-${worker}.json`), JSON.stringify({ pid: process.pid }))
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
const entry = process.env.TEST_RUNNER_ENTRY ?? new URL('../index.ts', import.meta.url).href
const { configure, run, test, processCLIArgs } = await import(entry)
const pluginsEntry =
  process.env.TEST_PLUGINS_ENTRY ?? new URL('../src/plugins/main.ts', import.meta.url).href
const { durationHistory } = await import(pluginsEntry)
processCLIArgs(process.argv.slice(2))
const costs = [30, 1, 20, 1, 10, 1]
const files = costs.map((_, i) => pathToFileURL(resolve(`file${i}.spec.ts`)))
const executed = []
let estimates
configure({
  files: () => files,
  plugins: [
    ...(process.env.TEST_NO_HISTORY === '1' || process.env.TEST_NO_PLUGIN === '1'
      ? []
      : [durationHistory({ file: process.env.TEST_HISTORY_FILE ?? 'history.json' })]),
    async ({ config }) => {
      estimates = config.shardDurations
      await writeFile(
        resolve(`started-${worker}.json`),
        JSON.stringify({ estimates, pid: process.pid })
      )
      if (process.env.TEST_TAMPER === '1') config.shardDurations = {}
    },
  ],
  reporters: { activated: [], list: [] },
  importer(url) {
    const index = files.findIndex((file) => file.href === url.href)
    test(`case ${index}`, async () => {
      executed.push(index)
      if (process.env.TEST_FAIL === '1' && index < 2) throw new Error('Expected fixture failure')
      await new Promise((done) => setTimeout(done, costs[index]))
    })
  },
})
await run()
if (process.env.TEST_DUPLICATE_OUTPUT === '1' && process.env.JAPA_SPEED_OUTPUT) {
  const { readFile } = await import('node:fs/promises')
  const report = JSON.parse(await readFile(process.env.JAPA_SPEED_OUTPUT, 'utf8'))
  report.durations = { 'default:duplicate.spec.ts': 1 }
  await writeFile(process.env.JAPA_SPEED_OUTPUT, JSON.stringify(report))
}
await writeFile(resolve(`observed-${worker}.json`), JSON.stringify({ executed, estimates }))
