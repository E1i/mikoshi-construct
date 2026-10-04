import type { CostSource, RunDecomposition, RunStep } from '../../../src/commands/cost/index.js'
import type { LedgerEntry } from '../../../src/commands/cost/ledger.js'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { parseLedgerLine } from '../../../src/commands/cost/ledger.js'
import { formatStepExpect, ladderSample, renderSample, stepExpects, stepsOfRepository } from '../../ghosts/expect-sample.js'
import { formatExpect } from '../../ghosts/expect.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const EXPECT_SAMPLE = path.join(REPO_ROOT, 'scripts/ghosts/expect-sample.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
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
    const sample = ladderSample({ ledgers: [{ source: 'runs.jsonl', lines: ledger }], effort: 'medium', runSteps: steps }, [])
    expect(sample.steps.find(expected => expected.step === 'preflight')).toEqual({ kind: 'forecast', step: 'preflight', effort: 'medium', tokens: 30_000, minutes: 1, n: 5 })
    expect(sample.steps.find(expected => expected.step === 'implement')).toEqual({ kind: 'forecast', step: 'implement', effort: 'medium', tokens: 80_000, minutes: 4, n: 5 })
  })

  it('writes none with n and the effort/step pair when fewer than five runs have the step', () => {
    const { ledger, steps } = mediumSample()
    const sample = ladderSample({ ledgers: [{ source: 'runs.jsonl', lines: ledger }], effort: 'medium', runSteps: steps }, [])
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
    const lines = renderSample(ladderSample({ ledgers: [{ source: 'runs.jsonl', lines: ledger }], effort: 'medium', runSteps: steps }, []))
    expect(lines.slice(0, 5)).toEqual([
      `expect: tokens ${APPROX} 1k, minutes ${APPROX} 1 ${DASH} effort medium, n=5, median; ledger runs.jsonl`,
      `step preflight tokens ${APPROX} 30k, minutes ${APPROX} 1 ${DASH} n=5`,
      `step design none ${DASH} n=4 for medium/design`,
      `step implement tokens ${APPROX} 80k, minutes ${APPROX} 4 ${DASH} n=5`,
      `step verify tokens ${APPROX} 10k, minutes ${APPROX} 0.5 ${DASH} n=5`,
    ])
  })

  it('extends the forecast launch prints with the breakdown by step', () => {
    const { ledger, steps } = mediumSample()
    const breakdown = ladderSample({ ledgers: [{ source: 'runs.jsonl', lines: ledger }], effort: 'medium', runSteps: steps }, []).steps
    expect(formatExpect({ kind: 'none', reason: 'n=0 for any' }, breakdown)).toBe(`expect none ${DASH} n=0 for any; by step (effort medium, median): preflight tokens ${APPROX} 30k, minutes ${APPROX} 1 ${DASH} n=5; design none ${DASH} n=4 for medium/design; implement tokens ${APPROX} 80k, minutes ${APPROX} 4 ${DASH} n=5; verify tokens ${APPROX} 10k, minutes ${APPROX} 0.5 ${DASH} n=5`)
  })
})

function sourceOf(decompositions: Record<string, RunDecomposition>): CostSource {
  return {
    runtime: 'claude-code',
    readable: () => true,
    read: () => ({ status: 'empty', runs: [], key: '', candidates: [] }),
    steps: run => decompositions[run] ?? null,
  }
}

function emptyRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'expect-steps-'))
}

describe('expect-sample warnings about the step cache', () => {
  it('names each run left out for an unread agent, with the agent and the reason the decomposition gave', () => {
    const warnings: string[] = []
    const source = sourceOf({
      u1: { steps: [step('preflight', 1, 1)], unread: [{ run: 'u1', agent: 'scout', reason: 'no workflow phase' }, { run: 'u1', agent: 'notes', reason: 'phase notes is not a step' }] },
      k1: { steps: [step('preflight', 1, 1)], unread: [] },
    })
    const runs = stepsOfRepository(emptyRoot(), ['u1', 'k1'], warnings, source)
    expect(warnings).toEqual(['run u1 is left out of the step forecast: agent scout (no workflow phase); agent notes (phase notes is not a step)'])
    expect([...runs.keys()]).toEqual(['k1'])
  })

  it('warns about nothing when no run has an unread agent', () => {
    const warnings: string[] = []
    stepsOfRepository(emptyRoot(), ['k1'], warnings, sourceOf({ k1: { steps: [step('preflight', 1, 1)], unread: [] } }))
    expect(warnings).toEqual([])
  })

  it('reports a malformed step cache line by its number', () => {
    const root = emptyRoot()
    mkdirSync(path.join(root, '.construct'))
    writeFileSync(path.join(root, '.construct/steps.jsonl'), `${JSON.stringify({ v: 1, run: 'm1', steps: [] })}\n{broken\n`)
    const result = spawnSync(process.execPath, [TSX_CLI, EXPECT_SAMPLE, 'R2', '--effort', 'medium', '--journal', path.join(root, 'none.jsonl')], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root } })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('step cache line 2 is malformed; skipped\n')
  })
})
