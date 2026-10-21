import type { BgResult, DetachedLaunch, ProcessList, RunningProcess } from '../../bus/bg.js'
import type { InForceDecision } from '../../bus/decisions.js'
import type { BusCode, MainAdvance, SupervisingParts } from '../../bus/supervisor.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { BUS_RUN_LAUNCH, launchName, PREFIX, runningInstance, startDetached } from '../../bus/bg.js'
import { RUNNING_CARD } from '../../bus/card-automaton.js'
import { appendEvent, openBus } from '../../bus/db.js'
import { ghApi } from '../../bus/github.js'
import { CARD_PROCESS, lastProcessBeats, recordHeartbeat, recordProcessHeartbeat, WINDOW_PROCESS } from '../../bus/heartbeat.js'
import { CARD_STARTED, RESTART_MISSED, RESTARTED } from '../../bus/inbox.js'
import { CARD_ADMITTED } from '../../bus/launch-candidates.js'
import { completeTask, drainOpen, leaseNext, leaseWhileFree, openDrain, StaleLease, TASK_EXPIRED } from '../../bus/lease.js'
import { LIVENESS_JUDGE, livenessSources, SILENT_MS } from '../../bus/liveness-sites.js'
import { Meter } from '../../bus/meter.js'
import { CHECK_MS } from '../../bus/netwatch.js'
import { reduce } from '../../bus/reducer.js'
import { reviewLaunch } from '../../bus/review-bg.js'
import { backoffMs, baselineAdvance, busDrain, BusSupervisor, DRAIN_LIMIT_MS, entryOf, expectedRunning, FAILURES_REPORTED, freeLeasesOf, JUDGE_ACTOR, JUDGED_HORIZON_MS, KEEP_MAX_MS, lastMainAdvance, LivenessJudge, mainAdvancedSince, outsideGroup, PROCESS_JUDGED, processName, recordRestartMissed, recordStarted, recordWorkerDown, RESTART_LIMIT_MS, RESTART_RETRY_MS, restartSilent, restartSilentSupervisor, startingBaseline, stillSilent, superviseUntilReplaced, SUPERVISOR_LAUNCH, SUPERVISOR_PROCESS, SUPERVISOR_SILENT_MS, WORKER_DOWN, WorkerKeeper } from '../../bus/supervisor.js'
import { recordWindowHeartbeat } from '../../bus/window-heartbeat.js'
import { busLaunches, switchWorker, wantedLaunches, workerLaunches } from '../../bus/workers.js'
import { GH_ATTEMPTS, GhBudgetWindow, ghPort } from '../../core/gh.js'

const NOT_CLEAN = 'replay byte-diff: the projection differs from a replay of the events'
const SHARED_FILE = 'scripts/bus/db.ts'
const SHARED_CODE: ReadonlySet<string> = new Set([SHARED_FILE])

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

  it('a GitHub error at a node start is technical and the supervisor loop goes on', () => {
    const spawned: number[] = []
    const hanging = ghPort({ spawn: () => {
      spawned.push(1)
      return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
    }, pause: () => {}, budget: new GhBudgetWindow({ calls: 100, windowMs: 1000 }, () => 0) })
    const review = reviewLaunch(() => {
      new Meter(ghApi('.', hanging), () => 0).get('repos/o/r/pulls?state=open')
      return []
    })
    const merge = workerLaunches(() => []).merge
    const s = kept([review, merge], (launch) => {
      launch.preflight?.()
      return ok(launch)
    })

    const lines = s.keeper.step()
    expect(spawned).toHaveLength(GH_ATTEMPTS)
    expect(s.starts).toEqual([launchName(review), launchName(merge)])
    expect(s.alive.map(process => process.args)).toEqual([`node pnpm.cjs --silent ${launchName(merge)}`])
    expect(lines.join('\n')).toContain(`${PREFIX}${launchName(review)} did not start, a technical failure: GitHub answered 599`)
    expect(lines.join('\n')).toContain(`${launchName(review)} failed to start 1 time(s) in a row; the next attempt in ${backoffMs(1) / 1000}s`)
    expect(lines.join('\n')).not.toContain('keeping the workers alive failed')

    s.clock.now = backoffMs(1)
    s.keeper.step()
    expect(s.starts).toEqual([launchName(review), launchName(merge), launchName(review)])
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

  it('a refused worker repaired by the reducer that then keeps running ends its episode, and a later refusal counts 1', () => {
    let shadow = [NOT_CLEAN]
    let reduceRepairs = true
    const review = reviewLaunch(() => shadow)
    const s = kept([review], preflighted, () => {
      if (reduceRepairs)
        shadow = []
      return []
    })

    for (let episode = 1; episode <= FAILURES_REPORTED; episode++) {
      s.alive = []
      shadow = [NOT_CLEAN]
      expect(s.keeper.step().join('\n')).not.toContain('needs the owner')
      for (let tick = 0; tick < 5; tick++)
        expect(s.keeper.step()).toEqual([])
      s.clock.now += 7 * 24 * 60 * 60_000
    }
    expect(s.reduces).toHaveLength(FAILURES_REPORTED)
    expect(s.journal).toEqual([])

    s.alive = []
    shadow = [NOT_CLEAN]
    reduceRepairs = false
    expect(s.keeper.step().at(-1)).toContain('failed to start 1 time(s) in a row')
  })

  it('a worker down past its backoff is retried and writes an event', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-down-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const review = workerLaunches(() => []).review
    const starts: number[] = []
    const lines: string[] = []
    const clock = { now: Date.parse('2026-10-20T19:40:00.000Z') }
    const keeper = new WorkerKeeper({
      wanted: () => [review],
      start: () => {
        starts.push(clock.now)
        return { stdout: [], stderr: [`${PREFIX}spawn failed`], exitCode: 1 }
      },
      processes: () => [],
      reduce: () => [],
      journal: () => {},
      down: down => recordWorkerDown(db, new Date(clock.now).toISOString(), down),
      now: () => clock.now,
    })
    const downRows = (): Record<string, unknown>[] => db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(WORKER_DOWN).map(row => JSON.parse(String(row.payload)) as Record<string, unknown>)
    const attempts = FAILURES_REPORTED + 3

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const before = starts.length
      lines.push(...keeper.step())
      expect(starts).toHaveLength(before + 1)
      expect(lines.filter(line => line.includes(`${launchName(review)} is switched on and not running; starting it`))).toHaveLength(attempt)
      clock.now += backoffMs(attempt) - 1
      expect(keeper.step()).toEqual([])
      expect(starts).toHaveLength(before + 1)
      clock.now += 1
    }

    const rows = downRows()
    expect(rows.map(row => row.failures)).toEqual(Array.from({ length: attempts - 1 }, (_, index) => index + 2))
    expect(rows.at(-1)).toEqual({ worker: launchName(review), failures: attempts, cause: `${PREFIX}spawn failed`, next_attempt_at: new Date(starts.at(-1)! + backoffMs(attempts)).toISOString() })
    db.close()
  })

  it('a worker.down that cannot be written leaves a line and does not stop the retries', () => {
    const merge = workerLaunches(() => []).merge
    const clock = { now: 0 }
    let starts = 0
    const keeper = new WorkerKeeper({
      wanted: () => [merge],
      start: () => {
        starts++
        return { stdout: [], stderr: [`${PREFIX}spawn failed`], exitCode: 1 }
      },
      processes: () => [],
      reduce: () => [],
      journal: () => {},
      down: () => {
        throw new Error('database is locked')
      },
      now: () => clock.now,
    })

    expect(keeper.step().join('\n')).not.toContain(WORKER_DOWN)
    clock.now += backoffMs(1)
    expect(keeper.step().at(-1)).toContain(`recording ${WORKER_DOWN} for ${launchName(merge)} failed: database is locked`)
    clock.now += backoffMs(2)
    keeper.step()
    expect(starts).toBe(3)
  })

  it('the backoff stops growing at its ceiling', () => {
    expect(backoffMs(100)).toBe(KEEP_MAX_MS)
  })
})

