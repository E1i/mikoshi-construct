import type { Theme } from '../src/ui/theme.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOARD_FORMAT, boardJson, IMPLEMENT_SKILL, printBoard, readBoard } from '../src/commands/board/index.js'
import { ciOf } from '../src/commands/board/prs.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const NOW = new Date('2026-10-02T12:00:00.000Z')
const HOUR = 3_600_000
const MINUTE = 60_000
const NO_STDIN = (): string => ''

function ago(milliseconds: number): string {
  return new Date(NOW.getTime() - milliseconds).toISOString()
}

function repository(options: { implement?: boolean } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-board-'))
  if (options.implement === true) {
    mkdirSync(path.join(dir, path.dirname(IMPLEMENT_SKILL)), { recursive: true })
    writeFileSync(path.join(dir, IMPLEMENT_SKILL), '')
  }
  return dir
}

function ledger(dir: string, lines: string[]): void {
  mkdirSync(path.join(dir, '.construct'), { recursive: true })
  writeFileSync(path.join(dir, '.construct/runs.jsonl'), `${lines.join('\n')}\n`)
}

function run(task: string, status: string, age: number): string {
  return JSON.stringify({ at: ago(age), task, effort: 'low', status, rung: 'low', attempts: [], agents: 1, tokens: 1, toolUses: 1, seconds: 1 })
}

function check(conclusion: string, age: number): Record<string, string> {
  return { name: 'ci', status: 'COMPLETED', conclusion, completedAt: ago(age) }
}

function pr(number: number, title: string, state: string, rollup: unknown[], times: Record<string, string | null> = {}): unknown {
  return { number, title, state, createdAt: ago(3 * HOUR), closedAt: null, mergedAt: null, statusCheckRollup: rollup, ...times }
}

function prsFile(dir: string, prs: unknown[]): string {
  const file = path.join(dir, 'prs.json')
  writeFileSync(file, JSON.stringify(prs))
  return file
}

function render(dir: string, options: { prs?: string, all?: boolean, staleHours?: number, theme?: Theme } = {}): string[] {
  const lines: string[] = []
  const ui = createUi(options.theme ?? resolveTheme({ plain: true }), text => lines.push(text.replace(/\n$/, '')))
  printBoard(ui, readBoard(dir, { all: options.all ?? false, staleHours: options.staleHours ?? 4, prs: options.prs, readStdin: NO_STDIN, now: NOW }))
  return lines
}

function json(dir: string, prs?: string): ReturnType<typeof boardJson> {
  return boardJson(readBoard(dir, { all: false, staleHours: 4, prs, readStdin: NO_STDIN, now: NOW }))
}

function cells(line: string): string[] {
  return line.split('│').slice(1, 6).map(cell => cell.trim())
}

function bodyRows(lines: string[]): string[][] {
  return lines.filter(line => line.startsWith('│')).slice(1).map(cells)
}

