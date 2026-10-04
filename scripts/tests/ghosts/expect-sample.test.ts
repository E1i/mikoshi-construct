import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { formatTokens, ladderSample, renderSample } from '../../ghosts/expect-sample.js'
import { parseExpect } from '../../ghosts/expect.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const EXPECT_SAMPLE = path.join(REPO_ROOT, 'scripts/ghosts/expect-sample.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
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

function oldSchemaLine(fixture: RunFixture): string {
  const row = JSON.parse(ledgerLine(fixture)) as { attempts: { reason?: string }[] }
  delete row.attempts[0]!.reason
  return JSON.stringify(row)
}

function sample(journal: string[], runs: RunFixture[], taskClass: string, effort?: string) {
  const warnings: string[] = []
  const result = ladderSample({ ledgers: [{ source: 'runs.jsonl', lines: runs.map(ledgerLine) }], effort, taskClass: { name: taskClass, journal: { source: 'ghosts.jsonl', lines: journal } } }, warnings)
  return { ...result, warnings }
}

function repositoryWith(ledger: string[]): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'expect-sample-')))
  mkdirSync(path.join(root, '.construct'))
  writeFileSync(path.join(root, '.construct/runs.jsonl'), `${ledger.join('\n')}\n`)
  return root
}

function cli(root: string, args: string[]): string[] {
  const result = spawnSync(process.execPath, [TSX_CLI, EXPECT_SAMPLE, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root } })
  expect(result.status).toBe(0)
  return result.stdout.trimEnd().split('\n')
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
    expect(result.line).toBe(`expect: none ${DASH} n=4 for class R2; ledger runs.jsonl; journal ghosts.jsonl`)
    expect(result.rows).toHaveLength(4)
  })

  it('takes the median over the runs of the class, not over every run in the ledger', () => {
    const result = sample([...R2_JOURNAL, ...R1_JOURNAL], [...SIX_R1, ...FIVE_R2], 'R2')
    expect(result.line).toBe(`expect: tokens ${APPROX} 300k, minutes ${APPROX} 30 ${DASH} effort medium, n=5, median, p25–p75 200k–400k; ledger runs.jsonl; journal ghosts.jsonl`)
  })

  it('prints a line parseExpect reads back as the same forecast', () => {
    const { line } = sample(R2_JOURNAL, FIVE_R2, 'R2')
    expect(parseExpect(`${HEAD}\n${line}`)).toEqual({ kind: 'forecast', tokens: 300_000, minutes: 30, basis: { effort: 'medium', n: 5 }, band: { p25: 200_000, p75: 400_000 } })
    expect(parseExpect(`${HEAD}\n${sample([], [], 'R2').line}`)).toEqual({ kind: 'none', reason: 'class R2 not recorded in ghosts.jsonl; ledger runs.jsonl; journal ghosts.jsonl' })
  })

  it('counts only done runs with a known token count, each run once', () => {
    const journal = [...R2_JOURNAL, journalTask('r2-1-again', 'wf_r2-1', 'R2'), journalTask('red', 'wf_red', 'R2'), journalTask('unk', 'wf_unk', 'R2')]
    const result = sample(journal, [...FIVE_R2, { run: 'wf_red', tokens: 35_000, seconds: 16, status: 'base red' }, { run: 'wf_unk', tokens: 'unknown', seconds: 60 }], 'R2')
    expect(result.rows.map(row => row.run)).toEqual(FIVE_R2.map(row => row.run))
  })

  it('keeps only the asked effort, and names it as the basis', () => {
    const highRuns = FIVE_R2.map(row => ({ ...row, run: `${row.run}-high`, effort: 'high', tokens: row.tokens * 2 }))
    const journal = [...R2_JOURNAL, ...highRuns.map(row => journalTask(`${row.task}-high`, row.run, 'R2'))]
    expect(sample(journal, [...FIVE_R2, ...highRuns], 'R2', 'high').line).toBe(`expect: tokens ${APPROX} 600k, minutes ${APPROX} 30 ${DASH} effort high, n=5, median, p25–p75 400k–800k; ledger runs.jsonl; journal ghosts.jsonl`)
    expect(sample(journal, [...FIVE_R2, ...highRuns], 'R2').line).toBe(`expect: none ${DASH} the sample for class R2 mixes efforts high, medium; pass --effort; ledger runs.jsonl; journal ghosts.jsonl`)
  })

  it('reports an unreadable journal line instead of dropping it silently', () => {
    const warnings: string[] = []
    ladderSample({ ledgers: [{ source: 'runs.jsonl', lines: [] }], taskClass: { name: 'R2', journal: { source: 'ghosts.jsonl', lines: ['{not json', journalTask('a', 'wf_a', 'R2')] } } }, warnings)
    expect(warnings).toEqual(['journal line 1 is not JSON; skipped'])
  })

  it('renders the line and then one row per run with its tokens and minutes', () => {
    expect(renderSample(sample(R2_JOURNAL.slice(0, 1), FIVE_R2, 'R2'))).toEqual([`expect: none ${DASH} n=1 for class R2; ledger runs.jsonl; journal ghosts.jsonl`, 'wf_r2-1  tokens 100000  minutes 10'])
  })
})

