import type { Run } from '../../ci/layers.js'
import type { BudgetDeps } from '../../quality/lock.js'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanTreeGate, throughQueue } from '../../ci/prepush.js'
import { printBoard } from '../../cli/board-page.js'
import { fullReview } from '../../nodes/review/review-depth.js'
import { claudeReviewer, ReviewTrees } from '../../nodes/review/reviewer.js'
import { budgetDirs, heavyStep, HELD_VARIABLE, joinSession, leaveSession, LOCK_DIR_VARIABLE, LOG_FILE, queueDir, registerRun, runGrant, WORKER_LIMIT_VARIABLE, workerBudget } from '../../quality/lock.js'
import { busWithCardStarted } from '../ghosts/card-started-bus.js'

const HEAD = 'a'.repeat(40)
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const HEADER = readFileSync(path.join(REPO_ROOT, 'scripts/nodes/launch/header.md'), 'utf8')
const NOW = new Date('2026-11-04T12:00:00Z')
const CORES = 16
const LIMIT_THAT_LEAVES_THE_GRANT = 1
const FULL_RUN: Run = { kind: 'full', why: 'fixture' }
const LAYER_RUN: Run = { kind: 'layers', layers: [], tests: [] }

const dirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cpubudget-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function session(dir: string, tree: string, over: Partial<BudgetDeps> = {}): BudgetDeps {
  return { dir, tree, pid: 101, cores: CORES, sessionLimit: LIMIT_THAT_LEAVES_THE_GRANT, isAlive: () => true, ...over }
}

function logEvents(dir: string): string[] {
  return readFileSync(path.join(dir, LOG_FILE), 'utf8').trim().split('\n').map(line => (JSON.parse(line) as { event: string }).event)
}

function lockCli(dir: string, script: string, env: NodeJS.ProcessEnv = {}): Promise<number | null> {
  const { [HELD_VARIABLE]: _held, ...outsideARun } = process.env
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(REPO_ROOT, 'scripts/quality/lock.ts'), process.execPath, '-e', script], { cwd: REPO_ROOT, env: { ...outsideARun, [LOCK_DIR_VARIABLE]: dir, ...env }, stdio: 'ignore' })
  return new Promise(resolve => child.on('exit', resolve))
}

