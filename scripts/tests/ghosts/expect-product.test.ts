import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { countsTowardSteps } from '../../../src/commands/cost/expect.js'
import { readStepCache } from '../../../src/commands/cost/index.js'
import { parseLedgerLine } from '../../../src/commands/cost/ledger.js'
import { runCli } from '../../../tests/cli-process.js'
import * as expectSample from '../../ghosts/expect-sample.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const EXPECT_SAMPLE = path.join(REPO_ROOT, 'scripts/ghosts/expect-sample.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const SOURCE = '.construct/runs.jsonl'

interface Row {
  run?: string
  effort?: string
  tokens: number | 'unknown'
  seconds: number
  status?: string
  at: string
}

function ledgerLine(row: Row): string {
  const effort = row.effort ?? 'medium'
  const record: Record<string, unknown> = {
    at: row.at,
    task: 'a task',
    effort,
    status: row.status ?? 'done',
    rung: effort,
    attempts: [{ rung: 1, effort, outcome: 'passed', reason: '' }],
    agents: 2,
    tokens: row.tokens,
    toolUses: 5,
    seconds: row.seconds,
  }
  if (row.run !== undefined)
    record.run = row.run
  return JSON.stringify(record)
}

function stamp(index: number): string {
  return new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString()
}

function noisyMedium(count: number): string[] {
  const done = Array.from({ length: count }, (_, index) => ledgerLine({ run: `a${index + 1}`, tokens: 50_000 + ((index * 37_000) % 400_000), seconds: 120 + ((index * 53) % 900), at: stamp(index) }))
  const noise = [
    ledgerLine({ run: 'f1', tokens: 9_000_000, seconds: 10, status: 'failed', at: stamp(100) }),
    ledgerLine({ run: 'u1', tokens: 'unknown', seconds: 10, at: stamp(101) }),
    ledgerLine({ run: 'l1', effort: 'low', tokens: 9_000_000, seconds: 10, at: stamp(102) }),
    ledgerLine({ run: 'a2', tokens: 9_000_000, seconds: 10, at: stamp(103) }),
    ledgerLine({ tokens: 9_000_000, seconds: 10, at: stamp(104) }),
    JSON.stringify({ run: 'old', at: stamp(105), task: 'old schema', effort: 'medium', status: 'done', rung: 'medium', attempts: [{ rung: 1, effort: 'medium', outcome: 'passed' }], agents: 1, tokens: 1, toolUses: 1, seconds: 1 }),
    'not json',
  ]
  return [...done, ...noise]
}

function stepsCache(runs: string[]): string[] {
  return runs.map((run, index) => JSON.stringify({
    v: 1,
    run,
    steps: [
      { step: 'preflight', role: 'harness', attempt: 1, effort: null, tokens: 30_000 + index * 500, seconds: 60 + index },
      ...(index % 3 === 0 ? [] : [{ step: 'design', role: 'architect', attempt: 1, effort: null, tokens: 90_000 + index * 1_000, seconds: 240 + index * 7 }]),
      { step: 'implement', role: 'implementer', attempt: 1, effort: 'medium', tokens: 20_000 + index * 3_000, seconds: 100 + index * 11 },
      ...(index % 4 === 0 ? [{ step: 'implement', role: 'implementer', attempt: 2, effort: 'medium', tokens: 15_000, seconds: 90 }] : []),
      { step: 'verify', role: 'harness', attempt: 1, effort: null, tokens: 10_000 + index * 100, seconds: 30 },
    ],
  }))
}

function journal(runs: string[]): string[] {
  return runs.map((run, index) => JSON.stringify({ event: 'task', task: `t-${run}`, run, class: 'M1', sketch: index % 2 === 0 ? 'sketch/t @ 0123456789abcdef0123456789abcdef01234567' : null, session: `s-${run}`, ts: stamp(index) }))
}

interface Fixture {
  root: string
  home: string
  ledger: string[]
}