describe('the supervisor starts the launch node in the mode an owner decision allows', () => {
  it('the supervisor starts the launch node with --live under an owner decision in force naming the launch queue and in shadow without one', () => {
    const busDir = mkdtempSync(path.join(tmpdir(), 'supervisor-live-'))
    roots.push(busDir)
    switchWorker(busDir, 'launch', true)
    const argsOf = (decisions: InForceDecision[]): string[] => wantedLaunches(busDir, () => [], decisions).find(launch => launch.script === 'bus:launch')!.args

    expect(argsOf([])).not.toContain('--live')
    expect(argsOf([{ decisionId: 5, text: 'allow-live review', cards: [] }])).not.toContain('--live')
    expect(argsOf([{ decisionId: 74, text: 'allow-live launch', cards: [] }])).toContain('--live')
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
    changedSince: sha => sha === head ? [] : [SHARED_FILE],
    runs: () => SHARED_CODE,
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
          journal: () => {},
          now: () => 0,
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

  it('a worker restart frees the leases of the killed process at once with fencing', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-leases-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const killedAt = '2026-10-11T06:44:00.000Z'
    const killed = leaseWhileFree(db, killedAt, { queue: 'launch', cardId: 845, generation: 'g1' }, 'worker:launch:killed', 1)!
    const elsewhere = leaseWhileFree(db, killedAt, { queue: 'answer', cardId: 745 }, 'worker:answer:alive', 1)!
    const launch = workerLaunches(() => []).launch
    let alive: RunningProcess[] = [{ pid: 600, args: `node pnpm.cjs --silent ${launchName(launch)} --on` }]
    let aliveWhenFreed: RunningProcess[] | undefined
    const supervisor = new BusSupervisor({
      known: [launch],
      wanted: () => [launch],
      start: ok,
      stop: async (instance) => {
        alive = alive.filter(candidate => candidate.pid !== instance.pid)
      },
      freeLeases: (stopped) => {
        aliveWhenFreed = alive
        return freeLeasesOf(db, killedAt, stopped)
      },
      processes: () => alive,
      mainSince: () => [{ id: 1, sha: NEW_MAIN }],
      code: { head: () => NEW_MAIN, holds: () => true, pull: () => {}, changedSince: () => [SHARED_FILE], runs: () => SHARED_CODE },
      journal: () => {},
      now: () => 0,
    }, 0)

    const lines = await supervisor.step()

    expect(aliveWhenFreed).toEqual([])
    expect(lines.join('\n')).toContain(`freed the leases of the stopped workers at once as ${TASK_EXPIRED}: ${killed.taskKey}`)
    const expired = db.prepare('SELECT ts, actor, payload FROM events WHERE type = ?').all(TASK_EXPIRED).map(row => ({ ts: row.ts, actor: row.actor, payload: JSON.parse(String(row.payload)) as Record<string, unknown> }))
    expect(expired).toEqual([{ ts: killedAt, actor: 'policy', payload: expect.objectContaining({ task_key: killed.taskKey, lease_gen: killed.leaseGen, reason: 'holder_stopped', next: 'queued' }) }])
    const state = (key: string): unknown => db.prepare('SELECT state, lease_gen FROM tasks WHERE task_key = ?').get(key)
    expect(state(killed.taskKey)).toEqual({ state: 'queued', lease_gen: 1 })
    expect(state(elsewhere.taskKey)).toEqual({ state: 'leased', lease_gen: 1 })

    expect(() => completeTask(db, killedAt, killed, [])).toThrow(StaleLease)
    const fresh = leaseNext(db, killedAt, 'launch', 'worker:launch:fresh')!
    expect(fresh.leaseGen).toBe(killed.leaseGen + 1)
    expect(() => completeTask(db, killedAt, killed, [])).toThrow(StaleLease)
    completeTask(db, killedAt, fresh, [])
    expect(state(killed.taskKey)).toEqual({ state: 'completed', lease_gen: 2 })
    db.close()
  })

  const MERGED_AT = Date.parse('2026-10-19T15:00:00.000Z')

  function drainBench(clock: { now: number }, main = { sha: NEW_MAIN, id: 1 }, failStops = { left: 0 }): { db: ReturnType<typeof openBus>, lease: NonNullable<ReturnType<typeof leaseWhileFree>>, alive: () => RunningProcess[], supervisor: BusSupervisor, ts: () => string } {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-drain-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const ts = (): string => new Date(MERGED_AT + clock.now).toISOString()
    const lease = leaseWhileFree(db, ts(), { queue: 'answer', cardId: 1089, pr: 927, head: OLD_MAIN }, 'worker:answer:alive', 1)!
    const answer = workerLaunches(() => []).answer
    let alive: RunningProcess[] = [{ pid: 600, args: `node pnpm.cjs --silent ${launchName(answer)} --on` }]
    let head = OLD_MAIN
    const supervisor = new BusSupervisor({
      known: [answer],
      wanted: () => [answer],
      start: ok,
      stop: async (instance) => {
        if (failStops.left > 0) {
          failStops.left -= 1
          throw new Error('stop failed')
        }
        alive = alive.filter(candidate => candidate.pid !== instance.pid)
      },
      freeLeases: stopped => freeLeasesOf(db, ts(), stopped),
      drain: busDrain(db, ts),
      processes: () => alive,
      mainSince: () => [{ id: main.id, sha: main.sha }],
      code: {
        head: () => head,
        holds: sha => sha === head,
        pull: () => {
          head = main.sha
        },
        changedSince: sha => sha === head ? [] : [SHARED_FILE],
        runs: () => SHARED_CODE,
      },
      journal: () => {},
      missed: (sha, waitedMs) => recordRestartMissed(db, ts(), sha, waitedMs),
      now: () => MERGED_AT + clock.now,
    }, 0)
    return { db, lease, alive: () => alive, supervisor, ts }
  }

  const holderStopped = (db: ReturnType<typeof openBus>): unknown[] => db.prepare('SELECT payload FROM events WHERE type = ?').all(TASK_EXPIRED).map(row => JSON.parse(String(row.payload)) as Record<string, unknown>).filter(payload => payload.reason === 'holder_stopped')

  it('a merge under scripts/bus with an answer lease in flight frees no lease as holder_stopped and restarts once the lease completes', async () => {
    const clock = { now: 0 }
    const { db, lease, alive, supervisor, ts } = drainBench(clock)

    const waiting = (await supervisor.step()).join('\n')
    expect(waiting).toContain(`the restart onto ${NEW_MAIN} waits for the leases in flight to finish, and no worker takes a new one: ${lease.taskKey}`)
    expect(alive()).toHaveLength(1)
    expect(drainOpen(db, ts(), 'answer')).toBe(true)

    clock.now = 60_000
    expect((await supervisor.step()).join('\n')).not.toContain('restarting every running bus process')
    expect(alive()).toHaveLength(1)

    completeTask(db, ts(), lease, [])
    clock.now = 120_000
    expect((await supervisor.step()).join('\n')).toContain(`main advanced to ${NEW_MAIN} with a change to the code every bus process runs; restarting every running bus process on ${NEW_MAIN}`)
    expect(holderStopped(db)).toEqual([])
    db.close()
  })

  it('a lease still in flight after the drain limit is freed as holder_stopped and the restart names the wait', async () => {
    const clock = { now: 0 }
    const { db, lease, supervisor } = drainBench(clock)

    await supervisor.step()
    clock.now = DRAIN_LIMIT_MS - 1
    expect((await supervisor.step()).join('\n')).not.toContain('restarting every running bus process')
    expect(holderStopped(db)).toEqual([])

    clock.now = DRAIN_LIMIT_MS
    const lines = (await supervisor.step()).join('\n')
    expect(lines).toContain(`the leases in flight did not finish within ${DRAIN_LIMIT_MS / 60_000} min; restarting on ${NEW_MAIN} anyway, and these are freed as ${TASK_EXPIRED}: ${lease.taskKey}`)
    expect(lines).toContain('restarting every running bus process')
    expect(holderStopped(db)).toEqual([expect.objectContaining({ task_key: lease.taskKey, reason: 'holder_stopped' })])
    db.close()
  })

  it('a restart that fails after the drain limit is retried on the next tick, with no second wait and no reopened drain', async () => {
    const clock = { now: 0 }
    const failStops = { left: 1 }
    const { db, supervisor, ts } = drainBench(clock, { sha: NEW_MAIN, id: 1 }, failStops)

    await supervisor.step()
    clock.now = DRAIN_LIMIT_MS
    expect((await supervisor.step()).join('\n')).toContain('supervisor step failed: stop failed')
    expect(drainOpen(db, ts(), 'answer')).toBe(false)

    clock.now = DRAIN_LIMIT_MS + 60_000
    const lines = (await supervisor.step()).join('\n')
    expect(lines).not.toContain('waits for the leases in flight')
    expect(lines).toContain('restarting every running bus process')
    expect(db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get('leases.draining')).toEqual({ n: 1 })
    db.close()
  })

  it('a restart that keeps failing after the drain limit still reaches the missed-restart limit', async () => {
    const clock = { now: 0 }
    const { db, supervisor } = drainBench(clock, { sha: NEW_MAIN, id: 1 }, { left: Number.POSITIVE_INFINITY })
    const missedRows = (): unknown[] => db.prepare('SELECT payload FROM events WHERE type = ?').all(RESTART_MISSED)

    await supervisor.step()
    clock.now = DRAIN_LIMIT_MS
    expect((await supervisor.step()).join('\n')).toContain('supervisor step failed: stop failed')
    clock.now = DRAIN_LIMIT_MS + RESTART_LIMIT_MS - 1
    expect((await supervisor.step()).join('\n')).not.toContain(RESTART_MISSED)
    expect(missedRows()).toEqual([])

    clock.now = DRAIN_LIMIT_MS + RESTART_LIMIT_MS
    const lines = (await supervisor.step()).join('\n')
    expect(lines).toContain(`the restart onto ${NEW_MAIN} did not happen within ${RESTART_LIMIT_MS / 60_000} min`)
    expect(missedRows()).toHaveLength(1)
    db.close()
  })

  it('a drain reopened on the same sha with a later deadline is recorded and read, as a new supervisor after a failed restart opens it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-drain-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const at = (ms: number): string => new Date(MERGED_AT + ms).toISOString()

    openDrain(db, at(0), NEW_MAIN, at(DRAIN_LIMIT_MS), 'answer')
    expect(drainOpen(db, at(DRAIN_LIMIT_MS), 'answer')).toBe(false)

    openDrain(db, at(DRAIN_LIMIT_MS + 60_000), NEW_MAIN, at(2 * DRAIN_LIMIT_MS + 60_000), 'answer')
    expect(drainOpen(db, at(DRAIN_LIMIT_MS + 120_000), 'answer')).toBe(true)
    expect(db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get('leases.draining')).toEqual({ n: 2 })
    db.close()
  })

  it('a second merge under scripts/bus while the drain waits keeps the first deadline, so continuous merges do not postpone the restart', async () => {
    const clock = { now: 0 }
    const main = { sha: NEW_MAIN, id: 1 }
    const { db, lease, supervisor, ts } = drainBench(clock, main)

    await supervisor.step()
    clock.now = DRAIN_LIMIT_MS - 60_000
    main.sha = 'c'.repeat(40)
    main.id = 2
    expect((await supervisor.step()).join('\n')).toContain(`the restart onto ${main.sha} waits for the leases in flight to finish`)
    expect(drainOpen(db, ts(), 'answer')).toBe(true)

    clock.now = DRAIN_LIMIT_MS
    expect(drainOpen(db, ts(), 'answer')).toBe(false)
    const lines = (await supervisor.step()).join('\n')
    expect(lines).toContain(`restarting on ${main.sha} anyway, and these are freed as ${TASK_EXPIRED}: ${lease.taskKey}`)
    expect(lines).toContain('restarting every running bus process')
    db.close()
  })

  it('a change under node A restarts only A and the lease of B runs on', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-scoped-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const clock = { now: 0 }
    const ts = (): string => new Date(MERGED_AT + clock.now).toISOString()
    const leaseOfA = leaseWhileFree(db, ts(), { queue: 'answer', cardId: 1181, pr: 1001, head: OLD_MAIN }, 'worker:answer:alive', 1)!
    const leaseOfB = leaseWhileFree(db, ts(), { queue: 'close', cardId: 1182, pr: 1002, head: OLD_MAIN }, 'worker:close:alive', 1)!
    const { answer, close } = workerLaunches(() => [])
    let alive: RunningProcess[] = [{ pid: 604, args: `node pnpm.cjs --silent ${launchName(answer)}` }, { pid: 605, args: `node pnpm.cjs --silent ${launchName(close)}` }]
    const started: string[] = []
    let head = OLD_MAIN
    const runs = new Map([
      [entryOf(answer)!, new Set([entryOf(answer)!, SHARED_FILE])],
      [entryOf(close)!, new Set([entryOf(close)!, SHARED_FILE])],
      [entryOf(SUPERVISOR_LAUNCH)!, new Set([entryOf(SUPERVISOR_LAUNCH)!, SHARED_FILE])],
    ])
    const supervisor = new BusSupervisor({
      known: [answer, close],
      wanted: () => [answer, close],
      start: (launch) => {
        started.push(launchName(launch))
        alive = [...alive, { pid: 700 + started.length, args: `node pnpm.cjs --silent ${launchName(launch)}` }]
        return ok(launch)
      },
      stop: async (instance) => {
        alive = alive.filter(candidate => candidate.pid !== instance.pid)
      },
      freeLeases: stopped => freeLeasesOf(db, ts(), stopped),
      drain: busDrain(db, ts),
      processes: () => alive,
      mainSince: () => [{ id: 1, sha: NEW_MAIN }],
      code: {
        head: () => head,
        holds: sha => sha === head,
        pull: () => {
          head = NEW_MAIN
        },
        changedSince: sha => sha === head ? [] : [entryOf(answer)!],
        runs: entry => runs.get(entry) ?? new Set(),
      },
      journal: () => {},
      now: () => MERGED_AT + clock.now,
    }, 0)

    const waiting = (await supervisor.step()).join('\n')
    expect(waiting).toContain(`the restart onto ${NEW_MAIN} waits for the leases in flight to finish, and bus:answer take no new one: ${leaseOfA.taskKey}`)
    expect(drainOpen(db, ts(), 'answer')).toBe(true)
    expect(drainOpen(db, ts(), 'close')).toBe(false)

    completeTask(db, ts(), leaseOfA, [])
    clock.now = 60_000
    const lines = (await supervisor.step()).join('\n')

    expect(lines).toContain(`main advanced to ${NEW_MAIN} with a change to the code of bus:answer; restarting only those on ${NEW_MAIN}, and every other bus process runs on`)
    expect(started).toEqual([launchName(answer)])
    expect(alive.map(each => each.pid)).toEqual([605, 701])
    expect(supervisor.ownCodeBehind).toBeNull()
    expect(drainOpen(db, ts(), 'answer')).toBe(false)
    expect(db.prepare('SELECT state, lease_gen FROM tasks WHERE task_key = ?').get(leaseOfB.taskKey)).toEqual({ state: 'leased', lease_gen: leaseOfB.leaseGen })
    expect(holderStopped(db)).toEqual([])
    completeTask(db, ts(), leaseOfB, [])
    db.close()
  })

  it('a merge under scripts/bus restarts the workers and the supervisor', async () => {
    let head = OLD_MAIN
    const review = reviewLaunch(() => [])
    let alive: RunningProcess[] = [{ pid: 500, args: SUPERVISOR_ARGS }, { pid: 600, args: `node pnpm.cjs --silent ${launchName(review)}` }]
    const started: string[] = []
    const relaunched: number[] = []
    const events: MainAdvance[] = [{ id: 7, sha: NEW_MAIN }]
    const code: BusCode = {
      head: () => head,
      holds: sha => sha === head,
      pull: () => {
        head = NEW_MAIN
      },
      changedSince: sha => sha === head ? [] : [SHARED_FILE],
      runs: () => SHARED_CODE,
    }
    const lines: string[] = []

    const supervisor = new BusSupervisor({
      known: [review],
      wanted: () => [review],
      start: (launch) => {
        started.push(launchName(launch))
        return ok(launch)
      },
      stop: async (instance) => {
        alive = alive.filter(candidate => candidate.pid !== instance.pid)
      },
      processes: () => alive,
      mainSince: afterId => events.filter(event => event.id > afterId),
      code,
      journal: () => {},
      now: () => 0,
    }, baselineAdvance(events.at(-1), code))

    await superviseUntilReplaced({
      supervisor,
      keeper: new WorkerKeeper({ wanted: () => [], start: ok, processes: () => alive, reduce: () => [], journal: () => {}, now: () => 0 }),
      relaunch: () => {
        relaunched.push(500)
        return { stdout: ['501'], stderr: [], exitCode: 0 }
      },
      print: line => lines.push(line),
      pause: async () => {
        throw new Error('the supervisor did not restart on the first tick')
      },
    })

    expect(started).toEqual([launchName(review)])
    expect(relaunched).toEqual([500])
    expect(lines.join('\n')).toContain(`main advanced to ${NEW_MAIN} with a change to the code every bus process runs; restarting every running bus process on ${NEW_MAIN}`)
  })

  it('a restart that does not happen within the limit writes a bus event and a board line', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-missed-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const clock = { now: 0 }
    const supervisor = new BusSupervisor({
      known: [],
      wanted: () => [],
      start: ok,
      stop: async () => {},
      processes: () => [],
      mainSince: afterId => afterId < 1 ? [{ id: 1, sha: NEW_MAIN }] : [],
      code: { head: () => OLD_MAIN, holds: () => false, pull: () => {}, changedSince: () => [SHARED_FILE], runs: () => SHARED_CODE },
      journal: () => {},
      missed: (sha, waitedMs) => recordRestartMissed(db, '2026-10-18T10:00:00.000Z', sha, waitedMs),
      now: () => clock.now,
    }, 0)
    const missedRows = (): { payload: string }[] => db.prepare('SELECT payload FROM events WHERE type = ?').all(RESTART_MISSED) as { payload: string }[]

    expect((await supervisor.step()).join('\n')).toContain('the restart waits for it')
    clock.now = RESTART_LIMIT_MS - 1
    expect((await supervisor.step()).join('\n')).not.toContain(RESTART_MISSED)
    expect(missedRows()).toEqual([])

    clock.now = RESTART_LIMIT_MS
    const lines = await supervisor.step()
    expect(lines.join('\n')).toContain(`the restart onto ${NEW_MAIN} did not happen within 5 min`)
    expect(lines.join('\n')).toContain(RESTART_MISSED)
    expect(missedRows().map(row => JSON.parse(row.payload))).toEqual([{ sha: NEW_MAIN, waited_ms: RESTART_LIMIT_MS, limit_ms: RESTART_LIMIT_MS }])

    clock.now = RESTART_LIMIT_MS * 2
    expect((await supervisor.step()).join('\n')).not.toContain(RESTART_MISSED)
    expect(missedRows()).toHaveLength(1)
    db.close()
  })

  it('a wait that clears and starts again re-arms the limit and reports a second missed restart', async () => {
    const clock = { now: 0 }
    const events: MainAdvance[] = [{ id: 1, sha: NEW_MAIN }]
    const missed: string[] = []
    let holds = false
    const supervisor = new BusSupervisor({
      known: [],
      wanted: () => [],
      start: ok,
      stop: async () => {},
      processes: () => [],
      mainSince: afterId => events.filter(event => event.id > afterId),
      code: { head: () => OLD_MAIN, holds: () => holds, pull: () => {}, changedSince: () => [], runs: () => SHARED_CODE },
      journal: () => {},
      missed: sha => missed.push(sha),
      now: () => clock.now,
    }, 0)

    await supervisor.step()
    clock.now = RESTART_LIMIT_MS
    await supervisor.step()
    expect(missed).toEqual([NEW_MAIN])

    holds = true
    await supervisor.step()
    holds = false
    events.push({ id: 2, sha: NEW_MAIN })
    clock.now += 1
    await supervisor.step()
    expect(missed).toEqual([NEW_MAIN])

    clock.now += RESTART_LIMIT_MS
    await supervisor.step()
    expect(missed).toEqual([NEW_MAIN, NEW_MAIN])
  })

  it('a supervisor start writes supervisor.restarted with the head of its checkout, once per sha', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-started-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const head = 'c'.repeat(40)
    const code: BusCode = { head: () => head, holds: () => true, pull: () => {}, changedSince: () => [], runs: () => SHARED_CODE }
    const logged: string[] = []
    const rows = (): { dedupe_key: string, payload: string }[] => db.prepare('SELECT dedupe_key, payload FROM events WHERE type = ?').all(RESTARTED) as { dedupe_key: string, payload: string }[]

    recordStarted(db, '2026-10-18T10:00:00.000Z', code, line => logged.push(line))
    recordStarted(db, '2026-10-18T10:05:00.000Z', code, line => logged.push(line))

    expect(rows().map(row => ({ key: row.dedupe_key, payload: JSON.parse(row.payload) as unknown }))).toEqual([{ key: `${RESTARTED}:${head}`, payload: { sha: head } }])
    expect(logged).toEqual([])
    db.close()
  })

  it('a supervisor start whose write throws logs a line and does not crash', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-started-fail-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    db.close()
    const logged: string[] = []

    expect(() => recordStarted(db, '2026-10-18T10:00:00.000Z', { head: () => NEW_MAIN, holds: () => true, pull: () => {}, changedSince: () => [], runs: () => SHARED_CODE }, line => logged.push(line))).not.toThrow()

    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain(`recording ${RESTARTED} failed`)
  })

  it('a missed record that throws once is retried on the next step and not lost', async () => {
    const clock = { now: 0 }
    const missed: string[] = []
    let failing = true
    const supervisor = new BusSupervisor({
      known: [],
      wanted: () => [],
      start: ok,
      stop: async () => {},
      processes: () => [],
      mainSince: afterId => afterId < 1 ? [{ id: 1, sha: NEW_MAIN }] : [],
      code: { head: () => OLD_MAIN, holds: () => false, pull: () => {}, changedSince: () => [SHARED_FILE], runs: () => SHARED_CODE },
      journal: () => {},
      missed: (sha) => {
        if (failing)
          throw new Error('database is locked')
        missed.push(sha)
      },
      now: () => clock.now,
    }, 0)

    await supervisor.step()
    clock.now = RESTART_LIMIT_MS
    const failed = await supervisor.step()
    expect(failed.join('\n')).toContain('database is locked')
    expect(missed).toEqual([])

    failing = false
    const retried = await supervisor.step()
    expect(missed).toEqual([NEW_MAIN])
    expect(retried.join('\n')).toContain(RESTART_MISSED)
    await supervisor.step()
    expect(missed).toEqual([NEW_MAIN])
  })

  it('the replacement does not see its own supervisor as already running', () => {
    const own = [{ pid: 500, group: 500, args: SUPERVISOR_ARGS }, { pid: 501, group: 500, args: 'node tsx scripts/bus/supervisor.ts --supervise' }]
    const other = { pid: 700, group: 700, args: 'node pnpm.cjs --silent bus:run' }
    expect(runningInstance(outsideGroup([...own, other], 500), SUPERVISOR_LAUNCH.markers)).toBeUndefined()
    expect(outsideGroup([...own, other], 500)).toEqual([{ pid: 700, args: other.args }])
    expect(runningInstance(outsideGroup(own, 700), SUPERVISOR_LAUNCH.markers)?.pid).toBe(500)
  })
})

