import type { ShiftTask } from '../../../src/card/task-file.js'
import type { TreeDeps } from '../../ports/worktree.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED } from '../../core/events.js'
import { realStarterPorts } from '../../nodes/launch/launch-worker.js'
import { CARD_VARIABLE, EXIT_REQUEST_VARIABLE, LOOP_PID_VARIABLE, WINDOW_MARK, WINDOW_VARIABLE } from '../../ports/session.js'
import { cardTree, WORKTREE_HOME_VARIABLE } from '../../ports/worktree-home.js'
import { cutTree } from '../../ports/worktree.js'
import { realRequestTools } from '../../window/window-request-tools.js'

const CARD_ID = 987654
const CARD = `#${CARD_ID} window-card [implement/ghosts/S/cheap/auto] · depends — · blocks —`
const BRANCH = 'feat/window-card'
const NOW = '2026-11-07T08:00:00.000Z'
const TASK_START = path.resolve(import.meta.dirname, '../../ports/task-start.ts')
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const CUT_TIMEOUT_MS = 120_000
const REFUSAL = `[task:start] a window does not start a task itself: the bus cuts its tree, ask it with pnpm bus:request tree.cut --card ${CARD_ID}; nothing written`
const WINDOWS: readonly [string, NodeJS.ProcessEnv][] = [
  ['a tab window', { [WINDOW_VARIABLE]: 'tab' }],
  ['the loop window', { [WINDOW_VARIABLE]: WINDOW_MARK }],
  ['a session under the loop pid', { [LOOP_PID_VARIABLE]: '4242' }],
  ['a session holding the loop exit request', { [EXIT_REQUEST_VARIABLE]: '/h/miko-exit.4242.request' }],
]

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' })
}

interface World { root: string, repo: string, bus: string }

