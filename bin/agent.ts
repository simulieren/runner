#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { diffReports, parseAgentReport, type ParsedAgentReport } from '../src/agent_delta.js'

/**
 * Harness-agnostic test loop for agents.
 *
 * It only composes existing Japa flags, so it works with any command that
 * forwards CLI arguments to Japa:
 *
 *   japa-agent -- node bin/test.js
 *   japa-agent --cwd=apps/web -- node --import=@poppinss/ts-exec bin/test.ts unit
 *
 * On first use it builds the selection caches, then runs only the files affected
 * by git changes and writes bounded JSON lines for the harness to read. Stdout is
 * left to the application; the wrapper reports on stderr.
 */

type Options = {
  cwd?: string
  out?: string
  full: boolean
  prepare: boolean
  timeout?: number
}

const SELECTION_FLAGS = /^--(tests|groups|tags|files|failed|changed)(=|$)/

function parse(argv: string[]): { options: Options; command: string[] } {
  const separator = argv.indexOf('--')
  const head = separator < 0 ? argv : argv.slice(0, separator)
  const command = separator < 0 ? [] : argv.slice(separator + 1)
  const options: Options = { full: false, prepare: true }
  for (let index = 0; index < head.length; index++) {
    const arg = head[index]
    if (arg === '--full') options.full = true
    else if (arg === '--no-prepare') options.prepare = false
    else if (arg.startsWith('--cwd=')) options.cwd = arg.slice('--cwd='.length)
    else if (arg === '--cwd') options.cwd = head[++index]
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length)
    else if (arg === '--out') options.out = head[++index]
    else if (arg.startsWith('--timeout=')) options.timeout = Number(arg.slice('--timeout='.length))
    else if (arg === '--timeout') options.timeout = Number(head[++index])
    else throw new Error(`Unknown japa-agent option: ${arg}`)
  }
  return { options, command }
}

function run(command: string, args: string[], cwd: string, timeout?: number) {
  return new Promise<number>((done, fail) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    const timer = timeout
      ? setTimeout(() => {
          child.kill('SIGTERM')
        }, timeout)
      : undefined
    child.once('error', (error) => {
      if (timer) clearTimeout(timer)
      fail(error)
    })
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      done(signal ? 130 : (code ?? 1))
    })
  })
}

async function hasCaches(cwd: string) {
  const directory = join(cwd, 'node_modules/.cache/japa')
  const names = await readdir(directory).catch(() => [] as string[])
  return names.some((name) => name.startsWith('index-')) && names.includes('dependencies.json')
}

async function main() {
  const { options, command } = parse(process.argv.slice(2))
  if (!command.length) {
    console.error(
      'Usage: japa-agent [--cwd=path] [--out=path] [--full] [--no-prepare] -- <test command...>'
    )
    return 1
  }

  const cwd = await realpath(options.cwd ? resolve(options.cwd) : process.cwd())
  const [executable, ...args] = command
  const selectionGiven = args.some((arg) => SELECTION_FLAGS.test(arg))

  if (options.prepare && !(await hasCaches(cwd))) {
    // Build both caches once. Selection flags are stripped so the index covers
    // every file rather than only the ones a filter would have imported.
    const prepareArgs = [...args.filter((arg) => !SELECTION_FLAGS.test(arg)), '--prepare']
    const prepared = await run(executable, prepareArgs, cwd, options.timeout)
    if (prepared !== 0) {
      console.error(`japa-agent: prepare failed with exit ${prepared}`)
      return prepared
    }
  }

  const out = options.out
    ? resolve(cwd, options.out)
    : join(cwd, 'node_modules/.cache/japa/agent.jsonl')
  const previous = await readReport(out)
  const runArgs = [...args, '--agent']
  if (!args.some((arg) => arg.startsWith('--agent-file'))) runArgs.push(`--agent-file=${out}`)
  if (!options.full && !selectionGiven) runArgs.push('--changed=auto')

  const exit = await run(executable, runArgs, cwd, options.timeout)

  const current = await readReport(out)
  const delta = diffReports(previous, current ?? { failures: [] })
  const deltaPath = `${out}.delta.json`
  await writeFile(deltaPath, `${JSON.stringify(delta, null, 2)}\n`).catch(() => {})

  process.stderr.write(
    `japa-agent: exit=${exit} new=${delta.counts.new} fixed=${delta.counts.fixed} ` +
      `report=${out} delta=${deltaPath}\n`
  )
  return exit
}

async function readReport(path: string): Promise<ParsedAgentReport | undefined> {
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  return parseAgentReport(text)
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
}