function fixture(ledger: string[], cache: string[] = [], extra: Record<string, string[]> = {}): Fixture {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'expect-product-')))
  const root = path.join(base, 'repo')
  const home = path.join(base, 'home')
  mkdirSync(path.join(root, '.construct'), { recursive: true })
  mkdirSync(home)
  writeFileSync(path.join(root, SOURCE), `${ledger.join('\n')}\n`)
  if (cache.length > 0)
    writeFileSync(path.join(root, '.construct/steps.jsonl'), `${cache.join('\n')}\n`)
  for (const [name, lines] of Object.entries(extra))
    writeFileSync(path.join(root, name), `${lines.join('\n')}\n`)
  return { root, home, ledger }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * q
  const below = Math.floor(position)
  const above = Math.ceil(position)
  return sorted[below] + (sorted[above] - sorted[below]) * (position - below)
}

interface ProductReport {
  line: string
  head: { kind: 'forecast', tokens: number, p25: number, p75: number, minutes: number, effort: string, n: number } | { kind: 'none', reason: string }
  steps: unknown[]
}

async function product(world: Fixture, ...args: string[]): Promise<ProductReport> {
  const run = await runCli(['cost', '--expect', ...args, '--json', '--dir', world.root], world.home)
  expect(run.status).toBe(0)
  return JSON.parse(run.stdout) as ProductReport
}

function scripted(world: Fixture, effort: string | undefined) {
  const runs = world.ledger.flatMap((text) => {
    const record = JSON.parse(text.startsWith('{') ? text : '{}') as { run?: string }
    return record.run === undefined ? [] : [record.run]
  })
  const runSteps = effort === undefined ? new Map() : new Map([...readStepCache(world.root).runs].filter(([run]) => runs.includes(run)))
  return expectSample.ladderSample({ ledgers: [{ source: SOURCE, lines: world.ledger }], effort, runSteps }, [])
}

const GOLDEN: string[] = [
  'expect: tokens ≈ 257k, minutes ≈ 7.8 — effort medium, n=20, median, p25–p75 159k–348k; ledger <root>/.construct/runs.jsonl; journal <root>/ghosts.jsonl; 2 rows the ledger parser rejects not counted in <root>/.construct/runs.jsonl (1 missing or invalid: attempts[0].reason, 1 not JSON); 1 run without a sketch record in <root>/ghosts.jsonl not counted for implement',
  'step preflight tokens ≈ 37k, minutes ≈ 1.2, p25–p75 34k–39k — n=20',
  'step design tokens ≈ 102k, minutes ≈ 5.4, p25–p75 97k–108k — n=16',
  'step implement (sketch) tokens ≈ 61k, minutes ≈ 4.4, p25–p75 45k–76k — n=12',
  'step verify tokens ≈ 11k, minutes ≈ 0.5, p25–p75 11k–12k — n=20',
  'role brief none — .construct/turns.jsonl not recorded',
  'role scan none — .construct/turns.jsonl not recorded',
  'role review none — .construct/turns.jsonl not recorded',
  'contour tokens ≈ 211k, p25–p75 187k–235k (sum of step bands) — covers preflight, design, implement, verify; not covered: brief (.construct/turns.jsonl not recorded), scan (.construct/turns.jsonl not recorded), review (.construct/turns.jsonl not recorded)',
  'a5  tokens 198000  minutes 5.5',
  'a6  tokens 235000  minutes 6.4',
  'a7  tokens 272000  minutes 7.3',
  'a8  tokens 309000  minutes 8.2',
  'a9  tokens 346000  minutes 9.1',
  'a10  tokens 383000  minutes 10',
  'a11  tokens 420000  minutes 10.8',
  'a12  tokens 57000  minutes 11.7',
  'a13  tokens 94000  minutes 12.6',
  'a14  tokens 131000  minutes 13.5',
  'a15  tokens 168000  minutes 14.4',
  'a16  tokens 205000  minutes 15.3',
  'a17  tokens 242000  minutes 16.1',
  'a18  tokens 279000  minutes 2',
  'a19  tokens 316000  minutes 2.9',
  'a20  tokens 353000  minutes 3.8',
  'a21  tokens 390000  minutes 4.7',
  'a22  tokens 427000  minutes 5.6',
  'a23  tokens 64000  minutes 6.4',
  'a24  tokens 101000  minutes 7.3',
]

