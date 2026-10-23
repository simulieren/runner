/**
 * Baseline discipline probes.
 *
 * The contract: repeated failures gain a consecutive count, entries that stop
 * failing are reported as fixed, and both-direction changes are visible so a
 * noisy run can be rejected.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffFailures, mergeBaseline, parseBaseline } from '../src/failure_baseline.js'

const entry = (title, file = 'tests/a.spec.ts') => ({ suite: 'unit', file, title })

test('a new failure starts at consecutive 1 and increments on repeat', () => {
  const first = mergeBaseline({ version: 1, failures: [] }, [entry('one')], 't1')
  assert.equal(first.baseline.failures[0].consecutive, 1)
  assert.equal(first.added.length, 1)
  assert.equal(first.removed.length, 0)

  const second = mergeBaseline(first.baseline, [entry('one')], 't2')
  assert.equal(second.baseline.failures[0].consecutive, 2)
  assert.equal(second.added.length, 0)
})

test('a failure that stops failing is kept with consecutive 0 and reported removed', () => {
  const previous = mergeBaseline({ version: 1, failures: [] }, [entry('one')])
  const next = mergeBaseline(previous.baseline, [entry('two')])
  assert.equal(next.removed.length, 1)
  assert.equal(next.added.length, 1)
  const fixed = next.baseline.failures.find((row) => row.title === 'one')
  assert.equal(fixed?.consecutive, 0)
})

test('diff reports fixed entries only from the baseline', () => {
  const baseline = mergeBaseline({ version: 1, failures: [] }, [entry('one'), entry('two')])
  const diff = diffFailures(baseline.baseline, [entry('one'), entry('three')])
  assert.deepEqual(
    diff.known.map((row) => row.title),
    ['one']
  )
  assert.deepEqual(
    diff.new.map((row) => row.title),
    ['three']
  )
  assert.deepEqual(
    diff.fixed.map((row) => row.title),
    ['two']
  )
})

test('the persisted shape survives a round trip', () => {
  const merged = mergeBaseline({ version: 1, failures: [] }, [entry('one')], 'now')
  const parsed = parseBaseline(JSON.parse(JSON.stringify(merged.baseline)))
  assert.equal(parsed.failures[0].consecutive, 1)
  assert.equal(parsed.failures[0].updatedAt, 'now')
})
