import type { ProcessTable } from '../../bus/chain-process.js'
import type { ChainObservation } from '../../bus/chain.js'
import type { Lease } from '../../bus/lease.js'
import type { Role, RoleLease, RoleStop } from '../../bus/role.js'
import type { World } from '../shift/fixtures/autopilot-world.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeChain } from '../../bus/chain.js'
import { appendEvent } from '../../bus/db.js'
import { taskKey } from '../../bus/identifiers.js'
import { CARD_STARTED } from '../../bus/inbox.js'
import { CARD_ADMITTED } from '../../bus/launch-candidates.js'
import { expireLeases, LEASE_MS, leaseNext } from '../../bus/lease.js'
import { CARD_CLOSED, FAILURES_TO_STOP } from '../../bus/queue.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { RestartExecutor } from '../../bus/restart-executor.js'
import { launchSwitchedOn, MIKO_LAUNCH_OFF, restartStepLine, RestartWorker, roleLauncher, runRestartWorker } from '../../bus/restart-worker.js'
import { leaseRole, observeRoleStop, RAISED_VARIABLE, RAISES_PER_HANDOFF } from '../../bus/role.js'
import { switchWorker } from '../../bus/workers.js'
import { MIKO_HANDOFF_NAME } from '../../miko/loop.js'
import { runBg } from '../../shift/bg.js'
import { chainObserver } from '../../shift/chain-bus.js'
import { CLAUDE_VARIABLE } from '../../shift/claude.js'
import { runRelaunchBg } from '../../shift/relaunch-bg.js'
import { runShift } from '../../shift/shift.js'
import { captured, depsOf, fakeGh, newWorld } from '../shift/fixtures/autopilot-world.js'
import { MAIN_1, MAIN_2 } from './github-fake.js'
import { eventCount, eventsOf, mergeBench, taskState } from './merge-bench.js'

vi.mock('../../shift/bg.js', () => ({
  runBg: vi.fn(() => ({ stdout: ['5151'], stderr: [], exitCode: 0 })),
}))

vi.mock('../../shift/relaunch-bg.js', () => ({
  runRelaunchBg: vi.fn(() => ({ stdout: ['6161'], stderr: [], exitCode: 0 })),
}))

afterEach(() => {
  vi.restoreAllMocks()
})

const CARD = 809
const DIR = '/shift/lane-1'
const LEADER = 4242
const ROLE_PIDS: Record<Role, number> = { operator: 6161, miko: 7171 }
const OPERATOR_HANDOFF = '/handoff/operator.md'
const MIKO_HANDOFF = `/handoff/${MIKO_HANDOFF_NAME}`
const restart = (head = MAIN_2, cardId = CARD): string => taskKey({ queue: 'restart', cardId, head })

function restartBench() {
  const bench = mergeBench()
  const signalled: number[] = []
  const raises: { role: Role, handoff: string }[] = []
  const dead = new Set<number>()
  const reused = new Set<number>()
  let launchOn = () => false
  const processes: ProcessTable = {
    commandLine: pid => dead.has(pid) ? null : reused.has(pid) ? 'vim notes.txt' : `node /opt/runner.js ${DIR} ${pid}`,
    signalGroup: leader => signalled.push(leader),
  }
  const roles = {
    raise: (role: Role, handoff: string): number => {
      raises.push({ role, handoff })
      return ROLE_PIDS[role]
    },
  }
  const launchSwitchedOn = (): boolean => launchOn()
  const executor = new RestartExecutor({ db: bench.db, roles, processes, launchSwitchedOn, clock: bench.clock.now })
  return {
    ...bench,
    signalled,
    roles,
    raises,
    processes,
    worker: (session = 'worker-1') => new RestartWorker({ db: bench.db, roles, processes, launchSwitchedOn, clock: bench.clock.now, session }),
    die: (pid: number): void => {
      dead.add(pid)
    },
    reuse: (pid: number): void => {
      reused.add(pid)
    },
    switchLaunch: (on: () => boolean): void => {
      launchOn = on
    },
    observe: (chain: Partial<ChainObservation> = {}): void => {
      observeChain(bench.db, bench.clock.now().toISOString(), 'worker:chain:shift-1', { dir: DIR, parking: '/parking/lane-1', cardId: CARD, sha: MAIN_1, pid: 4242, leader: null, boundary: true, state: 'running', ...chain })
    },
    stopRole: (stop: Omit<RoleStop, 'raised'>, raised = false): void => {
      observeRoleStop(bench.db, bench.clock.now().toISOString(), `worker:${stop.role}:7`, { ...stop, raised })
    },
    relaunch: (lease: RoleLease) => executor.relaunch(lease),
    advanceMain: (files: string[]): void => {
      bench.gitHub.mainFiles = { [MAIN_2]: files }
      bench.gitHub.main = MAIN_2
    },
    leaseRestart: (actor = 'worker:restart:worker-1'): Lease | null => leaseNext(bench.db, bench.clock.now().toISOString(), 'restart', actor),
    restart: (lease: Lease) => executor.restart(lease),
  }
}

