import type { SubagentRecord } from '../../../src/commands/cost/turns.js'
import { describe, expect, it } from 'vitest'
import { roleExpects, roleRuns } from '../../ghosts/role-sample.js'

function record(agent: string, agentType: string, minute: number, input: number, cacheRead = 0): SubagentRecord {
  return { agent, agentType, at: `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`, usage: { calls: 1, input, cacheWrite: 0, cacheRead, output: 0, models: [] } }
}

describe('role runs from the turn journal', () => {
  it('w3: forecasts scan with six runs as the median and the p25–p75 band, cache reads left out', () => {
    const scans = [10, 20, 30, 40, 50, 60].map((thousands, index) => record(`scan-${index}`, 'scan', index, thousands * 1_000, 5_000_000))
    const scan = roleExpects(scans).find(expected => expected.role === 'scan')!
    expect(scan.band).toEqual({ kind: 'band', median: 35_000, p25: 22_500, p75: 47_500, n: 6 })
  })

  it('w4: writes none with n for a role with fewer than five runs, never another role\'s median', () => {
    const records = [...[1, 2, 3, 4, 5].map(index => record(`review-${index}`, 'review', index, 90_000)), ...[1, 2].map(index => record(`brief-${index}`, 'brief', index, 1_000))]
    const brief = roleExpects(records).find(expected => expected.role === 'brief')!
    expect(brief).toEqual({ role: 'brief', band: { kind: 'none', n: 2 }, missing: null })
  })

  it('w7: counts the records of one agent as one run, summed', () => {
    const runs = roleRuns([record('a', 'brief', 1, 100), record('b', 'brief', 2, 50), record('a', 'brief', 3, 200)])
    expect(runs).toEqual([{ agent: 'a', role: 'brief', at: '2026-10-01T10:01:00.000Z', tokens: 300 }, { agent: 'b', role: 'brief', at: '2026-10-01T10:02:00.000Z', tokens: 50 }])
  })

  it('names the turn journal as not recorded instead of n=0', () => {
    expect(roleExpects(null).map(expected => expected.missing)).toEqual(Array.from({ length: 3 }).fill('.construct/turns.jsonl not recorded'))
  })
})
