import type { GhRunner } from '../../board/gh.js'
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { runBoard } from '../../board/run.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const FIXTURES = path.join(REPO_ROOT, 'scripts/tests/board/fixtures')
const BASIC = path.join(FIXTURES, 'basic')
const MATRIX = path.join(FIXTURES, 'matrix')
const CHEAP = path.join(FIXTURES, 'cheap')
const BOARD = path.join(REPO_ROOT, 'scripts/board/board.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const NOW = new Date('2026-09-28T12:00')

const PRS = [
  { number: 2, headRefName: 'ghost/alpha-2', headRefOid: 'a2a2a2a2a2', state: 'OPEN', mergedAt: null, mergeCommit: null },
  { number: 3, headRefName: 'ghost/beta-1', headRefOid: 'b1b1b1b1b1', state: 'OPEN', mergedAt: null, mergeCommit: null },
  { number: 20, headRefName: 'c-journal', headRefOid: '2020202020', state: 'MERGED', mergedAt: '2026-09-28T07:59:00Z', mergeCommit: { oid: 'f'.repeat(40) } },
  { number: 21, headRefName: 'c-gh', headRefOid: '2121212121', state: 'MERGED', mergedAt: '2026-09-28T08:40:00Z', mergeCommit: { oid: '9'.repeat(40) } },
  { number: 22, headRefName: 'c-open', headRefOid: '2222222222', state: 'OPEN', mergedAt: null, mergeCommit: null },
]

function stubGh(calls: string[][] = []): GhRunner {
  return (args) => {
    calls.push(args)
    if (args[0] === 'pr' && args[1] === 'list')
      return JSON.stringify(PRS)
    if (args[0] === 'pr' && args[1] === 'view')
      return JSON.stringify({ statusCheckRollup: [] })
    throw new Error(`unexpected gh ${args.join(' ')}`)
  }
}

const failingGh: GhRunner = () => {
  throw new Error('offline')
}

function board(argv: string[], gh: GhRunner = stubGh()): { stdout: string[], stderr: string[], exitCode: number } {
  return runBoard(argv, { gh, now: NOW })
}

function attemptBlock(stdout: string[], id: string): string[] {
  const start = stdout.findIndex(line => line.startsWith(`  ${id} `))
  expect(start, `no attempt block for ${id}`).toBeGreaterThanOrEqual(0)
  const end = stdout.findIndex((line, index) => index > start && !line.startsWith('    '))
  return stdout.slice(start, end === -1 ? undefined : end)
}

function stageOf(stdout: string[], id: string, stage: string): string {
  const line = attemptBlock(stdout, id).find(candidate => candidate.startsWith(`    ${stage} `))
  expect(line, `no ${stage} line for ${id}`).toBeDefined()
  return line!.slice(`    ${stage} `.length)
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
    const { stdout } = board(['--dir', BASIC, '--all'])
    expect(stdout).toContain('task brief-alpha.md (derived) live alpha-2 waiting, history alpha-1')
    expect(stdout).toContain('  alpha-1 history blocked')
    expect(stdout).toContain('  alpha-2 live waiting')
    expect(stdout.some(line => line.startsWith('# task (derived) = '))).toBe(true)
  })

  it.each([
    { name: 'default', argv: [] as string[], shown: ['alpha-2', 'beta-1', 'gamma-1', 'delta-1', 'm2', 'm3', 'm4', 'm5', 'm6'], hidden: ['alpha-1', 'm1'] },
    { name: '--all', argv: ['--all'], shown: ['alpha-1', 'alpha-2', 'beta-1', 'gamma-1', 'delta-1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'], hidden: [] as string[] },
  ])('$name shows the live open tasks and the last five merged, and --all the history too', ({ argv, shown, hidden }) => {
    const { stdout } = board(['--dir', BASIC, ...argv])
    const attempts = stdout.filter(line => /^ {2}\S/.test(line)).map(line => line.trim().split(' ')[0])
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
    { id: 'alpha-2', stage: 'ready', expected: 'UNKNOWN (missing: ready; recorded only on the cheap path, journal event:path)' },
    { id: 'alpha-2', stage: 'merged', expected: '— (PR #2 OPEN)' },
    { id: 'gamma-1', stage: 'ghost', expected: '— (not finished; status.md writing)' },
    { id: 'm6', stage: 'merged', expected: `done 2026-09-27T06:30:00.000Z (journal, by owner, ${'6'.repeat(7)})` },
  ])('$id $stage reads $expected', ({ id, stage, expected }) => {
    expect(stageOf(board(['--dir', BASIC]).stdout, id, stage)).toBe(expected)
  })

  it('names the failed gh query instead of claiming there is no PR', () => {
    const { stdout, stderr } = board(['--dir', BASIC], failingGh)
    expect(stageOf(stdout, 'delta-1', 'merged')).toBe('UNKNOWN (missing: merge; pr; the gh query failed)')
    expect(stderr).toEqual(['[board] gh pr list failed; every PR fact is UNKNOWN'])
  })
})