function restartTasks(bench: ReturnType<typeof mergeBench>): unknown[] {
  return bench.db.prepare(`SELECT task_key, state FROM tasks WHERE queue = 'restart' ORDER BY task_key`).all()
}

describe('the restart queue', () => {
  it('a merge into scripts/shift sets touches_mechanics and enters restart for a chain on the old sha', () => {
    const bench = restartBench()
    bench.observe()
    bench.observe({ dir: '/shift/lane-2', cardId: 810, sha: MAIN_2 })
    bench.advanceMain(['scripts/shift/shift.ts'])
    bench.tick()

    expect(eventsOf(bench.db, 'main.advanced').at(-1)).toEqual({ sha: MAIN_2, touches_mechanics: true })
    expect(restartTasks(bench)).toEqual([{ task_key: restart(), state: 'queued' }])
    expect(bench.leaseRestart()).toMatchObject({ taskKey: restart(), queue: 'restart', cardId: CARD, pr: null, head: MAIN_2, leaseGen: 1 })
    bench.close()
  })

  it('a merge outside scripts/shift does not enter restart', () => {
    const bench = restartBench()
    bench.observe()
    bench.advanceMain(['scripts/bus/queue.ts', 'package.json', '.claude/agents/review.md', 'scripts/shifted.ts'])
    bench.tick()

    expect(eventsOf(bench.db, 'main.advanced').at(-1)).toEqual({ sha: MAIN_2, touches_mechanics: false })
    expect(restartTasks(bench)).toEqual([])
    expect(bench.leaseRestart()).toBeNull()
    bench.close()
  })

  it('the restart waits for the task boundary and records both shas', () => {
    const bench = restartBench()
    bench.observe({ boundary: false, leader: LEADER })
    bench.advanceMain(['scripts/shift/bg.ts'])
    bench.tick()

    expect(bench.restart(bench.leaseRestart()!)).toEqual({ kind: 'waiting', taskKey: restart(), dir: DIR, why: 'not_at_boundary' })
    expect(bench.signalled).toEqual([])
    expect(taskState(bench.db, restart())).toEqual({ state: 'queued', lease_gen: 1, failures: 0 })

    bench.observe({ boundary: true, leader: LEADER })
    bench.tick()
    expect(bench.restart(bench.leaseRestart()!)).toEqual({ kind: 'handed', taskKey: restart(), dir: DIR, cardId: CARD, cardStopped: false })
    expect(bench.signalled).toEqual([LEADER])
    expect(eventsOf(bench.db, 'chain.restarted')).toEqual([])
    expect(taskState(bench.db, restart())).toEqual({ state: 'completed', lease_gen: 2, failures: 0 })

    bench.tick()
    expect(bench.db.prepare('SELECT dir, sha, pid, boundary, state FROM chains').all()).toEqual([{ dir: DIR, sha: MAIN_1, pid: 4242, boundary: 1, state: 'stopped' }])
    expect(restartTasks(bench)).toEqual([{ task_key: restart(), state: 'completed' }])
    const live = projectionDump(bench.db)
    reduce(bench.db)
    expect(projectionDump(bench.db)).toBe(live)
    bench.close()
  })

  it('a restart with a stale lease_gen is refused and writes nothing', () => {
    const bench = restartBench()
    bench.observe()
    bench.advanceMain(['scripts/shift/shift.ts'])
    bench.tick()
    const old = bench.leaseRestart('worker:restart:old')!
    bench.clock.advance(LEASE_MS + 1)
    expect(expireLeases(bench.db, bench.clock.now().toISOString())).toEqual([restart()])
    const current = bench.leaseRestart('worker:restart:new')!
    expect([old.leaseGen, current.leaseGen]).toEqual([1, 2])

    const before = eventCount(bench.db)
    expect(bench.restart(old)).toEqual({ kind: 'fenced', taskKey: restart() })
    expect(eventCount(bench.db)).toBe(before)
    expect(bench.signalled).toEqual([])
    bench.close()
  })

  it('a chain that left its boundary after the projection was read is not restarted', () => {
    const bench = restartBench()
    bench.observe({ leader: LEADER })
    bench.advanceMain(['scripts/shift/shift.ts'])
    bench.tick()
    const commandLine = bench.processes.commandLine
    let left = false
    bench.processes.commandLine = (pid) => {
      if (!left) {
        left = true
        bench.observe({ boundary: false, leader: LEADER })
      }
      return commandLine(pid)
    }

    expect(bench.restart(bench.leaseRestart()!)).toEqual({ kind: 'waiting', taskKey: restart(), dir: DIR, why: 'not_at_boundary' })
    expect(bench.signalled).toEqual([])
    expect(eventsOf(bench.db, 'chain.restarted')).toEqual([])
    bench.close()
  })

  it('a chain.observed is folded into chains when it is appended, not on the next reducer tick', () => {
    const bench = restartBench()
    bench.observe({ boundary: true })
    bench.observe({ boundary: false })
    expect(bench.db.prepare('SELECT boundary FROM chains WHERE dir = ?').get(DIR)).toEqual({ boundary: 0 })
    bench.close()
  })

  it('a chain waiting on #N sits at its boundary under the card it waits for, restarts on a mechanism merge, and replays the same', () => {
    const bench = restartBench()
    bench.observe({ cardId: 812, state: 'waiting', boundary: true, waitingOn: [809], leader: LEADER })
    expect(bench.db.prepare('SELECT card_id, state, boundary FROM chains WHERE dir = ?').get(DIR)).toEqual({ card_id: 812, state: 'waiting', boundary: 1 })
    bench.advanceMain(['scripts/shift/shift.ts'])
    bench.tick()
    expect(bench.restart(bench.leaseRestart()!)).toMatchObject({ kind: 'handed', dir: DIR, cardId: 812 })
    expect(bench.signalled).toEqual([LEADER])
    bench.tick()
    const live = projectionDump(bench.db)
    reduce(bench.db)
    expect(projectionDump(bench.db)).toBe(live)
    bench.close()
  })

  it('a chain.observed is refused when it waits without naming on what, or names what it waits on without waiting', () => {
    const bench = restartBench()
    expect(() => bench.observe({ state: 'waiting' })).toThrow('waitingOn')
    expect(() => bench.observe({ state: 'waiting', waitingOn: [0] })).toThrow('waitingOn')
    expect(() => bench.observe({ state: 'running', waitingOn: [809] })).toThrow('waitingOn')
    expect(bench.db.prepare('SELECT count(*) AS n FROM chains').get()).toEqual({ n: 0 })
    bench.close()
  })

  it('a stop that fails is a technical denial and the task goes back to the queue', () => {
    const bench = restartBench()
    bench.observe({ leader: LEADER })
    bench.advanceMain(['scripts/shift/shift.ts'])
    bench.tick()
    bench.processes.signalGroup = () => {
      throw new Error('kill EPERM')
    }

    expect(bench.restart(bench.leaseRestart()!)).toMatchObject({ kind: 'denied', reason: 'stop_failed', next: 'queued' })
    expect(eventsOf(bench.db, 'policy.denied')).toMatchObject([{ command: 'restart', kind: 'technical', reason: 'stop_failed' }])
    expect(taskState(bench.db, restart())).toEqual({ state: 'queued', lease_gen: 1, failures: 1 })
    bench.close()
  })
})

