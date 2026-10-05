import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseExpect } from '../scripts/ghosts/expect.js'
import { runCli } from './cli-process.js'

const DASH = String.fromCharCode(8212)
const APPROX = String.fromCharCode(8776)
const SOURCE = '.construct/runs.jsonl'
const IMPLEMENT_HEAD = '/implement x\nSketch: none — independent implementation is the witness'

interface Row {
  run?: string
  effort?: string
  tokens?: number | 'unknown'
  seconds?: number
  status?: string
  at?: string
}

function ledgerLine(row: Row): string {
  const effort = row.effort ?? 'medium'
  const record: Record<string, unknown> = {
    at: row.at ?? '2026-09-30T10:00:00Z',
    task: `task of ${row.run ?? 'unrecorded'}`,
    effort,
    status: row.status ?? 'done',
    rung: effort,
    attempts: [{ rung: 1, effort, outcome: 'passed', reason: '' }],
    agents: 2,
    tokens: row.tokens ?? 1000,
    toolUses: 5,
    seconds: row.seconds ?? 60,
  }
  if (row.run !== undefined)
    record.run = row.run
  return JSON.stringify(record)
}

function five(effort = 'medium', prefix = 'm'): string[] {
  return [1, 2, 3, 4, 5].map(index => ledgerLine({ run: `${prefix}${index}`, effort, tokens: index * 100_000, seconds: index * 600 }))
}

function stepsLine(run: string, steps: Array<[string, number, number]>): string {
  return JSON.stringify({ v: 1, run, steps: steps.map(([step, tokens, seconds]) => ({ step, role: 'harness', attempt: 1, effort: null, tokens, seconds })) })
}

interface World {
  home: string
  dir: string
}

function world(ledger: string[] | null, steps: string[] = []): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cost-expect-')))
  const home = path.join(root, 'home')
  const dir = path.join(root, 'repo')
  mkdirSync(home)
  mkdirSync(path.join(dir, '.construct'), { recursive: true })
  if (ledger !== null)
    writeFileSync(path.join(dir, SOURCE), `${ledger.join('\n')}\n`)
  if (steps.length > 0)
    writeFileSync(path.join(dir, '.construct/steps.jsonl'), `${steps.join('\n')}\n`)
  return { home, dir }
}

async function cost(w: World, ...args: string[]) {
  return runCli(['cost', ...args, '--dir', w.dir], w.home)
}

function lines(stdout: string): string[] {
  return stdout.trimEnd().split('\n')
}

function snapshot(w: World): Record<string, string> {
  const directory = path.join(w.dir, '.construct')
  return Object.fromEntries(readdirSync(directory).sort().map(name => [name, readFileSync(path.join(directory, name), 'utf8')]))
}

const FORECAST_LINE = `expect: tokens ${APPROX} 300k, minutes ${APPROX} 30 ${DASH} effort medium, n=5, median, p25–p75 200k–400k; ledger ${SOURCE}`
const NONE_FOUR_LINE = `expect: none ${DASH} n=4 for effort medium; ledger ${SOURCE}`

