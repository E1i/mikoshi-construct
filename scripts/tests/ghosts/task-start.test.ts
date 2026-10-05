import type { TaskStartDeps } from '../../ghosts/task-start.js'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runTaskStart } from '../../ghosts/task-start.js'

const SESSION = '0d538601-aaaa-bbbb-cccc-1234567890ab'
const NOW = new Date('2026-10-02T08:00:00.000Z')
const INSTALL_ARGS = ['install', '--frozen-lockfile', '--prefer-offline']

function card(id: number, bracket = 'implement/ghosts/S/cheap/auto'): string {
  return `#${id} task-${id} [${bracket}] · depends — · blocks —`
}

const W1_CARD = '#101 task-card [implement/ghosts/M/cheap/owner] · depends #86 · blocks #124 the board card'
const INTAKE_TS = '2026-10-01T08:00:00.000Z'
const ADMITTED = [W1_CARD, card(2), card(3), card(4), card(5), card(8, 'implement/ghosts/M/cheap/owner'), card(9, 'implement/ghosts/M/cheap/owner'), card(21, 'implement/ghosts/L/ladder/owner'), card(31), card(32)]

function intakeJournal(cards: readonly string[]): string {
  return cards.map(line => `${JSON.stringify({ event: 'intake', task: /^#(\d+)/.exec(line)![1], card: line, confirmation: 'none', corrections: [], ts: INTAKE_TS })}\n`).join('')
}

interface World {
  root: string
  repo: string
  handoff: string
  journal: string
}

const roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' })
}

function newWorld(): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'task-start-world-')))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'main-tree')
  const handoff = path.join(root, 'handoff')
  mkdirSync(origin)
  git(origin, ['init', '-q', '--bare', '-b', 'main'])
  git(root, ['clone', '-q', origin, repo])
  writeFileSync(path.join(repo, 'README.md'), 'world\n')
  git(repo, ['checkout', '-q', '-b', 'main'])
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'world'])
  git(repo, ['push', '-q', 'origin', 'main'])
  return { root, repo, handoff, journal: path.join(handoff, 'ghosts.jsonl') }
}

function depsOf(world: World, session: string | null = SESSION, installs: [string, string[]][] = []): TaskStartDeps {
  return {
    cwd: world.repo,
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }),
    install: (cwd, args) => {
      installs.push([cwd, args])
    },
    exists: existsSync,
    append: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, text)
    },
    now: () => NOW,
    session: session ?? undefined,
    handoffDir: world.handoff,
    readJournal: () => intakeJournal(ADMITTED),
  }
}