describe('the supervisor judges liveness from heartbeats alone', () => {
  const BEAT_AT = Date.parse('2026-10-21T00:00:00.000Z')
  const at = (ms: number): string => new Date(BEAT_AT + ms).toISOString()

  function judgedRows(db: ReturnType<typeof openBus>): { actor: string, payload: Record<string, unknown> }[] {
    return db.prepare('SELECT actor, payload FROM events WHERE type = ? ORDER BY id').all(PROCESS_JUDGED).map(row => ({ actor: String(row.actor), payload: JSON.parse(String(row.payload)) as Record<string, unknown> }))
  }

  const expecting = (...names: string[]): (() => (name: string) => boolean) => () => name => names.includes(name)

  it('a process without a heartbeat past SILENT_MS is judged silent by the supervisor alone', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-judge-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const clock = { now: BEAT_AT + SILENT_MS }
    recordProcessHeartbeat(db, at(0), 'bus:merge')
    recordProcessHeartbeat(db, at(SILENT_MS), 'netwatch')
    recordHeartbeat(db, at(0), { card: 1160, pr: null, head: null, step: 'launch', session: 's-1160', lease: null })
    recordWindowHeartbeat(db, at(SILENT_MS), 'w-1')
    expect(lastProcessBeats(db).map(beat => beat.process)).toEqual(['bus:merge', `${CARD_PROCESS}1160`, 'netwatch', `${WINDOW_PROCESS}w-1`])
    const restarted: string[] = []
    const judge = new LivenessJudge(db, () => clock.now, expecting('bus:merge', 'netwatch', `${CARD_PROCESS}1160`, SUPERVISOR_PROCESS), async (name) => {
      restarted.push(name)
      return []
    })

    expect(await judge.step()).toEqual([])
    expect(judgedRows(db)).toEqual([])

    clock.now += 1
    expect((await judge.step()).join('\n')).toContain(`bus:merge has not beaten for ${SILENT_MS / 60_000} min`)
    expect(judgedRows(db)).toEqual([
      { actor: JUDGE_ACTOR, payload: { process: 'bus:merge', verdict: 'silent', last_beat: at(0), silent_ms: SILENT_MS + 1, limit_ms: SILENT_MS } },
      { actor: JUDGE_ACTOR, payload: { process: `${CARD_PROCESS}1160`, verdict: 'silent', last_beat: at(0), silent_ms: SILENT_MS + 1, limit_ms: SILENT_MS } },
    ])
    expect(restarted).toEqual(['bus:merge', `${CARD_PROCESS}1160`])
    expect(await judge.step()).toEqual([])
    expect(judgedRows(db)).toHaveLength(2)
    expect(lastProcessBeats(db).find(beat => beat.process === SUPERVISOR_PROCESS)?.ts).toBe(at(SILENT_MS))

    const writers = [...livenessSources(path.resolve(import.meta.dirname, '..', '..', '..'))].filter(([, text]) => /type: (?:PROCESS_JUDGED|'process\.judged')/.test(text) || text.includes('recordJudged')).map(([file]) => file)
    expect(writers).toEqual([LIVENESS_JUDGE])
    db.close()
  })

  it('a process that finished cleanly is not judged: a card no longer running, a worker switched off, a window', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-judge-clean-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    recordProcessHeartbeat(db, at(0), 'bus:merge')
    recordHeartbeat(db, at(0), { card: 1170, pr: null, head: null, step: 'launch', session: 's-1170', lease: null })
    recordWindowHeartbeat(db, at(0), 'w-2')
    const judge = new LivenessJudge(db, () => BEAT_AT + 2 * SILENT_MS, () => expectedRunning(db, [workerLaunches(() => []).review]))

    expect(await judge.step()).toEqual([])
    expect(judgedRows(db)).toEqual([])
    db.close()
  })

  it('a wanted worker whose beat is older than SILENT_MS is judged through expectedRunning', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-judge-wanted-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const merge = workerLaunches(() => []).merge
    recordProcessHeartbeat(db, at(0), processName(merge))
    const judge = new LivenessJudge(db, () => BEAT_AT + SILENT_MS + 1, () => expectedRunning(db, [merge]))

    await judge.step()
    expect(judgedRows(db).map(row => row.payload.process)).toEqual([processName(merge)])
    db.close()
  })

  it('a running card whose session heartbeat is older than SILENT_MS is judged through expectedRunning', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-judge-card-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const cardId = 1160
    appendEvent(db, { ts: at(0), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { card: `#${cardId} part [implement/netwatch/S/cheap/auto] · depends — · blocks —`, lane: null, decision: 'auto', contour: 'cheap', depends: [] }, legacy: false })
    appendEvent(db, { ts: at(0), type: CARD_STARTED, actor: 'worker:launch:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:earlier-${cardId}`, payload: { session: `s-${cardId}`, worktree: root, branch: `feat/card-${cardId}`, base: 'f'.repeat(40), pid: 1, pgid: 1 }, legacy: false })
    reduce(db)
    expect(db.prepare('SELECT state FROM cards WHERE card_id = ?').get(cardId)).toEqual({ state: RUNNING_CARD })
    recordHeartbeat(db, at(0), { card: cardId, pr: null, head: null, step: 'launch', session: `s-${cardId}`, lease: null })
    const judge = new LivenessJudge(db, () => BEAT_AT + SILENT_MS + 1, () => expectedRunning(db, []))

    await judge.step()
    expect(judgedRows(db).map(row => row.payload.process)).toEqual([`${CARD_PROCESS}${cardId}`])
    db.close()
  })

  it('a process that beats again and falls silent a second time gets a second process.judged row', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-judge-twice-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const clock = { now: BEAT_AT + SILENT_MS + 1 }
    recordProcessHeartbeat(db, at(0), 'bus:merge')
    const judge = new LivenessJudge(db, () => clock.now, expecting('bus:merge'))

    await judge.step()
    const secondBeat = new Date(clock.now).toISOString()
    recordProcessHeartbeat(db, secondBeat, 'bus:merge')
    clock.now += SILENT_MS + 1
    await judge.step()

    expect(judgedRows(db).map(row => row.payload.last_beat)).toEqual([at(0), secondBeat])
    db.close()
  })

  it('a restart that fails is retried while the same beat stays silent, and stops once the worker beats again', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-judge-retry-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const clock = { now: BEAT_AT + SILENT_MS + 1 }
    recordProcessHeartbeat(db, at(0), 'bus:merge')
    const attempts: number[] = []
    const judge = new LivenessJudge(db, () => clock.now, expecting('bus:merge', SUPERVISOR_PROCESS), async () => {
      attempts.push(clock.now)
      throw new Error('spawn failed')
    })

    expect((await judge.step()).join('\n')).toContain('restarting bus:merge failed: spawn failed')
    clock.now += RESTART_RETRY_MS - 1
    expect(await judge.step()).toEqual([])
    clock.now += 1
    await judge.step()
    expect(attempts).toHaveLength(2)
    expect(judgedRows(db)).toHaveLength(1)

    recordProcessHeartbeat(db, new Date(clock.now).toISOString(), 'bus:merge')
    clock.now += RESTART_RETRY_MS
    expect(await judge.step()).toEqual([])
    expect(attempts).toHaveLength(2)
    db.close()
  })

  it('a process that beats again and falls silent again within RESTART_RETRY_MS is restarted at once', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-judge-again-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const clock = { now: BEAT_AT + SILENT_MS + 1 }
    recordProcessHeartbeat(db, at(0), 'bus:merge')
    const attempts: number[] = []
    const judge = new LivenessJudge(db, () => clock.now, expecting('bus:merge'), async () => {
      attempts.push(clock.now)
      return []
    })

    await judge.step()
    recordProcessHeartbeat(db, new Date(clock.now - SILENT_MS + 1).toISOString(), 'bus:merge')
    clock.now += 1
    expect(await judge.step()).toEqual([])
    clock.now += 2
    await judge.step()
    expect(attempts).toEqual([BEAT_AT + SILENT_MS + 1, BEAT_AT + SILENT_MS + 4])
    db.close()
  })

  it('a beat older than JUDGED_HORIZON_MS is no longer judged or restarted', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-judge-horizon-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    recordProcessHeartbeat(db, at(0), 'bus:merge')
    const restarted: string[] = []
    const judge = new LivenessJudge(db, () => BEAT_AT + JUDGED_HORIZON_MS + 1, expecting('bus:merge'), async (name) => {
      restarted.push(name)
      return []
    })

    expect(await judge.step()).toEqual([])
    expect(judgedRows(db)).toEqual([])
    expect(restarted).toEqual([])
    db.close()
  })

  it('the supervisor loop runs the liveness judge and prints its lines', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-judge-loop-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    recordProcessHeartbeat(db, at(0), 'bus:merge')
    const judge = new LivenessJudge(db, () => BEAT_AT + SILENT_MS + 1, expecting('bus:merge'), async name => [`${PREFIX}${name} restarted by the judge`])
    const m = machine()
    const parts = m.boot(500)
    let attempts = 0
    await superviseUntilReplaced({
      ...parts,
      judge,
      relaunch: () => ++attempts < 2 ? { stdout: [], stderr: [`${PREFIX}spawn failed`], exitCode: 1 } : parts.relaunch(),
    })
    expect(m.lines).toContain(`${PREFIX}bus:merge restarted by the judge`)
    db.close()
  })

  it('a gh that hangs past its timeout does not stop the supervisor loop', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-gh-hang-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const clock = { now: BEAT_AT }
    const hanging = ghPort({ spawn: (_command, _args, options) => {
      clock.now += options.timeoutMs
      return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
    }, pause: (ms) => {
      clock.now += ms
    }, budget: new GhBudgetWindow({ calls: 10_000, windowMs: 1000 }, () => clock.now) })
    const review = reviewLaunch(() => {
      new Meter(ghApi('.', hanging), () => clock.now).get('repos/o/r/pulls?state=open')
      return []
    })
    const starts: number[] = []
    const start = (launch: DetachedLaunch): BgResult => {
      starts.push(clock.now)
      launch.preflight?.()
      return ok(launch)
    }
    const supervisor = new BusSupervisor({ known: [review], wanted: () => [review], start, stop: async () => {}, processes: () => [], mainSince: () => [], code: { head: () => OLD_MAIN, holds: () => true, pull: () => {}, changedSince: () => [], runs: () => SHARED_CODE }, journal: () => {}, now: () => clock.now }, 0)
    const keeper = new WorkerKeeper({ wanted: () => [review], start, processes: () => [], reduce: () => [], journal: () => {}, now: () => clock.now })
    const lines: string[] = []
    const enough = new Error('enough ticks')
    let ticks = 0

    await expect(superviseUntilReplaced({
      supervisor,
      keeper,
      judge: new LivenessJudge(db, () => clock.now, expecting(SUPERVISOR_PROCESS)),
      relaunch: () => ({ stdout: [], stderr: [], exitCode: 1 }),
      print: line => lines.push(line),
      pause: async () => {
        if (++ticks >= 60)
          throw enough
        clock.now += CHECK_MS
      },
    })).rejects.toBe(enough)

    expect(starts.length).toBeGreaterThanOrEqual(3)
    expect(lines.join('\n')).toContain(`${launchName(review)} did not start, a technical failure: GitHub answered 599`)
    const beats = (db.prepare('SELECT ts FROM events WHERE type = ? ORDER BY id').all('process.heartbeat') as { ts: string }[]).map(row => Date.parse(row.ts))
    const marks = [BEAT_AT, ...beats, clock.now]
    const gaps = marks.slice(1).map((at, index) => at - marks[index]!)
    expect(clock.now - BEAT_AT).toBeGreaterThan(5 * SUPERVISOR_SILENT_MS)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(SUPERVISOR_SILENT_MS)
    expect(await restartSilentSupervisor({ db, now: () => clock.now, startedAt: () => null, processes: () => [{ pid: 500, args: SUPERVISOR_ARGS }], stop: async () => {} })).toEqual([])
    db.close()
  })

  it('no supervisor heartbeat for 2 min raises an alarm', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-heartbeat-alarm-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    recordProcessHeartbeat(db, at(0), SUPERVISOR_PROCESS)
    const stopped: number[] = []
    const watch = (nowMs: number, startedAt: number | null = null, processes: RunningProcess[] = [{ pid: 500, args: SUPERVISOR_ARGS }]): Promise<string[]> => restartSilentSupervisor({
      db,
      now: () => BEAT_AT + nowMs,
      startedAt: () => startedAt === null ? null : BEAT_AT + startedAt,
      processes: () => processes,
      stop: async (running) => {
        stopped.push(running.pid)
      },
    })

    expect(await watch(SUPERVISOR_SILENT_MS)).toEqual([])
    expect(await watch(SUPERVISOR_SILENT_MS + 1, 60_000)).toEqual([])
    expect(await watch(10 * SUPERVISOR_SILENT_MS, null, [])).toEqual([])
    expect(judgedRows(db)).toEqual([])
    expect(stopped).toEqual([])

    const lines = await watch(SUPERVISOR_SILENT_MS + 1)
    expect(lines.join('\n')).toContain(`the supervisor (pid 500) has not beaten for ${Math.round((SUPERVISOR_SILENT_MS + 1) / 1000)}s`)
    expect(judgedRows(db)).toEqual([{ actor: JUDGE_ACTOR, payload: { process: SUPERVISOR_PROCESS, verdict: 'silent', last_beat: at(0), silent_ms: SUPERVISOR_SILENT_MS + 1, limit_ms: SUPERVISOR_SILENT_MS } }])
    expect(stopped).toEqual([500])
    expect(stillSilent(db)).toEqual([{ process: SUPERVISOR_PROCESS, lastBeat: at(0) }])
    db.close()
  })

  it('a silent worker the supervisor wants is restarted by its own stop and start', async () => {
    const merge = workerLaunches(() => []).merge
    let alive: RunningProcess[] = [{ pid: 7, args: `node pnpm.cjs --silent ${launchName(merge)} --on` }]
    const stopped: number[] = []
    const lines = await restartSilent(processName(merge), [merge], {
      processes: () => alive,
      stop: async (running) => {
        stopped.push(running.pid)
        alive = []
      },
      start: ok,
    })
    expect(stopped).toEqual([7])
    expect(lines).toEqual([`${PREFIX}${processName(merge)} was judged silent; restarting it`, `${PREFIX}pnpm ${launchName(merge)}`])
    expect(await restartSilent(`${CARD_PROCESS}1160`, [merge], { processes: () => alive, stop: async () => {}, start: ok })).toEqual([])
  })
})

