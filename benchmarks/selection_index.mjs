/**
 * Selection-index probes.
 *
 * These cover the `shouldSkipFile` decision that stands between "narrow the
 * import list" and "silently drop a matching test". Any change here must stay
 * conservative: a file is dropped only when the index proves it cannot match.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldSkipFile } from '../src/selection_index.js'

const entry = {
  mtimeMs: 1,
  size: 10,
  tests: ['returns the commission', 'rejects a negative amount'],
  groups: ['ReferralCommissionService - calculateCommission'],
  tags: ['@referrals'],
}

test('a title filter keeps files containing the title', () => {
  assert.equal(shouldSkipFile(entry, { tests: ['returns the commission'] }), false)
})

test('a title filter drops files without the title', () => {
  assert.equal(shouldSkipFile(entry, { tests: ['chargeback window'] }), true)
})

test('title matching is case-insensitive and substring-based', () => {
  assert.equal(shouldSkipFile(entry, { tests: ['RETURNS THE COMMIS'] }), false)
})

test('a title filter also matches a group title', () => {
  assert.equal(shouldSkipFile(entry, { tests: ['calculateCommission'] }), false)
})

test('a group filter keeps the matching group and drops others', () => {
  assert.equal(shouldSkipFile(entry, { groups: ['calculateCommission'] }), false)
  assert.equal(shouldSkipFile(entry, { groups: ['payout service'] }), true)
})

test('a tag filter keeps files tagged accordingly', () => {
  assert.equal(shouldSkipFile(entry, { tags: ['@referrals'] }), false)
  assert.equal(shouldSkipFile(entry, { tags: ['@billing'] }), true)
})

test('combined filters drop a file when any layer cannot match', () => {
  assert.equal(
    shouldSkipFile(entry, { tests: ['returns the commission'], tags: ['@billing'] }),
    true
  )
  assert.equal(
    shouldSkipFile(entry, { tests: ['returns the commission'], tags: ['@referrals'] }),
    false
  )
})

test('a file with runtime titles is never skipped by a title filter', () => {
  const dynamic = { ...entry, dynamic: true }
  assert.equal(
    shouldSkipFile(dynamic, { tests: ['a title that only exists as a dataset row'] }),
    false
  )
  // Group and tag filters can still prune it: those are recorded at registration.
  assert.equal(shouldSkipFile(dynamic, { groups: ['no such group'] }), true)
})

test('no filters never skips', () => {
  assert.equal(shouldSkipFile(entry, {}), false)
})