describe('the chain producer', () => {
  async function chainOf(body: string, busPath: string, now: () => Date): Promise<World> {
    const world = newWorld([{ id: 1, body }])
    const observeChain = chainObserver({ busPath, sha: () => MAIN_1, pid: 4242, leader: () => null, now, err: () => {} })
    await runShift([world.shift, '--parking', world.parking, '--chain'], depsOf(world, fakeGh({}).gh, captured(), { sleep: async () => {}, observeChain }))
    return world
  }

  it('a chain that stops at fault writes chain.observed and a restart task enters the queue', async () => {
    const bench = restartBench()
    const world = await chainOf('do 1 STUB-FAIL', bench.busPath, bench.clock.now)

    expect(eventsOf(bench.db, 'chain.observed').map(({ state, boundary }) => `${String(state)} ${String(boundary)}`)).toEqual(['running false', 'running true', 'fault true'])
    bench.tick()
    expect(restartTasks(bench)).toEqual([{ task_key: restart(MAIN_1, 1), state: 'queued' }])
    expect(bench.restart(bench.leaseRestart()!)).toEqual({ kind: 'handed', taskKey: restart(MAIN_1, 1), dir: world.shift, cardId: 1, cardStopped: false })
    expect(bench.signalled).toEqual([])
    expect(bench.db.prepare('SELECT dir, state FROM chains').all()).toEqual([{ dir: world.shift, state: 'stopped' }])
    bench.close()
  })

  it('a chain that stops on a question writes chain.observed and enters no restart', async () => {
    const bench = restartBench()
    await chainOf('do 1 STUB-QUESTION STUB-NO-PR', bench.busPath, bench.clock.now)

    expect(eventsOf(bench.db, 'chain.observed').at(-1)).toMatchObject({ state: 'stopped', boundary: true })
    bench.tick()
    expect(restartTasks(bench)).toEqual([])
    bench.close()
  })
})