describe('board: the cheap path reads started, ready, pr and merged from the journal event:path line', () => {
  it.each([
    { id: 'c-journal', stage: 'started', expected: 'done 2026-09-28T07:00:00.000Z (journal event:path)' },
    { id: 'c-journal', stage: 'ready', expected: 'done 2026-09-28T07:30:00.000Z (journal event:path)' },
    { id: 'c-journal', stage: 'pr', expected: '#20 MERGED (journal event:path, sha 2020202), ci — (no checks recorded on 2020202)' },
    { id: 'c-journal', stage: 'merged', expected: `done 2026-09-28T08:00:00.000Z (journal, by owner, abcdefa)` },
    { id: 'c-gh', stage: 'ready', expected: 'done 2026-09-28T08:20:00.000Z (journal event:path)' },
    { id: 'c-gh', stage: 'merged', expected: `done 2026-09-28T08:40:00.000Z (gh PR #21, ${'9'.repeat(7)})` },
    { id: 'c-open', stage: 'pr', expected: '#22 OPEN, ci — (no checks recorded on 2222222)' },
    { id: 'c-open', stage: 'merged', expected: '— (PR #22 OPEN)' },
    { id: 'c-noready', stage: 'ready', expected: 'UNKNOWN (missing: ready; the journal event:path line records none)' },
    { id: 'c-noready', stage: 'pr', expected: 'UNKNOWN (missing: pr; the journal event:path line records none)' },
    { id: 'c-noready', stage: 'merged', expected: 'UNKNOWN (missing: merge; pr; the journal event:path line records none)' },
    { id: 'l-1', stage: 'ready', expected: 'UNKNOWN (missing: ready; recorded only on the cheap path, journal event:path)' },
  ])('$id $stage reads $expected', ({ id, stage, expected }) => {
    expect(stageOf(board(['--dir', CHEAP]).stdout, id, stage)).toBe(expected)
  })

  it.each([
    { id: 'c-journal', category: 'merged' },
    { id: 'c-gh', category: 'merged' },
    { id: 'c-open', category: 'waiting' },
    { id: 'c-noready', category: 'running' },
  ])('$id prints only the cheap-path stages and is $category', ({ id, category }) => {
    const block = attemptBlock(board(['--dir', CHEAP, '--all']).stdout, id)
    expect(block[0]).toBe(`  ${id} live ${category}`)
    expect(block.slice(1).map(line => line.trim().split(' ')[0])).toEqual(['started', 'ready', 'pr', 'merged'])
  })

  it('keeps the ladder stages for a task whose path line is not cheap', () => {
    const block = attemptBlock(board(['--dir', CHEAP, '--all']).stdout, 'l-1')
    expect(block.slice(1).map(line => line.trim().split(' ')[0])).toEqual(['brief', 'approved', 'ghost', 'review', 'ready', 'merged', 'pr', 'status.md', 'ledger'])
  })

  it('names the failed gh query for a cheap-path PR', () => {
    const { stdout } = board(['--dir', CHEAP], failingGh)
    expect(stageOf(stdout, 'c-open', 'pr')).toBe('UNKNOWN (missing: pr; the gh query failed)')
  })

  it('states in the definitions that ready is recorded only on the cheap path', () => {
    const { stdout } = board(['--dir', CHEAP])
    expect(stdout.filter(line => line.includes('ready is recorded only on the cheap path'))).toHaveLength(1)
    expect(stdout.filter(line => line.startsWith('#') && line.includes('no event exists'))).toEqual([])
  })
})

describe('board: summary, edges and prefixes', () => {
  it('counts live attempts only in the summary line at the top', () => {
    const { stdout } = board(['--dir', BASIC, '--all'])
    expect(stdout[0]).toBe('running 1, waiting 2, blocked 1, the longest — 180 min (brief-alpha.md)')
  })

  it.each([
    { name: 'without a matrix', dir: BASIC, edges: ['edge: UNKNOWN'] },
    { name: 'with a Shredder matrix', dir: MATRIX, edges: ['edge: a -> b'] },
  ])('prints edges $name', ({ dir, edges }) => {
    const { stdout } = board(['--dir', dir])
    expect(stdout.filter(line => line.startsWith('edge:'))).toEqual(edges)
  })

  it('prints the graph bare and keeps the definitions as # payload lines', () => {
    const { stdout, stderr, exitCode } = board(['--dir', BASIC])
    expect(exitCode).toBe(0)
    expect(stderr).toEqual([])
    expect(stdout.some(line => line.startsWith('[board]'))).toBe(false)
    expect(stdout[1].startsWith('# board: read-only')).toBe(true)
  })

  it.each([
    { name: 'no --dir', argv: [] as string[], names: '--dir is required' },
    { name: 'an unknown argument', argv: ['--dir', BASIC, '--bogus'], names: '\'--bogus\'' },
    { name: 'a missing directory', argv: ['--dir', path.join(FIXTURES, 'absent')], names: 'no such directory' },
  ])('refuses $name with a [board] message and no graph', ({ argv, names }) => {
    const { stdout, stderr, exitCode } = board(argv)
    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toHaveLength(1)
    expect(stderr[0].startsWith('[board] ')).toBe(true)
    expect(stderr[0]).toContain(names)
  })

  it('carries the [board] prefix on a usage error from the script itself', () => {
    const result = spawnSync(process.execPath, [TSX_CLI, BOARD], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.startsWith('[board] --dir is required; usage:')).toBe(true)
  })
})

describe('board: read only', () => {
  it('writes nothing into the handoff directory and runs only gh pr list and gh pr view', () => {
    const before = [snapshot(BASIC), snapshot(MATRIX), snapshot(CHEAP)]
    const calls: string[][] = []
    board(['--dir', BASIC], stubGh(calls))
    board(['--dir', BASIC, '--all'], stubGh(calls))
    board(['--dir', MATRIX], stubGh(calls))
    board(['--dir', CHEAP, '--all'], stubGh(calls))
    expect([snapshot(BASIC), snapshot(MATRIX), snapshot(CHEAP)]).toEqual(before)
    expect(new Set(calls.map(args => args.slice(0, 2).join(' ')))).toEqual(new Set(['pr list', 'pr view']))
  })
})