function lines(world: World): Record<string, unknown>[] {
  return readFileSync(world.journal, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('w1: task:start cuts the tree and writes the start line', () => {
  it('w1: cuts ../mc-<id> on the branch from origin/main and writes one start line with worktree, branch, session and the card', () => {
    const world = newWorld()
    const line = W1_CARD
    const result = runTaskStart(['feat/t1', '--card', line], depsOf(world))
    const worktree = path.join(world.root, 'mc-101')
    expect(result.exitCode).toBe(0)
    expect(result.worktree).toBe(worktree)
    expect(existsSync(worktree)).toBe(true)
    expect(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feat/t1')
    expect(lines(world).filter(entry => entry.event === 'path')).toEqual([{
      event: 'path',
      task: '101',
      path: 'cheap',
      started: NOW.toISOString(),
      session: SESSION,
      worktree,
      branch: 'feat/t1',
      card: { id: 101, name: 'task-card', kind: 'implement', milestone: 'ghosts', size: 'M', contour: 'cheap', decision: 'owner', depends: [86], blocks: [124], line },
      admission: { by: 'intake', confirmation: 'none', intake: INTAKE_TS },
      ts: NOW.toISOString(),
    }])
  })

  it('w8: prints CONTRACT, EXPECT, ACTION and RESULT from the card and the start line it wrote', () => {
    const world = newWorld()
    const result = runTaskStart(['feat/t8', '--card', card(8, 'implement/ghosts/M/cheap/owner')], depsOf(world))
    const worktree = path.join(world.root, 'mc-8')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toEqual([
      expect.stringMatching(/^-{4} task:start #8 task-8 -+$/),
      'CONTRACT | implement · cheap · owner · touches not recorded on the card · law not recorded on the card',
      'EXPECT   | expect not recorded on the start line: its session is the window\'s CLAUDE_CODE_SESSION_ID, shared by every task the window runs, so no session is this task\'s alone',
      `ACTION   | task:start feat/t8 #8: cut ${worktree} from origin/main; start line written to ${world.journal}`,
      'RESULT   | accepted · not started',
    ])
  })

  it('w8: writes the entry card beside the start line, in one append, in the four fields the card printed', () => {
    const world = newWorld()
    const appended: string[] = []
    const deps = { ...depsOf(world), append: (file: string, text: string) => {
      appended.push(text)
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, text)
    } }
    const result = runTaskStart(['feat/t9', '--card', card(9, 'implement/ghosts/M/cheap/owner')], deps)
    const worktree = path.join(world.root, 'mc-9')
    expect(appended).toHaveLength(1)
    expect(lines(world).map(entry => entry.event)).toEqual(['path', 'entry'])
    expect(lines(world)[1]).toEqual({
      event: 'entry',
      task: '9',
      CONTRACT: 'implement · cheap · owner · touches not recorded on the card · law not recorded on the card',
      EXPECT: 'expect not recorded on the start line: its session is the window\'s CLAUDE_CODE_SESSION_ID, shared by every task the window runs, so no session is this task\'s alone',
      ACTION: `task:start feat/t9 #9: cut ${worktree} from origin/main; start line written to ${world.journal}`,
      RESULT: 'accepted · not started',
      ts: NOW.toISOString(),
    })
    expect(result.stdout.slice(1).map(row => row.replace(/^\w+\s+\| /, ''))).toEqual(['CONTRACT', 'EXPECT', 'ACTION', 'RESULT'].map(field => (lines(world)[1] as Record<string, string>)[field]))
  })

  it('w8: a field with no data is named in the entry card: no session names it in ACTION', () => {
    const world = newWorld()
    const result = runTaskStart(['--card', card(2), 'feat/t2'], depsOf(world, null))
    expect(result.stdout[3]).toContain('CLAUDE_CODE_SESSION_ID is not set, the board will show WINDOW UNKNOWN (no session)')
    expect(result.stdout[4]).toBe('RESULT   | accepted · not started')
  })

  it('w1: writes a line without session and says the board will show WINDOW UNKNOWN when no session is set', () => {
    const world = newWorld()
    const result = runTaskStart(['--card', card(2), 'feat/t2'], depsOf(world, null))
    expect(result.exitCode).toBe(0)
    expect(lines(world)[0]).not.toHaveProperty('session')
    expect(result.stdout.join('\n')).toContain('WINDOW UNKNOWN (no session)')
  })

  it('w1: refuses an existing tree path and writes nothing', () => {
    const world = newWorld()
    mkdirSync(path.join(world.root, 'mc-3'))
    const result = runTaskStart(['feat/t3', '--card', card(3)], depsOf(world))
    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toMatch(/^\[task:start\] .*mc-3 already exists/)
    expect(existsSync(world.journal)).toBe(false)
    expect(git(world.repo, ['branch', '--list', 'feat/t3']).trim()).toBe('')
  })

  it('w1: refuses an existing local branch and writes nothing', () => {
    const world = newWorld()
    git(world.repo, ['branch', 'feat/t4'])
    const result = runTaskStart(['feat/t4', '--card', card(4)], depsOf(world))
    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toMatch(/^\[task:start\] branch feat\/t4 already exists/)
    expect(existsSync(path.join(world.root, 'mc-4'))).toBe(false)
    expect(existsSync(world.journal)).toBe(false)
  })

  it('w1: refuses a --card with no value or without a branch', () => {
    const world = newWorld()
    expect(runTaskStart(['feat/x', '--card'], depsOf(world)).stderr[0]).toMatch(/^\[task:start\] usage:/)
    expect(runTaskStart(['--card', card(5)], depsOf(world)).stderr[0]).toMatch(/^\[task:start\] usage:/)
  })
})

describe('w3: task:start installs the dependencies in the new tree', () => {
  it('w3: runs pnpm install --frozen-lockfile --prefer-offline once, in the cut tree, before the start line', () => {
    const world = newWorld()
    const installs: [string, string[]][] = []
    const result = runTaskStart(['feat/i1', '--card', card(31)], depsOf(world, SESSION, installs))
    expect(result.exitCode).toBe(0)
    expect(installs).toEqual([[path.join(world.root, 'mc-31'), INSTALL_ARGS]])
    expect(lines(world).filter(entry => entry.event === 'path')).toHaveLength(1)
  })

  it('w3: a failed install refuses with its first line, writes no start line, and removes the tree and the branch so a retry starts clean', () => {
    const world = newWorld()
    const deps: TaskStartDeps = {
      ...depsOf(world),
      install: () => {
        throw new Error('ERR_PNPM_NO_OFFLINE_TARBALL picocolors\nmore')
      },
    }
    const worktree = path.join(world.root, 'mc-32')
    const result = runTaskStart(['feat/i2', '--card', card(32)], deps)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual([`[task:start] pnpm install --frozen-lockfile --prefer-offline failed in ${worktree}: ERR_PNPM_NO_OFFLINE_TARBALL picocolors; the tree and branch feat/i2 were removed; nothing written`])
    expect(existsSync(world.journal)).toBe(false)
    expect(existsSync(worktree)).toBe(false)
    expect(git(world.repo, ['branch', '--list', 'feat/i2']).trim()).toBe('')
    expect(runTaskStart(['feat/i2', '--card', card(32)], depsOf(world)).exitCode).toBe(0)
  })
})

describe('w2: task:start refuses a card of the wrong form, and the old call', () => {
  it.each([
    ['an unknown milestone', card(11, 'implement/moon/S/cheap/auto'), `milestone 'moon' is not one of`],
    ['kind probe with decision owner', card(12, 'probe/ghosts/S/cheap/owner'), 'kind probe takes decision none, not owner'],
    ['a bad size', card(13, 'implement/ghosts/XL/cheap/auto'), `size 'XL' is not one of XS, S, M, L`],
    ['no · depends', '#14 x [implement/ghosts/S/cheap/auto] · blocks —', `'· depends <#id …|—>' must follow`],
  ])('w2: refuses %s with the reason, cuts no tree and writes no line', (_, line, reason) => {
    const world = newWorld()
    const result = runTaskStart(['feat/bad', '--card', line], depsOf(world))
    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toContain('[task:start] card refused: ')
    expect(result.stderr[0]).toContain(reason)
    expect(readdirSync(world.root).filter(name => name.startsWith('mc-'))).toEqual([])
    expect(existsSync(world.journal)).toBe(false)
  })

  it('w2: refuses the old task:start <id> <branch> and names the new form', () => {
    const world = newWorld()
    const result = runTaskStart(['t1', 'feat/t1'], depsOf(world))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual([`[task:start] a task starts from its card now: usage: pnpm task:start <branch> --card "<card>"; the id is the card's #<id>`])
    expect(existsSync(path.join(world.root, 'mc-t1'))).toBe(false)
  })
})

describe('the journal path follows the card contour', () => {
  it('writes path ladder for a ladder card', () => {
    const world = newWorld()
    expect(runTaskStart(['feat/l', '--card', card(21, 'implement/ghosts/L/ladder/owner')], depsOf(world)).exitCode).toBe(0)
    expect(lines(world)[0]).toMatchObject({ task: '21', path: 'ladder' })
  })
})