describe('construct cost --expect', () => {
  it('prints the forecast line for the effort from five done runs, naming the ledger it read', async () => {
    const run = await cost(world(five()), '--expect', '--effort', 'medium', '--plain')
    expect(run.status).toBe(0)
    expect(lines(run.stdout)[0]).toBe(FORECAST_LINE)
  })

  it('prints none with n and the effort when four runs are counted, and exits 0', async () => {
    const run = await cost(world(five().slice(0, 4)), '--expect', '--effort', 'medium', '--plain')
    expect(run.status).toBe(0)
    expect(lines(run.stdout)[0]).toBe(NONE_FOUR_LINE)
  })

  it('counts only done runs of the effort with known tokens, the first row of a run, and ignores a row with no run id', async () => {
    const noise = [
      ledgerLine({ run: 'f1', status: 'failed', tokens: 9_000_000 }),
      ledgerLine({ run: 'u1', tokens: 'unknown' }),
      ledgerLine({ run: 'l1', effort: 'low', tokens: 9_000_000 }),
      ledgerLine({ run: 'm1', tokens: 9_000_000, at: '2026-10-01T10:00:00Z' }),
      ledgerLine({ tokens: 9_000_000 }),
    ]
    const four = five().slice(0, 4)
    const none = await cost(world([...noise, ...four]), '--expect', '--effort', 'medium', '--plain')
    expect(lines(none.stdout)[0]).toBe(NONE_FOUR_LINE)
    const forecast = await cost(world([...noise, ...five()]), '--expect', '--effort', 'medium', '--plain')
    expect(lines(forecast.stdout)[0]).toBe(FORECAST_LINE)
  })

  it('reads the line with --plain as the forecast parseExpect takes from line 3 of an /implement text, and the none line as none', async () => {
    const forecast = await cost(world(five()), '--expect', '--effort', 'medium', '--plain')
    expect(forecast.status).toBe(0)
    expect(parseExpect(`${IMPLEMENT_HEAD}\n${lines(forecast.stdout)[0]}`)).toEqual({ kind: 'forecast', tokens: 300_000, minutes: 30, basis: { effort: 'medium', n: 5 }, band: { p25: 200_000, p75: 400_000 } })
    const none = await cost(world(five().slice(0, 4)), '--expect', '--effort', 'medium', '--plain')
    expect(parseExpect(`${IMPLEMENT_HEAD}\n${lines(none.stdout)[0]}`)).toEqual({ kind: 'none', reason: `n=4 for effort medium; ledger ${SOURCE}` })
  })

  it('prints the same expect line in the plain, the default and the johnny theme', async () => {
    const w = world(five())
    const [plain, themed, johnny] = [
      await cost(w, '--expect', '--effort', 'medium', '--plain'),
      await cost(w, '--expect', '--effort', 'medium'),
      await cost(w, '--expect', '--effort', 'medium', '--johnny'),
    ]
    expect([plain.status, themed.status, johnny.status]).toEqual([0, 0, 0])
    expect([lines(themed.stdout)[0], lines(johnny.stdout)[0]]).toEqual([FORECAST_LINE, FORECAST_LINE])
  })

  it('without --effort takes the one effort the done rows have, and refuses to mix several', async () => {
    const single = await cost(world(five()), '--expect', '--plain')
    expect(single.status).toBe(0)
    expect(lines(single.stdout)[0]).toBe(FORECAST_LINE)
    const mixed = await cost(world([...five('medium', 'm').slice(0, 3), ...five('low', 'l').slice(0, 3)]), '--expect', '--plain')
    expect(mixed.status).toBe(0)
    expect(lines(mixed.stdout)[0]).toBe(`expect: none ${DASH} the sample for every effort mixes efforts low, medium; pass --effort; ledger ${SOURCE}`)
  })

  it('names a ledger that is not there instead of printing n=0', async () => {
    const run = await cost(world(null), '--expect', '--effort', 'medium', '--plain')
    expect(run.status).toBe(0)
    expect(lines(run.stdout)[0]).toBe(`expect: none ${DASH} runs not recorded in ${SOURCE}; ledger ${SOURCE}`)
  })

  it('prints one step line per step after the expect line when an effort is given, from the step cache', async () => {
    const ledger = five()
    const steps = ledger.map((_, index) => stepsLine(`m${index + 1}`, [['preflight', 30_000, 60], ['design', 90_000, 240], ['implement', (index + 1) * 20_000, (index + 1) * 60], ['verify', 10_000, 30]]))
    const run = await cost(world(ledger, steps), '--expect', '--effort', 'medium', '--plain')
    expect(run.status).toBe(0)
    expect(lines(run.stdout)).toEqual([
      FORECAST_LINE,
      `step preflight tokens ${APPROX} 30k, minutes ${APPROX} 1, p25–p75 30k–30k ${DASH} n=5`,
      `step design tokens ${APPROX} 90k, minutes ${APPROX} 4, p25–p75 90k–90k ${DASH} n=5`,
      `step implement tokens ${APPROX} 60k, minutes ${APPROX} 3, p25–p75 40k–80k ${DASH} n=5`,
      `step verify tokens ${APPROX} 10k, minutes ${APPROX} 0.5, p25–p75 10k–10k ${DASH} n=5`,
    ])
  })

  it('writes nothing when the step cache already holds every run, and leaves the ledger as it was', async () => {
    const ledger = five()
    const w = world(ledger, ledger.map((_, index) => stepsLine(`m${index + 1}`, [['preflight', 1, 1]])))
    const before = snapshot(w)
    const run = await cost(w, '--expect', '--effort', 'medium', '--plain')
    expect(run.status).toBe(0)
    expect(snapshot(w)).toEqual(before)
  })

  it('prints one JSON object on stdout with the line, the head and the steps, and nothing else', async () => {
    const run = await cost(world(five()), '--expect', '--effort', 'medium', '--json')
    expect(run.status).toBe(0)
    const report = JSON.parse(run.stdout) as { line: string, head: unknown, sources: string[], notes: string[], steps: Array<{ step: string, kind: string }> }
    expect(report.line).toBe(FORECAST_LINE)
    expect(report.head).toEqual({ kind: 'forecast', tokens: 300_000, p25: 200_000, p75: 400_000, minutes: 30, effort: 'medium', n: 5 })
    expect([report.sources, report.notes]).toEqual([[`ledger ${SOURCE}`], []])
    expect(report.steps.map(step => step.step)).toEqual(['preflight', 'design', 'implement', 'verify'])
    const none = JSON.parse((await cost(world(five().slice(0, 4)), '--expect', '--effort', 'medium', '--json')).stdout) as { head: unknown }
    expect(none.head).toEqual({ kind: 'none', reason: 'n=4 for effort medium' })
  })
})

describe('construct cost --effort', () => {
  it('is refused without --expect, with a reason that names both flags, and writes nothing', async () => {
    const w = world(five())
    const before = snapshot(w)
    const run = await cost(w, '--effort', 'medium', '--plain')
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('--effort')
    expect(run.stderr).toContain('--expect')
    expect(run.stderr).not.toContain('Unknown flag')
    expect(snapshot(w)).toEqual(before)
  })

  it('is refused when its value is not low, medium or high, naming the value, and prints no forecast', async () => {
    const run = await cost(world(five()), '--expect', '--effort', 'extreme', '--plain')
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('extreme')
    expect(run.stdout).not.toContain('expect:')
  })
})

describe('construct cost without --expect', () => {
  it('still prints the report of the runs and no forecast line', async () => {
    const w = world(five())
    mkdirSync(path.join(w.home, '.claude/projects'), { recursive: true })
    const run = await cost(w, '--plain')
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('No /implement runs recorded here yet.')
    expect(run.stdout).not.toContain('expect:')
  })
})
