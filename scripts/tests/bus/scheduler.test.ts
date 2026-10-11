import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../bus/lease.js'
import type { Reviewer } from '../../bus/reviewer.js'
import type { HeavyRunParts } from '../../bus/scheduler.js'
import type { ReviewStatus, StatusPublisher } from '../../ghosts/verdict.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBus } from '../../bus/db.js'
import { completeTask, LEASE_MS, leasedCount } from '../../bus/lease.js'
import { NetWatch, TICK_MS } from '../../bus/netwatch.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { fullReview } from '../../bus/review-depth.js'
import { startReviewWorkers } from '../../bus/review-worker.js'
import { BusTick } from '../../bus/run.js'
import { SLOT_POLL_MS, SLOTS, SlotScheduler, slotsOf, slotsVariable } from '../../bus/scheduler.js'
import { runSlot, slotCall, spawnInherited } from '../../bus/slot.js'
import { Clock, FakeGitHub, sha } from './github-fake.js'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-scheduler-'))
  roots.push(root)
  return path.join(root, 'bus.db')
}

function scheduler(db: DatabaseSync, clock: Clock, session: string, slots: number, extra: Partial<HeavyRunParts> = {}): SlotScheduler {
  return new SlotScheduler({ db, clock: clock.now, session, slots, pause: async () => {}, announce: () => {}, ...extra })
}

function types(db: DatabaseSync): string[] {
  return db.prepare(`SELECT type FROM events WHERE type LIKE 'task.%' ORDER BY id`).all().map(row => String(row.type))
}

function states(db: DatabaseSync): Record<string, string> {
  return Object.fromEntries(db.prepare('SELECT task_key, state FROM tasks ORDER BY task_key').all().map(row => [String(row.task_key), String(row.state)]))
}

function expectReplayIdentical(db: DatabaseSync): void {
  const live = projectionDump(db)
  reduce(db)
  expect(projectionDump(db)).toBe(live)
}