describe('relaunch(role)', () => {
  it('the Operator and the Miko window stopped at a threshold with STATUS: CONTINUE are raised by role without the owner', () => {
    const bench = restartBench()
    bench.stopRole({ role: 'operator', handoff: OPERATOR_HANDOFF, status: 'CONTINUE', reason: 'context' })
    bench.stopRole({ role: 'miko', handoff: MIKO_HANDOFF, status: 'CONTINUE', reason: 'spend' })
    bench.tick()
    const worker = bench.worker()

    expect(worker.step()).toEqual({ kind: 'raised', role: 'miko', handoff: MIKO_HANDOFF, pid: ROLE_PIDS.miko })
    expect(worker.step()).toEqual({ kind: 'raised', role: 'operator', handoff: OPERATOR_HANDOFF, pid: ROLE_PIDS.operator })
    expect(worker.step()).toEqual({ kind: 'idle' })
    expect(bench.raises).toEqual([{ role: 'miko', handoff: MIKO_HANDOFF }, { role: 'operator', handoff: OPERATOR_HANDOFF }])
    expect(eventsOf(bench.db, 'role.raised')).toEqual([
      { role: 'miko', handoff: MIKO_HANDOFF, lease_gen: 1, pid: ROLE_PIDS.miko },
      { role: 'operator', handoff: OPERATOR_HANDOFF, lease_gen: 1, pid: ROLE_PIDS.operator },
    ])

    bench.tick()
    expect(bench.db.prepare('SELECT role, state, lease_gen, pid FROM roles ORDER BY role').all()).toEqual([
      { role: 'miko', state: 'raised', lease_gen: 1, pid: ROLE_PIDS.miko },
      { role: 'operator', state: 'raised', lease_gen: 1, pid: ROLE_PIDS.operator },
    ])
    expect(worker.step()).toEqual({ kind: 'idle' })
    bench.close()
  })

  it('a role stopped on another STATUS or not at a threshold is not raised', () => {
    const bench = restartBench()
    bench.stopRole({ role: 'operator', handoff: OPERATOR_HANDOFF, status: 'OWNER', reason: 'context' })
    bench.stopRole({ role: 'miko', handoff: MIKO_HANDOFF, status: 'CONTINUE', reason: 'ctrl-c' })
    bench.tick()

    expect(bench.worker().step()).toEqual({ kind: 'idle' })
    expect(bench.raises).toEqual([])
    bench.close()
  })

  it('a relaunch under a stale lease_gen is fenced and raises nothing', () => {
    const bench = restartBench()
    bench.stopRole({ role: 'operator', handoff: OPERATOR_HANDOFF, status: 'CONTINUE', reason: 'spend' })
    bench.tick()
    const old = leaseRole(bench.db, bench.clock.now().toISOString(), 'worker:restart:old')!
    bench.clock.advance(LEASE_MS + 1)
    const current = leaseRole(bench.db, bench.clock.now().toISOString(), 'worker:restart:new')!
    expect([old.leaseGen, current.leaseGen]).toEqual([1, 2])

    const before = eventCount(bench.db)
    expect(bench.relaunch(old)).toEqual({ kind: 'fenced', taskKey: 'relaunch:operator' })
    expect(eventCount(bench.db)).toBe(before)
    expect(bench.raises).toEqual([])
    expect(bench.relaunch(current)).toMatchObject({ kind: 'raised', role: 'operator' })
    bench.close()
  })
})

