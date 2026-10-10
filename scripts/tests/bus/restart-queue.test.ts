import type { ChainObservation, ChainRow } from '../../bus/chain.js'
import type { Lease } from '../../bus/lease.js'
import type { Role, RoleLease, RoleStop } from '../../bus/role.js'
import type { World } from '../shift/fixtures/autopilot-world.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeChain } from '../../bus/chain.js'
import { taskKey } from '../../bus/identifiers.js'
import { expireLeases, LEASE_MS, leaseNext } from '../../bus/lease.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { RestartExecutor } from '../../bus/restart-executor.js'
import { RestartWorker, runRestartWorker } from '../../bus/restart-worker.js'
import { leaseRole, observeRoleStop } from '../../bus/role.js'
import { chainObserver } from '../../shift/chain-bus.js'
import { runShift } from '../../shift/shift.js'
import { captured, depsOf, fakeGh, newWorld } from '../shift/fixtures/autopilot-world.js'
import { MAIN_1, MAIN_2 } from './github-fake.js'
import { eventCount, eventsOf, mergeBench, taskState } from './merge-bench.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const CARD = 809
const DIR = '/shift/lane-1'
const NEW_PID = 5151
const ROLE_PIDS: Record<Role, number> = { operator: 6161, miko: 7171 }
const OPERATOR_HANDOFF = '/handoff/operator.md'
const MIKO_HANDOFF = '/handoff/mikoshi.md'
const restart = (head = MAIN_2, cardId = CARD): string => taskKey({ queue: 'restart', cardId, head })

function restartBench() {
  const bench = mergeBench()
  const launches: { chain: ChainRow, dir: string }[] = []
  const raises: { role: Role, handoff: string }[] = []
  let holds = true
  const launcher = {
    holds: () => holds,
    launch: (chain: ChainRow, dir: string): number => {
      launches.push({ chain, dir })
      return NEW_PID
    },
  }
  const roles = {
    raise: (role: Role, handoff: string): number => {
      raises.push({ role, handoff })
      return ROLE_PIDS[role]
    },
  }
  const executor = new RestartExecutor({ db: bench.db, launcher, roles, clock: bench.clock.now })
  return {
    ...bench,
    launcher,
    launches,
    roles,
    raises,
    worker: (session = 'worker-1') => new RestartWorker({ db: bench.db, launcher, roles, clock: bench.clock.now, session }),
    holdNothing: () => {
      holds = false
    },
    observe: (chain: Partial<ChainObservation> = {}): void => {
      observeChain(bench.db, bench.clock.now().toISOString(), 'worker:chain:shift-1', { dir: DIR, parking: '/parking/lane-1', cardId: CARD, sha: MAIN_1, pid: 4242, boundary: true, state: 'running', ...chain })
    },
    stopRole: (stop: RoleStop): void => {
      observeRoleStop(bench.db, bench.clock.now().toISOString(), `worker:${stop.role}:7`, stop)
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
    bench.observe({ boundary: false })
    bench.advanceMain(['scripts/shift/bg.ts'])
    bench.tick()

    expect(bench.restart(bench.leaseRestart()!)).toEqual({ kind: 'waiting', taskKey: restart(), dir: DIR, why: 'not_at_boundary' })
    expect(bench.launches).toEqual([])
    expect(taskState(bench.db, restart())).toEqual({ state: 'queued', lease_gen: 1, failures: 0 })

    bench.observe({ boundary: true })
    bench.tick()
    const dir = `${DIR}-${MAIN_2.slice(0, 7)}`
    expect(bench.restart(bench.leaseRestart()!)).toEqual({ kind: 'restarted', taskKey: restart(), fromDir: DIR, dir, from: MAIN_1, to: MAIN_2, pid: NEW_PID })
    expect(bench.launches).toEqual([{ chain: expect.objectContaining({ dir: DIR, sha: MAIN_1, pid: 4242, parking: '/parking/lane-1' }), dir }])
    expect(eventsOf(bench.db, 'chain.restarted')).toEqual([{ from_dir: DIR, dir, from: MAIN_1, to: MAIN_2, pid: NEW_PID }])
    expect(taskState(bench.db, restart())).toEqual({ state: 'completed', lease_gen: 2, failures: 0 })

    bench.tick()
    expect(bench.db.prepare('SELECT dir, sha, pid, boundary FROM chains').all()).toEqual([{ dir, sha: MAIN_2, pid: NEW_PID, boundary: 0 }])
    expect(restartTasks(bench)).toEqual([{ task_key: restart(), state: 'completed' }])
    const live = projectionDump(bench.db)
    reduce(bench.db)
    expect(projectionDump(bench.db)).toBe(live)
    bench.close()
  })

  it('a checkout that does not hold the new main yet waits and starts nothing', () => {
    const bench = restartBench()
    bench.observe()
    bench.advanceMain(['scripts/shift/shift.ts'])
    bench.tick()
    bench.holdNothing()

    expect(bench.restart(bench.leaseRestart()!)).toMatchObject({ kind: 'waiting', why: 'checkout_behind' })
    expect(bench.launches).toEqual([])
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
    expect(bench.launches).toEqual([])
    bench.close()
  })

  it('a launch that fails is a technical denial and the task goes back to the queue', () => {
    const bench = restartBench()
    bench.observe()
    bench.advanceMain(['scripts/shift/shift.ts'])
    bench.tick()
    bench.launcher.launch = () => {
      throw new Error('shift:bg refused')
    }

    expect(bench.restart(bench.leaseRestart()!)).toMatchObject({ kind: 'denied', reason: 'launch_failed', next: 'queued' })
    expect(eventsOf(bench.db, 'policy.denied')).toMatchObject([{ command: 'restart', kind: 'technical', reason: 'launch_failed' }])
    expect(taskState(bench.db, restart())).toEqual({ state: 'queued', lease_gen: 1, failures: 1 })
    bench.close()
  })
})

