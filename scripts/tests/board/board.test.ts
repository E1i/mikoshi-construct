import type { GhRunner } from '../../board/gh.js'
import type { BoardResult } from '../../board/run.js'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { NEXT_BY_SITUATION } from '../../board/next.js'
import { formatAge, formatMinutes, summaryLine } from '../../board/render.js'
import { ageSince } from '../../board/row.js'
import { runBoard } from '../../board/run.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const FIXTURES = path.join(REPO_ROOT, 'scripts/tests/board/fixtures')
const BASIC = path.join(FIXTURES, 'basic')
const MATRIX = path.join(FIXTURES, 'matrix')
const CHEAP = path.join(FIXTURES, 'cheap')
const NEXT = path.join(FIXTURES, 'next')
const SKEW = path.join(FIXTURES, 'skew')
const SUPERSEDED = path.join(FIXTURES, 'superseded')
const BOARD = path.join(REPO_ROOT, 'scripts/board/board.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const NOW = new Date('2026-09-28T12:00')

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

function board(argv: string[], gh: GhRunner = stubGh(), defaultDir = path.join(FIXTURES, 'absent')): BoardResult {
  return runBoard(argv, { gh, now: NOW, defaultDir })
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

function rows(stdout: string[]): string[][] {
  return stdout.filter(line => line.includes(' · ') && !line.startsWith('#')).map(line => line.split(' · '))
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
    expect(stdout.some(line => line.startsWith('# task (derived) = '))).toBe(true)
  })

  it.each([
    { name: 'default', argv: [] as string[], shown: ['alpha-2', 'beta-1', 'gamma-1', 'delta-1', 'm2', 'm3', 'm4', 'm5', 'm6'], hidden: ['alpha-1', 'm1'] },
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

  it.each([
    { name: 'a complete last line', text: `${JSON.stringify({ run: 'run-1', status: 'done' })}\n`, expected: 'done run-1' },
    { name: 'a half-written last line', text: `${JSON.stringify({ run: 'run-1', status: 'done' })}\n{"run":"run-2","sta`, expected: 'UNKNOWN (missing: ledger line; runs.jsonl last line still being written)' },
    { name: 'a broken line before the last', text: `{"run":"run-1","sta\n${JSON.stringify({ run: 'run-2', status: 'done' })}\n`, expected: 'UNKNOWN (missing: ledger line; runs.jsonl unreadable)' },
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
    expect(block.slice(1).map(line => line.trim().split(' ')[0])).toEqual(['started', 'ready', 'pr', 'merged'])
  })

  it('keeps the ladder stages for a task whose path line is not cheap', () => {
    const block = attemptBlock(board(['--dir', CHEAP, 'l-1']).stdout, 'l-1')
    expect(block.slice(1).map(line => line.trim().split(' ')[0])).toEqual(['brief', 'approved', 'ghost', 'review', 'ready', 'merged', 'pr', 'status.md', 'ledger'])
  })

  it('names the failed gh query for a cheap-path PR', () => {
    expect(stageOf(CHEAP, 'c-open', 'pr', failingGh)).toBe('UNKNOWN (missing: pr; the gh query failed)')
  })

  it('states in the card definitions that ready is derived from CI and not from the journal', () => {
    const { stdout } = board(['--dir', CHEAP, 'c-open'])
    expect(stdout.filter(line => line.startsWith('# ready is derived from CI') && line.includes('a journal ready field is not read'))).toHaveLength(1)
    expect(stdout.filter(line => line.startsWith('#') && line.includes('no event exists'))).toEqual([])
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

  it('heads each frame with the time it was drawn and hands the interval to the loop', () => {
    const { stdout, exitCode, everySeconds } = board(['--dir', BASIC, '--every', '2'])
    expect(exitCode).toBe(0)
    expect(everySeconds).toBe(2)
    expect(stdout[0]).toBe(`[board] frame ${NOW.toISOString()}`)
    expect(stdout.slice(1)).toEqual(board(['--dir', BASIC]).stdout)
  })

  it('redraws from the script until it is interrupted', async () => {
    const bin = mkdtempSync(path.join(tmpdir(), 'board-every-'))
    writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nif [ "$2" = list ]; then echo \'[]\'; else echo \'{}\'; fi\n', { mode: 0o755 })
    try {
      const child = spawn(process.execPath, [TSX_CLI, BOARD, '--dir', BASIC, '--every', '1'], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } })
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
    }
    finally {
      rmSync(bin, { recursive: true, force: true })
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
    { name: 'the default', argv: [] as string[], second: '# TASK · PATH · STAGE · AGE · NEXT' },
    { name: 'a card', argv: ['alpha-2'], second: '# board: read-only' },
  ])('prints $name bare and keeps the definitions as # payload lines', ({ argv, second }) => {
    const { stdout, stderr, exitCode } = board(['--dir', BASIC, ...argv])
    expect(exitCode).toBe(0)
    expect(stderr).toEqual([])
    expect(stdout.some(line => line.startsWith('[board]'))).toBe(false)
    expect((argv.length === 0 ? stdout[1] : stdout[0]).startsWith(second)).toBe(true)
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
  ] as { dir: string, id: string, path: string, stage: string, situation: keyof typeof NEXT_BY_SITUATION }[])('$id: $path at $stage waits for $situation', ({ dir, id, path: taskPath, stage, situation }) => {
    const cells = rowOf(board(['--dir', dir, '--all']).stdout, id)
    expect(cells).toHaveLength(5)
    expect([cells[0], cells[1], cells[2], cells[4]]).toEqual([id, taskPath, stage, NEXT_BY_SITUATION[situation]])
  })

  it('gives every situation of the NEXT table a fixture above', () => {
    const covered = new Set(['ci', 'new-attempt', 'ghost-running', 'verdict', 'merged', 'brief', 'approval', 'launch', 'pr', 'ci-red', 'owner-merge', 'auto-merge', 'merge-unknown', 'pr-closed', 'pr-unknown', 'superseded'])
    expect(Object.keys(NEXT_BY_SITUATION).filter(situation => !covered.has(situation))).toEqual(['ci-unknown'])
  })

  it('reads NEXT ci-unknown when the checks cannot be read', () => {
    const gh: GhRunner = args => args[1] === 'view' ? failingGh(args) : stubGh()(args)
    expect(rowOf(board(['--dir', CHEAP], gh).stdout, 'c-open')[4]).toBe(NEXT_BY_SITUATION['ci-unknown'])
  })

  it('marks NEXT derived once, in the header definition line', () => {
    const { stdout } = board(['--dir', BASIC])
    expect(stdout.filter(line => line.includes('NEXT (derived)'))).toEqual([stdout[1]])
    expect(stdout[1].startsWith('# ')).toBe(true)
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

describe('board: the UNKNOWN tally line', () => {
  it.each([
    { name: 'the default', argv: ['--dir', CHEAP], expected: 'UNKNOWN: brief.written ×1, brief.approved ×1, review.started ×1, ready ×2, merge ×2, pr ×1' },
    { name: 'a card', argv: ['--dir', CHEAP, 'c-journal'], expected: 'UNKNOWN: none' },
    { name: 'the ladder', argv: ['--dir', BASIC], expected: 'UNKNOWN: brief.approved ×8, brief.written ×7, review.started ×6' },
    { name: 'PRs missing from the gh list', argv: ['--dir', NEXT], expected: 'UNKNOWN: ready ×1, pr ×1, merge ×1, brief.approved ×2, review.started ×1' },
  ])('ends $name with one tally of the events that occur', ({ argv, expected }) => {
    const { stdout } = board(argv)
    expect(stdout.at(-1)).toBe(expected)
    expect(stdout.filter(line => line.startsWith('UNKNOWN:'))).toHaveLength(1)
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
    expect(stdout).toContain(`alpha-2 · ladder · review · ${rowOf(stdout, 'alpha-2')[3]} · CI`)
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
    { name: 'the default', argv: [] as string[], summary: 'running 1, waiting 0, blocked 0, the longest — ', shown: ['271-4'], hidden: 'hidden: 2 tasks (2 superseded), --all shows them', unknown: 'UNKNOWN: ready ×1, pr ×1, merge ×1' },
    { name: '--all', argv: ['--all'], summary: 'running 1, waiting 0, blocked 0, the longest — ', shown: ['271-2', '271-3', '271-4'], hidden: 'hidden: none', unknown: 'UNKNOWN: ready ×1, pr ×1, merge ×1' },
  ])('$name leaves it out of the summary and the UNKNOWN tally, and lists it only with --all', ({ argv, summary, shown, hidden, unknown }) => {
    const { stdout } = board(['--dir', SUPERSEDED, ...argv])
    expect(stdout[0].startsWith(summary) && stdout[0].endsWith('271-4)')).toBe(true)
    expect(rows(stdout).map(cells => cells[0]).sort()).toEqual(shown)
    expect(stdout[2].endsWith(hidden)).toBe(true)
    expect(stdout.at(-1)).toBe(unknown)
  })

  it('names the successor in the card, as a fact and in NEXT', () => {
    const { stdout } = board(['--dir', SUPERSEDED, '271-2'])
    expect(attemptBlock(stdout, '271-2').at(-1)).toBe('    superseded by 271-4 (journal event:superseded, 2026-09-28T07:00:00.000Z)')
    expect(stdout).toContain('next — (superseded) (derived; by 271-4)')
    expect(stdout.at(-1)).toBe('UNKNOWN: brief.written ×1, brief.approved ×1, review.started ×1, ready ×1, merge ×1')
  })

  it('carries the relation in --json and keeps the superseded attempts out of its UNKNOWN tally', () => {
    const json = JSON.parse(board(['--dir', SUPERSEDED, '--json']).stdout[0])
    const attempts = Object.fromEntries(json.tasks.flatMap((task: any) => task.attempts).map((attempt: any) => [attempt.id, attempt]))
    expect(attempts['271-2'].superseded).toEqual({ by: '271-4', ts: '2026-09-28T07:00:00.000Z' })
    expect(attempts['271-3'].superseded).toEqual({ by: '271-4', ts: '2026-09-28T07:00:00.000Z' })
    expect(attempts['271-4'].superseded).toBeNull()
    expect(attempts['271-2'].derived.next).toEqual({ situation: 'superseded', text: '— (superseded)', why: 'by 271-4' })
    expect(json.tasks.filter((task: any) => task.derived.shownByDefault).map((task: any) => task.derived.live)).toEqual(['271-4'])
    expect(json.unknown).toEqual({ ready: 1, pr: 1, merge: 1 })
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
    expect(json.format).toBe('board/1')
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
    expect(json.unknown).toEqual({ 'brief.written': 8, 'brief.approved': 9, 'review.started': 7 })
  })
})
