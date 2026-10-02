import { describe, expect, it } from 'vitest'
import { expectSample, formatTokens, renderSample } from '../../ghosts/expect-sample.js'
import { parseExpect } from '../../ghosts/expect.js'

const DASH = String.fromCharCode(8212)
const APPROX = String.fromCharCode(8776)
const HEAD = '/implement x\nSketch: sketch/t @ 0123456789abcdef0123456789abcdef01234567'

interface RunFixture {
  run: string
  tokens: number | 'unknown'
  seconds: number
  effort?: string
  status?: string
}

function ledgerLine(fixture: RunFixture): string {
  return JSON.stringify({
    run: fixture.run,
    at: '2026-09-27T18:00:00Z',
    task: `task of ${fixture.run}`,
    effort: fixture.effort ?? 'medium',
    status: fixture.status ?? 'done',
    rung: fixture.effort ?? 'medium',
    attempts: [{ rung: 1, effort: fixture.effort ?? 'medium', outcome: 'passed', reason: '' }],
    agents: 2,
    tokens: fixture.tokens,
    toolUses: 10,
    seconds: fixture.seconds,
  })
}

function journalTask(task: string, run: string | null, taskClass: string | null): string {
  return JSON.stringify({ event: 'task', task, run, class: taskClass, session: `session-${task}`, ts: '2026-09-27T18:00:00Z' })
}

function sample(journal: string[], runs: RunFixture[], taskClass: string, effort?: string) {
  const warnings: string[] = []
  const result = expectSample(journal, [{ source: 'runs.jsonl', lines: runs.map(ledgerLine) }], taskClass, effort, warnings)
  return { ...result, warnings }
}

const FIVE_R2 = [1, 2, 3, 4, 5].map(index => ({ task: `r2-${index}`, run: `wf_r2-${index}`, tokens: index * 100_000, seconds: index * 600 }))
const SIX_R1 = [1, 2, 3, 4, 5, 6].map(index => ({ task: `r1-${index}`, run: `wf_r1-${index}`, tokens: 9_000_000, seconds: 6000 }))
const R2_JOURNAL = FIVE_R2.map(row => journalTask(row.task, row.run, 'R2'))
const R1_JOURNAL = SIX_R1.map(row => journalTask(row.task, row.run, 'R1'))

describe('expectSample', () => {
  it('joins a journal task line to its ledger row by the run id, not by order or task text', () => {
    const journal = [journalTask('a', 'wf_b', 'R2'), journalTask('b', 'wf_a', 'R1')]
    const result = sample(journal, [{ run: 'wf_a', tokens: 1_000, seconds: 60 }, { run: 'wf_b', tokens: 2_000, seconds: 120 }], 'R2')
    expect(result.rows).toEqual([{ run: 'wf_b', effort: 'medium', tokens: 2_000, minutes: 2 }])
  })

  it('writes none with the class and n when fewer than five runs of the class joined', () => {
    const result = sample([...R2_JOURNAL.slice(0, 4), ...R1_JOURNAL], [...FIVE_R2, ...SIX_R1], 'R2')
    expect(result.line).toBe(`expect: none ${DASH} n=4 for R2`)
    expect(result.rows).toHaveLength(4)
  })

  it('takes the median over the runs of the class, not over every run in the ledger', () => {
    const result = sample([...R2_JOURNAL, ...R1_JOURNAL], [...SIX_R1, ...FIVE_R2], 'R2')
    expect(result.line).toBe(`expect: tokens ${APPROX} 300k, minutes ${APPROX} 30 ${DASH} effort medium, n=5, median`)
  })

  it('prints a line parseExpect reads back as the same forecast', () => {
    const { line } = sample(R2_JOURNAL, FIVE_R2, 'R2')
    expect(parseExpect(`${HEAD}\n${line}`)).toEqual({ kind: 'forecast', tokens: 300_000, minutes: 30, basis: { effort: 'medium', n: 5 } })
    expect(parseExpect(`${HEAD}\n${sample([], [], 'R2').line}`)).toEqual({ kind: 'none', reason: 'n=0 for R2' })
  })

  it('counts only done runs with a known token count, each run once', () => {
    const journal = [...R2_JOURNAL, journalTask('r2-1-again', 'wf_r2-1', 'R2'), journalTask('red', 'wf_red', 'R2'), journalTask('unk', 'wf_unk', 'R2')]
    const result = sample(journal, [...FIVE_R2, { run: 'wf_red', tokens: 35_000, seconds: 16, status: 'base red' }, { run: 'wf_unk', tokens: 'unknown', seconds: 60 }], 'R2')
    expect(result.rows.map(row => row.run)).toEqual(FIVE_R2.map(row => row.run))
  })

  it('keeps only the asked effort, and names it as the basis', () => {
    const highRuns = FIVE_R2.map(row => ({ ...row, run: `${row.run}-high`, effort: 'high', tokens: row.tokens * 2 }))
    const journal = [...R2_JOURNAL, ...highRuns.map(row => journalTask(`${row.task}-high`, row.run, 'R2'))]
    expect(sample(journal, [...FIVE_R2, ...highRuns], 'R2', 'high').line).toBe(`expect: tokens ${APPROX} 600k, minutes ${APPROX} 30 ${DASH} effort high, n=5, median`)
    expect(sample(journal, [...FIVE_R2, ...highRuns], 'R2').line).toBe(`expect: none ${DASH} the sample for R2 mixes efforts high, medium; pass --effort`)
  })

  it('reports an unreadable journal or ledger line instead of dropping it silently', () => {
    const warnings: string[] = []
    expectSample(['{not json', journalTask('a', 'wf_a', 'R2')], [{ source: 'runs.jsonl', lines: ['{"run":"wf_a"}'] }], 'R2', undefined, warnings)
    expect(warnings).toEqual(['journal line 1 is not JSON; skipped', expect.stringMatching(/^runs\.jsonl line 1 is malformed \(.+\); skipped$/)])
  })

  it('renders the line and then one row per run with its tokens and minutes', () => {
    expect(renderSample(sample(R2_JOURNAL.slice(0, 1), FIVE_R2, 'R2'))).toEqual([`expect: none ${DASH} n=1 for R2`, 'wf_r2-1  tokens 100000  minutes 10'])
  })
})

describe('formatTokens', () => {
  it('writes the k and M scales parseExpect reads', () => {
    expect([formatTokens(950), formatTokens(166_400), formatTokens(1_234_567)]).toEqual(['950', '166k', '1.2M'])
  })
})
