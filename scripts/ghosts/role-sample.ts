import type { Band } from '../../src/commands/cost/sample.js'
import type { SubagentRecord } from '../../src/commands/cost/turns.js'
import { recentBand } from '../../src/commands/cost/sample.js'
import { TURN_JOURNAL_FILE } from '../../src/commands/cost/turns.js'
import { tokensWithoutCacheReads } from '../../src/commands/cost/usage.js'

export const ROLES = ['brief', 'scan', 'review'] as const

export type Role = typeof ROLES[number]

export interface RoleRun {
  agent: string
  role: string
  at: string
  tokens: number
}

export interface RoleExpect {
  role: Role
  band: Band
  missing: string | null
}

export function roleRuns(records: SubagentRecord[]): RoleRun[] {
  const byAgent = new Map<string, RoleRun>()
  for (const record of records) {
    const run = byAgent.get(record.agent)
    if (run === undefined) {
      byAgent.set(record.agent, { agent: record.agent, role: record.agentType, at: record.at, tokens: tokensWithoutCacheReads(record.usage) })
      continue
    }
    run.tokens += tokensWithoutCacheReads(record.usage)
    if (record.at < run.at)
      run.at = record.at
  }
  return [...byAgent.values()].sort((a, b) => a.at.localeCompare(b.at))
}

export function roleExpects(records: SubagentRecord[] | null): RoleExpect[] {
  const runs = records === null ? [] : roleRuns(records)
  return ROLES.map((role) => {
    const tokens = runs.filter(run => run.role === role).map(run => run.tokens)
    return { role, band: recentBand(tokens), missing: records === null ? `${TURN_JOURNAL_FILE} not recorded` : null }
  })
}