function opened(): { promise: Promise<void>, resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function gitIn(tree: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-C', tree, ...args], { stdio: 'ignore' })
}

function pushedTree(): string {
  const tree = scratch()
  gitIn(tree, 'init', '--quiet')
  writeFileSync(path.join(tree, 'a.txt'), 'a\n')
  gitIn(tree, 'add', '.')
  gitIn(tree, 'commit', '--quiet', '-m', 'first')
  gitIn(tree, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  return tree
}

function readerOf(tree: string): (args: readonly string[]) => string {
  return args => execFileSync('git', ['-C', tree, ...args], { encoding: 'utf8' })
}

describe('one worker budget for the machine', () => {
  it('two live sessions each get at most half of the cores', () => {
    const dir = scratch()
    joinSession(session(dir, '/tree/a'))
    expect(joinSession(session(dir, '/tree/b'))).toBeLessThanOrEqual(CORES / 2)
    expect(joinSession(session(dir, '/tree/a'))).toBeLessThanOrEqual(CORES / 2)
  })

  it('the worker limit vitest runs with comes from the session budget of this tree', async () => {
    const dir = scratch()
    vi.stubEnv(LOCK_DIR_VARIABLE, dir)
    const cores = os.availableParallelism()
    joinSession(session(dir, '/tree/other', { cores, pid: process.pid }))
    const { default: config } = await import('../../../vitest.config.js')
    expect(config.test?.maxWorkers).toBe(1)
  })

  it('two buses with simultaneous runs get at most cores minus one workers in sum', () => {
    const reads = [scratch(), scratch()]
    const first = session(reads[0]!, '/bus-a/tree', { reads, pid: 101 })
    const second = session(reads[1]!, '/bus-b/tree', { reads, pid: 102 })
    registerRun(first)
    registerRun(second)
    expect(runGrant(first) + runGrant(second)).toBeLessThanOrEqual(CORES - 1)
  })

  it('a run that starts behind another gets what the earlier one left, and never less than one worker', () => {
    const dir = scratch()
    expect(joinSession(session(dir, '/tree/a', { pid: 101 }))).toBe(CORES - 1)
    expect(joinSession(session(dir, '/tree/b', { pid: 102 }))).toBe(1)
  })

  it('a review joins the budget of the runs around it and leaves room for one more', () => {
    const dir = scratch()
    const review = joinSession(session(dir, '/reviews/session', { pid: 101 }), 1)
    const prepush = joinSession(session(dir, '/tree/prepush', { pid: 102 }))
    expect(review).toBe(workerBudget(CORES, 2))
    expect(review + prepush).toBeLessThanOrEqual(CORES - 1)
  })

  it('a session that left stops counting while its worker process lives on', () => {
    const dir = scratch()
    const review = session(dir, '/reviews/session', { pid: 101 })
    joinSession(review)
    leaveSession(review)
    expect(joinSession(session(dir, '/tree/a', { pid: 102 }))).toBe(CORES - 1)
  })

  it('the budget reads the queue directory of a sandboxed run and of an unsandboxed one, and only the named one when moved', () => {
    const home = scratch()
    expect(budgetDirs({}, home)).toEqual([path.join(home, '.construct', 'quality'), path.join('/tmp', `claude-${os.userInfo().uid}`, 'construct-quality')])
    expect(budgetDirs({ [LOCK_DIR_VARIABLE]: '/moved' }, home)).toEqual(['/moved'])
  })

  it('a review session is registered for as long as it runs and is spawned with its grant in the env', async () => {
    const dir = scratch()
    const joined: string[] = []
    const left: string[] = []
    const spawned: (string | undefined)[] = []
    const trees = new ReviewTrees('/repo', dir, { git: () => {}, worktrees: () => [], prepare: () => {}, state: () => ({ head: HEAD, status: [] }) })
    const review = claudeReviewer(trees, async (params) => {
      expect(left).toEqual([])
      spawned.push(params.env?.[WORKER_LIMIT_VARIABLE])
      writeFileSync(path.join(dir, `${params.sessionId}.verdict.json`), '{"verdict":"pass","findings":[]}')
      return 0
    }, () => {}, 50, () => null, {
      gate: { start: async () => true, release: () => {} },
      keep: () => true,
      joinWorkers: (tree) => {
        joined.push(tree)
        return 3
      },
      leaveWorkers: tree => left.push(tree),
    })
    await review({ taskKey: `review:1050:950:${HEAD}`, queue: 'review', cardId: 1050, pr: 950, head: HEAD, leaseGen: 1, actor: 'worker:review:w' }, fullReview('a fixed plan'))
    expect(spawned).toEqual(['3'])
    expect(joined).toHaveLength(1)
    expect(left).toEqual(joined)
  })

  it('a second run in one tree is one session', () => {
    const dir = scratch()
    const alone = joinSession(session(dir, '/tree/a'))
    expect(joinSession(session(dir, '/tree/a', { pid: 102 }))).toBe(alone)
  })

  it('a session stops counting as soon as its process is gone', () => {
    const dir = scratch()
    joinSession(session(dir, '/tree/gone', { pid: 101 }))
    expect(joinSession(session(dir, '/tree/a', { pid: 102, isAlive: pid => pid === 102 }))).toBe(workerBudget(CORES, 1))
  })

  it('a run that ended in a tree does not hide another run still alive there', () => {
    const dir = scratch()
    joinSession(session(dir, '/tree/a', { pid: 101 }))
    joinSession(session(dir, '/tree/a', { pid: 102 }))
    expect(joinSession(session(dir, '/tree/b', { pid: 103, isAlive: pid => pid !== 102 }))).toBe(1)
  })

  it('the floor is one worker, so a budget never stops a run', () => {
    expect(workerBudget(1, 1)).toBe(1)
    expect(workerBudget(4, 50)).toBe(1)
    expect(workerBudget(4, 0)).toBe(3)
  })

  it('a registry that cannot be written leaves the run its budget', () => {
    const blocked = path.join(scratch(), 'a-file')
    writeFileSync(blocked, '')
    expect(joinSession(session(path.join(blocked, 'below'), '/tree/a'))).toBe(workerBudget(CORES, 1))
  })
})

describe('heavy steps', () => {
  it('two heavy steps wait in one queue', async () => {
    vi.stubEnv(HELD_VARIABLE, undefined)
    const dir = scratch()
    let running = 0
    let most = 0
    const started = [opened(), opened()]
    const released = [opened(), opened()]
    let starts = 0
    const step = async (): Promise<number> => {
      const turn = starts++
      running += 1
      most = Math.max(most, running)
      started[turn]!.resolve()
      await released[turn]!.promise
      running -= 1
      return 0
    }
    const both = Promise.all([heavyStep(step, dir), heavyStep(step, dir)])
    await started[0]!.promise
    released[0]!.resolve()
    await started[1]!.promise
    released[1]!.resolve()
    expect(await both).toEqual([0, 0])
    expect(most).toBe(1)
    expect(logEvents(dir).filter(event => event !== 'wait')).toEqual(['start', 'end', 'start', 'end'])
  })

  it('two runs of the lock command line take turns and each returns its exit code', async () => {
    const dir = scratch()
    const codes = await Promise.all([lockCli(dir, 'setTimeout(() => process.exit(3), 500)'), lockCli(dir, 'setTimeout(() => process.exit(3), 500)')])
    expect(codes).toEqual([3, 3])
    expect(logEvents(dir).filter(event => event !== 'wait')).toEqual(['start', 'end', 'start', 'end'])
  })

  it('the lock command line inside a held run does not take the lock', async () => {
    const dir = scratch()
    expect(await lockCli(dir, 'process.exit(4)', { [HELD_VARIABLE]: '1' })).toBe(4)
    expect(() => readFileSync(path.join(dir, LOG_FILE))).toThrow()
  })

  it('a step inside a held queue does not wait on the lock its parent holds', async () => {
    vi.stubEnv(HELD_VARIABLE, '1')
    const dir = scratch()
    expect(await heavyStep(async () => 7, dir)).toBe(7)
    expect(() => readFileSync(path.join(dir, LOG_FILE))).toThrow()
  })

  it('the pre-push full suite goes through the queue and a layered run does not', async () => {
    const queue = vi.fn(async (step: () => Promise<number>) => step())
    expect(await throughQueue(FULL_RUN, async () => 3, queue)).toBe(3)
    expect(queue).toHaveBeenCalledTimes(1)
    expect(await throughQueue(LAYER_RUN, async () => 4, queue)).toBe(4)
    expect(queue).toHaveBeenCalledTimes(1)
  })

  it('the lint script runs eslint through the queue', () => {
    const { scripts } = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: { lint: string } }
    expect(scripts.lint).toBe('node --import tsx scripts/quality/lock.ts eslint .')
  })

  it('the queue stays in the documented home directory while that can be written', () => {
    const home = scratch()
    expect(queueDir({}, home)).toBe(path.join(home, '.construct', 'quality'))
    expect(queueDir({ [LOCK_DIR_VARIABLE]: '/moved' }, home)).toBe('/moved')
  })

  it('a sandboxed session that cannot write the home directory queues in the shared temp directory', () => {
    const home = scratch()
    writeFileSync(path.join(home, '.construct'), '')
    expect(queueDir({}, home)).toBe(path.join('/tmp', `claude-${os.userInfo().uid}`, 'construct-quality'))
  })
})

describe('a clean tree', () => {
  it('a clean tree does not start the pre-push checks', () => {
    const tree = pushedTree()
    const { GIT_DIR: _dir, GIT_WORK_TREE: _work, ...env } = process.env
    const run = spawnSync(process.execPath, ['--import', 'tsx', path.join(REPO_ROOT, 'scripts/ci/prepush.ts')], { cwd: REPO_ROOT, env: { ...env, GIT_DIR: path.join(tree, '.git'), GIT_WORK_TREE: tree }, encoding: 'utf8' })
    expect(run.stdout).toBe('prepush: clean — the tree holds no change and no unpushed commit; no check started.\n')
    expect(run.status).toBe(0)
  })

  it('a malformed answer from git starts them instead of reading as clean', () => {
    for (const answer of ['', 'junk'])
      expect(cleanTreeGate(args => args[0] === 'status' ? '' : answer)).toBeNull()
    expect(cleanTreeGate(args => args[0] === 'status' ? '' : '0\n')).not.toBeNull()
  })

  it('an edited or an untracked file starts them', () => {
    const tree = pushedTree()
    writeFileSync(path.join(tree, 'b.txt'), 'b\n')
    expect(cleanTreeGate(readerOf(tree))).toBeNull()
  })

  it('a commit no remote holds starts them, so a concluded merge is checked', () => {
    const tree = pushedTree()
    gitIn(tree, 'commit', '--quiet', '--allow-empty', '-m', 'merge')
    expect(cleanTreeGate(readerOf(tree))).toBeNull()
  })

  it('the launch prompt and the answer prompt say a clean session runs none of the checks', () => {
    const answerer = readFileSync(path.join(REPO_ROOT, 'scripts/nodes/answer/answerer.ts'), 'utf8')
    expect(HEADER.replaceAll(/\s+/g, ' ')).toContain('A session that leaves a clean tree and no unpushed commit runs none of them.')
    expect(answerer).toContain('A session that leaves a clean tree and no unpushed commit runs none of them.')
  })
})

describe('the board', () => {
  it('the board shows the machine load', () => {
    vi.spyOn(os, 'loadavg').mockReturnValue([92.04, 80, 70])
    vi.spyOn(os, 'availableParallelism').mockReturnValue(CORES)
    const pages: string[] = []
    expect(printBoard(busWithCardStarted([]).file, NOW, text => pages.push(text), path.join(scratch(), 'no-handoff.md'), 'html')).toBe(0)
    expect(pages.join('')).toContain('<span>load <b>92.0 / 16 cores</b></span>')
  })
})
