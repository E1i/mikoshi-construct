import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../core/lease.js'
import type { NodeStep } from '../../core/node.js'
import type { QueuedTask } from '../../core/queue.js'
import type { BgResult, RunningProcess } from '../../supervisor/bg.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { REDUCED } from '../../core/events.js'
import { completeTask, recordWorkerStarted } from '../../core/lease.js'
import { Node } from '../../core/node.js'
import { queueTaskWithin } from '../../core/queue.js'
import { launchName, PREFIX } from '../../supervisor/bg.js'
import { slotsVariable } from '../../supervisor/scheduler.js'
import { busDrain, BusSupervisor, freeLeasesOf, withoutRetiring } from '../../supervisor/supervisor.js'
import { workerLaunches } from '../../supervisor/workers.js'

const OLD_MAIN = 'a'.repeat(40)
const NEW_MAIN = 'b'.repeat(40)
const SHARED_FILE = 'scripts/core/db.ts'
const RESTARTED_AT = Date.parse('2026-11-09T08:45:23.000Z')
const OLD_PID = 610
const NEW_PID = 711
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

class ReviewRounds extends Node<NodeStep> {
  readonly taken: string[] = []
  private readonly rounds: (() => void)[] = []

  constructor(db: DatabaseSync, clock: () => Date, session: string, private readonly codeOf: string) {
    super('review', { db, clock, session, mode: 'live', env: { [slotsVariable('review')]: '3' }, self: { pid: session === 'old' ? OLD_PID : NEW_PID, started: clock().toISOString() }, codeSha: () => codeOf })
  }

  protected candidates(): QueuedTask[] {
    return []
  }

  protected async handle(lease: Lease): Promise<NodeStep> {
    this.taken.push(`${this.codeOf}:${lease.cardId}`)
    await new Promise<void>((resolve) => {
      this.rounds.push(resolve)
    })
    completeTask(this.db, new Date().toISOString(), lease, [])
    return { kind: 'reviewed', taskKey: lease.taskKey }
  }

  finish(): void {
    for (const round of this.rounds.splice(0))
      round()
  }
}

function openPr(db: DatabaseSync, pr: number): QueuedTask {
  const head = String(pr % 10).repeat(40)
  appendEvent(db, { ts: new Date(RESTARTED_AT).toISOString(), type: REDUCED, actor: 'reducer', cardId: null, pr: null, head: null, dedupeKey: `${REDUCED}:seed:${pr}`, payload: { through_event_id: 0, applied: 0, rejected: 0 }, legacy: false })
  const seeded = Number((db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
  db.prepare(`INSERT INTO prs (pr, card_id, base, head, state, mergeable, ci, verdict_on_head, auto_merge, draft, event_id) VALUES (?, ?, 'main', ?, 'open', 'clean', 'green', NULL, 0, 0, ?)`).run(pr, pr, head, seeded)
  return { queue: 'review', cardId: pr, pr, head }
}

async function untilTrue(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 500 && !condition(); tries++)
    await sleep(2)
  expect(condition()).toBe(true)
}

function supervised(db: DatabaseSync, ts: () => string): BusSupervisor {
  const { review } = workerLaunches(() => [])
  let alive: RunningProcess[] = [{ pid: OLD_PID, args: `node pnpm.cjs --silent ${launchName(review)}` }]
  let head = OLD_MAIN
  const processes = withoutRetiring(() => alive, db)
  return new BusSupervisor({
    known: [review],
    wanted: () => [review],
    start: (launch): BgResult => {
      if (processes().some(each => each.args.includes(launchName(launch))))
        return { stdout: [], stderr: [`${launch.script} is already running`], exitCode: 1, alreadyRunning: processes()[0] }
      alive = [...alive, { pid: NEW_PID, args: `node pnpm.cjs --silent ${launchName(launch)}` }]
      return { stdout: [`${PREFIX}started`], stderr: [], exitCode: 0 }
    },
    stop: async (instance) => {
      alive = alive.filter(each => each.pid !== instance.pid)
    },
    freeLeases: list => freeLeasesOf(db, ts(), list),
    drain: busDrain(db, ts),
    processes,
    mainSince: () => [{ id: 1, sha: NEW_MAIN }],
    code: {
      head: () => head,
      holds: sha => sha === head,
      pull: () => {
        head = NEW_MAIN
      },
      changedSince: sha => sha === head ? [] : [SHARED_FILE],
      runs: () => new Set([SHARED_FILE]),
    },
    journal: () => {},
    now: () => RESTARTED_AT,
  }, 0)
}

describe('the review slots while one review lease is held', () => {
  it('while one review lease is held the free review slots take the next queued review', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'review-drain-slots-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const date = (): Date => new Date(RESTARTED_AT)
    const ts = (): string => date().toISOString()
    recordWorkerStarted(db, ts(), 'worker:review:old', { pid: OLD_PID, started: ts() })
    queueTaskWithin(db, ts(), openPr(db, 1486))
    const old = new ReviewRounds(db, date, 'old', OLD_MAIN)
    const oldStop = new AbortController()
    const oldRun = old.run({ pause: () => sleep(2), signal: oldStop.signal })
    await untilTrue(() => old.taken.length === 1)

    const lines = (await supervised(db, ts).step()).join('\n')
    expect(lines).toContain(`finishes the rounds it holds on ${OLD_MAIN} and exits`)

    queueTaskWithin(db, ts(), openPr(db, 1485))
    const fresh = new ReviewRounds(db, date, 'new', NEW_MAIN)
    const freshStop = new AbortController()
    const freshRun = fresh.run({ pause: () => sleep(2), signal: freshStop.signal })
    await untilTrue(() => fresh.taken.length === 1)
    expect(fresh.taken).toEqual([`${NEW_MAIN}:1485`])

    old.finish()
    oldStop.abort()
    await oldRun
    fresh.finish()
    freshStop.abort()
    await freshRun
    db.close()
  })
})