describe('construct board', () => {
  it('each row takes its stage, next and tone from its own source, and nothing is joined', () => {
    const dir = repository({ implement: true })
    ledger(dir, [run('alpha', 'done', 2 * HOUR), run('beta', 'failed', HOUR)])
    const file = prsFile(dir, [
      pr(1, 'one ready', 'OPEN', [check('SUCCESS', 25 * MINUTE), check('SKIPPED', 20 * MINUTE)]),
      pr(2, 'two red', 'OPEN', [check('FAILURE', 20 * MINUTE)]),
      pr(3, 'three pending', 'OPEN', [{ context: 'lint', state: 'PENDING' }]),
      pr(4, 'four none', 'OPEN', []),
      pr(5, 'five error', 'OPEN', [{ context: 'lint', state: 'ERROR' }]),
    ])
    const rows = json(dir, file).rows as Array<Record<string, unknown>>
    expect(rows.map(row => [row.task, row.path, row.stage, row.state, row.next, row.tone])).toEqual([
      ['alpha', 'ladder', 'ladder done', 'waiting', 'a review, then a PR (you)', 'red'],
      ['beta', 'ladder', 'ladder failed', 'blocked', 'a decision (you): ladder failed', 'red'],
      ['#1 one ready', 'pr', 'ready', 'waiting', 'a merge (you)', 'red'],
      ['#2 two red', 'pr', 'open', 'blocked', 'a fix (you): CI red', 'red'],
      ['#3 three pending', 'pr', 'open', 'running', 'CI', null],
      ['#4 four none', 'pr', 'open', 'waiting', 'a merge (you): no CI checks reported', 'red'],
      ['#5 five error', 'pr', 'open', 'blocked', 'a fix (you): CI red', 'red'],
    ])
    expect(ciOf([check('SUCCESS', MINUTE), check('NEUTRAL', MINUTE)]).state).toBe('green')
  })

  it('rows are ordered blocked, stale, waiting, running, the oldest first, and a stale row says so', () => {
    const dir = repository()
    const file = prsFile(dir, [
      pr(1, 'running', 'OPEN', [{ context: 'lint', state: 'PENDING' }]),
      pr(2, 'blocked', 'OPEN', [check('FAILURE', MINUTE)]),
      pr(3, 'waiting old', 'OPEN', [check('SUCCESS', 5 * HOUR)]),
      pr(4, 'waiting new', 'OPEN', [check('SUCCESS', 20 * MINUTE)]),
    ])
    const lines = render(dir, { prs: file })
    expect(lines[0]).toBe('open 4: running 1, waiting 2, blocked 1, stale 1 · merged 12h: 0')
    expect(bodyRows(lines).map(row => row[0])).toEqual(['#2 blocked', '#3 waiting old', '#4 waiting new', '#1 running'])
    expect(bodyRows(lines)[1]![4]).toBe('stale 5h00m · a merge (you)')
    expect(bodyRows(render(dir, { prs: file, staleHours: 6 }))[1]![4]).toBe('a merge (you)')
  })

  it('an earlier run, a closed pull request, and a run finished or a pull request merged more than 12 hours ago are hidden unless --all', () => {
    const dir = repository()
    ledger(dir, [run('alpha', 'failed', 5 * HOUR), run('alpha', 'done', 2 * HOUR), run('old', 'done', 50 * HOUR)])
    const file = prsFile(dir, [
      pr(1, 'fresh merge', 'MERGED', [], { mergedAt: ago(HOUR) }),
      pr(2, 'old merge', 'MERGED', [], { mergedAt: ago(13 * HOUR) }),
      pr(3, 'closed', 'CLOSED', [], { closedAt: ago(HOUR) }),
    ])
    const shown = render(dir, { prs: file })
    expect(bodyRows(shown).map(row => row[0])).toEqual(['alpha'])
    expect(shown).toContain('merged: #1 fresh merge   (older: --all)')
    expect(shown).toContain('hidden: 3 rows, --all shows them')
    expect(shown[0]).toBe('open 1: running 0, waiting 1, blocked 0, stale 0 · merged 12h: 1')
    const all = render(dir, { prs: file, all: true })
    expect(bodyRows(all).map(row => row[0]).sort()).toEqual(['#3 closed', 'alpha', 'alpha', 'old'])
    expect(all).toContain('merged: #1 fresh merge · #2 old merge')
    expect(all.some(line => line.startsWith('hidden:'))).toBe(false)
  })

  it('only the STAGE and NEXT cells are coloured, and a plain run carries no escape', () => {
    const dir = repository()
    ledger(dir, [run('alpha', 'done', HOUR)])
    const coloured: Theme = { ...resolveTheme({ plain: true }), name: 'arasaka', primary: text => `<${text}>` }
    const row = render(dir, { theme: coloured }).find(line => line.includes('alpha'))!
    expect(row.split('│').slice(1, 6).map(cell => cell.trim())).toEqual(['alpha', 'ladder', '<ladder done>', '1h00m', '<a review, then a PR (you)>'])
    const plain = render(dir).join('\n')
    expect(plain).toContain('\u2502 ladder done \u2502')
    expect(plain).not.toContain('\u001B')
  })

  it('an absent or unreadable source is named as such and tallied as unknown only in --json', () => {
    const empty = repository()
    const text = render(empty).join('\n')
    expect(text).toContain('ledger .construct/runs.jsonl: absent')
    expect(text).toContain('prs: not read')
    expect(text).not.toContain('UNKNOWN')
    expect(json(empty).unknown).toEqual({ '.construct/runs.jsonl': 1, 'pull requests': 1 })

    const dir = repository()
    ledger(dir, [run('good', 'done', HOUR), 'not json'])
    const missing = path.join(dir, 'missing.json')
    expect(render(dir, { prs: missing }).join('\n')).toMatch(/prs .*missing\.json: unreadable \(.*ENOENT.*\)/)
    expect(render(dir, { prs: missing }).join('\n')).toContain('malformed lines 2')
    expect(json(dir, missing).unknown).toEqual({ '.construct/runs.jsonl': 1, 'pull requests': 1 })
    const object = path.join(dir, 'object.json')
    writeFileSync(object, '{}')
    expect((json(dir, object).sources as { prs: { reason: string } }).prs.reason).toBe('not a JSON array')
    expect(json(dir, prsFile(dir, [])).unknown).toEqual({ '.construct/runs.jsonl': 1 })
  })

  it('with nothing open the board names what was read and how to start, with and without /implement', () => {
    const command = 'gh pr list --state all --limit 100 --json number,title,state,createdAt,closedAt,mergedAt,statusCheckRollup'
    const withSkill = repository({ implement: true })
    const without = repository()
    const file = prsFile(withSkill, [])
    const tail = (lines: string[]): string[] => lines.filter(line => line.startsWith('nothing open') || line.startsWith('Start one') || line.startsWith('This repository'))
    expect(tail(render(withSkill, { prs: file }))).toEqual(['nothing open — no ladder runs in .construct/runs.jsonl and no open pull requests.', 'Start one in Claude Code: /plan <feature>, then /implement <task>.'])
    expect(tail(render(without, { prs: file }))).toEqual(['nothing open — no open pull requests.', 'This repository has no /implement, so the board lists pull requests only.'])
    expect(tail(render(withSkill))[0]).toBe(`nothing open — no ladder runs in .construct/runs.jsonl; pull requests not read: ${command} | construct board --prs -`)
    expect(tail(render(without))[0]).toBe(`nothing open — pull requests not read: ${command} | construct board --prs -`)
    ledger(withSkill, [run('old', 'done', 20 * HOUR)])
    expect(tail(render(withSkill, { prs: file }))[0]).toBe('nothing open — no ladder runs from the last 12 hours in .construct/runs.jsonl and no open pull requests.')
  })

  it('--json names its own format and says which rows are shown', () => {
    const dir = repository()
    ledger(dir, [run('old', 'done', 20 * HOUR)])
    const out = json(dir)
    expect(out.format).toBe(BOARD_FORMAT)
    expect(out.format).toBe('user-board/1')
    expect(out.schemaVersion).toBe(1)
    expect((out.rows as Array<{ shown: boolean }>).map(row => row.shown)).toEqual([false])
  })
})
