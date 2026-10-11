import type { BgResult, DetachedLaunch, ProcessList, RunningProcess } from '../../bus/bg.js'
import type { BusCode, MainAdvance, SupervisingParts } from '../../bus/supervisor.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { BUS_RUN_LAUNCH, launchName, PREFIX, runningInstance, startDetached } from '../../bus/bg.js'
import { CHECK_MS } from '../../bus/netwatch.js'
import { reviewLaunch } from '../../bus/review-bg.js'
import { backoffMs, BusSupervisor, FAILURES_REPORTED, KEEP_MAX_MS, outsideGroup, superviseUntilReplaced, SUPERVISOR_LAUNCH, WorkerKeeper } from '../../bus/supervisor.js'
import { workerLaunches } from '../../bus/workers.js'

const NOT_CLEAN = 'replay byte-diff: the projection differs from a replay of the events'

interface Kept {
  keeper: WorkerKeeper
  alive: RunningProcess[]
  starts: string[]
  reduces: number[]
  journal: Record<string, unknown>[]
  clock: { now: number }
}

function kept(wanted: DetachedLaunch[], start: (launch: DetachedLaunch, kept: Kept) => BgResult, reduce: () => string[] = () => []): Kept {
  const state: Kept = { keeper: undefined as unknown as WorkerKeeper, alive: [], starts: [], reduces: [], journal: [], clock: { now: 0 } }
  let pid = 1000
  state.keeper = new WorkerKeeper({
    wanted: () => wanted,
    start: (launch) => {
      state.starts.push(launchName(launch))
      const started = start(launch, state)
      if (started.exitCode === 0)
        state.alive.push({ pid: ++pid, args: `node pnpm.cjs --silent ${launchName(launch)}` })
      return started
    },
    processes: () => state.alive,
    reduce: () => {
      state.reduces.push(state.clock.now)
      return reduce()
    },
    journal: entry => state.journal.push(entry),
    now: () => state.clock.now,
  })
  return state
}

const ok = (launch: DetachedLaunch): BgResult => ({ stdout: [`${PREFIX}pnpm ${launchName(launch)}`], stderr: [], exitCode: 0 })

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function startedForReal(processes: ProcessList): (launch: DetachedLaunch) => BgResult {
  const busDir = mkdtempSync(path.join(tmpdir(), 'supervisor-liveness-'))
  roots.push(busDir)
  return launch => startDetached(launch, busDir, process.env, processes)
}