describe('the ceiling on relaunch(role)', () => {
  function inbox(bench: ReturnType<typeof restartBench>): unknown[] {
    return eventsOf(bench.db, 'card.stopped').filter(payload => payload.reason === 'question.owner')
  }

  it(`a role the bus raised ${RAISES_PER_HANDOFF} times on one handoff goes to the owner as question.owner, not to another raise`, () => {
    const bench = restartBench()
    const worker = bench.worker()
    bench.stopRole({ role: 'operator', handoff: OPERATOR_HANDOFF, status: 'CONTINUE', reason: 'spend' })
    bench.tick()
    for (let raise = 0; raise < RAISES_PER_HANDOFF; raise += 1) {
      expect(worker.step()).toMatchObject({ kind: 'raised', role: 'operator' })
      bench.clock.advance(1000)
      bench.stopRole({ role: 'operator', handoff: OPERATOR_HANDOFF, status: 'CONTINUE', reason: 'spend' }, true)
      bench.tick()
    }

    expect(worker.step()).toMatchObject({ kind: 'to_owner', role: 'operator', handoff: OPERATOR_HANDOFF })
    expect(worker.step()).toEqual({ kind: 'idle' })
    expect(bench.raises).toHaveLength(RAISES_PER_HANDOFF)
    expect(inbox(bench)).toMatchObject([{ reason: 'question.owner', role: 'operator', handoff: OPERATOR_HANDOFF }])

    bench.clock.advance(1000)
    bench.stopRole({ role: 'operator', handoff: OPERATOR_HANDOFF, status: 'CONTINUE', reason: 'spend' }, false)
    bench.tick()
    expect(worker.step()).toMatchObject({ kind: 'raised', role: 'operator' })
    bench.close()
  })

  it(`a role whose raise fails ${FAILURES_TO_STOP} times in a row goes to the owner and is not retried`, () => {
    const bench = restartBench()
    bench.roles.raise = () => {
      throw new Error('relaunch did not start')
    }
    const worker = bench.worker()
    bench.stopRole({ role: 'operator', handoff: OPERATOR_HANDOFF, status: 'CONTINUE', reason: 'context' })
    bench.tick()

    for (let failure = 0; failure < FAILURES_TO_STOP; failure += 1)
      expect(worker.step()).toMatchObject({ kind: 'raise_failed', role: 'operator', detail: 'relaunch did not start' })
    expect(worker.step()).toMatchObject({ kind: 'to_owner', role: 'operator' })
    expect(worker.step()).toEqual({ kind: 'idle' })
    expect(eventsOf(bench.db, 'role.raise_failed')).toHaveLength(FAILURES_TO_STOP)
    expect(inbox(bench)).toHaveLength(1)
    const live = projectionDump(bench.db)
    reduce(bench.db)
    expect(projectionDump(bench.db)).toBe(live)
    bench.close()
  })

  it('the real role launcher keeps the launch of pnpm miko switched off and names why', () => {
    expect(() => roleLauncher({}).raise('miko', MIKO_HANDOFF)).toThrow(MIKO_LAUNCH_OFF)
  })

  it('a raised Operator keeps the worker\'s SHIFT_CLAUDE unchanged', () => {
    const ownerMode = 'claude --permission-mode auto'
    expect(roleLauncher({ [CLAUDE_VARIABLE]: ownerMode }).raise('operator', OPERATOR_HANDOFF)).toBe(ROLE_PIDS.operator)
    expect(vi.mocked(runRelaunchBg)).toHaveBeenLastCalledWith([OPERATOR_HANDOFF], { [CLAUDE_VARIABLE]: ownerMode, [RAISED_VARIABLE]: '1' })
  })
})

