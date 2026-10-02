import type { GhRunner } from '../../board/gh.js'
import type { GitReader } from '../../board/git.js'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { runBoard } from '../../board/run.js'

const NOW = new Date('2026-10-02T08:00:00.000Z')
const SESSION = '0d538601-aaaa-bbbb-cccc-1234567890ab'
const OTHER_SESSION = '7e9ecd33-aaaa-bbbb-cccc-1234567890ab'
const roots: string[] = []

const PRS = [
  { number: 50, headRefName: 'feat/m1', headRefOid: '5050505050', state: 'MERGED', mergedAt: '2026-10-02T06:00:00Z', mergeCommit: { oid: '5'.repeat(40) } },
  { number: 60, headRefName: 'ghost/ra', headRefOid: '6060606060', state: 'MERGED', mergedAt: '2026-10-02T07:00:00Z', mergeCommit: { oid: '6'.repeat(40) } },
]

const gh: GhRunner = (args) => {
  if (args[0] === 'pr' && args[1] === 'list')
    return JSON.stringify(PRS)
  if (args[0] === 'pr' && args[1] === 'view')
    return JSON.stringify({ statusCheckRollup: [] })
  throw new Error(`unexpected gh ${args.join(' ')}`)
}

const git: GitReader = { dirty: () => 0, worktrees: () => [] }

const START = { event: 'path', task: 'w', path: 'cheap', started: '2026-10-02T07:00:00.000Z', session: SESSION, worktree: 'TREE', branch: 'feat/w', ts: '2026-10-02T07:00:00.000Z' }
const OLD = [
  { event: 'path', task: 'old', path: 'ladder', reason: 'hand-started', started: '2026-10-01T18:00:00Z', session: OTHER_SESSION, ts: '2026-10-01T18:00:00Z' },
  { event: 'task', task: 'old', baseSha: 'abc1234', install: 0, exit: 0, ladder: 'done', ts: '2026-10-01T19:00:00Z' },
]
const FRESH = [
  { event: 'path', task: 'fresh', path: 'ladder', reason: 'hand-started', started: '2026-10-02T07:00:00Z', ts: '2026-10-02T07:00:00Z' },
  { event: 'task', task: 'fresh', baseSha: 'abc1234', install: 0, exit: 0, ladder: 'done', ts: '2026-10-02T07:30:00Z' },
]
const RA = [
  { event: 'path', task: 'ra', path: 'ladder', reason: 'hand-started', started: '2026-10-02T05:00:00Z', ts: '2026-10-02T05:00:00Z' },
  { event: 'task', task: 'ra', baseSha: 'abc1234', install: 0, exit: 0, ladder: 'done', ts: '2026-10-02T06:00:00Z' },
]
const M1 = { event: 'path', task: 'm1', path: 'cheap', pr: 50, started: '2026-10-02T05:00:00Z', ts: '2026-10-02T06:00:00Z' }
const TURN = { v: 1, kind: 'turn', session: SESSION, startedAt: '2026-10-02T07:50:00.000Z', endedAt: '2026-10-02T07:55:00.000Z', context: 91_500 }
const STOP = { v: 1, event: 'budget-stop', level: 'session', spent: 150_000, limit: 150_000, tool: 'Agent', at: '2026-10-02T07:56:00.000Z', session_id: SESSION }
const FOREIGN_WARN = { v: 1, event: 'budget-warn', level: 'session', spent: 120_000, limit: 150_000, tool: null, at: '2026-10-02T07:40:00.000Z', session_id: OTHER_SESSION }
const LIMITS = { contextLimit: 150_000, sessionSpend: 3_000_000, agentSpend: 2_000_000, runSpend: 3_000_000, warnRatio: 0.8 }

interface World {
  handoff: string
  repoRoot: string
}

function lines(entries: object[]): string {
  return entries.map(entry => `${JSON.stringify(entry)}\n`).join('')
}

function newWorld({ turns = [TURN] }: { turns?: object[] } = {}): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'board-view-')))
  roots.push(root)
  const handoff = path.join(root, 'handoff')
  const repoRoot = path.join(root, 'main-tree')
  const tree = path.join(root, 'mc-w')
  for (const dir of [handoff, path.join(repoRoot, '.construct'), path.join(repoRoot, '.claude'), tree])
    mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(handoff, 'ghosts.jsonl'), lines([{ ...START, worktree: tree }, ...OLD, ...FRESH, ...RA, M1]))
  writeFileSync(path.join(repoRoot, '.construct', 'turns.jsonl'), lines(turns))
  writeFileSync(path.join(repoRoot, '.construct', 'eddies.jsonl'), lines([STOP, FOREIGN_WARN]))
  writeFileSync(path.join(repoRoot, '.claude', 'eddies.json'), JSON.stringify(LIMITS))
  return { handoff, repoRoot }
}

function run(world: World, argv: string[] = [], { session }: { session: string | undefined } = { session: SESSION }): string[] {
  const result = runBoard(['--dir', world.handoff, ...argv], { gh, now: NOW, defaultDir: world.handoff, colour: false, repoRoot: world.repoRoot, git, session })
  expect(result.exitCode).toBe(0)
  return result.stdout.map(line => stripVTControlCharacters(line))
}

