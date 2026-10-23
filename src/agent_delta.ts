/*
 * @japa/runner
 *
 * (c) Japa
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Compare two agent reports so a harness can show only what changed.
 *
 * A test missing from the current report may simply not have been selected, so
 * "fixed" is only reported when the selection signature and total are identical.
 */
export type AgentTestRow = { file?: string; title: string }

export type AgentSelection = {
  mode: string
  planned: number
  skipped: number
  fallback?: boolean
}

export type AgentSummary = {
  total: number
  selection?: AgentSelection
  phases?: { bootMs?: number; importMs?: number; testMs?: number }
}

export type ParsedAgentReport = {
  summary?: AgentSummary
  failures: AgentTestRow[]
}

export type AgentDelta = {
  comparable: boolean
  newFailures: AgentTestRow[]
  fixed: AgentTestRow[]
  counts: { previous: number; current: number; new: number; fixed: number }
  truncated: boolean
}

const MAX_ROWS = 50

function keyOf(row: AgentTestRow) {
  return `${row.file ?? ''}\u0000${row.title}`
}

/** Parse JSON lines produced by the agent reporter. Unknown lines are ignored. */
export function parseAgentReport(text: string): ParsedAgentReport {
  const failures: AgentTestRow[] = []
  let summary: AgentSummary | undefined

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const kind = record.event ?? record.t
    if (kind === 'summary' && typeof record.total === 'number') {
      summary = {
        total: record.total,
        ...(record.selection && typeof record.selection === 'object'
          ? { selection: record.selection as AgentSelection }
          : {}),
        ...(record.phases && typeof record.phases === 'object'
          ? { phases: record.phases as AgentSummary['phases'] }
          : {}),
      }
    } else if (kind === 'test' && record.status === 'failed' && typeof record.title === 'string') {
      failures.push({
        ...(typeof record.file === 'string' ? { file: record.file } : {}),
        title: record.title,
      })
    }
  }

  return summary ? { summary, failures } : { failures }
}

function sameSelection(previous: AgentSummary | undefined, current: AgentSummary) {
  if (!previous) return false
  if (previous.total !== current.total) return false
  const a = previous.selection
  const b = current.selection
  if (!a || !b) return !a && !b
  return a.mode === b.mode && a.planned === b.planned && a.skipped === b.skipped
}

export function diffReports(
  previous: ParsedAgentReport | undefined,
  current: ParsedAgentReport
): AgentDelta {
  const comparable = Boolean(previous && sameSelection(previous.summary, current.summary!))
  const before = new Map((previous?.failures ?? []).map((row) => [keyOf(row), row]))
  const after = new Map(current.failures.map((row) => [keyOf(row), row]))

  const newFailures = [...after].filter(([key]) => !before.has(key)).map(([, row]) => row)
  const fixed = comparable
    ? [...before].filter(([key]) => !after.has(key)).map(([, row]) => row)
    : []

  const truncated = newFailures.length > MAX_ROWS || fixed.length > MAX_ROWS
  return {
    comparable,
    newFailures: newFailures.slice(0, MAX_ROWS),
    fixed: fixed.slice(0, MAX_ROWS),
    counts: {
      previous: previous?.failures.length ?? 0,
      current: current.failures.length,
      new: newFailures.length,
      fixed: fixed.length,
    },
    truncated,
  }
}
