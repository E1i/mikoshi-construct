import type { GhRunner } from '../../board/gh.js'
import type { GitReader } from '../../board/git.js'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { windowsRoot } from '../../board/git.js'
import { runBoard } from '../../board/run.js'

const NOW = new Date('2026-10-02T08:00:00.000Z')
const SESSION = '0d538601-aaaa-bbbb-cccc-1234567890ab'
const roots: string[] = []

function ghWith(prs: object[]): GhRunner {
  return (args) => {
    if (args[0] === 'pr' && args[1] === 'list')
      return JSON.stringify(prs)
    if (args[0] === 'pr' && args[1] === 'view')
      return JSON.stringify({ statusCheckRollup: [], files: [] })
    throw new Error(`unexpected gh ${args.join(' ')}`)
  }
}

const noPrs = ghWith([])

function git(dirty: number, worktrees: { path: string, branch: string | undefined }[] = []): GitReader {
  return { dirty: () => dirty, worktrees: () => worktrees }
}

interface World {
  handoff: string
  repoRoot: string
  tree: string
}

function newWorld(journal: object[], turns: object[]): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'board-window-')))
  roots.push(root)
  const handoff = path.join(root, 'handoff')
  const repoRoot = path.join(root, 'main-tree')
  const tree = path.join(root, 'mc-w')
  for (const dir of [handoff, path.join(repoRoot, '.construct'), tree])
    mkdirSync(dir, { recursive: true })
  const lines = (entries: object[]): string => entries.map(entry => `${JSON.stringify(entry)}\n`).join('')
  writeFileSync(path.join(handoff, 'ghosts.jsonl'), lines(journal.map(entry => 'worktree' in entry && entry.worktree === 'TREE' ? { ...entry, worktree: tree } : entry)))
  writeFileSync(path.join(repoRoot, '.construct', 'turns.jsonl'), lines(turns))
  return { handoff, repoRoot, tree }
}

function board(world: World, reader: GitReader = git(0), gh: GhRunner = noPrs): { summary: string, cells: string[], stdout: string[] } {
  const { stdout } = runBoard(['--dir', world.handoff], { gh, now: NOW, defaultDir: world.handoff, colour: false, repoRoot: world.repoRoot, git: reader })
  const row = stdout.map(line => stripVTControlCharacters(line)).filter(line => line.startsWith('│')).map(line => line.split('│').slice(1, -1).map(cell => cell.trim())).find(cells => cells[0] === 'w')
  return { summary: stdout[0]!, cells: row ?? [], stdout }
}

const START = { event: 'path', task: 'w', path: 'cheap', started: '2026-10-02T07:00:00.000Z', session: SESSION, worktree: 'TREE', branch: 'feat/w', ts: '2026-10-02T07:00:00.000Z' }
const REASON_LINE = { event: 'path', task: 'w', path: 'cheap', reason: 'a later line without worktree', ts: '2026-10-02T07:01:00.000Z' }
const TURN = { v: 1, kind: 'turn', session: SESSION, startedAt: '2026-10-02T07:50:00.000Z', endedAt: '2026-10-02T07:55:00.000Z' }
const SESSION_END = { v: 1, kind: 'session-end', session: SESSION, at: '2026-10-02T07:56:00.000Z', reason: 'other' }

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('w2: a cheap task with a start line and no PR', () => {
  it('w2: is running, with WINDOW the session and its last turn age and TREE the branch and the dirty count', () => {
    const world = newWorld([START, REASON_LINE], [TURN])
    const { summary, cells } = board(world, git(3))
    expect(summary).toMatch(/^open 1: running 1, waiting 0, blocked 0, /)
    expect(summary).toMatch(/ · windows live 1 · /)
    expect(cells[1]).toBe('cheap')
    expect(cells[5]).toBe('0d538601 · turn 5m')
    expect(cells[6]).toBe('mc-w · feat/w · dirty 3')
  })

  it('w2: shows UNKNOWN (no session) when no line names a session, and gone when the tree is missing', () => {
    const { session: _session, ...withoutSession } = START
    const world = newWorld([{ ...withoutSession, worktree: '/nonexistent/mc-w' }], [])
    const { cells } = board(world)
    expect(cells[5]).toBe('UNKNOWN (no session)')
    expect(cells[6]).toBe('gone')
  })
})