function rows(stdout: string[]): string[][] {
  return stdout.filter(line => line.startsWith('│')).map(line => line.split('│').slice(1, -1).map(cell => cell.trim())).filter(cells => cells[0] !== 'TASK')
}

function rowOf(stdout: string[], id: string): string[] {
  const row = rows(stdout).find(cells => cells[0] === id)
  expect(row, `no row for ${id}`).toBeDefined()
  return row!
}

function boardJson(world: World): any {
  return JSON.parse(run(world, ['--json'])[0]!)
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('w1: one summary line above one table', () => {
  it('w1: prints one line before the table, and no eddies, longest or hidden line', () => {
    const stdout = run(newWorld())
    expect(stdout.findIndex(line => line.startsWith('┌'))).toBe(1)
    expect(stdout.filter(line => line.startsWith('eddies:') || line.startsWith('hidden:') || line.includes('the longest'))).toEqual([])
    expect(stdout[0]).toBe('MIKO context 61% · open 3: running 1, waiting 2, blocked 0, stale 1 · windows live 1 · merged 12h: 2')
  })
})

describe('w2: a window\'s Eddies lines sit on the row of the task whose start line names its session', () => {
  it('w2: the cheap row shows its window\'s context and stop, and not another session\'s warning', () => {
    expect(rowOf(run(newWorld()), 'w')[7]).toBe('ctx 61% · stop 1')
  })

  it('w2: a row with neither a live window nor a budget line shows —', () => {
    expect(rowOf(run(newWorld()), 'fresh')[7]).toBe('—')
  })
})

describe('w3: --json carries the Eddies readings as board/4', () => {
  it('w3: each attempt has its eddies, and the board has the window it was run from', () => {
    const json = boardJson(newWorld())
    expect(json.format).toBe('board/4')
    expect(json.window).toEqual({ session: SESSION, context: 91_500, contextLimit: 150_000, warnPercent: 80 })
    const attempt = json.tasks.flatMap((task: any) => task.attempts).find((candidate: any) => candidate.id === 'w')
    expect(attempt.eddies).toEqual({ context: 91_500, stop: 1, warn: 0 })
  })
})

describe('w4: an open task with no event for longer than the stale threshold is marked stale', () => {
  it('w4: a ladder whose last stage is 13h old reads stale in NEXT; one 30m old does not', () => {
    const stdout = run(newWorld())
    expect(rowOf(stdout, 'old')[4]).toBe('stale 13h00m · verdict (window)')
    expect(rowOf(stdout, 'fresh')[4]).toBe('verdict (window)')
  })

  it('w4: --stale raises the threshold', () => {
    const stdout = run(newWorld(), ['--stale', '24'])
    expect(rowOf(stdout, 'old')[4]).toBe('verdict (window)')
    expect(stdout[0]).toContain('stale 0')
  })

  it('w4: rows run blocked, stale, waiting, running, the oldest first within each', () => {
    expect(rows(run(newWorld())).map(cells => cells[0])).toEqual(['old', 'fresh', 'w'])
  })
})

describe('w5: finished tasks leave the table for one merged line', () => {
  it('w5: lists them newest first with their PR, and no table row', () => {
    const stdout = run(newWorld())
    expect(rows(stdout).map(cells => cells[0])).not.toContain('m1')
    expect(stdout.filter(line => line.startsWith('merged: '))).toEqual(['merged: ra PR #60 · m1 PR #50'])
  })
})

describe('w6: the summary opens with the context of the window that runs the board', () => {
  it('w6: reads the last turn\'s context against the limit and the warn ratio of .claude/eddies.json', () => {
    expect(run(newWorld())[0]).toMatch(/^MIKO context 61% · /)
  })

  it('w6: --context-warn sets the threshold that marks it', () => {
    expect(run(newWorld(), ['--context-warn', '50'])[0]).toMatch(/^MIKO context 61% \(warn at 50%\) · /)
  })

  it('w6: a window with no context reading reads context —, never 0%', () => {
    const { context: _context, ...withoutContext } = TURN
    expect(run(newWorld({ turns: [withoutContext] }))[0]).toMatch(/^MIKO context — · /)
  })

  it('w6: a board run outside a window has no MIKO segment', () => {
    expect(run(newWorld(), [], { session: undefined })[0]).toMatch(/^open 3: /)
  })
})

describe('w7: a ladder attempt with no recorded branch finds its PR by ghost/<id>', () => {
  it('w7: names the source of the PR and counts the task as merged', () => {
    const world = newWorld()
    const card = run(world, ['ra'])
    expect(card.find(line => line.startsWith('    pr '))).toMatch(/^ {4}pr #60 MERGED \(pr via ghost\/ra\)/)
    const attempt = boardJson(world).tasks.flatMap((task: any) => task.attempts).find((candidate: any) => candidate.id === 'ra')
    expect(attempt.derived.category).toBe('merged')
    expect(attempt.pr).toMatchObject({ kind: 'found', number: 60, via: 'ghost/ra' })
  })
})