function newWorld(files: Record<string, string>): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'task-start-window-')))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'main-tree')
  mkdirSync(origin)
  git(origin, ['init', '-q', '--bare', '-b', 'main'])
  git(root, ['clone', '-q', origin, repo])
  for (const [name, content] of Object.entries(files))
    writeFileSync(path.join(repo, name), content)
  git(repo, ['checkout', '-q', '-b', 'main'])
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'world'])
  git(repo, ['push', '-q', 'origin', 'main'])
  const bus = path.join(root, 'bus', 'bus.db')
  const db = openBus(bus)
  appendEvent(db, { ts: NOW, type: CARD_ADMITTED, actor: 'reducer', cardId: CARD_ID, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:intake:${CARD_ID}`, payload: { lane: 'lane-1', depends: [], decision: null, contour: null, admission: `intake:${CARD_ID}` }, legacy: false })
  db.close()
  return { root, repo, bus }
}

function cliWorld(): World {
  const script = `node --import ${JSON.stringify(TSX_LOADER)} ${JSON.stringify(TASK_START)}`
  return newWorld({ 'package.json': JSON.stringify({ name: 'world', private: true, scripts: { 'task:start': script } }) })
}

function envOf(world: World, marks: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, CONSTRUCT_BUS_DB: world.bus, [WORKTREE_HOME_VARIABLE]: '', [CARD_VARIABLE]: '', [WINDOW_VARIABLE]: '', [LOOP_PID_VARIABLE]: '', [EXIT_REQUEST_VARIABLE]: '', ...marks }
}

function branchHeld(repo: string, branch: string): boolean {
  return git(repo, ['branch', '--list', branch]).trim() !== ''
}

function startsIn(bus: string): number {
  const db = openBus(bus)
  const { n } = db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(CARD_STARTED) as { n: number }
  db.close()
  return Number(n)
}

function startedOutsideAnyRepository(marks: NodeJS.ProcessEnv, argv: string[]): { stderr: string, status: number | null } {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'task-start-window-bus-')))
  roots.push(dir)
  const env = { ...process.env, CONSTRUCT_BUS_DB: path.join(dir, 'bus.db'), [CARD_VARIABLE]: '', [WINDOW_VARIABLE]: '', [LOOP_PID_VARIABLE]: '', [EXIT_REQUEST_VARIABLE]: '', ...marks }
  const { stderr, status } = spawnSync(process.execPath, ['--import', TSX_LOADER, TASK_START, ...argv], { cwd: dir, env, encoding: 'utf8' })
  return { stderr: stderr.trim(), status }
}

it('task start in a window refuses at once and names tree.cut', () => {
  for (const [, marks] of WINDOWS) {
    expect(startedOutsideAnyRepository(marks, [BRANCH, '--card', CARD])).toEqual({ stderr: REFUSAL, status: 1 })
    expect(startedOutsideAnyRepository(marks, [BRANCH, '--card', CARD, '--adopt', '/some/tree'])).toEqual({ stderr: REFUSAL, status: 1 })
  }
  expect(startedOutsideAnyRepository({ [WINDOW_VARIABLE]: 'tab' }, [BRANCH]).stderr).toContain('pnpm bus:request tree.cut --card <N>')
}, CUT_TIMEOUT_MS)

it('the real command in a window leaves no branch, no tree and no start', () => {
  const world = cliWorld()
  const run = spawnSync('pnpm', ['--silent', 'task:start', BRANCH, '--card', CARD], { cwd: world.repo, env: envOf(world, { [WINDOW_VARIABLE]: 'tab' }), encoding: 'utf8' })
  expect(run.stderr).toContain(REFUSAL)
  expect(run.status).not.toBe(0)
  expect(branchHeld(world.repo, BRANCH)).toBe(false)
  expect(existsSync(cardTree({}, world.bus, String(CARD_ID)))).toBe(false)
  expect(startsIn(world.bus)).toBe(0)
}, CUT_TIMEOUT_MS)

it.each([
  ['a session id alone, which a bus raised from a window also inherits', { CLAUDE_CODE_SESSION_ID: 'bare-session' }],
  ['a plain terminal', {}],
  ['a card session, even with a window mark it inherited', { [CARD_VARIABLE]: '1646', [WINDOW_VARIABLE]: 'tab' }],
] as const)('%s is no window, so the refusal does not fire', (_case, marks) => {
  expect(startedOutsideAnyRepository(marks, [BRANCH, '--card', CARD]).stderr).not.toContain('tree.cut')
}, CUT_TIMEOUT_MS)

it('the bus tree.cut path still cuts the tree', () => {
  const world = cliWorld()
  const db = openBus(world.bus)
  try {
    const bus = envOf(world, { [WINDOW_VARIABLE]: 'tab', [LOOP_PID_VARIABLE]: '4242', [EXIT_REQUEST_VARIABLE]: '/h/miko-exit.4242.request' })
    const tools = realRequestTools(db, world.bus, world.repo, bus)
    tools.cutTree(BRANCH, CARD)
    expect(existsSync(tools.treeOf(CARD_ID))).toBe(true)
    expect(branchHeld(world.repo, BRANCH)).toBe(true)
  }
  finally {
    db.close()
  }
  expect(startsIn(world.bus)).toBe(1)
}, CUT_TIMEOUT_MS)

it('the launch cut from a bus a window raised still cuts the tree', () => {
  const world = cliWorld()
  const ports = realStarterPorts(world.repo, envOf(world, { [WINDOW_VARIABLE]: WINDOW_MARK, [LOOP_PID_VARIABLE]: '4242' }), '', () => 'u', () => null, () => [], null, world.bus)
  const worktree = ports.cut({ card: { id: CARD_ID, line: CARD }, branch: BRANCH } as ShiftTask)
  expect(existsSync(worktree)).toBe(true)
  expect(startsIn(world.bus)).toBe(1)
}, CUT_TIMEOUT_MS)

function treeDeps(world: World, overGit?: TreeDeps['git']): TreeDeps {
  return {
    cwd: world.repo,
    git: overGit ?? ((cwd, args) => git(cwd, args)),
    install: () => {},
    exists: existsSync,
    treeOf: id => path.join(world.root, 'trees', id),
  }
}

function smudgeRefusingWorld(): World {
  const world = newWorld({ 'README.md': 'world\n', '.gitattributes': '* filter=broken\n' })
  git(world.repo, ['config', 'filter.broken.smudge', 'false'])
  git(world.repo, ['config', 'filter.broken.required', 'true'])
  return world
}

it('a failed worktree add leaves no branch', () => {
  const world = smudgeRefusingWorld()
  const tree = path.join(world.root, 'trees', String(CARD_ID))
  const result = cutTree(treeDeps(world), String(CARD_ID), BRANCH)
  expect(result).toMatchObject({ refused: expect.stringContaining(`branch ${BRANCH} was removed; nothing written`) })
  expect(branchHeld(world.repo, BRANCH)).toBe(false)
  expect(existsSync(tree)).toBe(false)
  expect(git(world.repo, ['worktree', 'list', '--porcelain'])).not.toContain(tree)
})

it('a branch the failed add cannot remove is named, and nothing written is not claimed', () => {
  const world = smudgeRefusingWorld()
  const result = cutTree(treeDeps(world, (cwd, args) => {
    if (args[0] === 'branch' && args[1] === '-D')
      throw new Error('error: cannot delete branch')
    return git(cwd, args)
  }), String(CARD_ID), BRANCH)
  expect(result).toMatchObject({ refused: expect.stringContaining(`remove ${path.join(world.root, 'trees', String(CARD_ID))} and branch ${BRANCH} by hand`) })
  expect(result).not.toMatchObject({ refused: expect.stringContaining('nothing written') })
})

it('an add refused because another cut holds the branch leaves that branch alone', () => {
  const world = newWorld({ 'README.md': 'world\n' })
  const result = cutTree(treeDeps(world, (cwd, args) => {
    if (args[0] === 'worktree' && args[1] === 'add')
      git(cwd, ['branch', BRANCH, 'origin/main'])
    return git(cwd, args)
  }), String(CARD_ID), BRANCH)
  expect(result).toMatchObject({ refused: expect.stringContaining('nothing written') })
  expect(branchHeld(world.repo, BRANCH)).toBe(true)
})
