import type { GhRunner } from '../../board/gh.js'
import type { BoardResult } from '../../board/run.js'
import type { Tone } from '../../board/tone.js'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it } from 'vitest'
import { CLEAR_SCREEN, FRAME_FILE, frameText, writeFrameFile } from '../../board/frame.js'
import { NEXT_BY_SITUATION } from '../../board/next.js'
import { formatAge, formatMinutes, summaryLine } from '../../board/render.js'
import { ageSince } from '../../board/row.js'
import { HELP, runBoard, USAGE } from '../../board/run.js'
import { colourFor, painter, TONES } from '../../board/tone.js'
import { VERIFICATION_WORDS } from '../../board/verification.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const FIXTURES = path.join(REPO_ROOT, 'scripts/tests/board/fixtures')
const BASIC = path.join(FIXTURES, 'basic')
const MATRIX = path.join(FIXTURES, 'matrix')
const CHEAP = path.join(FIXTURES, 'cheap')
const NEXT = path.join(FIXTURES, 'next')
const SKEW = path.join(FIXTURES, 'skew')
const SUPERSEDED = path.join(FIXTURES, 'superseded')
const HAND = path.join(FIXTURES, 'hand')
const BOARD = path.join(REPO_ROOT, 'scripts/board/board.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const NOW = new Date('2026-09-28T12:00')
const HAND_NOW = new Date('2026-09-30T12:00:00Z')

const PRS = [
  { number: 2, headRefName: 'ghost/alpha-2', headRefOid: 'a2a2a2a2a2', state: 'OPEN', mergedAt: null, mergeCommit: null },
  { number: 3, headRefName: 'ghost/beta-1', headRefOid: 'b1b1b1b1b1', state: 'OPEN', mergedAt: null, mergeCommit: null },
  { number: 20, headRefName: 'c-journal', headRefOid: '2020202020', state: 'MERGED', mergedAt: '2026-09-28T07:59:00Z', mergeCommit: { oid: 'f'.repeat(40) } },
  { number: 21, headRefName: 'c-gh', headRefOid: '2121212121', state: 'MERGED', mergedAt: '2026-09-28T08:40:00Z', mergeCommit: { oid: '9'.repeat(40) } },
  { number: 22, headRefName: 'c-open', headRefOid: '2222222222', state: 'OPEN', mergedAt: null, mergeCommit: null },
  { number: 30, headRefName: 'n-red', headRefOid: '3030303030', state: 'OPEN', mergedAt: null, mergeCommit: null },
  { number: 31, headRefName: 'n-owner', headRefOid: '3131313131', state: 'OPEN', mergedAt: null, mergeCommit: null },
  { number: 32, headRefName: 'n-auto', headRefOid: '3232323232', state: 'OPEN', mergedAt: null, mergeCommit: null },
  { number: 33, headRefName: 'n-nofiles', headRefOid: '3333333333', state: 'OPEN', mergedAt: null, mergeCommit: null },
  { number: 34, headRefName: 'n-closed', headRefOid: '3434343434', state: 'CLOSED', mergedAt: null, mergeCommit: null },
  { number: 35, headRefName: 'n-pending', headRefOid: '3535353535', state: 'OPEN', mergedAt: null, mergeCommit: null },
  { number: 36, headRefName: 'n-release', title: 'chore: version packages', headRefOid: '3636363636', state: 'OPEN', mergedAt: null, mergeCommit: null },
  { number: 37, headRefName: 'n-pushed', headRefOid: '3737373737', state: 'OPEN', mergedAt: null, mergeCommit: null },
]

function green(completedAt: string): unknown[] {
  return [
    { name: 'quality', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt },
    { name: 'required', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt },
  ]
}

const GREEN = green('2026-09-28T07:20:00Z')

const VIEWS: Record<string, { headRefOid?: string, statusCheckRollup: unknown[], files?: { path: string }[] }> = {
  21: { statusCheckRollup: green('2026-09-28T08:20:00Z') },
  30: { statusCheckRollup: [{ name: 'quality', status: 'COMPLETED', conclusion: 'FAILURE' }, { name: 'required', status: 'COMPLETED', conclusion: 'FAILURE' }], files: [{ path: 'src/cli.ts' }] },
  31: { statusCheckRollup: GREEN, files: [{ path: 'src/cli.ts' }, { path: '.claude/skills/implement/SKILL.md' }] },
  32: { statusCheckRollup: GREEN, files: [{ path: 'src/cli.ts' }] },
  33: { statusCheckRollup: GREEN },
  35: { statusCheckRollup: [{ name: 'quality', status: 'IN_PROGRESS' }, { name: 'required', status: 'QUEUED' }], files: [{ path: 'src/cli.ts' }] },
  36: { statusCheckRollup: GREEN, files: [{ path: 'package.json' }] },
  37: { headRefOid: '3737373737', statusCheckRollup: [{ name: 'quality', status: 'IN_PROGRESS' }], files: [{ path: 'src/cli.ts' }] },
}

function stubGh(calls: string[][] = []): GhRunner {
  return (args) => {
    calls.push(args)
    if (args[0] === 'pr' && args[1] === 'list')
      return JSON.stringify(PRS)
    if (args[0] === 'pr' && args[1] === 'view')
      return JSON.stringify(VIEWS[args[2]!] ?? { statusCheckRollup: [] })
    throw new Error(`unexpected gh ${args.join(' ')}`)
  }
}

const failingGh: GhRunner = () => {
  throw new Error('offline')
}

function board(argv: string[], gh: GhRunner = stubGh(), defaultDir = path.join(FIXTURES, 'absent'), now = NOW): BoardResult {
  return runBoard(argv, { gh, now, defaultDir, colour: false })
}

function attemptBlock(stdout: string[], id: string): string[] {
  const start = stdout.findIndex(line => line.startsWith(`  ${id} `))
  expect(start, `no attempt block for ${id}`).toBeGreaterThanOrEqual(0)
  const end = stdout.findIndex((line, index) => index > start && !line.startsWith('    '))
  return stdout.slice(start, end === -1 ? undefined : end)
}

function stageOf(dir: string, id: string, stage: string, gh?: GhRunner): string {
  const line = attemptBlock(board(['--dir', dir, id], gh).stdout, id).find(candidate => candidate.startsWith(`    ${stage} `))
  expect(line, `no ${stage} line for ${id}`).toBeDefined()
  return line!.slice(`    ${stage} `.length)
}

function isCellLine(line: string): boolean {
  return stripVTControlCharacters(line).startsWith('│')
}

function cellsOf(line: string): string[] {
  return stripVTControlCharacters(line).split('│').slice(1, -1).map(cell => cell.trim())
}

function rows(stdout: string[]): string[][] {
  return stdout.filter(isCellLine).map(cellsOf).filter(cells => cells[0] !== 'TASK')
}

function rowOf(stdout: string[], id: string): string[] {
  const row = rows(stdout).find(cells => cells[0] === id)
  expect(row, `no row for ${id}`).toBeDefined()
  return row!
}

function snapshot(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const full = path.join(entry.parentPath, entry.name)
      return `${path.relative(dir, full)} ${statSync(full).mtimeMs}`
    })
    .sort()
}