describe('the chain producer', () => {
  async function chainOf(body: string, busPath: string, now: () => Date): Promise<World> {
    const world = newWorld([{ id: 1, body }])
    const observeChain = chainObserver({ busPath, sha: () => MAIN_1, pid: 4242, now, err: () => {} })
    await runShift([world.shift, '--parking', world.parking, '--chain'], depsOf(world, fakeGh({}).gh, captured(), { sleep: async () => {}, observeChain }))
    return world
  }

  it('a chain that stops at fault writes chain.observed and a restart task enters the queue', async () => {
    const bench = restartBench()
    const world = await chainOf('do 1 STUB-FAIL', bench.busPath, bench.clock.now)

    expect(eventsOf(bench.db, 'chain.observed').map(({ state, boundary }) => `${String(state)} ${String(boundary)}`)).toEqual(['running false', 'running true', 'fault true'])
    bench.tick()
    expect(restartTasks(bench)).toEqual([{ task_key: restart(MAIN_1, 1), state: 'queued' }])
    const dir = `${world.shift}-${MAIN_1.slice(0, 7)}`
    expect(bench.restart(bench.leaseRestart()!)).toEqual({ kind: 'restarted', taskKey: restart(MAIN_1, 1), fromDir: world.shift, dir, from: MAIN_1, to: MAIN_1, pid: NEW_PID })
    expect(bench.launches).toEqual([{ chain: expect.objectContaining({ dir: world.shift, parking: world.parking, state: 'fault' }), dir }])
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

describe('the restart worker', () => {
  it('takes the restart queue and is idle once it is empty', () => {
    const bench = restartBench()
    bench.observe()
    bench.advanceMain(['scripts/shift/shift.ts'])
    bench.tick()
    const worker = bench.worker()

    expect(worker.step()).toMatchObject({ kind: 'restarted', taskKey: restart() })
    expect(worker.step()).toEqual({ kind: 'idle' })
    bench.close()
  })

  it('ships switched off: without --on it opens nothing and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const bench = restartBench()
    expect(await runRestartWorker([], { busPath: '/nonexistent/bus.db', launcher: bench.launcher, roles: bench.roles, session: 'worker-1', pause: async () => {} })).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('switched off'))
    bench.close()
  })
})