describe('the switch is a flag, and the supervisor moves each worker to it', () => {
  it('brings a worker to its flag within one tick', async () => {
    const busDir = mkdtempSync(path.join(tmpdir(), 'supervisor-flag-'))
    roots.push(busDir)
    switchWorker(busDir, 'merge', true)
    let alive: RunningProcess[] = [{ pid: 1, args: 'node pnpm.cjs --silent bus:run' }, { pid: 2, args: 'node pnpm.cjs --silent bus:update --on' }]
    const stopped: number[] = []
    const starts: string[] = []
    const start = (launch: DetachedLaunch): BgResult => {
      starts.push(launchName(launch))
      alive = [...alive, { pid: 3, args: `node pnpm.cjs --silent ${launchName(launch)}` }]
      return ok(launch)
    }
    const processes = (): RunningProcess[] => alive
    const wanted = (): DetachedLaunch[] => wantedLaunches(busDir, () => [])
    const code: BusCode = { head: () => 'a'.repeat(40), holds: () => true, pull: () => {}, changedSince: () => [], runs: () => SHARED_CODE }
    const supervisor = new BusSupervisor({
      known: busLaunches(() => []),
      wanted,
      start,
      stop: async (running) => {
        stopped.push(running.pid)
        alive = alive.filter(candidate => candidate.pid !== running.pid)
      },
      processes,
      mainSince: () => [],
      code,
      journal: () => {},
      now: () => 0,
    }, 0)
    const keeper = new WorkerKeeper({ wanted, start, processes, reduce: () => [], journal: () => {}, now: () => 0 })
    const lines: string[] = []
    const oneTick = new Error('one tick')

    await expect(superviseUntilReplaced({ supervisor, keeper, relaunch: () => ({ stdout: [], stderr: [], exitCode: 1 }), print: line => lines.push(line), pause: async () => {
      throw oneTick
    } })).rejects.toBe(oneTick)

    expect(stopped).toEqual([2])
    expect(starts).toEqual(['bus:merge --on'])
    expect(alive.map(candidate => candidate.args)).toEqual(['node pnpm.cjs --silent bus:run', 'node pnpm.cjs --silent bus:merge --on'])
    expect(lines).toContain(`${PREFIX}bus:update --on is switched off and was running as pid 2; stopped it`)
    expect(lines).toContain(`${PREFIX}bus:merge --on is switched on and not running; starting it`)
  })
})

