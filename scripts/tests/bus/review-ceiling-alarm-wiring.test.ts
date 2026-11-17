import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../core/lease.js'
import type { Review, ReviewStart, TreeTools } from '../../nodes/review/reviewer.js'
import type { SpawnSessionParams } from '../../ports/session.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBus } from '../../core/db.js'
import { BOARD_ALARM, SESSION_STALLED } from '../../core/events.js'
import { leaseQueued } from '../../core/lease.js'
import { keyOf, queueTask } from '../../core/queue.js'
import { fullReview } from '../../nodes/review/review-depth.js'
import { claudeReviewer, missedCeilingAlarmLine, osDescendants, realReviewStart, REVIEW_AT_CEILING, REVIEW_CEILING_MS, ReviewTrees } from '../../nodes/review/reviewer.js'
import { InMemoryProcessTable } from '../../ports/process-table.js'
import { eventsOf } from './merge-bench.js'

const PASS = '{"verdict":"pass","findings":[]}'
const cleanups: (() => void)[] = []

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0))
    cleanup()
})

function temporary(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function readBus<T>(busPath: string, read: (db: DatabaseSync) => T): T {
  const db = openBus(busPath)
  try {
    return read(db)
  }
  finally {
    db.close()
  }
}

function productionWiring(busPath: string): ReviewStart {
  return {
    ...realReviewStart(busPath),
    gate: { start: async () => true, release: () => {} },
    keep: () => true,
    joinWorkers: () => 1,
    leaveWorkers: () => {},
    descendants: osDescendants(new InMemoryProcessTable({})),
    verdictPollMs: 10,
  }
}

async function reviewRunningPastTheCeiling(busPath: string, lease: Lease, atTheCeiling: () => void = () => {}): Promise<Review> {
  const dir = temporary('review-ceiling-wiring-trees-')
  const tools: TreeTools = { git: () => {}, worktrees: () => [], prepare: () => {}, state: () => ({ head: lease.head!, status: [] }) }
  const spawn = async (params: SpawnSessionParams): Promise<number> => {
    vi.advanceTimersByTime(REVIEW_CEILING_MS)
    atTheCeiling()
    writeFileSync(path.join(dir, `${params.sessionId}.verdict.json`), PASS)
    return 0
  }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  return claudeReviewer(new ReviewTrees('/repo', dir, tools), spawn, () => {}, REVIEW_CEILING_MS * 2, () => null, productionWiring(busPath))(lease, fullReview('plan'))
}

describe('the review ceiling as production wires it', () => {
  it('a reviewer run through realReviewStart raises board.alarm and session.stalled in the bus at the ceiling and the review runs on to its verdict', async () => {
    const busPath = path.join(temporary('review-ceiling-wiring-bus-'), 'bus.db')
    const task = { queue: 'review' as const, cardId: 4981, pr: 4981, head: 'd'.repeat(40) }
    const lease = readBus(busPath, (db) => {
      queueTask(db, new Date(0).toISOString(), task)
      return leaseQueued(db, new Date(0).toISOString(), keyOf(task), 'worker:review:worker-1')!
    })
    let alarmsAtTheCeiling = -1

    const review = await reviewRunningPastTheCeiling(busPath, lease, () => {
      alarmsAtTheCeiling = readBus(busPath, db => eventsOf(db, BOARD_ALARM).length)
    })

    expect(review.verdict).toBe('pass')
    expect(alarmsAtTheCeiling).toBe(1)
    readBus(busPath, (db) => {
      expect(eventsOf(db, BOARD_ALARM)).toMatchObject([{ task_key: lease.taskKey, lease_gen: lease.leaseGen, reason: REVIEW_AT_CEILING }])
      expect(eventsOf(db, SESSION_STALLED)).toMatchObject([{ task_key: lease.taskKey, session: review.session, queue: 'review', life: 'live' }])
    })
  })

  it('a ceiling alarm the bus refuses prints the missed-alarm line and the review still reaches its verdict', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    const notADirectory = path.join(temporary('review-ceiling-wiring-blocked-'), 'file')
    writeFileSync(notADirectory, '')
    const lease: Lease = { taskKey: `review:4982:4982:${'e'.repeat(40)}`, queue: 'review', cardId: 4982, pr: 4982, head: 'e'.repeat(40), leaseGen: 1, actor: 'worker:review:worker-1' }
    const lineHead = missedCeilingAlarmLine('\0', '').split('\0')[0]!

    const review = await reviewRunningPastTheCeiling(path.join(notADirectory, 'bus.db'), lease)

    expect(review.verdict).toBe('pass')
    const missed = said.mock.calls.map(call => String(call[0])).filter(line => line.startsWith(lineHead))
    expect(missed).toHaveLength(1)
    expect(missed[0]!.startsWith(missedCeilingAlarmLine(review.session, ''))).toBe(true)
    expect(missed[0]!.length).toBeGreaterThan(missedCeilingAlarmLine(review.session, '').length)
  })
})