describe('the restart worker', () => {
  it('takes the restart queue and is idle once it is empty', () => {
    const bench = restartBench()
    bench.observe({ leader: LEADER })
    bench.advanceMain(['scripts/shift/shift.ts'])
    bench.tick()
    const worker = bench.worker()

    expect(worker.step()).toMatchObject({ kind: 'handed', taskKey: restart() })
    expect(worker.step()).toEqual({ kind: 'idle' })
    bench.close()
  })

  it('ships switched off: without --on it opens nothing and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const bench = restartBench()
    expect(await runRestartWorker([], { busPath: '/nonexistent/bus.db', roles: bench.roles, processes: bench.processes, launchSwitchedOn: () => false, session: 'worker-1', pause: async () => {} })).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('switched off'))
    bench.close()
  })
})

function closedCard(bench: ReturnType<typeof restartBench>, cardId: number): void {
  bench.gitHub.open({ number: cardId - 100 })
  bench.tick()
  bench.gitHub.close(cardId - 100, true)
  bench.tick()
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_CLOSED, actor: 'worker:close:earlier', cardId, pr: cardId - 100, head: null, dedupeKey: `${CARD_CLOSED}:${cardId}`, payload: { verification: 'run' }, legacy: false })
  bench.tick()
}

function chainRows(bench: ReturnType<typeof restartBench>): unknown[] {
  return bench.db.prepare('SELECT dir, card_id, state FROM chains ORDER BY dir').all()
}