describe('w3: a closed window with no PR', () => {
  it('w3: a session-end and no PR is blocked and NEXT reads window closed, no PR', () => {
    const world = newWorld([START], [TURN, SESSION_END])
    const { summary, cells } = board(world)
    expect(summary).toMatch(/^open 1: running 0, waiting 0, blocked 1, /)
    expect(cells[4]).toBe('window closed, no PR')
    expect(cells[5]).toBe('0d538601 · ended')
  })

  it('w3: a handoff file naming the task id makes NEXT read handoff, waits for a new window', () => {
    const world = newWorld([START], [TURN, SESSION_END])
    writeFileSync(path.join(world.handoff, 'handoff-w-more.md'), 'continue\n')
    expect(board(world).cells[4]).toBe('handoff, waits for a new window')
  })

  it('w3: a handoff file whose name holds the id only inside another token does not count', () => {
    const world = newWorld([START], [TURN, SESSION_END])
    writeFileSync(path.join(world.handoff, 'handoff-wx.md'), 'other\n')
    expect(board(world).cells[4]).toBe('window closed, no PR')
  })
})

describe('w3: a closed window whose start line names a branch with a PR', () => {
  const pr = (state: string, mergedAt: string | null): object => ({ number: 438, headRefName: 'feat/w', headRefOid: '4384384384', state, mergedAt, mergeCommit: mergedAt === null ? null : { oid: '4'.repeat(40) } })

  function cheapJson(world: World, gh: GhRunner): any {
    const { stdout } = runBoard(['--dir', world.handoff, '--json'], { gh, now: NOW, defaultDir: world.handoff, colour: false, repoRoot: world.repoRoot, git: git(0) })
    return JSON.parse(stdout[0]!).tasks.find((task: any) => task.derived.task === 'w').attempts[0]
  }

  it('w3: a merged PR found by the branch is merged, not blocked, and its pr stage names the source pr via the branch', () => {
    const world = newWorld([START], [TURN, SESSION_END])
    const gh = ghWith([pr('MERGED', '2026-10-02T07:50:00Z')])
    expect(board(world, git(0), gh).summary).toMatch(/^open 0: running 0, waiting 0, blocked 0, .* merged 12h: 1$/)
    const task = cheapJson(world, gh)
    expect(task.derived.category).toBe('merged')
    expect(task.stages.find((stage: any) => stage.name === 'pr')).toMatchObject({ state: 'fact', value: '#438 MERGED', source: 'pr via feat/w' })
  })

  it('w3: an open PR found by the branch keeps the row out of blocked and NEXT is not window closed', () => {
    const world = newWorld([START], [TURN, SESSION_END])
    const { summary, cells } = board(world, git(0), ghWith([pr('OPEN', null)]))
    expect(summary).toMatch(/^open 1: running 1, waiting 0, blocked 0, /)
    expect(cells[4]).toMatch(/^CI/)
  })

  it('w3: a PR on another branch does not count, and the row stays blocked as before', () => {
    const world = newWorld([START], [TURN, SESSION_END])
    const { summary, cells } = board(world, git(0), ghWith([{ ...pr('MERGED', '2026-10-02T07:50:00Z'), headRefName: 'feat/other' }]))
    expect(summary).toMatch(/^open 1: running 0, waiting 0, blocked 1, /)
    expect(cells[4]).toBe('window closed, no PR')
  })
})

describe('w6: trees no task names', () => {
  it('w6: lists them after the table, scratch trees in their own group, and not the main tree or a named one', () => {
    const world = newWorld([START], [TURN])
    const reader = git(2, [
      { path: '/repo/main-tree', branch: 'main' },
      { path: world.tree, branch: 'feat/w' },
      { path: '/repo/mc-stray', branch: 'old' },
      { path: '/tmp/x/scratchpad/w', branch: undefined },
    ])
    const { stdout } = board(world, reader)
    const after = stdout.slice(stdout.findIndex(line => line.startsWith('└')) + 1)
    expect(after).toEqual(['unregistered trees 2', '  /repo/mc-stray old dirty 2', 'session scratch 1', '  /tmp/x/scratchpad/w detached dirty 2'])
  })
})

describe('w7: the windows\' journals are read from the main worktree', () => {
  const reader = (entries: { path: string, branch: string | undefined }[] | undefined): GitReader => ({ dirty: () => 0, worktrees: () => entries })

  it('a board run from a task worktree reads the main tree, which git lists first', () => {
    expect(windowsRoot(reader([{ path: '/repo', branch: 'main' }, { path: '/mc-101', branch: 'feat/task-start' }]), '/mc-101')).toBe('/repo')
  })

  it('without a worktree list it reads the checkout it runs from', () => {
    expect(windowsRoot(reader(undefined), '/mc-101')).toBe('/mc-101')
  })
})
