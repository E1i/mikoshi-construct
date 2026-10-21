import type { DatabaseSync } from 'node:sqlite'
import type { BgResult, DetachedLaunch, RunningProcess } from '../../bus/bg.js'
import type { BusCode } from '../../bus/supervisor.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { launchName } from '../../bus/bg.js'
import { appendEvent, openBus } from '../../bus/db.js'
import { completeTask, drainOpen, leaseWhileFree } from '../../bus/lease.js'
import { reviewLaunch } from '../../bus/review-bg.js'
import { touchesMechanics } from '../../bus/snapshot.js'
import { busDrain, BusSupervisor, entryOf, freeLeasesOf, gitCode, importClosure, LOCAL_MAIN_REF, mainAdvancedSince, SUPERVISOR_LAUNCH } from '../../bus/supervisor.js'
import { busLaunches, workerLaunches } from '../../bus/workers.js'
import { TASK_EXPIRED } from '../../core/events.js'

const OLD_MAIN = 'a'.repeat(40)
const NEW_MAIN = 'b'.repeat(40)
const SHARED_FILE = 'scripts/bus/db.ts'

describe('the supervisor follows the local main ref', () => {
  it('a moved local main ref restarts the bus with no GitHub call', async () => {
    let checkout = OLD_MAIN
    const review = reviewLaunch(() => [])
    let alive: RunningProcess[] = [{ pid: 600, args: `node pnpm.cjs --silent ${launchName(review)}` }]
    const started: string[] = []
    const stopped: number[] = []
    const mainAdvancedReads: number[] = []
    const code: BusCode = {
      head: () => checkout,
      holds: sha => sha === checkout,
      pull: () => {
        throw new Error('the checkout already holds the local main; no pull is needed')
      },
      changedSince: sha => sha === checkout ? [] : [SHARED_FILE],
      runs: () => new Set([SHARED_FILE]),
      localMain: () => checkout,
    }
    const supervisor = new BusSupervisor({
      known: [review],
      wanted: () => [review],
      start: (launch: DetachedLaunch): BgResult => {
        started.push(launchName(launch))
        alive = [...alive, { pid: 700, args: `node pnpm.cjs --silent ${launchName(launch)}` }]
        return { stdout: [], stderr: [], exitCode: 0 }
      },
      stop: async (instance) => {
        stopped.push(instance.pid)
        alive = alive.filter(candidate => candidate.pid !== instance.pid)
      },
      processes: () => alive,
      mainSince: (afterId) => {
        mainAdvancedReads.push(afterId)
        return []
      },
      code,
      journal: () => {},
      now: () => 0,
    }, 0)

    expect(await supervisor.step()).toEqual([])
    expect(supervisor.ownCodeBehind).toBeNull()

    checkout = NEW_MAIN
    const lines = await supervisor.step()

    expect(lines.join('\n')).toContain(`the local ${LOCAL_MAIN_REF} moved to ${NEW_MAIN} with no main.advanced on the bus`)
    expect(lines.join('\n')).toContain(`restarting every running bus process on ${NEW_MAIN}`)
    expect(stopped).toEqual([600])
    expect(started).toEqual([launchName(review)])
    expect(supervisor.ownCodeBehind).toBe(NEW_MAIN)
    expect(mainAdvancedReads).toEqual([0, 0])

    expect(await supervisor.step()).toEqual([])
    expect(started).toEqual([launchName(review)])
  })

  it('a local main ref that cannot be read leaves the supervisor on main.advanced alone', async () => {
    const review = reviewLaunch(() => [])
    const supervisor = new BusSupervisor({
      known: [review],
      wanted: () => [review],
      start: () => ({ stdout: [], stderr: [], exitCode: 0 }),
      stop: async () => {},
      processes: () => [],
      mainSince: () => [],
      code: { head: () => OLD_MAIN, holds: () => true, pull: () => {}, changedSince: () => [SHARED_FILE], runs: () => new Set([SHARED_FILE]), localMain: () => null },
      journal: () => {},
      now: () => 0,
    }, 0)

    expect(await supervisor.step()).toEqual([])
    expect(supervisor.ownCodeBehind).toBeNull()
  })
})

