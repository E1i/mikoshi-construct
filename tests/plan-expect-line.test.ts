import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalImplementText } from '../scripts/ghosts/approval.js'
import { parseExpect } from '../scripts/ghosts/expect.js'
import { runCli } from './cli-process.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(ROOT, 'scripts/construct/check-acceptance.mjs')
const FACTORY_COPY = '.claude/commands/plan.md'
const TEMPLATE_COPY = 'templates/ai/claude/_claude/commands/plan.md'
const COPIES = [FACTORY_COPY, TEMPLATE_COPY]
const LINE_THREE = 2
const EXPECT_PREFIX = 'expect: '
const SOURCE = '.construct/runs.jsonl'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function skeletonLines(copy: string): string[] {
  const text = readFileSync(path.join(ROOT, copy), 'utf8')
  const block = /\n```text\n([\s\S]*?)\n```\n/.exec(text)
  expect(block, copy).not.toBeNull()
  return block![1].split('\n')
}

function filled(copy: string): string[] {
  let next = 0
  return skeletonLines(copy).map(line => line.startsWith(EXPECT_PREFIX) ? line : line.replace(/<[^>]+>/g, () => `p${next += 1}`))
}

function ledgerLine(run: string, index: number): string {
  return JSON.stringify({
    at: '2026-09-30T10:00:00Z',
    task: `task of ${run}`,
    effort: 'medium',
    status: 'done',
    rung: 'medium',
    attempts: [{ rung: 1, effort: 'medium', outcome: 'passed', reason: '' }],
    agents: 2,
    tokens: index * 100_000,
    toolUses: 5,
    seconds: index * 600,
    run,
  })
}

async function costLine(runs: number): Promise<string> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'plan-expect-line-')))
  dirs.push(root)
  const home = path.join(root, 'home')
  const repo = path.join(root, 'repo')
  mkdirSync(home)
  mkdirSync(path.join(repo, '.construct'), { recursive: true })
  const rows = Array.from({ length: runs }, (_, index) => ledgerLine(`m${index + 1}`, index + 1))
  writeFileSync(path.join(repo, SOURCE), `${rows.join('\n')}\n`)
  const run = await runCli(['cost', '--expect', '--effort', 'medium', '--plain', '--dir', repo], home)
  expect(run.status).toBe(0)
  return run.stdout.split('\n')[0]
}

function withExpectLine(copy: string, line: string): string {
  const lines = filled(copy)
  const at = lines.findIndex(candidate => candidate.startsWith(EXPECT_PREFIX))
  expect(at, copy).toBe(LINE_THREE)
  lines[at] = line
  return lines.join('\n')
}

function entryCard(brief: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-expect-card-'))
  dirs.push(dir)
  writeFileSync(path.join(dir, 'brief.md'), brief)
  const child = spawnSync(process.execPath, [SCRIPT, 'card', '--brief', path.join(dir, 'brief.md')], { encoding: 'utf8' })
  expect(child.status).toBe(0)
  return child.stdout
}

describe('the /plan skeleton carries the expect line the entry card and the launcher read', () => {
  it.each(COPIES)('in %s, has an expect: placeholder on line 3 of the skeleton that names construct cost --expect', (copy) => {
    const line = skeletonLines(copy)[LINE_THREE]

    expect(line.startsWith(EXPECT_PREFIX)).toBe(true)
    expect(line).toContain('construct cost --expect')
    expect(line.match(/<[^>]+>/g)).toHaveLength(1)
  })

  it('in the template copy, which has no Sketch: line, leaves line 2 blank so expect: is still line 3', () => {
    const lines = skeletonLines(TEMPLATE_COPY)

    expect(lines[1]).toBe('')
    expect(lines.filter(line => line.startsWith(EXPECT_PREFIX))).toHaveLength(1)
  })

  it.each(COPIES)('in %s, filled with the first line of cost --expect from five done runs, is read by the entry card and by parseExpect as a forecast of n=5', async (copy) => {
    const line = await costLine(5)
    const brief = withExpectLine(copy, line)

    expect(entryCard(brief)).toContain(`ladder: ${line.slice(EXPECT_PREFIX.length)} · brief, review not recorded`)
    expect(parseExpect(canonicalImplementText(brief)!)).toMatchObject({ kind: 'forecast', basis: { effort: 'medium', n: 5 } })
  })

  it.each(COPIES)('in %s, filled with the none line cost --expect prints for four runs, is read by the entry card and by parseExpect as none', async (copy) => {
    const line = await costLine(4)
    const brief = withExpectLine(copy, line)

    expect(line.startsWith('expect: none — n=4 for effort medium')).toBe(true)
    expect(entryCard(brief)).toContain(`ladder: ${line.slice(EXPECT_PREFIX.length)} · brief, review not recorded`)
    expect(parseExpect(canonicalImplementText(brief)!)).toMatchObject({ kind: 'none' })
  })

  it('in the factory copy, no longer says the skeleton leaves the expect line out, and says line 3 carries it', () => {
    const text = readFileSync(path.join(ROOT, FACTORY_COPY), 'utf8')

    expect(text).not.toContain('the skeleton leaves it out')
    expect(text).toContain('Line 3 is the `expect:` line the skeleton carries')
  })
})