const FIVE_MEDIUM = FIVE_R2.map(row => ({ run: row.run, tokens: row.tokens, seconds: row.seconds }))
const SIX_OLD_SCHEMA = [1, 2, 3, 4, 5, 6].map(index => oldSchemaLine({ run: `wf_old-${index}`, tokens: 9_000_000, seconds: 6000 }))

describe('one ladder sample for the CLI and the library', () => {
  it('prints from the CLI with --effort medium the same n and median the library reads from the same ledger', () => {
    const ledger = [...FIVE_MEDIUM.map(ledgerLine), ledgerLine({ run: 'wf_r2-1', tokens: 1, seconds: 1 }), ledgerLine({ run: 'wf_high', tokens: 1, seconds: 1, effort: 'high' })]
    const root = repositoryWith(ledger)
    const library = ladderSample({ ledgers: [{ source: path.join(root, '.construct/runs.jsonl'), lines: ledger }], effort: 'medium' }, [])
    const [line] = cli(root, ['--effort', 'medium'])
    expect(library.line).toBe(`expect: tokens ${APPROX} 300k, minutes ${APPROX} 30 ${DASH} effort medium, n=5, median, p25–p75 200k–400k; ledger ${path.join(root, '.construct/runs.jsonl')}`)
    expect(line).toBe(library.line)
  })

  it('counts only the rows the ledger parser accepts and names the rejected ones with their source', () => {
    const root = repositoryWith([...SIX_OLD_SCHEMA, ...FIVE_MEDIUM.map(ledgerLine)])
    const ledger = path.join(root, '.construct/runs.jsonl')
    expect(cli(root, ['--effort', 'medium'])[0]).toBe(`expect: tokens ${APPROX} 300k, minutes ${APPROX} 30 ${DASH} effort medium, n=5, median, p25–p75 200k–400k; ledger ${ledger}; 6 rows the ledger parser rejects not counted in ${ledger} (6 missing or invalid: attempts[0].reason)`)
  })

  it('names the class not recorded in the journal instead of printing n=0', () => {
    const journal = FIVE_R2.map(row => journalTask(row.task, row.run, null))
    const result = ladderSample({ ledgers: [{ source: 'runs.jsonl', lines: FIVE_MEDIUM.map(ledgerLine) }], effort: 'medium', taskClass: { name: 'R2', journal: { source: 'ghosts.jsonl', lines: journal } } }, [])
    expect(result.line).toBe(`expect: none ${DASH} class not recorded on 5 lines in ghosts.jsonl; ledger runs.jsonl; journal ghosts.jsonl`)
  })

  it('names a ledger or a journal that is not there instead of printing n=0', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'expect-sample-')))
    const journal = path.join(root, 'ghosts.jsonl')
    expect(cli(root, ['--effort', 'medium'])[0]).toBe(`expect: none ${DASH} runs not recorded in ${path.join(root, '.construct/runs.jsonl')}; ledger ${path.join(root, '.construct/runs.jsonl')}`)
    expect(ladderSample({ ledgers: [{ source: 'runs.jsonl', lines: FIVE_MEDIUM.map(ledgerLine) }], taskClass: { name: 'R2', journal: { source: journal, lines: null } } }, []).line).toBe(`expect: none ${DASH} task lines not recorded in ${journal}; ledger runs.jsonl; journal ${journal}`)
  })

  it('prints a forecast line with its sources that parseExpect still reads as the forecast', () => {
    const { line } = ladderSample({ ledgers: [{ source: 'runs.jsonl', lines: [...SIX_OLD_SCHEMA, ...FIVE_MEDIUM.map(ledgerLine)] }], effort: 'medium' }, [])
    expect(parseExpect(`${HEAD}\n${line}`)).toEqual({ kind: 'forecast', tokens: 300_000, minutes: 30, basis: { effort: 'medium', n: 5 }, band: { p25: 200_000, p75: 400_000 } })
  })
})

describe('formatTokens', () => {
  it('writes the k and M scales parseExpect reads', () => {
    expect([formatTokens(950), formatTokens(166_400), formatTokens(1_234_567)]).toEqual(['950', '166k', '1.2M'])
  })
})