describe('the code a bus process runs', () => {
  const repoRoot = path.join(import.meta.dirname, '..', '..', '..')
  const code = gitCode(repoRoot)
  const runsOf = (launch: DetachedLaunch): ReadonlySet<string> => code.runs(entryOf(launch)!)

  it('every launch the supervisor knows, and the supervisor itself, names an entry its checkout holds', () => {
    for (const launch of [...busLaunches(() => []), SUPERVISOR_LAUNCH])
      expect(runsOf(launch).has(entryOf(launch)!)).toBe(true)
  })

  it('the shared bus code is in the code of every node, and one node\'s worker is not in another\'s', () => {
    const { answer, close } = workerLaunches(() => [])
    for (const launch of [...busLaunches(() => []), SUPERVISOR_LAUNCH]) {
      for (const shared of ['scripts/bus/db.ts', 'scripts/bus/node.ts', 'scripts/bus/lease.ts', 'scripts/bus/queue.ts', 'scripts/bus/reducer.ts'])
        expect(runsOf(launch)).toContain(shared)
    }
    for (const launch of Object.values(workerLaunches(() => [])))
      expect(runsOf(launch)).toContain('scripts/bus/node.ts')
    expect(runsOf(close)).not.toContain(entryOf(answer))
    expect(runsOf(answer)).not.toContain(entryOf(close))
  })

  it('an import closure follows import, export-from and side-effect imports across lines and directories', () => {
    const files: Record<string, string> = {
      'a/entry.ts': `import type { T } from './types.js'\nimport {\n  b,\n} from './b.js'\nexport * from '../c/c.js'\nimport './side.js'\nimport fs from 'node:fs'\n`,
      'a/types.ts': '',
      'a/b.ts': `export const b = 'from here'\n`,
      'c/c.ts': `import data from './data.json'\n`,
      'c/data.json': '{}',
      'a/side.ts': '',
      'a/unreached.ts': '',
    }
    expect([...importClosure('a/entry.ts', file => files[file] ?? null)].sort()).toEqual(['a/b.ts', 'a/entry.ts', 'a/side.ts', 'a/types.ts', 'c/c.ts', 'c/data.json'])
  })
})