describe('the supervisor keeps every switched-on worker alive', () => {
  it('a killed worker comes back without the owner', () => {
    const merge = workerLaunches(() => []).merge
    const s = kept([BUS_RUN_LAUNCH, merge], ok)
    s.alive.push({ pid: 1, args: 'node pnpm.cjs --silent bus:run' }, { pid: 2, args: 'node pnpm.cjs --silent bus:merge --on' })
    expect(s.keeper.step()).toEqual([])

    s.alive = s.alive.filter(process => process.pid !== 2)
    const lines = s.keeper.step()
    expect(s.starts).toEqual([launchName(merge)])
    expect(lines.join('\n')).toContain(`${launchName(merge)} is switched on and not running; starting it`)

    expect(s.keeper.step()).toEqual([])
    expect(s.starts).toEqual([launchName(merge)])
    expect(s.reduces).toEqual([])
    expect(s.journal).toEqual([])
  })

  it('a start that fails is retried after an exponential backoff, and a success resets the count', () => {
    const update = workerLaunches(() => []).update
    let failing = 2
    const s = kept([update], launch => failing-- > 0 ? { stdout: [], stderr: [`${PREFIX}spawn failed`], exitCode: 1 } : ok(launch))

    expect(s.keeper.step().at(-1)).toContain(`failed to start 1 time(s) in a row; the next attempt in ${backoffMs(1) / 1000}s`)
    s.clock.now = backoffMs(1) - 1
    expect(s.keeper.step()).toEqual([])
    s.clock.now = backoffMs(1)
    expect(s.keeper.step().at(-1)).toContain(`failed to start 2 time(s) in a row; the next attempt in ${backoffMs(2) / 1000}s`)
    expect(backoffMs(2)).toBe(2 * backoffMs(1))
    expect(backoffMs(3)).toBe(4 * backoffMs(1))
    s.clock.now += backoffMs(2)
    s.keeper.step()
    expect(s.starts).toHaveLength(3)
    expect(s.alive).toHaveLength(1)
    expect(s.keeper.step()).toEqual([])

    s.alive = []
    failing = 1
    s.keeper.step()
    expect(s.starts).toHaveLength(4)
    s.clock.now += backoffMs(1)
    s.keeper.step()
    expect(s.starts).toHaveLength(5)
    expect(s.journal).toEqual([])
  })

  it('a worker seen running again resets the count, though the keeper did not start it', () => {
    const merge = workerLaunches(() => []).merge
    const s = kept([merge], () => ({ stdout: [], stderr: [`${PREFIX}spawn failed`], exitCode: 1 }))

    s.keeper.step()
    s.clock.now += backoffMs(1)
    s.keeper.step()
    s.clock.now += backoffMs(2)
    s.alive.push({ pid: 1, args: 'node pnpm.cjs --silent bus:merge --on' })
    expect(s.keeper.step()).toEqual([])

    s.clock.now += 60 * 60_000
    s.alive = []
    const lines = s.keeper.step()
    expect(lines.at(-1)).toContain(`failed to start 1 time(s) in a row; the next attempt in ${backoffMs(1) / 1000}s`)
    expect(lines.join('\n')).not.toContain('needs the owner')
    expect(s.journal).toEqual([])
  })

  it('a worker switched off and on again starts at once with a fresh count', () => {
    const merge = workerLaunches(() => []).merge
    const wanted = [merge]
    let failing = false
    const s = kept(wanted, launch => failing ? { stdout: [], stderr: [`${PREFIX}spawn failed`], exitCode: 1 } : ok(launch))

    s.keeper.step()
    expect(s.starts).toEqual([launchName(merge)])
    s.alive = []
    wanted.length = 0
    expect(s.keeper.step()).toEqual([])

    s.clock.now = 60 * 60_000
    wanted.push(merge)
    const lines = s.keeper.step()
    expect(s.starts).toEqual([launchName(merge), launchName(merge)])
    expect(lines.join('\n')).not.toContain('failed to start')
    expect(s.keeper.step()).toEqual([])

    s.alive = []
    failing = true
    const reports: string[] = []
    for (let attempt = 1; attempt <= FAILURES_REPORTED; attempt++) {
      reports.push(...s.keeper.step())
      s.clock.now += backoffMs(attempt)
    }
    expect(s.starts).toHaveLength(2 + FAILURES_REPORTED)
    expect(s.journal).toHaveLength(1)
    expect(s.journal[0]).toMatchObject({ event: 'worker.down', worker: launchName(merge) })
    expect(reports.filter(line => line.includes('needs the owner'))).toHaveLength(1)
  })

  it('a start that finds the worker already running counts as a success', () => {
    const merge = workerLaunches(() => []).merge
    const running = { pid: 7, args: 'node pnpm.cjs --silent bus:merge --on' }
    const s = kept([merge], () => ({ stdout: [], stderr: [`${PREFIX}bus:merge is already running as pid 7 (${running.args}); nothing started`], exitCode: 1, alreadyRunning: running }))

    for (let attempt = 1; attempt <= FAILURES_REPORTED; attempt++)
      expect(s.keeper.step().join('\n')).not.toContain('failed to start')
    expect(s.starts).toHaveLength(FAILURES_REPORTED)
    expect(s.journal).toEqual([])
  })

  it('a start refused by the projection preflight runs the reducer and comes back', () => {
    let shadow = [NOT_CLEAN]
    const review = reviewLaunch(() => shadow)
    const startedAfterReduce = { pid: 7, args: `node pnpm.cjs --silent ${launchName(review)}` }
    const s = kept([review], startedForReal(() => shadow.length === 0 ? [startedAfterReduce] : []), () => {
      shadow = []
      return ['[bus:reduce] bus.db: applied 12, rejected 0']
    })

    const lines = s.keeper.step()
    expect(s.reduces).toHaveLength(1)
    expect(s.starts).toEqual([launchName(review), launchName(review)])
    expect(lines.join('\n')).toContain('refused by the projection preflight; running bus:reduce once')
    expect(lines).toContain('[bus:reduce] bus.db: applied 12, rejected 0')
    expect(lines.join('\n')).toContain(`is already running as pid ${startedAfterReduce.pid}`)
    expect(lines.join('\n')).not.toContain('failed to start')
    expect(s.journal).toEqual([])
  })

  it('a refusal that is not the preflight does not run the reducer', () => {
    const merge = workerLaunches(() => []).merge
    const s = kept([merge], () => ({ stdout: [], stderr: [`${PREFIX}another start (pid 7) is starting bus:merge; nothing started`], exitCode: 1 }))
    s.keeper.step()
    expect(s.reduces).toEqual([])
    expect(s.starts).toHaveLength(1)
  })

  it('three failed starts in a row write a journal line and a report', () => {
    const review = reviewLaunch(() => [NOT_CLEAN])
    const s = kept([review], startedForReal(() => []))

    const reports: string[][] = []
    for (let attempt = 1; attempt <= FAILURES_REPORTED + 1; attempt++) {
      reports.push(s.keeper.step())
      s.clock.now += backoffMs(attempt)
    }

    expect(s.reduces).toHaveLength(FAILURES_REPORTED + 1)
    expect(s.starts).toHaveLength(2 * (FAILURES_REPORTED + 1))
    expect(s.journal).toHaveLength(1)
    expect(s.journal[0]).toMatchObject({ event: 'worker.down', worker: launchName(review) })
    const failures = s.journal[0]!.failures as string[]
    expect(failures).toHaveLength(FAILURES_REPORTED)
    for (const failure of failures)
      expect(failure).toContain(NOT_CLEAN)

    expect(reports[FAILURES_REPORTED - 2]!.join('\n')).not.toContain('needs the owner')
    const report = reports[FAILURES_REPORTED - 1]!.at(-1)!
    expect(report).toContain(`${launchName(review)} failed ${FAILURES_REPORTED} starts in a row and needs the owner`)
    expect(report).toContain(NOT_CLEAN)
    expect(report).toContain('keeps backing off')
    expect(reports[FAILURES_REPORTED]!.at(-1)).toContain(`failed to start ${FAILURES_REPORTED + 1} time(s) in a row`)
  })

  it('a worker that dies right after its start backs off and reaches the owner after three starts', () => {
    const merge = workerLaunches(() => []).merge
    const s = kept([merge], ok)
    const startedAt: number[] = []
    const reports: string[] = []
    for (let tick = 0; tick < 120; tick++) {
      s.clock.now = tick * CHECK_MS
      const before = s.starts.length
      reports.push(...s.keeper.step())
      if (s.starts.length > before)
        startedAt.push(s.clock.now)
      s.alive = []
    }

    const gaps = startedAt.slice(1).map((at, index) => at - startedAt[index]!)
    expect(gaps.length).toBeGreaterThanOrEqual(FAILURES_REPORTED)
    for (let index = 1; index < gaps.length; index++)
      expect(gaps[index]!).toBeGreaterThan(gaps[index - 1]!)
    expect(s.starts.length).toBeLessThan(20)

    expect(s.journal).toHaveLength(1)
    expect(s.journal[0]).toMatchObject({ event: 'worker.down', worker: launchName(merge), failures: ['exited after start', 'exited after start', 'exited after start'] })
    const owner = reports.filter(line => line.includes('needs the owner'))
    expect(owner).toHaveLength(1)
    expect(owner[0]).toContain(`${launchName(merge)} failed ${FAILURES_REPORTED} starts in a row and needs the owner: 1) exited after start`)
  })

  it('three preflight refusals of one worker in a row raise worker.down although a start succeeded between them', () => {
    let shadow = [NOT_CLEAN]
    let reduceRepairs = false
    const review = reviewLaunch(() => shadow)
    const s = kept([review], preflighted, () => {
      if (reduceRepairs)
        shadow = []
      return []
    })

    expect(s.keeper.step().at(-1)).toContain('failed to start 1 time(s) in a row')
    s.clock.now += backoffMs(1)
    reduceRepairs = true
    expect(s.keeper.step().join('\n')).not.toContain('needs the owner')
    expect(s.alive).toHaveLength(1)
    expect(s.keeper.step()).toEqual([])

    s.alive = []
    shadow = [NOT_CLEAN]
    reduceRepairs = false
    const lines = s.keeper.step()
    expect(s.reduces).toHaveLength(FAILURES_REPORTED)
    expect(s.journal).toHaveLength(1)
    expect(s.journal[0]).toMatchObject({ event: 'worker.down', worker: launchName(review) })
    expect(lines.at(-1)).toContain(`${launchName(review)} failed ${FAILURES_REPORTED} starts in a row and needs the owner`)
  })

  it('the backoff stops growing at its ceiling', () => {
    expect(backoffMs(100)).toBe(KEEP_MAX_MS)
  })
})