describe('board: tasks are attempts grouped by brief', () => {
  it('groups attempts that name one brief into one derived task whose latest attempt is live', () => {
    const { stdout } = board(['--dir', BASIC, 'alpha-1'])
    expect(stdout).toContain('task brief-alpha.md (derived) live alpha-2 waiting, history alpha-1')
    expect(stdout).toContain('  alpha-1 history blocked')
    expect(stdout).toContain('  alpha-2 live waiting')
    expect(HELP.some(line => line.startsWith('# task (derived) = '))).toBe(true)
  })

  it.each([
    { name: 'default', argv: [] as string[], shown: ['alpha-2', 'beta-1', 'gamma-1', 'delta-1'], hidden: ['alpha-1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'] },
    { name: '--all', argv: ['--all'], shown: ['alpha-2', 'beta-1', 'gamma-1', 'delta-1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'], hidden: ['alpha-1'] },
  ])('$name prints one line per shown task, its live attempt, and --all every task', ({ argv, shown, hidden }) => {
    const { stdout } = board(['--dir', BASIC, ...argv])
    const attempts = rows(stdout).map(cells => cells[0])
    expect(attempts.sort()).toEqual([...shown].sort())
    for (const id of hidden)
      expect(attempts).not.toContain(id)
  })
})

describe('board: — for what did not happen, UNKNOWN naming the missing record', () => {
  it.each([
    { id: 'beta-1', stage: 'merged', expected: '— (not merged; last review verdict changes)' },
    { id: 'beta-1', stage: 'ready', expected: '— (last review verdict changes)' },
    { id: 'delta-1', stage: 'merged', expected: '— (no PR for ghost/delta-1)' },
    { id: 'delta-1', stage: 'pr', expected: '— (no PR for ghost/delta-1)' },
    { id: 'delta-1', stage: 'review', expected: 'UNKNOWN (missing: review.started)' },
    { id: 'alpha-2', stage: 'ready', expected: '— (no checks recorded on a2a2a2a)' },
    { id: 'alpha-2', stage: 'merged', expected: '— (PR #2 OPEN)' },
    { id: 'gamma-1', stage: 'ghost', expected: '— (not finished; status.md writing)' },
    { id: 'm6', stage: 'merged', expected: `done 2026-09-27T06:30:00.000Z (journal, by owner, ${'6'.repeat(7)})` },
  ])('$id $stage reads $expected', ({ id, stage, expected }) => {
    expect(stageOf(BASIC, id, stage)).toBe(expected)
  })

  it('names the failed gh query instead of claiming there is no PR', () => {
    const { stderr } = board(['--dir', BASIC], failingGh)
    expect(stageOf(BASIC, 'delta-1', 'merged', failingGh)).toBe('UNKNOWN (missing: merge; pr; the gh query failed)')
    expect(stderr).toEqual(['[board] gh pr list failed; every PR fact is UNKNOWN'])
  })
})