describe('a drain follows touches_mechanics, and only the nodes whose mechanics changed drain', () => {
  const repoRoot = path.join(import.meta.dirname, '..', '..', '..')
  const EVERY_NODE_RUNS = 'scripts/miko/eddies-measure.ts'
  const ANSWER_MECHANICS = 'scripts/shift/answer-only.ts'
  const MERGED_AT = Date.parse('2026-10-21T18:14:32.000Z')
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true })
  })

  interface Bench {
    db: DatabaseSync
    clock: { now: number }
    ts: () => string
    alive: () => RunningProcess[]
    started: string[]
    supervisor: BusSupervisor
  }

  function bench(changed: string, runs: (entry: string) => ReadonlySet<string>, touchesMechanicsFlag: boolean): Bench {
    const root = mkdtempSync(path.join(tmpdir(), 'supervisor-mechanics-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const clock = { now: 0 }
    const ts = (): string => new Date(MERGED_AT + clock.now).toISOString()
    appendEvent(db, { ts: ts(), type: 'main.advanced', actor: 'netwatch', cardId: null, pr: null, head: null, dedupeKey: `main:${NEW_MAIN}`, payload: { sha: NEW_MAIN, touches_mechanics: touchesMechanicsFlag }, legacy: false })
    const { answer, close } = workerLaunches(() => [])
    let alive: RunningProcess[] = [{ pid: 604, args: `node pnpm.cjs --silent ${launchName(answer)}` }, { pid: 605, args: `node pnpm.cjs --silent ${launchName(close)}` }]
    const started: string[] = []
    let head = OLD_MAIN
    const supervisor = new BusSupervisor({
      known: [answer, close],
      wanted: () => [answer, close],
      start: (launch) => {
        started.push(launchName(launch))
        alive = [...alive, { pid: 700 + started.length, args: `node pnpm.cjs --silent ${launchName(launch)}` }]
        return { stdout: [], stderr: [], exitCode: 0 }
      },
      stop: async (instance) => {
        alive = alive.filter(candidate => candidate.pid !== instance.pid)
      },
      freeLeases: stopped => freeLeasesOf(db, ts(), stopped),
      drain: busDrain(db, ts),
      processes: () => alive,
      mainSince: afterId => mainAdvancedSince(db, afterId),
      code: {
        head: () => head,
        holds: sha => sha === head,
        pull: () => {
          head = NEW_MAIN
        },
        changedSince: sha => sha === head ? [] : [changed],
        runs,
      },
      journal: () => {},
      now: () => MERGED_AT + clock.now,
    }, 0)
    return { db, clock, ts, alive: () => alive, started, supervisor }
  }

  const drains = (db: DatabaseSync): unknown[] => db.prepare('SELECT payload FROM events WHERE type = ?').all('leases.draining').map(row => JSON.parse(String(row.payload)) as unknown)
  const holderStopped = (db: DatabaseSync): unknown[] => db.prepare('SELECT payload FROM events WHERE type = ?').all(TASK_EXPIRED).map(row => JSON.parse(String(row.payload)) as { reason?: string }).filter(payload => payload.reason === 'holder_stopped')

  it('a main.advanced with touches_mechanics false whose diff changes a file every node imports writes no leases.draining, and each node restarts between its leases', async () => {
    const code = gitCode(repoRoot)
    const { answer, close } = workerLaunches(() => [])
    for (const launch of [answer, close, SUPERVISOR_LAUNCH])
      expect(code.runs(entryOf(launch)!)).toContain(EVERY_NODE_RUNS)
    expect(touchesMechanics([EVERY_NODE_RUNS])).toBe(false)
    const { db, clock, ts, started, supervisor } = bench(EVERY_NODE_RUNS, entry => code.runs(entry), false)
    const leaseOfAnswer = leaseWhileFree(db, ts(), { queue: 'answer', cardId: 1023, pr: 1023, head: OLD_MAIN }, 'worker:answer:alive', 1)!

    const waiting = (await supervisor.step()).join('\n')
    expect(waiting).toContain(`main advanced to ${NEW_MAIN} with no change to the mechanics, so nothing drains; restarting bus:close now, and bus:answer restart once their leases in flight finish: ${leaseOfAnswer.taskKey}`)
    expect(started).toEqual([launchName(close)])
    expect(drainOpen(db, ts(), 'answer')).toBe(false)
    expect(leaseWhileFree(db, ts(), { queue: 'close', cardId: 1024, pr: 1024, head: OLD_MAIN }, 'worker:close:fresh', 1)).not.toBeNull()

    clock.now = 60_000
    expect(await supervisor.step()).toEqual([])
    completeTask(db, ts(), leaseOfAnswer, [])
    clock.now = 120_000
    const lines = (await supervisor.step()).join('\n')

    expect(lines).toContain(`main advanced to ${NEW_MAIN} with a change to the code of bus:answer, ${SUPERVISOR_LAUNCH.script}`)
    expect(started).toEqual([launchName(close), launchName(answer)])
    expect(supervisor.ownCodeBehind).toBe(NEW_MAIN)
    expect(drains(db)).toEqual([])
    expect(holderStopped(db)).toEqual([])
    db.close()
  })

  it('a mechanics change to node A\'s code alone drains only A, and a lease of node B is taken during the drain', async () => {
    const { answer, close } = workerLaunches(() => [])
    const closures = new Map([
      [entryOf(answer)!, new Set([entryOf(answer)!, ANSWER_MECHANICS])],
      [entryOf(close)!, new Set([entryOf(close)!])],
      [entryOf(SUPERVISOR_LAUNCH)!, new Set([entryOf(SUPERVISOR_LAUNCH)!])],
    ])
    expect(touchesMechanics([ANSWER_MECHANICS])).toBe(true)
    const { db, clock, ts, alive, started, supervisor } = bench(ANSWER_MECHANICS, entry => closures.get(entry) ?? new Set(), true)
    const leaseOfA = leaseWhileFree(db, ts(), { queue: 'answer', cardId: 1209, pr: 1209, head: OLD_MAIN }, 'worker:answer:alive', 1)!

    const waiting = (await supervisor.step()).join('\n')
    expect(waiting).toContain(`the restart onto ${NEW_MAIN} waits for the leases in flight to finish, and bus:answer take no new one: ${leaseOfA.taskKey}`)
    expect(drains(db)).toEqual([expect.objectContaining({ sha: NEW_MAIN, node: 'answer' })])
    expect(drainOpen(db, ts(), 'answer')).toBe(true)
    expect(drainOpen(db, ts(), 'close')).toBe(false)
    const leaseOfB = leaseWhileFree(db, ts(), { queue: 'close', cardId: 1210, pr: 1210, head: OLD_MAIN }, 'worker:close:alive', 1)
    expect(leaseOfB).not.toBeNull()

    completeTask(db, ts(), leaseOfA, [])
    clock.now = 60_000
    expect((await supervisor.step()).join('\n')).toContain(`main advanced to ${NEW_MAIN} with a change to the code of bus:answer; restarting only those on ${NEW_MAIN}, and every other bus process runs on`)
    expect(started).toEqual([launchName(answer)])
    expect(alive().map(each => each.pid)).toEqual([605, 701])
    expect(drains(db).every(drain => (drain as { node: string }).node === 'answer')).toBe(true)
    expect(db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(leaseOfB!.taskKey)).toEqual({ state: 'leased' })
    expect(holderStopped(db)).toEqual([])
    db.close()
  })
})