function preflighted(launch: DetachedLaunch): BgResult {
  const problems = launch.preflight?.() ?? []
  return problems.length > 0 ? { stdout: [], stderr: [`${launch.prefix}refused to start ${launch.script}:`, ...problems.map(problem => `  ${problem}`)], exitCode: 1 } : ok(launch)
}

const OLD_MAIN = 'a'.repeat(40)
const NEW_MAIN = 'b'.repeat(40)
const SUPERVISOR_ARGS = 'node pnpm.cjs --silent bus:bg --supervise'
const PAUSES_ALLOWED = 10

interface Machine {
  alive: RunningProcess[]
  events: MainAdvance[]
  boots: { pid: number, head: string }[]
  reduces: string[]
  lines: string[]
  projection: string
  boot: (pid: number) => SupervisingParts
  merge: () => void
}

function machine(): Machine {
  let head = OLD_MAIN
  let pid = 500
  let pauses = 0
  const code: BusCode = {
    head: () => head,
    holds: sha => sha === head,
    pull: () => {
      head = NEW_MAIN
    },
    busChangedSince: sha => sha !== head,
  }
  const m: Machine = {
    alive: [{ pid, args: SUPERVISOR_ARGS }, { pid: 600, args: `node pnpm.cjs --silent ${launchName(reviewLaunch(() => []))}` }],
    events: [],
    boots: [],
    reduces: [],
    lines: [],
    projection: OLD_MAIN,
    merge: () => {
      m.events.push({ id: m.events.length + 1, sha: NEW_MAIN })
      m.projection = 'torn by the new workers'
    },
    boot: (self) => {
      const bootedOn = head
      m.boots.push({ pid: self, head: bootedOn })
      const review = reviewLaunch(() => m.projection === bootedOn ? [] : [NOT_CLEAN])
      const start = (launch: DetachedLaunch): BgResult => {
        const started = preflighted(launch)
        if (started.exitCode === 0)
          m.alive.push({ pid: ++pid + 100, args: `node pnpm.cjs --silent ${launchName(launch)}` })
        return started
      }
      return {
        supervisor: new BusSupervisor({
          known: [review],
          wanted: () => [review],
          start,
          stop: async (instance) => {
            m.alive = m.alive.filter(candidate => candidate.pid !== instance.pid)
          },
          processes: () => m.alive,
          mainSince: afterId => m.events.filter(event => event.id > afterId),
          code,
        }, m.events.at(-1)?.id ?? 0),
        keeper: new WorkerKeeper({
          wanted: () => [review],
          start,
          processes: () => m.alive,
          reduce: () => {
            m.reduces.push(bootedOn)
            m.projection = bootedOn
            return []
          },
          journal: () => {},
          now: () => 0,
        }),
        relaunch: () => {
          const fresh = ++pid
          m.alive.push({ pid: fresh, args: SUPERVISOR_ARGS })
          return { stdout: [String(fresh)], stderr: [], exitCode: 0 }
        },
        print: line => m.lines.push(line),
        pause: async () => {
          if (++pauses > PAUSES_ALLOWED)
            throw new Error(`the supervisor booted as pid ${self} is still running after ${PAUSES_ALLOWED} ticks`)
          if (pauses === 1)
            m.merge()
        },
      }
    },
  }
  return m
}

