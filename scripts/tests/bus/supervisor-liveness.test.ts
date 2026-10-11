import type { BgResult, DetachedLaunch, RunningProcess } from '../../bus/bg.js'
import { describe, expect, it } from 'vitest'
import { BUS_RUN_LAUNCH, launchName, PREFIX } from '../../bus/bg.js'
import { CHECK_MS } from '../../bus/netwatch.js'
import { reviewLaunch } from '../../bus/review-bg.js'
import { backoffMs, FAILURES_REPORTED, KEEP_MAX_MS, WorkerKeeper } from '../../bus/supervisor.js'
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

function preflighted(launch: DetachedLaunch): BgResult {
  const problems = launch.preflight?.() ?? []
  return problems.length === 0 ? ok(launch) : { stdout: [], stderr: [`${launch.prefix}refused to start ${launch.script}:`, ...problems.map(problem => `  ${problem}`)], exitCode: 1 }
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
    const s = kept([review], preflighted, () => {
      shadow = []
      return ['[bus:reduce] bus.db: applied 12, rejected 0']
    })

    const lines = s.keeper.step()
    expect(s.reduces).toHaveLength(1)
    expect(s.starts).toEqual([launchName(review), launchName(review)])
    expect(s.alive).toHaveLength(1)
    expect(lines.join('\n')).toContain('refused by the projection preflight; running bus:reduce once')
    expect(lines).toContain('[bus:reduce] bus.db: applied 12, rejected 0')
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
    const s = kept([review], preflighted)

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

  it('the backoff stops growing at its ceiling', () => {
    expect(backoffMs(100)).toBe(KEEP_MAX_MS)
  })
})