describe('board: the ledger stage reads the last line of the worktree ledger', () => {
  function withLedgers(ledgers: Record<string, string>): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'board-ledger-'))
    cpSync(BASIC, dir, { recursive: true })
    for (const [id, text] of Object.entries(ledgers)) {
      mkdirSync(path.join(dir, 'worktrees', id, '.construct'), { recursive: true })
      writeFileSync(path.join(dir, 'worktrees', id, '.construct', 'runs.jsonl'), text)
    }
    return dir
  }

  const LEDGER_ROW = { at: '2026-09-27T20:00:00.000Z', task: 'a run', effort: 'low', status: 'done', rung: 'low', attempts: [{ rung: 1, effort: 'low', outcome: 'done', reason: '' }], agents: 3, tokens: 100, toolUses: 4, seconds: 10 }
  const rowOf = (fields: Record<string, unknown>): string => JSON.stringify({ ...LEDGER_ROW, ...fields })

  it.each([
    { name: 'a complete last line', text: `${rowOf({ run: 'run-1' })}\n`, expected: 'done run-1' },
    { name: 'a half-written last line', text: `${rowOf({ run: 'run-1' })}\n{"run":"run-2","sta`, expected: 'UNKNOWN (missing: ledger line; runs.jsonl last line still being written)' },
    { name: 'a broken line before the last', text: `{"run":"run-1","sta\n${rowOf({ run: 'run-2' })}\n`, expected: 'UNKNOWN (missing: ledger line; runs.jsonl unreadable)' },
    { name: 'a last line that is not a ledger row', text: `${rowOf({ run: 'run-1' })}\n${JSON.stringify({ run: 'run-2', status: 'done' })}\n`, expected: 'UNKNOWN (missing: ledger line; runs.jsonl unreadable)' },
  ])('$name reads $expected', ({ text, expected }) => {
    const dir = withLedgers({ 'alpha-2': text })
    try {
      expect(stageOf(dir, 'alpha-2', 'ledger')).toBe(expected)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('board: a model-mismatch line of .construct/roles.jsonl shows on its task\'s card and in the summary', () => {
  const MISMATCH = { v: 1, at: '2026-09-28T11:00:00.000Z', kind: 'model-mismatch', session: 's-1', agent: 'a-1', agentType: 'brief', expected: 'sonnet', actual: 'claude-fable-5-1' }

  function roles(dir: string, lines: unknown[]): void {
    mkdirSync(path.join(dir, '.construct'), { recursive: true })
    writeFileSync(path.join(dir, '.construct', 'roles.jsonl'), lines.map(line => `${JSON.stringify(line)}\n`).join(''))
  }

  function scratch(): { dir: string, root: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'board-roles-'))
    cpSync(BASIC, dir, { recursive: true })
    const root = path.join(dir, 'repo-root')
    mkdirSync(root)
    return { dir, root }
  }

  function boardWith(root: string, argv: string[]): string[] {
    return runBoard(argv, { gh: stubGh(), now: NOW, defaultDir: path.join(FIXTURES, 'absent'), colour: false, repoRoot: root }).stdout
  }

  it('prints the mismatch under the attempt whose worktree recorded it, and counts the window\'s and the tasks\' in the summary', () => {
    const { dir, root } = scratch()
    try {
      roles(path.join(dir, 'worktrees', 'alpha-2'), [MISMATCH, { ...MISMATCH, kind: 'no-snapshot' }])
      roles(root, [MISMATCH, MISMATCH])

      expect(attemptBlock(boardWith(root, ['--dir', dir, 'alpha-2']), 'alpha-2')).toContain('    model-mismatch brief expected sonnet, ran on claude-fable-5-1 (2026-09-28T11:00:00.000Z, session s-1)')
      expect(boardWith(root, ['--dir', dir])[1]).toBe('model-mismatch 3: window 2, tasks 1 (a role ran on a model its definition does not name; .construct/roles.jsonl)')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves the board as it was when no model-mismatch line exists', () => {
    const { dir, root } = scratch()
    try {
      roles(root, [{ ...MISMATCH, kind: 'no-snapshot' }])

      expect(boardWith(root, ['--dir', dir])).toEqual(board(['--dir', dir]).stdout)
      expect(boardWith(root, ['--dir', dir, 'alpha-2'])).toEqual(board(['--dir', dir, 'alpha-2']).stdout)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('board: a budget line of .construct/eddies.jsonl shows on its task\'s card and in the summary (W10)', () => {
  const STOP = { v: 1, event: 'budget-stop', level: 'session-context', reason: 'context 150001 >= contextLimit 150000', tool: 'Agent', spent: 150001, limit: 150000, session_id: 's-1', agent_id: null, run_id: null, at: '2026-10-01T11:00:00.000Z' }
  const WARN = { ...STOP, event: 'budget-warn', level: 'agent', tool: undefined, spent: 1200000.4, limit: 1500000 }

  function eddies(dir: string, lines: unknown[]): void {
    mkdirSync(path.join(dir, '.construct'), { recursive: true })
    writeFileSync(path.join(dir, '.construct', 'eddies.jsonl'), lines.map(line => `${JSON.stringify(line)}\n`).join(''))
  }

  function scratch(): { dir: string, root: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'board-eddies-'))
    cpSync(BASIC, dir, { recursive: true })
    const root = path.join(dir, 'repo-root')
    mkdirSync(root)
    return { dir, root }
  }

  function boardWith(root: string, argv: string[]): string[] {
    return runBoard(argv, { gh: stubGh(), now: NOW, defaultDir: path.join(FIXTURES, 'absent'), colour: false, repoRoot: root }).stdout
  }

  it('prints each stop and warning under the attempt whose worktree recorded it, and counts the window\'s and the tasks\' in the summary', () => {
    const { dir, root } = scratch()
    try {
      eddies(path.join(dir, 'worktrees', 'alpha-2'), [STOP, WARN, { ...STOP, event: 'unread', reason: 'config-missing' }])
      eddies(root, [STOP])

      const block = attemptBlock(boardWith(root, ['--dir', dir, 'alpha-2']), 'alpha-2')
      expect(block).toContain('    budget-stop session-context 150001 / 150000 on Agent (2026-10-01T11:00:00.000Z, session s-1)')
      expect(block).toContain('    budget-warn agent 1200000 / 1500000 (2026-10-01T11:00:00.000Z, session s-1)')
      expect(boardWith(root, ['--dir', dir])[1]).toBe('eddies: budget-stop 2, budget-warn 1: window 1/0, tasks 1/1 (stop/warn; .construct/eddies.jsonl)')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves the board byte for byte as it was when no budget line exists', () => {
    const { dir, root } = scratch()
    try {
      eddies(root, [{ ...STOP, event: 'unread', reason: 'config-missing' }])
      const views = [boardWith(root, ['--dir', dir]), boardWith(root, ['--dir', dir, 'alpha-2'])]

      expect(views[0].join('\n')).toBe(board(['--dir', dir]).stdout.join('\n'))
      expect(views[1].join('\n')).toBe(board(['--dir', dir, 'alpha-2']).stdout.join('\n'))
      expect(views.flat().filter(line => /^eddies:|budget-(?:stop|warn) /.test(line.trim()))).toEqual([])
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('board: the cheap path reads started, pr and merged from the journal event:path line, and ready from CI', () => {
  it.each([
    { id: 'c-journal', stage: 'started', expected: 'done 2026-09-28T07:00:00.000Z (journal event:path)' },
    { id: 'c-journal', stage: 'ready', expected: '— (no checks recorded on 2020202)' },
    { id: 'c-journal', stage: 'pr', expected: '#20 MERGED (journal event:path, sha 2020202), ci — (no checks recorded on 2020202)' },
    { id: 'c-journal', stage: 'merged', expected: `done 2026-09-28T08:00:00.000Z (journal, by owner, abcdefa)` },
    { id: 'c-gh', stage: 'ready', expected: 'done 2026-09-28T08:20:00.000Z (CI required green on 2121212)' },
    { id: 'c-gh', stage: 'merged', expected: `done 2026-09-28T08:40:00.000Z (gh PR #21, ${'9'.repeat(7)})` },
    { id: 'c-open', stage: 'pr', expected: '#22 OPEN, ci — (no checks recorded on 2222222)' },
    { id: 'c-open', stage: 'merged', expected: '— (PR #22 OPEN)' },
    { id: 'c-noready', stage: 'ready', expected: 'UNKNOWN (missing: ready; pr; the journal event:path line records none)' },
    { id: 'c-noready', stage: 'pr', expected: 'UNKNOWN (missing: pr; the journal event:path line records none)' },
    { id: 'c-noready', stage: 'merged', expected: 'UNKNOWN (missing: merge; pr; the journal event:path line records none)' },
    { id: 'l-1', stage: 'ready', expected: 'UNKNOWN (missing: ready; branch; no tasks file names one)' },
  ])('$id $stage reads $expected', ({ id, stage, expected }) => {
    expect(stageOf(CHEAP, id, stage)).toBe(expected)
  })

  it.each([
    { id: 'c-journal', category: 'merged' },
    { id: 'c-gh', category: 'merged' },
    { id: 'c-open', category: 'running' },
    { id: 'c-noready', category: 'running' },
  ])('$id prints only the cheap-path stages and is $category', ({ id, category }) => {
    const block = attemptBlock(board(['--dir', CHEAP, id]).stdout, id)
    expect(block[0]).toBe(`  ${id} live ${category}`)
    expect(block.slice(1).map(line => line.trim().split(' ')[0])).toEqual(['started', 'ready', 'pr', 'merged', 'verification'])
  })

  it('keeps the ladder stages for a task whose path line is not cheap', () => {
    const block = attemptBlock(board(['--dir', CHEAP, 'l-1']).stdout, 'l-1')
    expect(block.slice(1).map(line => line.trim().split(' ')[0])).toEqual(['brief', 'approved', 'ghost', 'review', 'ready', 'merged', 'pr', 'status.md', 'ledger'])
  })

  it('names the failed gh query for a cheap-path PR', () => {
    expect(stageOf(CHEAP, 'c-open', 'pr', failingGh)).toBe('UNKNOWN (missing: pr; the gh query failed)')
  })

  it('states in --help that ready is derived from CI and not from the journal', () => {
    const stdout = HELP
    expect(stdout.filter(line => line.startsWith('# ready is derived from CI') && line.includes('a journal ready field is not read'))).toHaveLength(1)
    expect(stdout.filter(line => line.startsWith('#') && line.includes('no event exists'))).toEqual([])
  })
})

describe('board: a cheap task that ends in a report, not a PR', () => {
  it('prints the report as its outcome, not a PR as its next step', () => {
    const cells = rowOf(board(['--dir', CHEAP]).stdout, 'c-report')
    expect([cells[0], cells[1], cells[2], cells[4]]).toEqual(['c-report', 'cheap', 'reported', 'report: notes/c-report.md'])
  })

  it('is reported, not running, and has only the started and reported stages', () => {
    const block = attemptBlock(board(['--dir', CHEAP, 'c-report']).stdout, 'c-report')
    expect(block).toEqual([
      '  c-report live reported',
      '    started done 2026-09-28T10:00:00.000Z (journal event:path)',
      '    reported done 2026-09-28T10:30:00.000Z (journal event:path, report notes/c-report.md)',
      '    verification code-reading (journal event:path)',
    ])
  })

  it('leaves it out of the running count and the longest', () => {
    const summary = board(['--dir', CHEAP]).stdout[0]
    expect(summary).toMatch(/^running 2, waiting 1, blocked 0, /)
    expect(summary).not.toContain('c-report')
  })

  it('carries the category and the report in --json', () => {
    const json = JSON.parse(board(['--dir', CHEAP, '--json']).stdout[0])
    const task = json.tasks.find((candidate: any) => candidate.derived.live === 'c-report')
    expect(task.derived.category).toBe('reported')
    expect(task.derived.next).toEqual({ situation: 'report', text: 'report: notes/c-report.md', why: null })
    expect(task.derived.shownByDefault).toBe(true)
  })
})

describe('board: the verification word a cheap task records in its event:path line', () => {
  it.each([
    { id: 'c-gh', expected: 'run (journal event:path)' },
    { id: 'c-report', expected: 'code-reading (journal event:path)' },
    { id: 'c-journal', expected: 'UNKNOWN (missing: verification; the journal event:path line records none)' },
    { id: 'c-open', expected: `UNKNOWN (missing: verification; 'a hunch' is not one of ${VERIFICATION_WORDS.join(', ')})` },
  ])('$id reads $expected', ({ id, expected }) => {
    expect(stageOf(CHEAP, id, 'verification')).toBe(expected)
  })

  it('carries it in --json among the attempt facts', () => {
    const json = JSON.parse(board(['--dir', CHEAP, '--json']).stdout[0])
    const attempt = json.tasks.flatMap((task: any) => task.attempts).find((candidate: any) => candidate.id === 'c-gh')
    expect(attempt.facts).toContainEqual({ name: 'verification', state: 'fact', value: 'run', source: 'journal event:path', text: 'run (journal event:path)' })
  })

  it('keeps it out of the UNKNOWN tally, which counts stages only', () => {
    expect(Object.keys(JSON.parse(board(['--dir', CHEAP, '--json']).stdout[0]).unknown)).not.toContain('verification')
  })

  it('has every word explained in the AGENTS.md rule', () => {
    const agents = readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8')
    const rule = agents.split('\n').find(line => line.includes('`verification`'))
    expect(rule, 'no AGENTS.md line names the verification field').toBeDefined()
    for (const word of VERIFICATION_WORDS)
      expect(agents).toContain(`\`${word}\``)
  })
})

describe('board: ready is CI on the PR\'s current head, never the journal', () => {
  it.each([
    { id: 'n-auto', ready: 'done 2026-09-28T07:20:00.000Z (CI required green on 3232323)', category: 'waiting', note: 'green, and its journal line carries no ready' },
    { id: 'n-red', ready: '— (CI red (quality, required) on 3030303)', category: 'running', note: 'red, although its journal line carries ready' },
    { id: 'n-pending', ready: '— (CI pending (2 of 2) on 3535353)', category: 'running', note: 'running' },
    { id: 'n-pushed', ready: '— (CI pending (required not reported) on 3737373)', category: 'running', note: 'a new head whose required check has not reported, although its journal line carries ready and an older sha' },
  ])('$id reads $ready: $note', ({ id, ready, category }) => {
    const block = attemptBlock(board(['--dir', NEXT, id]).stdout, id)
    expect(block[0]).toBe(`  ${id} live ${category}`)
    expect(block.find(line => line.startsWith('    ready '))).toBe(`    ready ${ready}`)
  })

  it('makes a task not ready once a push makes a new head, until CI on that head is green', () => {
    const pushed: GhRunner = (args) => {
      if (args[1] === 'list')
        return JSON.stringify(PRS.map(pr => pr.number === 32 ? { ...pr, headRefOid: '4242424242' } : pr))
      if (args[1] === 'view' && args[2] === '32')
        return JSON.stringify({ headRefOid: '4242424242', statusCheckRollup: [{ name: 'quality', status: 'IN_PROGRESS' }, { name: 'required', status: 'QUEUED' }], files: [{ path: 'src/cli.ts' }] })
      return stubGh()(args)
    }
    const before = rowOf(board(['--dir', NEXT]).stdout, 'n-auto')
    expect([before[2], before[4]]).toEqual(['ready', NEXT_BY_SITUATION['auto-merge']])
    const after = board(['--dir', NEXT, 'n-auto'], pushed).stdout
    expect(attemptBlock(after, 'n-auto')[0]).toBe('  n-auto live running')
    expect(attemptBlock(after, 'n-auto')).toContain('    ready — (CI pending (2 of 2) on 4242424)')
    expect(rowOf(after, 'n-auto')[4]).toBe(NEXT_BY_SITUATION.ci)
  })
})

describe('board --every: reprint the view until interrupted', () => {
  it.each([
    { name: 'a missing value', argv: ['--every'] },
    { name: 'a flag as its value', argv: ['--every', '--all'] },
    { name: 'a non-numeric value', argv: ['--every', 'soon'] },
    { name: 'a fraction', argv: ['--every', '1.5'] },
    { name: 'zero', argv: ['--every', '0'] },
    { name: 'a negative value', argv: ['--every', '-5'] },
  ])('refuses $name, naming --every', ({ argv }) => {
    const { stdout, stderr, exitCode } = board(['--dir', BASIC, ...argv])
    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toHaveLength(1)
    expect(stderr[0].startsWith('[board] --every ')).toBe(true)
  })

  it('heads each frame with the time it was drawn and hands the interval and the frame file to the loop', () => {
    const { stdout, exitCode, everySeconds, frameFile } = board(['--dir', BASIC, '--every', '2'])
    expect(exitCode).toBe(0)
    expect(everySeconds).toBe(2)
    expect(frameFile).toBe(path.join(BASIC, 'board.txt'))
    expect(board(['--dir', BASIC]).frameFile).toBeUndefined()
    expect(stdout[0]).toBe(`[board] frame ${NOW.toISOString()}`)
    expect(stdout.slice(1)).toEqual(board(['--dir', BASIC]).stdout)
  })

  it('redraws from the script until it is interrupted, and replaces board.txt in the handoff directory with each frame', async () => {
    const bin = mkdtempSync(path.join(tmpdir(), 'board-every-'))
    const handoff = mkdtempSync(path.join(tmpdir(), 'board-every-handoff-'))
    cpSync(BASIC, handoff, { recursive: true })
    writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nif [ "$2" = list ]; then echo \'[]\'; else echo \'{}\'; fi\n', { mode: 0o755 })
    try {
      const child = spawn(process.execPath, [TSX_CLI, BOARD, '--dir', handoff, '--every', '1'], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } })
      let stdout = ''
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })
      const exited = new Promise(resolve => child.on('exit', resolve))
      await new Promise(resolve => setTimeout(resolve, 4500))
      expect(child.exitCode).toBeNull()
      child.kill('SIGTERM')
      await exited
      const lines = stdout.split('\n')
      const headers = lines.flatMap((line, index) => /^\[board\] frame \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(line) ? [index] : [])
      expect(headers.length).toBeGreaterThanOrEqual(2)
      for (const index of headers)
        expect(lines[index + 1]).toMatch(/^running \d+, waiting \d+, blocked \d+, the longest — /)
      expect(stdout).not.toContain(CLEAR_SCREEN)
      const frame = readFileSync(path.join(handoff, FRAME_FILE), 'utf8').split('\n')
      expect(frame[0]).toMatch(/^\[board\] frame \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(frame[1]).toMatch(/^running \d+, waiting \d+, blocked \d+, the longest — /)
      expect(frame.at(-2)).toMatch(/^└─+┴/)
      expect(frame.at(-1)).toBe('')
      expect(readdirSync(handoff).filter(name => name.endsWith('.tmp'))).toEqual([])
    }
    finally {
      rmSync(bin, { recursive: true, force: true })
      rmSync(handoff, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('board: summary, edges and prefixes', () => {
  it('counts live attempts only in the summary line at the top', () => {
    const { stdout } = board(['--dir', BASIC, '--all'])
    expect(stdout[0]).toBe('running 1, waiting 2, blocked 1, the longest — 180 min (alpha-2)')
  })

  it.each([
    { name: 'without a matrix', dir: BASIC, id: 'alpha-2', edges: ['edge: UNKNOWN'] },
    { name: 'with a Shredder matrix', dir: MATRIX, id: 'b', edges: ['edge: a -> b'] },
  ])('prints the card\'s edges $name', ({ dir, id, edges }) => {
    const { stdout } = board(['--dir', dir, id])
    expect(stdout.filter(line => line.startsWith('edge:'))).toEqual(edges)
  })

  it.each([
    { name: 'the default', argv: [] as string[], first: 'running 1, waiting 2, blocked 1, the longest — 180 min (alpha-2)', second: 'hidden: 6 tasks, --all shows them' },
    { name: '--all', argv: ['--all'], first: 'running 1, waiting 2, blocked 1, the longest — 180 min (alpha-2)', second: '┌' },
    { name: 'a card', argv: ['alpha-2'], first: '┌', second: '│ TASK' },
  ])('prints $name bare, with no # line, no UNKNOWN tally and no legend; they are in --help and --json', ({ argv, first, second }) => {
    const { stdout, stderr, exitCode } = board(['--dir', BASIC, ...argv])
    expect(exitCode).toBe(0)
    expect(stderr).toEqual([])
    expect(stdout.filter(line => line.startsWith('[board]') || line.startsWith('#') || line.startsWith('UNKNOWN'))).toEqual([])
    expect(stdout[0]!.startsWith(first)).toBe(true)
    expect(stdout[1]!.startsWith(second)).toBe(true)
  })

  it('carries every definition line in --help', () => {
    for (const prefix of ['# board: ', '# columns: ', '# stages: ', '# shown: ', '# hand-ladder = '])
      expect(HELP.filter(line => line.startsWith(prefix))).toHaveLength(1)
  })

  it.each([
    { name: 'no --dir and no default directory', argv: [] as string[], names: `no handoff directory at ${path.join(FIXTURES, 'absent')}, the default` },
    { name: 'an unknown argument', argv: ['--dir', BASIC, '--bogus'], names: '\'--bogus\'' },
    { name: 'a missing directory', argv: ['--dir', path.join(FIXTURES, 'absent')], names: 'no such directory' },
    { name: 'an unknown task id', argv: ['--dir', BASIC, 'zeta-1'], names: 'no task or attempt \'zeta-1\'' },
    { name: '--json with a task id', argv: ['--dir', BASIC, '--json', 'alpha-2'], names: '--json prints every task' },
  ])('refuses $name with a [board] message and no graph', ({ argv, names }) => {
    const { stdout, stderr, exitCode } = board(argv)
    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toHaveLength(1)
    expect(stderr[0].startsWith('[board] ')).toBe(true)
    expect(stderr[0]).toContain(names)
  })

  it('reads the default directory when --dir is not given, and --dir overrides it', () => {
    expect(board([], stubGh(), BASIC)).toEqual(board(['--dir', BASIC]))
    expect(board(['--dir', CHEAP], stubGh(), BASIC)).toEqual(board(['--dir', CHEAP]))
  })

  it('takes the default directory from CONSTRUCT_HANDOFF_DIR in the script itself, with the [board] prefix on its refusal', () => {
    const absent = path.join(FIXTURES, 'absent')
    const result = spawnSync(process.execPath, [TSX_CLI, BOARD], { encoding: 'utf8', env: { ...process.env, CONSTRUCT_HANDOFF_DIR: absent } })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.startsWith(`[board] no handoff directory at ${absent}, the default;`)).toBe(true)
  })
})

describe('board: read only', () => {
  it('writes nothing into the handoff directory and runs only gh pr list and gh pr view', () => {
    const before = [snapshot(BASIC), snapshot(MATRIX), snapshot(CHEAP), snapshot(NEXT), snapshot(SKEW), snapshot(SUPERSEDED)]
    const calls: string[][] = []
    board(['--dir', BASIC], stubGh(calls))
    board(['--dir', BASIC, '--all'], stubGh(calls))
    board(['--dir', MATRIX], stubGh(calls))
    board(['--dir', CHEAP, '--all'], stubGh(calls))
    board(['--dir', BASIC, 'alpha-1'], stubGh(calls))
    board(['--dir', BASIC, '--json'], stubGh(calls))
    board(['--dir', NEXT, '--json'], stubGh(calls))
    board(['--dir', SUPERSEDED, '--json'], stubGh(calls))
    expect([snapshot(BASIC), snapshot(MATRIX), snapshot(CHEAP), snapshot(NEXT), snapshot(SKEW), snapshot(SUPERSEDED)]).toEqual(before)
    expect(new Set(calls.map(args => args.slice(0, 2).join(' ')))).toEqual(new Set(['pr list', 'pr view']))
  })
})

describe('board: one line per live task, TASK · PATH · STAGE · AGE · NEXT', () => {
  it.each([
    { dir: BASIC, id: 'alpha-2', path: 'ladder', stage: 'review', situation: 'ci' },
    { dir: BASIC, id: 'beta-1', path: 'ladder', stage: 'review', situation: 'new-attempt' },
    { dir: BASIC, id: 'gamma-1', path: 'ladder', stage: '—', situation: 'ghost-running' },
    { dir: BASIC, id: 'delta-1', path: 'ladder', stage: 'ghost', situation: 'verdict' },
    { dir: BASIC, id: 'm6', path: 'ladder', stage: 'merged', situation: 'merged' },
    { dir: NEXT, id: 's-brief', path: 'ladder', stage: '—', situation: 'brief' },
    { dir: NEXT, id: 's-approval', path: 'ladder', stage: 'brief', situation: 'approval' },
    { dir: NEXT, id: 's-launch', path: 'ladder', stage: 'approved', situation: 'launch' },
    { dir: NEXT, id: 's-stopped', path: 'ladder', stage: 'ghost', situation: 'new-attempt' },
    { dir: NEXT, id: 's-nopr', path: 'ladder', stage: 'review', situation: 'pr' },
    { dir: CHEAP, id: 'c-noready', path: 'cheap', stage: 'started', situation: 'pr' },
    { dir: CHEAP, id: 'c-open', path: 'cheap', stage: 'started', situation: 'ci' },
    { dir: CHEAP, id: 'c-journal', path: 'cheap', stage: 'merged', situation: 'merged' },
    { dir: NEXT, id: 'n-red', path: 'cheap', stage: 'started', situation: 'ci-red' },
    { dir: NEXT, id: 'n-pending', path: 'cheap', stage: 'started', situation: 'ci' },
    { dir: NEXT, id: 'n-pushed', path: 'cheap', stage: 'started', situation: 'ci' },
    { dir: NEXT, id: 'n-owner', path: 'cheap', stage: 'ready', situation: 'owner-merge' },
    { dir: NEXT, id: 'n-release', path: 'cheap', stage: 'ready', situation: 'owner-merge' },
    { dir: NEXT, id: 'n-auto', path: 'cheap', stage: 'ready', situation: 'auto-merge' },
    { dir: NEXT, id: 'n-nofiles', path: 'cheap', stage: 'ready', situation: 'merge-unknown' },
    { dir: NEXT, id: 'n-closed', path: 'cheap', stage: 'started', situation: 'pr-closed' },
    { dir: NEXT, id: 'n-lost', path: 'cheap', stage: 'started', situation: 'pr-unknown' },
    { dir: SUPERSEDED, id: '271-2', path: 'ladder', stage: 'ghost', situation: 'superseded' },
    { dir: HAND, id: 'h-live', path: 'ladder', stage: 'hand-ladder', situation: 'hand-ladder-running' },
  ] as { dir: string, id: string, path: string, stage: string, situation: keyof typeof NEXT_BY_SITUATION }[])('$id: $path at $stage waits for $situation', ({ dir, id, path: taskPath, stage, situation }) => {
    const cells = rowOf(board(['--dir', dir, '--all'], stubGh(), undefined, dir === HAND ? HAND_NOW : NOW).stdout, id)
    expect(cells).toHaveLength(5)
    expect([cells[0], cells[1], cells[2], cells[4]]).toEqual([id, taskPath, stage, NEXT_BY_SITUATION[situation]])
  })

  it('gives every situation of the NEXT table a fixture above', () => {
    const covered = new Set(['ci', 'new-attempt', 'ghost-running', 'verdict', 'merged', 'brief', 'approval', 'launch', 'pr', 'ci-red', 'owner-merge', 'auto-merge', 'merge-unknown', 'pr-closed', 'pr-unknown', 'superseded', 'report', 'hand-ladder-running'])
    expect(Object.keys(NEXT_BY_SITUATION).filter(situation => !covered.has(situation))).toEqual(['ci-unknown'])
  })

  it('reads NEXT ci-unknown when the checks cannot be read', () => {
    const gh: GhRunner = args => args[1] === 'view' ? failingGh(args) : stubGh()(args)
    expect(rowOf(board(['--dir', CHEAP], gh).stdout, 'c-open')[4]).toBe(NEXT_BY_SITUATION['ci-unknown'])
  })

  it('marks NEXT derived once, in the --help column definition', () => {
    expect(HELP.filter(line => line.includes('NEXT (derived)'))).toHaveLength(1)
    expect(HELP.find(line => line.includes('NEXT (derived)'))!.startsWith('# columns: ')).toBe(true)
    expect(board(['--dir', BASIC]).stdout.filter(line => line.includes('NEXT (derived)'))).toEqual([])
  })

  it('prints AGE as the time since the latest stage', () => {
    const cells = rowOf(board(['--dir', CHEAP, '--all']).stdout, 'c-journal')
    expect(cells[3]).toBe(formatAge(ageSince(new Date('2026-09-28T08:00:00.000Z'), NOW)))
  })

  it.each([
    { minutes: 0, text: '0m' },
    { minutes: 59, text: '59m' },
    { minutes: 65, text: '1h05m' },
    { minutes: 24 * 60 + 61, text: '1d1h' },
  ])('formats $minutes minutes as $text', ({ minutes, text }) => {
    expect(formatMinutes(minutes)).toBe(text)
  })

  it.each([
    { name: 'a past time', at: '2026-09-28T10:00:00.000Z', now: '2026-09-28T10:30:00.000Z', expected: '30m' },
    { name: 'a future time', at: '2026-09-28T10:30:00.000Z', now: '2026-09-28T10:00:00.000Z', expected: 'clock skew (30m ahead)' },
  ])('never prints a negative AGE: $name reads $expected', ({ at, now, expected }) => {
    expect(formatAge(ageSince(new Date(at), new Date(now)))).toBe(expected)
  })

  it('prints a stage recorded in the future as clock skew, in the row and in the summary', () => {
    const { stdout } = board(['--dir', SKEW])
    expect(stdout[0]).toMatch(/^running 1, waiting 0, blocked 0, the longest — clock skew \(\d+ min ahead, k-future\)$/)
    expect(rowOf(stdout, 'k-future')[3]).toMatch(/^clock skew \(\d+d\d+h ahead\)$/)
    expect(stdout.join('\n')).not.toMatch(/-\d/)
  })

  it.each([
    { longest: { minutes: -5, task: 't' }, expected: 'clock skew (5 min ahead, t)' },
    { longest: { minutes: 5, task: 't' }, expected: '5 min (t)' },
  ])('summary longest $longest.minutes reads $expected', ({ longest, expected }) => {
    expect(summaryLine({ counts: { running: 1, waiting: 0, blocked: 0 }, longest })).toBe(`running 1, waiting 0, blocked 0, the longest — ${expected}`)
  })
})

describe('board --json: the UNKNOWN tally, and only there', () => {
  const TALLY: Record<string, Record<string, number>> = {
    cheap: { 'brief.written': 1, 'brief.approved': 1, 'review.started': 1, 'ready': 2, 'merge': 2, 'pr': 1 },
    basic: { 'brief.written': 8, 'brief.approved': 9, 'review.started': 7 },
    next: { 'brief.written': 1, 'brief.approved': 4, 'task': 3, 'review.started': 4, 'ready': 1, 'pr': 1, 'merge': 1 },
    superseded: { ready: 1, pr: 1, merge: 1 },
    hand: { 'brief.written': 4, 'brief.approved': 4, 'task': 1, 'review.started': 4, 'ready': 4, 'merge': 4, 'hand-ladder': 1 },
  }

  it.each(Object.keys(TALLY))('%s tallies the UNKNOWN stages of every attempt but the superseded, by event', (fixture) => {
    const dir = path.join(FIXTURES, fixture)
    expect(JSON.parse(board(['--dir', dir, '--json']).stdout[0]).unknown).toEqual(TALLY[fixture])
    for (const argv of [['--all'], [rows(board(['--dir', dir]).stdout)[0]?.[0] ?? '--all']])
      expect(board(['--dir', dir, ...argv]).stdout.filter(line => line.includes('UNKNOWN:') || line.includes('×'))).toEqual([])
  })
})

describe('board <task-id>: the expanded card of one task', () => {
  it.each([
    { name: 'the live attempt', id: 'alpha-2' },
    { name: 'a history attempt', id: 'alpha-1' },
    { name: 'the task name', id: 'brief-alpha.md' },
  ])('finds the task by $name and prints every attempt, stage and fact', ({ id }) => {
    const { stdout, exitCode } = board(['--dir', BASIC, id])
    expect(exitCode).toBe(0)
    expect(rows(stdout)).toHaveLength(1)
    expect([...rowOf(stdout, 'alpha-2').slice(0, 3), rowOf(stdout, 'alpha-2')[4]]).toEqual(['alpha-2', 'ladder', 'review', 'CI'])
    for (const attempt of ['alpha-1', 'alpha-2']) {
      expect(attemptBlock(stdout, attempt).slice(1).map(line => line.trim().split(' ')[0])).toEqual(['brief', 'approved', 'ghost', 'review', 'ready', 'merged', 'pr', 'status.md', 'ledger'])
    }
    expect(stdout).toContain('next CI (derived; — (no checks recorded on a2a2a2a))')
  })

  it('names why NEXT is Eli\'s merge', () => {
    const { stdout } = board(['--dir', NEXT, 'n-owner'])
    expect(stdout).toContain('next Eli\'s merge (derived; owner-merges own-instructions: .claude/skills/implement/SKILL.md)')
  })
})

describe('board: an attempt a journal event:superseded names', () => {
  it.each([
    { name: 'the default', argv: [] as string[], summary: 'running 1, waiting 0, blocked 0, the longest — ', shown: ['271-4'], hidden: ['hidden: 2 tasks (2 superseded), --all shows them'] },
    { name: '--all', argv: ['--all'], summary: 'running 1, waiting 0, blocked 0, the longest — ', shown: ['271-2', '271-3', '271-4'], hidden: [] },
  ])('$name leaves it out of the summary, and lists it only with --all', ({ argv, summary, shown, hidden }) => {
    const { stdout } = board(['--dir', SUPERSEDED, ...argv])
    expect(stdout[0].startsWith(summary) && stdout[0].endsWith('271-4)')).toBe(true)
    expect(rows(stdout).map(cells => cells[0]).sort()).toEqual(shown)
    expect(stdout.filter(line => line.startsWith('hidden: '))).toEqual(hidden)
  })

  it('names the successor in the card, as a fact and in NEXT', () => {
    const { stdout } = board(['--dir', SUPERSEDED, '271-2'])
    expect(attemptBlock(stdout, '271-2').at(-1)).toBe('    superseded by 271-4 (journal event:superseded, 2026-09-28T07:00:00.000Z)')
    expect(stdout).toContain('next — (superseded) (derived; by 271-4)')
  })

  it('carries the relation in --json', () => {
    const json = JSON.parse(board(['--dir', SUPERSEDED, '--json']).stdout[0])
    const attempts = Object.fromEntries(json.tasks.flatMap((task: any) => task.attempts).map((attempt: any) => [attempt.id, attempt]))
    expect(attempts['271-2'].superseded).toEqual({ by: '271-4', ts: '2026-09-28T07:00:00.000Z' })
    expect(attempts['271-3'].superseded).toEqual({ by: '271-4', ts: '2026-09-28T07:00:00.000Z' })
    expect(attempts['271-4'].superseded).toBeNull()
    expect(attempts['271-2'].derived.next).toEqual({ situation: 'superseded', text: '— (superseded)', why: 'by 271-4' })
    expect(json.tasks.filter((task: any) => task.derived.shownByDefault).map((task: any) => task.derived.live)).toEqual(['271-4'])
  })
})

describe('board: a ladder the owner decided to run by hand, from its status.md policy row', () => {
  function hand(argv: string[]): BoardResult {
    return board(['--dir', HAND, ...argv], stubGh(), undefined, HAND_NOW)
  }

  const HAND_LADDERS = {
    'h-live': { category: 'running', stage: 'hand-ladder', situation: 'hand-ladder-running', handLadder: `    hand-ladder done ${new Date('2026-09-28T12:00').toISOString()} (status.md policy hand-ladder-h-live)` },
    'h-stamp': { category: 'running', stage: '—', situation: 'hand-ladder-running', handLadder: '    hand-ladder UNKNOWN (missing: hand-ladder start; status.md policy hand-ladder-h-stamp updated is not YYYY-MM-DD HH:MM)' },
    'h-done': { category: 'waiting', stage: 'ghost', situation: 'verdict', handLadder: '    hand-ladder finished (status.md policy hand-ladder-h-done, updated 2026-09-28 12:00; a later journal event:task, review or merge)' },
    'h-none': { category: 'blocked', stage: 'ghost', situation: 'new-attempt', handLadder: undefined },
  } as const

  it.each(Object.entries(HAND_LADDERS))('%s is $category at $stage and waits for $situation', (id, { category, stage, situation, handLadder }) => {
    const cells = rowOf(hand(['--all']).stdout, id)
    expect([cells[2], cells[4]]).toEqual([stage, NEXT_BY_SITUATION[situation]])
    const block = attemptBlock(hand([id]).stdout, id)
    expect(block[0]).toBe(`  ${id} live ${category}`)
    expect(block.find(candidate => candidate.startsWith('    hand-ladder '))).toBe(handLadder)
    const json = JSON.parse(hand(['--json']).stdout[0])
    const task = json.tasks.find((candidate: any) => candidate.derived.live === id)
    expect([task.derived.category, task.derived.next.situation]).toEqual([category, situation])
  })

  it('shows the running ones by default and counts them as running', () => {
    const { stdout } = hand([])
    expect(stdout[0]).toMatch(/^running 2, waiting 1, blocked 1, /)
    expect(rows(stdout).map(cells => cells[0]).sort()).toEqual(['h-done', 'h-live', 'h-none', 'h-stamp'])
  })

  it('names the hand-ladder stage in --help', () => {
    expect(HELP.find(line => line.startsWith('# stages: '))).toContain('hand-ladder = the updated time of the status.md policy row hand-ladder-<id>')
    expect(HELP.find(line => line.startsWith('# hand-ladder = '))).toContain('NEXT reads the ladder\'s run')
  })
})

describe('board --json: the full output for agents', () => {
  function parsed(dir: string): any {
    const { stdout, stderr, exitCode } = board(['--dir', dir, '--json'])
    expect(exitCode).toBe(0)
    expect(stderr).toEqual([])
    expect(stdout).toHaveLength(1)
    expect(stdout[0].startsWith('{')).toBe(true)
    return JSON.parse(stdout[0])
  }

  it('prints every task and attempt, history included, whatever the default hides', () => {
    const json = parsed(BASIC)
    expect(json.format).toBe('board/3')
    const attempts = json.tasks.flatMap((task: any) => task.attempts.map((attempt: any) => attempt.id))
    expect(attempts.sort()).toEqual(['alpha-1', 'alpha-2', 'beta-1', 'delta-1', 'gamma-1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'])
    expect(json.tasks.find((task: any) => task.derived.live === 'm1').derived.shownByDefault).toBe(false)
  })

  it('keeps every derived field under derived', () => {
    const json = parsed(BASIC)
    expect(Object.keys(json).sort()).toEqual(['derived', 'edges', 'format', 'now', 'tasks', 'unknown'])
    expect(Object.keys(json.derived.summary).sort()).toEqual(['counts', 'longest'])
    for (const task of json.tasks) {
      expect(Object.keys(task).sort()).toEqual(['attempts', 'derived'])
      expect(Object.keys(task.derived).sort()).toEqual(['age', 'category', 'live', 'next', 'path', 'shownByDefault', 'stage', 'task'])
      for (const attempt of task.attempts)
        expect(Object.keys(attempt.derived).sort()).toEqual(['category', 'live', 'next', 'path'])
    }
  })

  it('gives each stage its state with the source or the UNKNOWN reason', () => {
    const json = parsed(BASIC)
    const alpha2 = json.tasks.flatMap((task: any) => task.attempts).find((attempt: any) => attempt.id === 'alpha-2')
    const byName = Object.fromEntries(alpha2.stages.map((stage: any) => [stage.name, stage]))
    expect(byName.review).toMatchObject({ state: 'done', at: '2026-09-28T07:10:00.000Z', source: 'verdict pass' })
    expect(byName.ready).toMatchObject({ state: 'not', reason: 'no checks recorded on a2a2a2a' })
    expect(byName.merged).toMatchObject({ state: 'not', reason: 'PR #2 OPEN' })
    expect(alpha2.derived.next).toEqual({ situation: 'ci', text: 'CI', why: '— (no checks recorded on a2a2a2a)' })
  })
})

describe('board: merged and reported tasks older than 12 hours are hidden by default', () => {
  const FINISHED = ['c-gh', 'c-journal', 'c-report']

  it.each([
    { name: 'all three finished within 12h', now: '2026-09-28T19:59:00Z', argv: [] as string[], shown: ['c-gh', 'c-journal', 'c-report'] },
    { name: 'c-journal merged 12h01m ago', now: '2026-09-28T20:01:00Z', argv: [] as string[], shown: ['c-gh', 'c-report'] },
    { name: 'both merged over 12h ago', now: '2026-09-28T20:41:00Z', argv: [] as string[], shown: ['c-report'] },
    { name: 'c-report reported 12h01m ago', now: '2026-09-28T22:31:00Z', argv: [] as string[], shown: [] },
    { name: '--all', now: '2026-09-28T22:31:00Z', argv: ['--all'], shown: ['c-gh', 'c-journal', 'c-report'] },
  ])('$name shows $shown among the finished', ({ now, argv, shown }) => {
    const at = new Date(now)
    const finished = (ids: string[]): string[] => ids.filter(id => FINISHED.includes(id)).sort()
    expect(finished(rows(board(['--dir', CHEAP, ...argv], stubGh(), undefined, at).stdout).map(cells => cells[0]!))).toEqual(shown)
    const byDefault = rows(board(['--dir', CHEAP], stubGh(), undefined, at).stdout).map(cells => cells[0]!)
    const json = JSON.parse(board(['--dir', CHEAP, '--json'], stubGh(), undefined, at).stdout[0])
    expect(finished(json.tasks.filter((task: any) => task.derived.shownByDefault).map((task: any) => task.derived.live))).toEqual(finished(byDefault))
  })

  it('states the rule in --help', () => {
    expect(HELP.find(line => line.startsWith('# shown: '))).toContain('each only while it merged or reported within the last 12h')
  })
})

describe('board: a bordered table measured by visible width', () => {
  const BORDERED = {
    top: /^┌─+(?:┬─+)+┐$/,
    under: /^├─+(?:┼─+)+┤$/,
    bottom: /^└─+(?:┴─+)+┘$/,
  }

  it.each([
    { name: 'the list', argv: ['--dir', NEXT, '--all'] },
    { name: 'a card', argv: ['--dir', NEXT, 'n-owner'] },
  ])('$name draws the same borders coloured and plain, and every table line has one visible width', ({ argv }) => {
    const plain = board(argv).stdout
    const coloured = runBoard(argv, { gh: stubGh(), now: NOW, defaultDir: NEXT, colour: true }).stdout
    expect(coloured).not.toEqual(plain)
    const start = plain.findIndex(line => line.startsWith('┌'))
    const end = plain.findIndex(line => line.startsWith('└'))
    expect([plain[start], plain[start + 2], plain[end]].map((line, index) => Object.values(BORDERED)[index]!.test(line!))).toEqual([true, true, true])
    for (const index of [start, start + 2, end])
      expect(coloured[index]).toBe(plain[index])
    const table = coloured.slice(start, end + 1).map(line => stripVTControlCharacters(line))
    expect(new Set(table.map(line => line.length)).size).toBe(1)
    expect(table.filter(line => line.startsWith('│')).map(line => [...line].filter(char => char === '│').length)).toEqual(table.filter(line => line.startsWith('│')).map(() => 6))
    expect(table).toEqual(plain.slice(start, end + 1))
  })
})

describe('board: colour on the STAGE and NEXT cells only', () => {
  function coloured(dir: string, argv: string[] = ['--all']): string[] {
    return runBoard(['--dir', dir, ...argv], { gh: stubGh(), now: NOW, defaultDir: dir, colour: true }).stdout
  }

  it.each([
    { dir: NEXT, id: 's-brief', tone: 'purple' },
    { dir: CHEAP, id: 'c-noready', tone: 'purple' },
    { dir: NEXT, id: 's-approval', tone: 'red' },
    { dir: NEXT, id: 's-launch', tone: 'red' },
    { dir: NEXT, id: 's-nopr', tone: 'red' },
    { dir: NEXT, id: 'n-red', tone: 'red' },
    { dir: NEXT, id: 'n-owner', tone: 'red' },
    { dir: NEXT, id: 'n-auto', tone: 'red' },
    { dir: BASIC, id: 'delta-1', tone: 'red' },
    { dir: BASIC, id: 'gamma-1', tone: 'yellow' },
    { dir: BASIC, id: 'm6', tone: 'grey' },
    { dir: CHEAP, id: 'c-journal', tone: 'grey' },
    { dir: NEXT, id: 'n-pending', tone: undefined },
    { dir: CHEAP, id: 'c-report', tone: undefined },
    { dir: SUPERSEDED, id: '271-2', tone: undefined },
    { dir: HAND, id: 'h-live', tone: 'yellow' },
  ] as { dir: string, id: string, tone: Tone | undefined }[])('$id paints STAGE and NEXT $tone and nothing else', ({ dir, id, tone }) => {
    const now = dir === HAND ? HAND_NOW : NOW
    const plain = board(['--dir', dir, '--all'], stubGh(), undefined, now).stdout
    const painted = runBoard(['--dir', dir, '--all'], { gh: stubGh(), now, defaultDir: dir, colour: true }).stdout
    const index = plain.findIndex(line => isCellLine(line) && cellsOf(line)[0] === id)
    const [, , stage, , next] = rowOf(plain, id)
    const paint = painter(true)
    const line = painted[index]!
    expect(line.includes(paint(tone, stage!))).toBe(true)
    expect(line.includes(paint(tone, next!))).toBe(true)
    const unpainted = line.replace(paint(tone, stage!), stage!).replace(paint(tone, next!), next!)
    expect(unpainted).toBe(plain[index])
  })

  it('paints no line but the table rows, and nothing in --json', () => {
    for (const dir of [BASIC, CHEAP, NEXT, SUPERSEDED]) {
      const plain = board(['--dir', dir, '--all']).stdout
      const painted = coloured(dir)
      const rowIds = new Set(rows(plain).map(cells => cells[0]))
      painted.forEach((line, index) => {
        if (!isCellLine(plain[index]!) || !rowIds.has(cellsOf(plain[index]!)[0]!))
          expect(line).toBe(plain[index])
      })
      expect(coloured(dir, ['--json'])).toEqual(board(['--dir', dir, '--json']).stdout)
    }
  })

  it.each([
    { name: 'a TTY with NO_COLOR unset', isTTY: true, noColor: undefined, expected: true },
    { name: 'a TTY with NO_COLOR empty', isTTY: true, noColor: '', expected: true },
    { name: 'a TTY with NO_COLOR=1', isTTY: true, noColor: '1', expected: false },
    { name: 'a pipe', isTTY: undefined, noColor: undefined, expected: false },
    { name: 'a non-TTY stream', isTTY: false, noColor: undefined, expected: false },
  ])('colours $name: $expected', ({ isTTY, noColor, expected }) => {
    expect(colourFor(isTTY, noColor)).toBe(expected)
  })
})

describe('board --help: the usage and the colour legend', () => {
  it('prints the usage and every colour with its meaning, and the default output carries no legend', () => {
    const { stdout, stderr, exitCode } = board(['--help'])
    expect(exitCode).toBe(0)
    expect(stderr).toEqual([])
    expect(stdout).toEqual(HELP)
    expect(stdout[0]).toBe(USAGE)
    expect(stdout.some(line => line.startsWith('--every ') && line.includes('clears a terminal') && line.includes(`<handoff dir>/${FRAME_FILE}`) && line.includes('a run without --every writes nothing'))).toBe(true)
    for (const [tone, meaning] of Object.entries(TONES))
      expect(stdout.some(line => line.includes(tone) && line.endsWith(meaning))).toBe(true)
    const printed = board(['--dir', BASIC, '--all']).stdout
    for (const meaning of Object.values(TONES))
      expect(printed.some(line => line.endsWith(meaning))).toBe(false)
  })
})

describe('board --every: the frame on the terminal and in board.txt', () => {
  it.each([
    { name: 'a terminal frame', clear: true, expected: `${CLEAR_SCREEN}a\nb\n` },
    { name: 'a piped frame', clear: false, expected: 'a\nb\n' },
  ])('$name reads $expected', ({ clear, expected }) => {
    expect(frameText(['a', 'b'], clear)).toBe(expected)
  })

  it('writes the frame as plain text, replaces the previous one and leaves no temporary file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'board-frame-'))
    try {
      const file = path.join(dir, FRAME_FILE)
      const paint = painter(true)
      writeFrameFile(file, ['first', paint('red', 'second')])
      expect(readFileSync(file, 'utf8')).toBe('first\nsecond\n')
      writeFrameFile(file, [paint('grey', 'third')])
      expect(readFileSync(file, 'utf8')).toBe('third\n')
      expect(readdirSync(dir)).toEqual([FRAME_FILE])
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
