import type { RunStep } from '../../../src/commands/cost/index.js'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { ladderSample } from '../../ghosts/expect-sample.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const EXPECT_SAMPLE = path.join(REPO_ROOT, 'scripts/ghosts/expect-sample.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const SHA = '0123456789abcdef0123456789abcdef01234567'
const SIX = [1, 2, 3, 4, 5, 6]

type Mark = 'sha' | 'null' | 'absent'

function ledgerLine(run: string, mark: Mark, tokens: number): string {
  const row: Record<string, unknown> = {
    run,
    at: '2026-10-05T10:00:00Z',
    task: `task of ${run}`,
    effort: 'medium',
    status: 'done',
    rung: 'medium',
    attempts: [{ rung: 1, effort: 'medium', outcome: 'passed', reason: '' }],
    agents: 2,
    tokens,
    toolUses: 5,
    seconds: 600,
  }
  if (mark === 'sha')
    row.sketch = SHA
  if (mark === 'null')
    row.sketch = null
  return JSON.stringify(row)
}

function journalLine(run: string, sketch: string | null): string {
  return JSON.stringify({ event: 'task', task: `t-${run}`, run, class: 'M1', sketch, session: `s-${run}`, ts: '2026-10-05T10:00:00Z' })
}

interface Group {
  prefix: string
  mark: Mark
  tokens: number
}

function world(groups: Group[]) {
  const rows = groups.flatMap(group => SIX.map(index => ({ run: `${group.prefix}-${index}`, mark: group.mark, tokens: group.tokens + index })))
  const runSteps = new Map<string, RunStep[]>(rows.map(row => [row.run, [{ step: 'implement', role: 'implementer', attempt: 1, effort: 'medium', tokens: row.tokens, seconds: 120 }]]))
  return { lines: rows.map(row => ledgerLine(row.run, row.mark, row.tokens)), runSteps }
}

function implementStep(lines: string[], runSteps: Map<string, RunStep[]>, journal: string[], wanted: boolean) {
  const result = ladderSample({
    ledgers: [{ source: 'runs.jsonl', lines }],
    effort: 'medium',
    runSteps,
    sketch: { wanted, journal: { source: 'ghosts.jsonl', lines: journal } },
  }, [])
  return { step: result.steps.find(step => step.step === 'implement')!, line: result.line }
}

describe('the implement step is split by the sketch field of the ledger row', () => {
  const marked = world([{ prefix: 'with', mark: 'sha', tokens: 40_000 }, { prefix: 'without', mark: 'null', tokens: 100_000 }])

  it('counts the rows that carry a sha for sketch and the rows that carry null for no sketch, with an empty journal', () => {
    const yes = implementStep(marked.lines, marked.runSteps, [], true)
    const no = implementStep(marked.lines, marked.runSteps, [], false)
    expect(yes.step).toMatchObject({ kind: 'forecast', subsample: 'sketch', n: 6 })
    expect(no.step).toMatchObject({ kind: 'forecast', subsample: 'no sketch', n: 6 })
    expect((yes.step as { tokens: number }).tokens).toBeLessThan(50_000)
    expect((no.step as { tokens: number }).tokens).toBeGreaterThan(100_000)
    expect(yes.line).not.toContain('without a sketch record')
  })

  it('takes the sketch of a row with no field from the journal: the old way still works', () => {
    const old = world([{ prefix: 'with', mark: 'absent', tokens: 40_000 }, { prefix: 'without', mark: 'absent', tokens: 100_000 }])
    const journal = [...SIX.map(index => journalLine(`with-${index}`, `sketch/t @ ${SHA}`)), ...SIX.map(index => journalLine(`without-${index}`, null))]
    expect(implementStep(old.lines, old.runSteps, journal, true).step).toMatchObject({ kind: 'forecast', subsample: 'sketch', n: 6 })
    expect(implementStep(old.lines, old.runSteps, journal, false).step).toMatchObject({ kind: 'forecast', subsample: 'no sketch', n: 6 })
  })

  it('counts a row with no field and no journal record on neither side, and says how many', () => {
    const known = world([{ prefix: 'with', mark: 'sha', tokens: 40_000 }, { prefix: 'without', mark: 'null', tokens: 100_000 }])
    const silent = world([{ prefix: 'silent', mark: 'absent', tokens: 70_000 }])
    const lines = [...known.lines, ...silent.lines]
    const runSteps = new Map([...known.runSteps, ...silent.runSteps])
    for (const wanted of [true, false]) {
      const result = implementStep(lines, runSteps, [], wanted)
      expect(result.step, `wanted ${wanted}`).toMatchObject({ kind: 'forecast', n: 6 })
      expect(result.line, `wanted ${wanted}`).toMatch(/\b6 runs without a sketch record in ghosts\.jsonl not counted for implement/)
    }
  })

  it('lets the field win when the journal says the opposite', () => {
    const journal = [...SIX.map(index => journalLine(`with-${index}`, null)), ...SIX.map(index => journalLine(`without-${index}`, `sketch/t @ ${SHA}`))]
    const yes = implementStep(marked.lines, marked.runSteps, journal, true)
    const no = implementStep(marked.lines, marked.runSteps, journal, false)
    expect(yes.step).toMatchObject({ subsample: 'sketch', n: 6 })
    expect((yes.step as { tokens: number }).tokens).toBeLessThan(50_000)
    expect((no.step as { tokens: number }).tokens).toBeGreaterThan(100_000)
  })

  it('puts a row that carries a sha on the sketch side only', () => {
    const only = world([{ prefix: 'with', mark: 'sha', tokens: 40_000 }])
    expect(implementStep(only.lines, only.runSteps, [], true).step).toMatchObject({ kind: 'forecast', subsample: 'sketch', n: 6 })
    expect(implementStep(only.lines, only.runSteps, [], false).step).toMatchObject({ kind: 'none', subsample: 'no sketch', n: 0 })
  })
})

describe('the printed step line from the command', () => {
  it('prints the sketch subsample from ledger fields alone, with no journal file', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'expect-sample-ledger-sketch-')))
    mkdirSync(path.join(root, '.construct'))
    const marked = world([{ prefix: 'with', mark: 'sha', tokens: 40_000 }, { prefix: 'without', mark: 'null', tokens: 100_000 }])
    writeFileSync(path.join(root, '.construct/runs.jsonl'), `${marked.lines.join('\n')}\n`)
    const steps = [...marked.runSteps].map(([run, recorded]) => JSON.stringify({ v: 1, run, steps: recorded }))
    writeFileSync(path.join(root, '.construct/steps.jsonl'), `${steps.join('\n')}\n`)
    const result = spawnSync(process.execPath, [TSX_CLI, EXPECT_SAMPLE, '--effort', 'medium', '--sketch', 'yes', '--journal', path.join(root, 'absent.jsonl')], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root } })
    expect(result.status, result.stderr).toBe(0)
    const stepLine = result.stdout.split('\n').find(line => line.startsWith('step implement')) ?? ''
    expect(stepLine).toMatch(/^step implement \(sketch\) tokens ≈ 4\dk/)
    expect(stepLine).toMatch(/n=6$/)
  })
})