async function runUntilReplaced(m: Machine, self: number): Promise<void> {
  await superviseUntilReplaced(m.boot(self))
  m.alive = m.alive.filter(candidate => candidate.pid !== self)
}

function supervisors(m: Machine): number[] {
  return m.alive.filter(candidate => candidate.args === SUPERVISOR_ARGS).map(candidate => candidate.pid)
}

describe('the supervisor restarts itself after a merge under scripts/bus', () => {
  it('after a merge under scripts/bus the supervisor restarts itself on the new main without a hand kill', async () => {
    const m = machine()
    await runUntilReplaced(m, 500)

    const [fresh] = supervisors(m)
    expect(supervisors(m)).toEqual([fresh])
    expect(fresh).not.toBe(500)
    expect(m.lines.join('\n')).toContain(`a fresh supervisor runs on ${NEW_MAIN} and this one exits`)

    m.boot(fresh!)
    expect(m.boots.map(boot => boot.head)).toEqual([OLD_MAIN, NEW_MAIN])
  })

  it('after a merge under scripts/bus the restarted supervisor reduces with the new reducer', async () => {
    const m = machine()
    await runUntilReplaced(m, 500)
    expect(m.reduces).toEqual([])

    const fresh = m.boot(supervisors(m)[0]!)
    expect(await fresh.supervisor.step()).toEqual([])
    fresh.keeper.step()
    expect(m.reduces).toEqual([NEW_MAIN])
    expect(m.alive.some(candidate => candidate.args.includes(launchName(reviewLaunch(() => []))))).toBe(true)
  })

  it('a supervisor that cannot start its replacement keeps running and tries again on the next tick', async () => {
    const m = machine()
    const parts = m.boot(500)
    let attempts = 0
    await superviseUntilReplaced({
      ...parts,
      relaunch: () => ++attempts < 2 ? { stdout: [], stderr: [`${PREFIX}spawn failed`], exitCode: 1 } : parts.relaunch(),
    })
    expect(attempts).toBe(2)
    expect(m.lines.join('\n')).toContain(`could not start a fresh supervisor on ${NEW_MAIN}`)
  })

  it('the replacement does not see its own supervisor as already running', () => {
    const own = [{ pid: 500, group: 500, args: SUPERVISOR_ARGS }, { pid: 501, group: 500, args: 'node tsx scripts/bus/supervisor.ts --supervise' }]
    const other = { pid: 700, group: 700, args: 'node pnpm.cjs --silent bus:run' }
    expect(runningInstance(outsideGroup([...own, other], 500), SUPERVISOR_LAUNCH.markers)).toBeUndefined()
    expect(outsideGroup([...own, other], 500)).toEqual([{ pid: 700, args: other.args }])
    expect(runningInstance(outsideGroup(own, 700), SUPERVISOR_LAUNCH.markers)?.pid).toBe(500)
  })
})