describe('heavy run scheduler', () => {
  it('a heavy run waits while every slot of its kind is leased', async () => {
    const db = openBus(scratch())
    const clock = new Clock()
    const first = scheduler(db, clock, 'first', 2).tryTake('vitest', 812)!
    expect(scheduler(db, clock, 'second', 2).tryTake('vitest', 812)).not.toBeNull()
    expect(scheduler(db, clock, 'blocked', 2).tryTake('vitest', 812)).toBeNull()
    expect(scheduler(db, clock, 'other-kind', 2).tryTake('quality', 812)).not.toBeNull()
    expect(leasedCount(db, 'vitest')).toBe(2)

    const pauses: number[] = []
    const lines: string[] = []
    const waiting = scheduler(db, clock, 'third', 2, {
      pause: async (ms) => {
        pauses.push(ms)
        if (pauses.length === 2)
          completeTask(db, clock.now().toISOString(), first, [])
      },
      announce: line => lines.push(line),
    })
    const ran: number[] = []
    const code = await waiting.run({ kind: 'vitest', cardId: 812, command: async () => {
      ran.push(leasedCount(db, 'vitest'))
      return 0
    } })

    expect(code).toBe(0)
    expect(pauses).toEqual([SLOT_POLL_MS, SLOT_POLL_MS])
    expect(lines).toEqual(['[bus:slot] every vitest slot (2) is leased; waiting for one'])
    expect(ran).toEqual([2])
    expect(states(db)['vitest:812:third']).toBe('completed')
    expect(leasedCount(db, 'vitest')).toBe(1)
    expectReplayIdentical(db)
    db.close()
  })

  it('bus:slot passes the command exit code through and releases the slot', async () => {
    const busPath = scratch()
    const clock = new Clock()
    const run = { busPath, env: {}, clock: clock.now, pause: async () => {}, spawn: spawnInherited }

    expect(await runSlot(['quality', '--card', '812', '--', process.execPath, '-e', 'process.exit(7)'], { ...run, session: 'red' })).toBe(7)
    expect(await runSlot(['quality', '--card', '812', '--', process.execPath, '-e', 'process.exit(0)'], { ...run, session: 'green' })).toBe(0)

    const db = openBus(busPath)
    expect(states(db)).toEqual({ 'quality:812:green': 'completed', 'quality:812:red': 'completed' })
    expect(types(db)).toEqual(['task.enqueued', 'task.leased', 'task.completed', 'task.enqueued', 'task.leased', 'task.completed'])
    expect(leasedCount(db, 'quality')).toBe(0)
    expectReplayIdentical(db)
    db.close()
  })

  it('a slot whose holder died is released when its lease expires', () => {
    const db = openBus(scratch())
    const clock = new Clock()
    expect(scheduler(db, clock, 'died', 1).tryTake('quality', 812)).not.toBeNull()
    expect(scheduler(db, clock, 'next', 1).tryTake('quality', 813)).toBeNull()

    clock.advance(LEASE_MS + 1)
    const lease = scheduler(db, clock, 'next', 1).tryTake('quality', 813)

    expect(lease?.taskKey).toBe('quality:813:next')
    expect(types(db)).toEqual(['task.enqueued', 'task.leased', 'task.expired', 'task.enqueued', 'task.leased'])
    const expired = db.prepare(`SELECT payload FROM events WHERE type = 'task.expired'`).get() as { payload: string }
    expect(JSON.parse(expired.payload)).toMatchObject({ task_key: 'quality:812:died', reason: 'lease_expired' })
    expect(leasedCount(db, 'quality')).toBe(1)
    expectReplayIdentical(db)
    db.close()
  })

  it('three PRs with green CI are reviewed at once, each under its own lease, with no double verdict', async () => {
    const db = openBus(scratch())
    const gitHub = new FakeGitHub()
    const clock = new Clock()
    const busTick = new BusTick(db, new NetWatch(db, gitHub.client, clock.now), clock.now)
    const statuses: ReviewStatus[] = []
    const publish: StatusPublisher = (status) => {
      statuses.push(status)
      const pull = [...gitHub.pulls.values()].find(candidate => candidate.head === status.commit)
      if (pull !== undefined)
        pull.review = status.state
    }
    gitHub.open({ number: 961, head: sha('b') })
    gitHub.open({ number: 962, head: sha('c') })
    gitHub.open({ number: 963, head: sha('d') })
    busTick.run()
    clock.advance(TICK_MS)

    const inFlight: Lease[] = []
    let allIn: () => void = () => {}
    const together = new Promise<void>((resolve) => {
      allIn = resolve
    })
    const reviewer: Reviewer = async (lease) => {
      inFlight.push(lease)
      if (inFlight.length === SLOTS.review)
        allIn()
      await together
      return { verdict: 'pass', findings: [], session: `reviewer-${lease.pr}` }
    }
    const workers = startReviewWorkers({ db, gitHub: gitHub.client, publish, reviewer, plan: () => fullReview('a fixed plan'), clock: clock.now, session: 'parallel' }, slotsOf('review', {}))

    const steps = await Promise.all(workers.map(async worker => worker.step()))

    expect(steps.map(step => step.kind)).toEqual(['recorded', 'recorded', 'recorded'])
    expect(new Set(inFlight.map(lease => lease.taskKey)).size).toBe(3)
    expect(inFlight.map(lease => lease.actor)).toEqual(['worker:review:parallel-1', 'worker:review:parallel-2', 'worker:review:parallel-3'])
    const recorded = db.prepare(`SELECT pr, head FROM events WHERE type = 'review.recorded' ORDER BY pr`).all().map(row => [Number(row.pr), String(row.head)])
    expect(recorded).toEqual([[961, sha('b')], [962, sha('c')], [963, sha('d')]])
    expect(statuses.map(status => status.commit)).toHaveLength(3)

    busTick.run()
    expect((await Promise.all(workers.map(async worker => worker.step()))).map(step => step.kind)).toEqual(['idle', 'idle', 'idle'])
    expect(db.prepare(`SELECT count(*) AS n FROM events WHERE type = 'review.recorded'`).get()).toEqual({ n: 3 })
    expectReplayIdentical(db)
    db.close()
  })

  it('the number of slots of a kind is a named constant the environment may override', () => {
    expect(slotsOf('review', {})).toBe(3)
    expect(slotsOf('quality', {})).toBe(SLOTS.quality)
    expect(slotsOf('review', { [slotsVariable('review')]: '5' })).toBe(5)
    for (const given of ['0', '-1', '1.5', 'three', ' 2'])
      expect(() => slotsOf('vitest', { [slotsVariable('vitest')]: given })).toThrow(/not a positive integer/)
  })

  it('bus:slot refuses a call that names no kind, no card or no command', () => {
    expect(slotCall(['quality', '--card', '812', '--', 'pnpm', 'run', 'quality'])).toEqual({ kind: 'run', run: 'quality', cardId: 812, command: ['pnpm', 'run', 'quality'] })
    expect(slotCall(['vitest', '--card', '#812', 'pnpm', 'exec', 'vitest'])).toEqual({ kind: 'run', run: 'vitest', cardId: 812, command: ['pnpm', 'exec', 'vitest'] })
    for (const argv of [['review', '--card', '812', '--', 'true'], ['quality', '--', 'true'], ['quality', '--card', 'x', '--', 'true'], ['quality', '--card', '812', '--']])
      expect(slotCall(argv)).toMatchObject({ kind: 'refused' })
  })
})
