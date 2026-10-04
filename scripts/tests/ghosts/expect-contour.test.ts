import type { RunStep } from '../../../src/commands/cost/index.js'
import type { SubagentRecord } from '../../../src/commands/cost/turns.js'
import { describe, expect, it } from 'vitest'
import { formatContour, ladderSample } from '../../ghosts/expect-sample.js'

const DASH = String.fromCharCode(8212)
const APPROX = String.fromCharCode(8776)

function at(index: number): string {
  return new Date(Date.UTC(2026, 8, 1) + index * 3_600_000).toISOString()
}

function ledgerLine(run: string, index: number, tokens: number): string {
  return JSON.stringify({ run, at: at(index), task: `task of ${run}`, effort: 'medium', status: 'done', rung: 'medium', attempts: [{ rung: 1, effort: 'medium', outcome: 'passed', reason: '' }], agents: 2, tokens, toolUses: 5, seconds: 600 })
}

function journalTask(run: string, sketch: string | null | undefined): string {
  return JSON.stringify({ event: 'task', task: run, run, class: null, ...(sketch === undefined ? {} : { sketch }), ts: '2026-09-27T18:00:00Z' })
}

function step(name: string, tokens: number): RunStep {
  return { step: name, role: 'harness', attempt: 1, effort: null, tokens, seconds: 60 }
}

function subagent(agent: string, agentType: string, index: number, input: number): SubagentRecord {
  return { agent, agentType, at: at(index), usage: { calls: 1, input, cacheWrite: 0, cacheRead: 9_000_000, output: 0, models: [] } }
}

const SHA = '0123456789abcdef0123456789abcdef01234567'

describe('the ladder forecast reads the recent window', () => {
  it('w1: a class with two epochs forecasts from the last twenty runs by time, not from the whole history', () => {
    const old = Array.from({ length: 25 }, (_, index) => ledgerLine(`wf_old-${index}`, index, 50_000))
    const fresh = Array.from({ length: 20 }, (_, index) => ledgerLine(`wf_new-${index}`, 100 + index, 300_000))
    for (const lines of [[...old, ...fresh], [...fresh, ...old]]) {
      const sample = ladderSample({ ledgers: [{ source: 'runs.jsonl', lines }], effort: 'medium' }, [])
      expect(sample.line).toBe(`expect: tokens ${APPROX} 300k, minutes ${APPROX} 10 ${DASH} effort medium, n=20, median, p25–p75 300k–300k; ledger runs.jsonl`)
      expect(sample.rows.map(row => row.run)).toEqual(fresh.map((_, index) => `wf_new-${index}`))
    }
  })
})

describe('the implement step by sketch', () => {
  const sketched = Array.from({ length: 5 }, (_, index) => `wf_s-${index}`)
  const plain = Array.from({ length: 5 }, (_, index) => `wf_p-${index}`)
  const unknown = ['wf_u-0', 'wf_u-1']
  const runs = [...sketched, ...plain, ...unknown]
  const lines = runs.map((run, index) => ledgerLine(run, index, 100_000))
  const runSteps = new Map(runs.map(run => [run, [step('preflight', 30_000), step('implement', sketched.includes(run) ? 40_000 : 110_000)]]))
  const journal = { source: 'ghosts.jsonl', lines: [...sketched.map(run => journalTask(run, SHA)), ...plain.map(run => journalTask(run, null)), ...unknown.map(run => journalTask(run, undefined))] }

  it('w2: --sketch yes forecasts implement from the runs whose journal line carries a sketch, and names the runs with no record', () => {
    const sample = ladderSample({ ledgers: [{ source: 'runs.jsonl', lines }], effort: 'medium', runSteps, sketch: { wanted: true, journal } }, [])
    expect(sample.steps.find(expected => expected.step === 'implement')).toMatchObject({ kind: 'forecast', tokens: 40_000, n: 5, subsample: 'sketch' })
    expect(sample.steps.find(expected => expected.step === 'preflight')).toMatchObject({ kind: 'forecast', tokens: 30_000, n: 12 })
    expect(sample.line).toContain('; 2 runs without a sketch record in ghosts.jsonl not counted for implement')
  })

  it('w2: --sketch no forecasts implement from the runs whose sketch is null', () => {
    const sample = ladderSample({ ledgers: [{ source: 'runs.jsonl', lines }], effort: 'medium', runSteps, sketch: { wanted: false, journal } }, [])
    expect(sample.steps.find(expected => expected.step === 'implement')).toMatchObject({ kind: 'forecast', tokens: 110_000, n: 5, subsample: 'no sketch' })
  })

  it('writes none for a sketch subsample under five instead of the whole sample', () => {
    const fewer = { ...journal, lines: journal.lines.slice(1) }
    const sample = ladderSample({ ledgers: [{ source: 'runs.jsonl', lines }], effort: 'medium', runSteps, sketch: { wanted: true, journal: fewer } }, [])
    expect(sample.steps.find(expected => expected.step === 'implement')).toEqual({ kind: 'none', step: 'implement', effort: 'medium', n: 4, subsample: 'sketch' })
  })
})

describe('the contour', () => {
  const runs = Array.from({ length: 5 }, (_, index) => `wf_c-${index}`)
  const lines = runs.map((run, index) => ledgerLine(run, index, 100_000))
  const runSteps = new Map(runs.map((run, index) => [run, [step('preflight', 10_000), ...(index < 4 ? [step('design', 1)] : []), step('implement', 20_000 * (index + 1)), step('verify', 5_000)]]))
  const turns = Array.from({ length: 5 }, (_, index) => subagent(`brief-${index}`, 'brief', index, 100_000))

  it('w5: sums the bands of the covered steps under its label and names every step it does not cover', () => {
    const sample = ladderSample({ ledgers: [{ source: 'runs.jsonl', lines }], effort: 'medium', runSteps, turns }, [])
    expect(sample.contour).toBe(`contour tokens ${APPROX} 175k, p25–p75 155k–195k (sum of step bands) ${DASH} covers preflight, implement, verify, brief; not covered: design (n=4 for medium/design), scan (n=0 for role scan), review (n=0 for role review)`)
  })

  it('names the turn journal as missing for every role when it is not there', () => {
    const sample = ladderSample({ ledgers: [{ source: 'runs.jsonl', lines }], effort: 'medium', runSteps, turns: null }, [])
    expect(sample.contour).toContain('brief (.construct/turns.jsonl not recorded)')
  })

  it('is none with every step named when nothing has a sample', () => {
    expect(formatContour([], [])).toBe(`contour none ${DASH} no step has a sample`)
  })
})