describe('a dead chain', () => {
  it('a dead chain of a closed card is stopped and its restart task withdrawn', () => {
    const bench = restartBench()
    bench.observe({ boundary: false })
    bench.advanceMain(['scripts/shift/shift.ts'])
    bench.tick()
    closedCard(bench, CARD)
    bench.die(4242)

    expect(bench.restart(bench.leaseRestart()!)).toMatchObject({ kind: 'denied', taskKey: restart(), reason: 'chain_dead', next: 'withdrawn' })
    expect(chainRows(bench)).toEqual([{ dir: DIR, card_id: CARD, state: 'stopped' }])
    expect(taskState(bench.db, restart())).toMatchObject({ state: 'withdrawn' })
    expect(bench.leaseRestart()).toBeNull()
    expect(bench.signalled).toEqual([])
    bench.tick()
    expect(restartTasks(bench)).toEqual([{ task_key: restart(), state: 'withdrawn' }])
    const live = projectionDump(bench.db)
    reduce(bench.db)
    expect(projectionDump(bench.db)).toBe(live)
    bench.close()
  })

  it('a dead chain of an open card is observed fault', () => {
    const bench = restartBench()
    bench.observe({ boundary: false })
    bench.advanceMain(['scripts/shift/shift.ts'])
    bench.tick()
    bench.die(4242)

    bench.restart(bench.leaseRestart()!)
    expect(chainRows(bench)).toEqual([{ dir: DIR, card_id: CARD, state: 'fault' }])
    expect(eventsOf(bench.db, 'chain.observed').at(-1)).toMatchObject({ dir: DIR, pid: 4242, state: 'fault', boundary: false })
    bench.close()
  })

  it('while launch is switched off a dead chain is not restarted and no lease loops', () => {
    const bench = restartBench()
    bench.observe({ boundary: false })
    bench.advanceMain(['scripts/shift/shift.ts'])
    bench.tick()
    bench.die(4242)
    const worker = bench.worker()

    expect(worker.step()).toMatchObject({ kind: 'denied', taskKey: restart(), reason: 'launch_off', next: 'withdrawn' })
    expect(worker.step()).toEqual({ kind: 'idle' })
    bench.tick()
    expect(worker.step()).toEqual({ kind: 'idle' })
    expect(bench.signalled).toEqual([])
    const ofRestart = (type: string): unknown[] => eventsOf(bench.db, type).filter(event => event.queue === 'restart')
    expect(ofRestart('task.leased')).toHaveLength(1)
    expect(ofRestart('task.released')).toEqual([])
    bench.close()
  })

  it('a chain whose leader PID another process took is dead, while a chain with no leader stays undecided', () => {
    const bench = restartBench()
    bench.observe({ boundary: false, leader: 4242 })
    bench.observe({ dir: '/shift/lane-2', cardId: 810, pid: 4343, leader: null, boundary: false })
    bench.advanceMain(['scripts/shift/shift.ts'])
    bench.tick()
    bench.reuse(4242)
    bench.reuse(4343)
    const worker = bench.worker()

    expect(worker.step()).toMatchObject({ kind: 'denied', taskKey: restart(), reason: 'launch_off', next: 'withdrawn' })
    expect(worker.step()).toEqual({ kind: 'waiting', taskKey: restart(MAIN_2, 810), dir: '/shift/lane-2', why: 'not_at_boundary' })
    expect(chainRows(bench)).toEqual([{ dir: DIR, card_id: CARD, state: 'fault' }, { dir: '/shift/lane-2', card_id: 810, state: 'running' }])
    bench.close()
  })

  it('with launch switched on a fault chain whose process died restarts without waiting for the boundary', () => {
    const busDir = mkdtempSync(path.join(tmpdir(), 'bus-workers-'))
    const bench = restartBench()
    bench.switchLaunch(() => launchSwitchedOn(busDir))
    switchWorker(busDir, 'launch', true)
    bench.observe({ boundary: false })
    bench.advanceMain(['scripts/shift/shift.ts'])
    bench.tick()
    bench.die(4242)

    expect(bench.restart(bench.leaseRestart()!)).toEqual({ kind: 'handed', taskKey: restart(), dir: DIR, cardId: CARD, cardStopped: false })
    expect(bench.signalled).toEqual([])
    expect(chainRows(bench)).toEqual([{ dir: DIR, card_id: CARD, state: 'stopped' }])
    bench.close()
    rmSync(busDir, { recursive: true, force: true })
  })

  it('a live chain behind main still waits for its boundary', () => {
    const bench = restartBench()
    bench.switchLaunch(() => true)
    bench.observe({ boundary: false })
    bench.advanceMain(['scripts/shift/shift.ts'])
    bench.tick()

    expect(bench.restart(bench.leaseRestart()!)).toEqual({ kind: 'waiting', taskKey: restart(), dir: DIR, why: 'not_at_boundary' })
    expect(bench.signalled).toEqual([])
    bench.close()
  })

  it('a dead chain of a closed card with no restart task is stopped by the worker', () => {
    const bench = restartBench()
    bench.observe({ boundary: false })
    closedCard(bench, CARD)
    bench.die(4242)

    expect(restartTasks(bench)).toEqual([])
    expect(bench.worker().step()).toEqual({ kind: 'dead_chains', chains: [{ dir: DIR, cardId: CARD, state: 'stopped' }] })
    expect(chainRows(bench)).toEqual([{ dir: DIR, card_id: CARD, state: 'stopped' }])
    expect(eventsOf(bench.db, 'chain.observed').at(-1)).toMatchObject({ dir: DIR, pid: 4242, state: 'stopped', boundary: false })
    expect(bench.signalled).toEqual([])
    bench.close()
  })

  it('a dead chain of an open card with no restart task is observed fault and nothing starts', () => {
    const bench = restartBench()
    bench.switchLaunch(() => true)
    bench.observe({ boundary: false })
    bench.observe({ dir: '/shift/lane-2', cardId: 810, pid: 4343, boundary: false })
    bench.die(4242)
    const worker = bench.worker()

    expect(restartTasks(bench)).toEqual([])
    expect(worker.step()).toEqual({ kind: 'dead_chains', chains: [{ dir: DIR, cardId: CARD, state: 'fault' }] })
    expect(worker.step()).toEqual({ kind: 'idle' })
    expect(chainRows(bench)).toEqual([{ dir: DIR, card_id: CARD, state: 'fault' }, { dir: '/shift/lane-2', card_id: 810, state: 'running' }])
    expect(bench.signalled).toEqual([])
    bench.close()
  })

  it('a stopped chain of an open card whose PID is gone is not observed again', () => {
    const bench = restartBench()
    bench.observe({ boundary: false, state: 'stopped' })
    bench.die(4242)

    expect(bench.worker().step()).toEqual({ kind: 'idle' })
    expect(chainRows(bench)).toEqual([{ dir: DIR, card_id: CARD, state: 'stopped' }])
    bench.close()
  })

  it('the worker writes one line per dead chain it observed', () => {
    expect(restartStepLine({ kind: 'dead_chains', chains: [{ dir: DIR, cardId: CARD, state: 'stopped' }, { dir: '/shift/lane-2', cardId: 810, state: 'fault' }] })).toBe([
      `[bus:restart] #${CARD}: the chain in ${DIR} died with no restart task; observed stopped, nothing started`,
      '[bus:restart] #810: the chain in /shift/lane-2 died with no restart task; observed fault, nothing started',
    ].join('\n'))
  })

  it('a card\'s live chain stands for it, not an older stopped row', () => {
    const bench = restartBench()
    bench.observe({ dir: '/shift/lane-0', state: 'stopped' })
    bench.observe({ boundary: false })
    bench.advanceMain(['scripts/shift/shift.ts'])
    bench.tick()

    expect(bench.restart(bench.leaseRestart()!)).toEqual({ kind: 'waiting', taskKey: restart(), dir: DIR, why: 'not_at_boundary' })
    bench.close()
  })

  it('a dead chain is raised through a launch task, never through shift:bg', () => {
    const bench = restartBench()
    bench.switchLaunch(() => true)
    const admit = (cardId: number): void => {
      appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
    }
    admit(CARD)
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:earlier', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:earlier-${CARD}`, payload: { session: 'earlier' }, legacy: false })
    admit(810)
    bench.observe({ boundary: false })
    bench.tick()
    bench.die(4242)
    const worker = bench.worker()

    expect(worker.step()).toEqual({ kind: 'dead_chains', chains: [{ dir: DIR, cardId: CARD, state: 'fault' }] })
    bench.tick()
    expect(worker.step()).toEqual({ kind: 'handed', taskKey: restart(MAIN_1), dir: DIR, cardId: CARD, cardStopped: true })
    expect(vi.mocked(runBg)).not.toHaveBeenCalled()
    expect(eventsOf(bench.db, 'chain.restarted')).toEqual([])
    expect(eventsOf(bench.db, 'card.stopped')).toMatchObject([{ reason: 'fault' }])
    expect(chainRows(bench)).toEqual([{ dir: DIR, card_id: CARD, state: 'stopped' }])
    bench.tick()
    expect(bench.db.prepare(`SELECT task_key, state FROM tasks WHERE queue = 'launch'`).all()).toEqual([{ task_key: 'launch:810:admission-810', state: 'queued' }])
    bench.close()
  })
})
