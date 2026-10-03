import type { RunStep } from '../../../src/commands/cost/index.js'
import type { LedgerEntry } from '../../../src/commands/cost/ledger.js'
import { describe, expect, it } from 'vitest'
import { parseLedgerLine } from '../../../src/commands/cost/ledger.js'
import { expectSample, formatStepExpect, renderSample, stepExpects } from '../../ghosts/expect-sample.js'
import { formatExpect } from '../../ghosts/expect.js'

const DASH = String.fromCharCode(8212)
const APPROX = String.fromCharCode(8776)

function ledgerLine(run: string, effort: string, status = 'done'): string {
  return JSON.stringify({ run, at: '2026-09-30T10:00:00Z', task: `task of ${run}`, effort, status, rung: effort, attempts: [{ rung: 1, effort, outcome: 'passed', reason: '' }], agents: 3, tokens: 1000, toolUses: 5, seconds: 60 })
}

function step(name: string, tokens: number, seconds: number, attempt = 1): RunStep {
  return { step: name, role: 'harness', attempt, effort: null, tokens, seconds }
}

function cache(runs: Array<[string, RunStep[]]>): Map<string, RunStep[]> {
  return new Map(runs)
}

const FIVE_MEDIUM = ['m1', 'm2', 'm3', 'm4', 'm5']

function mediumSample(): { ledger: string[], steps: Map<string, RunStep[]> } {
  return {
    ledger: FIVE_MEDIUM.map(run => ledgerLine(run, 'medium')),
    steps: cache(FIVE_MEDIUM.map((run, index) => [run, [
      step('preflight', 30_000, 60),
      ...(index < 4 ? [step('design', 90_000, 240)] : []),
      step('implement', (index + 1) * 20_000, (index + 1) * 60),
      step('verify', 10_000, 30),
      ...(index === 0 ? [step('implement', 100_000, 600, 2)] : []),
    ]])),
  }
}

function entriesOf(ledger: string[]): LedgerEntry[] {
  return ledger.map(text => parseLedgerLine(text) as LedgerEntry)
}

describe('expect-sample by effort and step', () => {
  it('forecasts the median of each step from n >= 5 done runs of the effort, summing the attempts of a step within a run', () => {
    const { ledger, steps } = mediumSample()
    const sample = expectSample([], [{ source: 'runs.jsonl', lines: ledger }], 'any', 'medium', [], steps)
    expect(sample.steps.find(expected => expected.step === 'preflight')).toEqual({ kind: 'forecast', step: 'preflight', effort: 'medium', tokens: 30_000, minutes: 1, n: 5 })
    expect(sample.steps.find(expected => expected.step === 'implement')).toEqual({ kind: 'forecast', step: 'implement', effort: 'medium', tokens: 80_000, minutes: 4, n: 5 })
  })

  it('writes none with n and the effort/step pair when fewer than five runs have the step', () => {
    const { ledger, steps } = mediumSample()
    const sample = expectSample([], [{ source: 'runs.jsonl', lines: ledger }], 'any', 'medium', [], steps)
    const design = sample.steps.find(expected => expected.step === 'design')!
    expect(design).toEqual({ kind: 'none', step: 'design', effort: 'medium', n: 4 })
    expect(formatStepExpect(design)).toBe(`design none ${DASH} n=4 for medium/design`)
  })

  it('counts only done runs of the effort, each run once, and only runs whose steps are known', () => {
    const { ledger, steps } = mediumSample()
    const noisy = [...ledger, ledgerLine('m1', 'medium'), ledgerLine('h1', 'high'), ledgerLine('f1', 'medium', 'failed'), ledgerLine('u1', 'medium')]
    steps.set('h1', [step('preflight', 1, 1)])
    steps.set('f1', [step('preflight', 1, 1)])
    const result = stepExpects(entriesOf(noisy), steps, 'medium')
    expect(result.map(expected => expected.n)).toEqual([5, 4, 5, 5])
    expect(result.every(expected => expected.kind === 'none' || expected.tokens !== 1)).toBe(true)
  })

  it('prints a step line per step under the expect: line', () => {
    const { ledger, steps } = mediumSample()
    const lines = renderSample(expectSample([], [{ source: 'runs.jsonl', lines: ledger }], 'any', 'medium', [], steps))
    expect(lines.slice(0, 5)).toEqual([
      `expect: none ${DASH} n=0 for any`,
      `step preflight tokens ${APPROX} 30k, minutes ${APPROX} 1 ${DASH} n=5`,
      `step design none ${DASH} n=4 for medium/design`,
      `step implement tokens ${APPROX} 80k, minutes ${APPROX} 4 ${DASH} n=5`,
      `step verify tokens ${APPROX} 10k, minutes ${APPROX} 0.5 ${DASH} n=5`,
    ])
  })

  it('extends the forecast launch prints with the breakdown by step', () => {
    const { ledger, steps } = mediumSample()
    const breakdown = expectSample([], [{ source: 'runs.jsonl', lines: ledger }], 'any', 'medium', [], steps).steps
    expect(formatExpect({ kind: 'none', reason: 'n=0 for any' }, breakdown)).toBe(`expect none ${DASH} n=0 for any; by step (effort medium, median): preflight tokens ${APPROX} 30k, minutes ${APPROX} 1 ${DASH} n=5; design none ${DASH} n=4 for medium/design; implement tokens ${APPROX} 80k, minutes ${APPROX} 4 ${DASH} n=5; verify tokens ${APPROX} 10k, minutes ${APPROX} 0.5 ${DASH} n=5`)
  })
})
