import type { RoleMinutes } from '../../src/commands/cost/expect.js'
import type { Band } from '../../src/commands/cost/sample.js'
import type { SubagentRecord } from '../../src/commands/cost/turns.js'
import { median, RECENT_RUNS, recentBand } from '../../src/commands/cost/sample.js'
import { TURN_JOURNAL_FILE } from '../../src/commands/cost/turns.js'
import { tokensWithoutCacheReads } from '../../src/commands/cost/usage.js'

export const ROLES = ['brief', 'scan', 'review'] as const

export type Role = typeof ROLES[number]

export interface RoleRun {
  agent: string
  role: string
  at: string
  tokens: number
  seconds: number | null
}

export interface RoleExpect {
  role: Role
  band: Band
  minutes: RoleMinutes
  missing: string | null
}

interface Span {
  startedAt: string
  endedAt: string
}

function widened(span: Span | null, record: SubagentRecord): Span | null {
  if (record.startedAt === null)
    return span
  if (span === null)
    return { startedAt: record.startedAt, endedAt: record.at }
  return { startedAt: record.startedAt < span.startedAt ? record.startedAt : span.startedAt, endedAt: record.at > span.endedAt ? record.at : span.endedAt }
}

function secondsOf(span: Span | null): number | null {
  if (span === null)
    return null
  const seconds = (Date.parse(span.endedAt) - Date.parse(span.startedAt)) / 1000
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

export function roleRuns(records: SubagentRecord[]): RoleRun[] {
  const byAgent = new Map<string, { run: RoleRun, span: Span | null }>()
  for (const record of records) {
    const known = byAgent.get(record.agent)
    if (known === undefined) {
      byAgent.set(record.agent, { run: { agent: record.agent, role: record.agentType, at: record.at, tokens: tokensWithoutCacheReads(record.usage), seconds: null }, span: widened(null, record) })
      continue
    }
    known.run.tokens += tokensWithoutCacheReads(record.usage)
    known.span = widened(known.span, record)
    if (record.at < known.run.at)
      known.run.at = record.at
  }
  return [...byAgent.values()].map(({ run, span }) => ({ ...run, seconds: secondsOf(span) })).sort((a, b) => a.at.localeCompare(b.at))
}

function roleMinutes(runs: RoleRun[]): RoleMinutes {
  const recent = runs.slice(-RECENT_RUNS)
  const seconds = recent.flatMap(run => run.seconds === null ? [] : [run.seconds])
  if (recent.length === 0 || seconds.length < recent.length)
    return { kind: 'not recorded', undated: recent.length - seconds.length, runs: recent.length }
  return { kind: 'median', minutes: Math.round(median(seconds) / 6) / 10 }
}

export function roleExpects(records: SubagentRecord[] | null): RoleExpect[] {
  const runs = records === null ? [] : roleRuns(records)
  return ROLES.map((role) => {
    const ofRole = runs.filter(run => run.role === role)
    return { role, band: recentBand(ofRole.map(run => run.tokens)), minutes: roleMinutes(ofRole), missing: records === null ? `${TURN_JOURNAL_FILE} not recorded` : null }
  })
}