describe('the main.advanced the supervisor starts from', () => {
  const held: BusCode = { head: () => OLD_MAIN, holds: () => true, pull: () => {}, changedSince: () => [], runs: () => SHARED_CODE }
  const unheld: BusCode = { ...held, holds: () => false }

  function advance(db: ReturnType<typeof openBus>, key: string, payload: Record<string, unknown>): void {
    appendEvent(db, { ts: '2026-10-18T10:00:00.000Z', type: 'main.advanced', actor: 'netwatch', cardId: null, pr: null, head: null, dedupeKey: key, payload, legacy: false })
  }

  it('baselineAdvance is 0 with no advance, the id when the checkout holds the sha, and the id before it when not', () => {
    const last = { id: 7, sha: NEW_MAIN }
    expect(baselineAdvance(undefined, held)).toBe(0)
    expect(baselineAdvance(last, held)).toBe(7)
    expect(baselineAdvance(last, unheld)).toBe(6)
  })

  it('a last main.advanced with no readable sha counts as seen, so no earlier one is replayed', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-baseline-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    expect(startingBaseline(db, held)).toBe(0)

    advance(db, 'main:1', { sha: OLD_MAIN })
    const readable = lastMainAdvance(db)
    expect(startingBaseline(db, held)).toBe(readable)
    expect(startingBaseline(db, unheld)).toBe(readable - 1)

    advance(db, 'main:2', { touches_mechanics: true })
    const unreadable = lastMainAdvance(db)
    expect(unreadable).toBeGreaterThan(readable)
    expect(startingBaseline(db, unheld)).toBe(unreadable)
    expect(mainAdvancedSince(db, startingBaseline(db, unheld))).toEqual([])
    db.close()
  })
})
