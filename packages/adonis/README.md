# `@japa/adonis` (private)

Helpers for running an AdonisJS suite in isolated Japa workers. This package is
private: it is consumed by tests and copied into app examples, not published yet.

```ts
import { workerResources, workerEnv, assertWorkerIsolation } from '@japa/adonis'

const resources = workerResources(Number(process.env.JAPA_WORKER_ID ?? 1), {
  databasePrefix: 'myapp_test_',
  redisBasePort: 26_380,
})

Object.assign(process.env, workerEnv(resources))
assertWorkerIsolation(resources)
```

`workerResources` derives database, Redis, search, HTTP and mail values.
`workerEnv` returns the environment object without mutating anything, and accepts
renamed variables for apps that do not use Typesense. Provisioning the database
and services remains the app's job.

## Ace command

Ace discovers commands in the app's `commands/` directory, so the command class
must live in the app. A thin wrapper is enough:

```ts
// commands/test.ts
import { BaseCommand } from '@adonisjs/core/ace'
import { spawn } from 'node:child_process'

export default class Test extends BaseCommand {
  static commandName = 'test'
  static description = 'Run tests (agent-friendly)'

  async run() {
    const child = spawn(
      process.execPath,
      ['node_modules/@japa/runner/build/bin/agent.js', '--', process.execPath, '--import=@poppinss/ts-exec', 'bin/test.ts', ...this.parsed.args],
      { stdio: 'inherit' }
    )
    this.exitCode = await new Promise((resolve) => child.once('close', (code) => resolve(code ?? 1)))
  }
}
```
