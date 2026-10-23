/*
 * @japa/runner
 *
 * (c) Japa
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Run metadata that only the runner knows (selection size, phase timings,
 * baseline counts). The agent reporter reads it when printing the summary, so a
 * harness can tell a fast, narrow run from a silent fallback to everything.
 */
export type AgentContext = {
  selection?: {
    mode: 'all' | 'filtered' | 'changed'
    planned: number
    skipped: number
    /** A filter was requested but could not narrow the import list. */
    fallback?: boolean
  }
  phases?: {
    bootMs: number
    importMs: number
    testMs: number
  }
  baseline?: {
    known: number
    new: number
    fixed?: number
  }
}

const contexts = new WeakMap<object, AgentContext>()

export function setAgentContext(runner: object, patch: AgentContext) {
  contexts.set(runner, { ...(contexts.get(runner) ?? {}), ...patch })
}

export function getAgentContext(runner: object): AgentContext {
  return contexts.get(runner) ?? {}
}
