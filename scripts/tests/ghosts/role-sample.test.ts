import type { SubagentRecord } from '../../../src/commands/cost/turns.js'
import { describe, expect, it } from 'vitest'
import { roleExpects, roleRuns } from '../../ghosts/role-sample.js'

function minuteAt(minute: number): string {
  return `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`
}

function record(agent: string, agentType: string, minute: number, input: number, cacheRead = 0, startedAt: string | null = null): SubagentRecord {
  return { agent, agentType, at: minuteAt(minute), startedAt, usage: { calls: 1, input, cacheWrite: 0, cacheRead, output: 0, models: [] } }
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
    expect(brief).toEqual({ role: 'brief', band: { kind: 'none', n: 2 }, minutes: { kind: 'not recorded', undated: 2, runs: 2 }, missing: null })
  })

  it('w7: counts the records of one agent as one run, summed', () => {
    const runs = roleRuns([record('a', 'brief', 1, 100), record('b', 'brief', 2, 50), record('a', 'brief', 3, 200)])
    expect(runs).toEqual([{ agent: 'a', role: 'brief', at: '2026-10-01T10:01:00.000Z', tokens: 300, seconds: null }, { agent: 'b', role: 'brief', at: '2026-10-01T10:02:00.000Z', tokens: 50, seconds: null }])
  })

  it('takes a run\'s seconds from the earliest startedAt to the latest stop of the records that carry one, so a late tail without it does not stretch the run', () => {
    const runs = roleRuns([record('a', 'brief', 10, 100, 0, minuteAt(4)), record('a', 'brief', 40, 50)])
    expect(runs).toEqual([{ agent: 'a', role: 'brief', at: minuteAt(10), tokens: 150, seconds: 360 }])
  })

  it('forecasts minutes as the median duration when every recent run of the role carries one', () => {
    const briefs = [2, 4, 6, 8, 10].map((minutes, index) => record(`brief-${index}`, 'brief', 20 + index, 1_000, 0, minuteAt(20 + index - minutes)))
    const brief = roleExpects(briefs).find(expected => expected.role === 'brief')!
    expect(brief.minutes).toEqual({ kind: 'median', minutes: 6 })
  })

  it('names the runs without a startedAt instead of a median of the rest', () => {
    const briefs = [1, 2, 3, 4, 5, 6].map(index => record(`brief-${index}`, 'brief', 20 + index, 1_000, 0, index === 3 ? null : minuteAt(index)))
    const brief = roleExpects(briefs).find(expected => expected.role === 'brief')!
    expect(brief.minutes).toEqual({ kind: 'not recorded', undated: 1, runs: 6 })
  })

  it('names the turn journal as not recorded instead of n=0', () => {
    expect(roleExpects(null).map(expected => expected.missing)).toEqual(Array.from({ length: 3 }).fill('.construct/turns.jsonl not recorded'))
  })
})