const CASES: Array<{ name: string, ledger: string[], cache: string[], effort: string | undefined }> = [
  { name: 'twenty-four done rows and every kind of row that is not counted, with a step cache', ledger: noisyMedium(24), cache: stepsCache(Array.from({ length: 24 }, (_, index) => `a${index + 1}`)), effort: 'medium' },
  { name: 'a sample that mixes two efforts and no --effort', ledger: [...noisyMedium(6), ...Array.from({ length: 6 }, (_, index) => ledgerLine({ run: `b${index}`, effort: 'low', tokens: 5_000, seconds: 30, at: stamp(200 + index) }))], cache: [], effort: undefined },
  { name: 'four counted rows', ledger: noisyMedium(4), cache: [], effort: 'medium' },
  { name: 'exactly five counted rows and no step cache', ledger: noisyMedium(5), cache: [], effort: 'medium' },
]

describe('the script and the product are one calculation', () => {
  for (const scenario of CASES) {
    it(`gives the same line, steps and band for ${scenario.name}`, async () => {
      const world = fixture(scenario.ledger, scenario.cache)
      const report = await product(world, ...(scenario.effort === undefined ? [] : ['--effort', scenario.effort]))
      const sample = scripted(world, scenario.effort)
      expect(report.line).toBe(sample.line)
      expect(report.steps).toEqual(sample.steps)
      if (report.head.kind === 'none') {
        expect(report.line.startsWith(`expect: none — ${report.head.reason}`)).toBe(true)
        return
      }
      const tokens = sample.rows.map(row => row.tokens)
      expect(report.head.n).toBe(sample.rows.length)
      expect([report.head.tokens, report.head.p25, report.head.p75]).toEqual([median(tokens), quantile(tokens, 0.25), quantile(tokens, 0.75)])
      expect(Math.round(report.head.minutes * 10) / 10).toBe(Math.round(median(sample.rows.map(row => row.minutes)) * 10) / 10)
    })
  }
})

describe('the script keeps its inputs and its output', () => {
  it('still exports what its importers name', () => {
    const exported = expectSample as Record<string, unknown>
    for (const name of ['formatTokens', 'formatStepExpect', 'launchStepExpects', 'ladderSample', 'renderSample', 'stepExpects', 'stepsOfRepository', 'formatContour'])
      expect(typeof exported[name], name).toBe('function')
  })

  it('notes the runs without a sketch record by the step-count rule of src', () => {
    const counted = ledgerLine({ run: 'n1', tokens: 1_000, seconds: 10, at: stamp(300) })
    const ledger = [counted, ledgerLine({ run: 'n2', tokens: 1_000, seconds: 10, status: 'failed', at: stamp(301) }), ledgerLine({ run: 'n3', effort: 'low', tokens: 1_000, seconds: 10, at: stamp(302) })]
    const entries = ledger.map(text => parseLedgerLine(text)).filter(entry => typeof entry !== 'string')
    expect(entries.map(entry => countsTowardSteps(entry, 'medium'))).toEqual([true, false, false])
    const sample = expectSample.ladderSample({ ledgers: [{ source: SOURCE, lines: ledger }], effort: 'medium', runSteps: new Map(), sketch: { wanted: true, journal: { source: 'ghosts.jsonl', lines: [] } } }, [])
    expect(sample.line).toContain('; 1 run without a sketch record in ghosts.jsonl not counted for implement')
  })

  it('prints, for a journal class, a sketch subsample, a step cache and the ledger, the lines it printed before the calculation moved', () => {
    const ledger = noisyMedium(24)
    const runs = Array.from({ length: 24 }, (_, index) => `a${index + 1}`)
    const world = fixture(ledger, stepsCache(runs), { 'ghosts.jsonl': journal(runs) })
    const result = spawnSync(process.execPath, [TSX_CLI, EXPECT_SAMPLE, 'M1', '--effort', 'medium', '--sketch', 'yes', '--journal', path.join(world.root, 'ghosts.jsonl'), '--runs', path.join(world.root, SOURCE)], { cwd: world.root, encoding: 'utf8', env: { ...process.env, HOME: world.home } })
    expect(result.status).toBe(0)
    expect(result.stdout.split(world.root).join('<root>').trimEnd().split('\n')).toEqual(GOLDEN)
  })
})
