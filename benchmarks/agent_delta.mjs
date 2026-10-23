/**
 * Delta-report probes.
 *
 * The contract: "fixed" is only reported when the selection is identical, so a
 * harness can never be told a test was fixed merely because it was not selected.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffReports, parseAgentReport } from '../src/agent_delta.js'

const summary = (total, planned = 1, skipped = 0) =>
  JSON.stringify({
    t: 'summary',
    total,
    selection: { mode: 'filtered', planned, skipped },
  })

const failed = (title, file = 'tests/a.spec.ts') =>
  JSON.stringify({ t: 'test', status: 'failed', file, title })

test('parse keeps the summary and failures, ignoring noise', () => {
  const parsed = parseAgentReport(`${summary(2)}\n${failed('one')}\nnot json\n`)
  assert.equal(parsed.summary?.total, 2)
  assert.equal(parsed.failures.length, 1)
})

test('the first run is not comparable and reports no fixed tests', () => {
  const current = parseAgentReport(`${summary(2)}\n${failed('one')}`)
  const delta = diffReports(undefined, current)
  assert.equal(delta.comparable, false)
  assert.equal(delta.counts.new, 1)
  assert.equal(delta.counts.fixed, 0)
})

test('a new failure appears and disappears correctly', () => {
  const previous = parseAgentReport(`${summary(2)}\n${failed('one')}`)
  const current = parseAgentReport(`${summary(2)}\n${failed('two')}`)
  const delta = diffReports(previous, current)
  assert.equal(delta.comparable, true)
  assert.deepEqual(
    delta.newFailures.map((row) => row.title),
    ['two']
  )
  assert.deepEqual(
    delta.fixed.map((row) => row.title),
    ['one']
  )
})

test('a different selection never claims a fixed test', () => {
  const previous = parseAgentReport(`${summary(2, 1, 0)}\n${failed('one')}`)
  const current = parseAgentReport(`${summary(1, 2, 5)}\n`)
  const delta = diffReports(previous, current)
  assert.equal(delta.comparable, false)
  assert.equal(delta.counts.fixed, 0)
})

test('the same failure is neither new nor fixed', () => {
  const previous = parseAgentReport(`${summary(2)}\n${failed('one')}`)
  const delta = diffReports(previous, parseAgentReport(`${summary(2)}\n${failed('one')}`))
  assert.equal(delta.counts.new, 0)
  assert.equal(delta.counts.fixed, 0)
})
