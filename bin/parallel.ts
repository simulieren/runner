#!/usr/bin/env node

import { runParallel } from '../src/parallel.js'

async function main() {
  const cliArguments = process.argv.slice(2)
  const separator = cliArguments.indexOf('--')
  const options = separator < 0 ? cliArguments : cliArguments.slice(0, separator)
  if (separator < 0 || options.includes('--help')) {
    console.log(
      'Usage: japa-parallel [--workers=4] [--history=path] [--cwd=path] -- node bin/test.js unit'
    )
    return options.includes('--help') ? 0 : 1
  }
  let workers: number | undefined
  let historyFile: string | undefined
  let cwd: string | undefined
  for (let index = 0; index < options.length; index++) {
    const option = options[index]
    if (option.startsWith('--workers=')) workers = Number(option.slice('--workers='.length))
    else if (option === '--workers') workers = Number(options[++index])
    else if (option.startsWith('--cwd=')) cwd = option.slice('--cwd='.length)
    else if (option === '--cwd') {
      cwd = options[++index]
      if (!cwd) throw new Error('--cwd requires a directory')
    } else if (option.startsWith('--history=')) historyFile = option.slice('--history='.length)
    else if (option === '--history') {
      historyFile = options[++index]
      if (!historyFile) throw new Error('--history requires a path')
    } else throw new Error(`Unknown coordinator option: ${option}`)
  }
  const [command, ...args] = cliArguments.slice(separator + 1)
  const controller = new AbortController()
  let signalCode: number | undefined
  const interrupt = () => {
    signalCode = 130
    controller.abort()
  }
  const terminate = () => {
    signalCode = 143
    controller.abort()
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try {
    const result = await runParallel({
      command,
      args,
      workers,
      historyFile,
      cwd,
      signal: controller.signal,
    })
    for (const worker of result.workers) {
      if (worker.error) console.error(`[japa-parallel] worker ${worker.worker}: ${worker.error}`)
    }
    const exitCode = signalCode ?? result.exitCode
    console.log(
      `[japa-parallel] workers=${result.workers.length} exit=${exitCode} timings=${result.historyUpdated ? 'updated' : 'unchanged'}`
    )
    return exitCode
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
