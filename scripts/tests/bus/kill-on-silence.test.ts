import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../core/lease.js'
import type { CardStart, CardStarter, QueuedCard, StartedCard } from '../../nodes/launch/launch-executor.js'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { TreeTools } from '../../nodes/review/reviewer.js'
import type { DiskReader } from '../../ports/disk.js'
import type { IsolationReader } from '../../ports/isolation.js'
import type { SpawnSessionParams } from '../../ports/session.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_STOPPED, COMMAND_EXECUTED, SESSION_HEARTBEAT, SESSION_STALLED, TASK_FAILED } from '../../core/events.js'
import { failTask, leaseNext, leaseQueued } from '../../core/lease.js'
import { ownerMoveCommand } from '../../core/owner-commands.js'
import { keyOf, queueTask } from '../../core/queue.js'
import { LaunchExecutor } from '../../nodes/launch/launch-executor.js'
import { LAUNCH_LIMIT_MINUTES, LaunchNode, NO_HEARTBEAT_CAUSE, TIME_LIMIT_CAUSE } from '../../nodes/launch/launch-worker.js'
import { fullReview } from '../../nodes/review/review-depth.js'
import { claudeReviewer, osDescendants, raiseCeilingAlarm, REVIEW_AT_CEILING, reviewSession, ReviewTrees } from '../../nodes/review/reviewer.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { InMemoryProcessTable } from '../../ports/process-table.js'
import { recordHeartbeat } from '../../supervisor/heartbeat.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { NO_PROGRESS_LINES, StalledSessions } from '../../supervisor/stalled-sessions.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })
const roomy: DiskReader = () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES })
const SILENT_MINUTES = 25
const PGID = 4242
const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0))
    cleanup()
})

class RecordingStarter implements CardStarter {
  stops: StartedCard[] = []
  start(card: QueuedCard): CardStart {
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: PGID, pgid: PGID } }
  }

  stop(card: StartedCard): void {
    this.stops.push(card)
  }
}

function runningLaunch(cardId: number) {
  const bench = mergeBench()
  cleanups.push(() => bench.close())
  const starter = new RecordingStarter()
  const signalled: number[] = []
  const processes: ProcessTable = { commandLine: () => starter.stops.length > 0 ? null : `sh -c claude -p --session-id s-${cardId}`, signalGroup: pgid => signalled.push(pgid) }
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
  bench.tick()
  const executor = new LaunchExecutor({ silentMs: SILENT_MS, db: bench.db, starter, clock: bench.clock.now, disk: roomy, isolation: sandboxed })
  expect(executor.launch(leaseNext(bench.db, bench.clock.now().toISOString(), 'launch', 'worker:launch:worker-1')!).kind).toBe('started')
  bench.tick()
  const node = new LaunchNode({ silentMs: SILENT_MS, db: bench.db, starter, clock: bench.clock.now, session: 'w1', mode: 'live', env: {}, processes, disk: roomy, isolation: sandboxed })
  const beat = (): void => {
    recordHeartbeat(bench.db, bench.clock.now().toISOString(), { card: cardId, pr: null, head: null, step: 'PostToolUse', session: `s-${cardId}`, lease: null })
  }
  const ownerStops = (): void => {
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: COMMAND_EXECUTED, actor: 'owner', cardId, pr: null, head: null, dedupeKey: `${COMMAND_EXECUTED}:owner-stop:${cardId}`, payload: { command: ownerMoveCommand('stop', cardId) }, legacy: false })
  }
  return { bench, starter, signalled, node, beat, ownerStops }
}

function alarmsOf(db: DatabaseSync, cause: string): Record<string, unknown>[] {
  return eventsOf(db, BOARD_ALARM).filter(payload => payload.reason === cause)
}

function stallsOf(db: DatabaseSync, cause: string): Record<string, unknown>[] {
  return eventsOf(db, SESSION_STALLED).filter(payload => String(payload.reason).startsWith(`${cause}: `))
}

function reviewBus(): { db: DatabaseSync, lease: Lease } {
  const root = mkdtempSync(path.join(tmpdir(), 'kill-on-silence-review-'))
  const db = openBus(path.join(root, 'bus.db'))
  cleanups.push(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const task = { queue: 'review' as const, cardId: 4703, pr: 4703, head: 'c'.repeat(40) }
  queueTask(db, new Date(0).toISOString(), task)
  return { db, lease: leaseQueued(db, new Date(0).toISOString(), keyOf(task), 'worker:review:worker-1')! }
}

describe('a live session is warned on silence or over time and only the owner stops it', () => {
  it('a card session silent for 25 min is warned and is not killed', () => {
    const { bench, starter, signalled, node } = runningLaunch(4701)

    bench.clock.advance(SILENT_MINUTES * 60_000)
    expect(node.stopOverdue()).toEqual([])
    bench.clock.advance(60_000)
    expect(node.stopOverdue()).toEqual([])

    expect(starter.stops).toEqual([])
    expect(signalled).toEqual([])
    expect(eventsOf(bench.db, CARD_STOPPED)).toEqual([])
    expect(alarmsOf(bench.db, NO_HEARTBEAT_CAUSE)).toHaveLength(1)
    expect(stallsOf(bench.db, NO_HEARTBEAT_CAUSE)).toMatchObject([{ session: 's-4701', life: 'live' }])
  })

  it('a session past its time limit or the review ceiling is warned and is not killed', async () => {
    const launch = runningLaunch(4702)
    launch.bench.clock.advance(LAUNCH_LIMIT_MINUTES * 60_000)
    launch.beat()
    expect(launch.node.stopOverdue()).toEqual([])
    expect(launch.node.stopOverdue()).toEqual([])
    expect(launch.starter.stops).toEqual([])
    expect(alarmsOf(launch.bench.db, TIME_LIMIT_CAUSE)).toHaveLength(1)
    expect(stallsOf(launch.bench.db, TIME_LIMIT_CAUSE)).toHaveLength(1)
    launch.ownerStops()
    expect(launch.node.stopOverdue()).toEqual([4702])
    expect(launch.starter.stops.map(card => card.pgid)).toEqual([PGID])

    const { db, lease } = reviewBus()
    const reviewLine = NO_PROGRESS_LINES.review
    let now = 0
    const stopped: string[] = []
    const watch = new StalledSessions(db, () => new Date(now), { lifeOf: () => 'live', stop: session => stopped.push(session), spendOf: () => null, pulseOf: () => '4100', overTime: { check: () => [] } })
    const beatReview = (leased: Lease, at: number): void => {
      appendEvent(db, { ts: new Date(at).toISOString(), type: SESSION_HEARTBEAT, actor: leased.actor, cardId: leased.cardId, pr: leased.pr, head: leased.head, dedupeKey: `${SESSION_HEARTBEAT}:${leased.taskKey}:${leased.leaseGen}:${at}`, payload: { task_key: leased.taskKey, lease_gen: leased.leaseGen, session: 'review-session', context: 1000 }, legacy: false })
    }
    const sweepAt = (at: number): string[] => {
      now = at
      return watch.step()
    }
    beatReview(lease, 60_000)
    expect(sweepAt(60_000)).toEqual([])
    expect(sweepAt(reviewLine + 2 * 60_000)).toEqual([expect.stringContaining('the session runs on and is not stopped')])
    failTask(db, new Date(reviewLine + 3 * 60_000).toISOString(), lease, { reason: 'exit 1', withdraw: false }, SILENT_MS)
    const again = leaseQueued(db, new Date(reviewLine + 4 * 60_000).toISOString(), lease.taskKey, 'worker:review:worker-1')!
    beatReview(again, reviewLine + 5 * 60_000)
    expect(sweepAt(reviewLine + 5 * 60_000)).toEqual([])
    expect(sweepAt(2 * reviewLine + 6 * 60_000)).toEqual([expect.stringContaining('stalled a second time')])
    expect(sweepAt(2 * reviewLine + 30 * 60_000)).toEqual([])
    expect(stopped).toEqual([])
    expect(eventsOf(db, BOARD_ALARM)).toHaveLength(2)
    expect(eventsOf(db, TASK_FAILED).map(payload => payload.next)).toEqual(['queued'])

    expect(reviewSession('/repo', '/reviews', 's-1', again, fullReview('plan')).ceilingMs).toBeUndefined()
    const dir = mkdtempSync(path.join(tmpdir(), 'kill-on-silence-ceiling-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const tools: TreeTools = { git: () => {}, worktrees: () => [], prepare: () => {}, state: () => ({ head: again.head!, status: [] }) }
    const signals: NodeJS.Signals[] = []
    let ceilingAlarmed: () => void = () => {}
    const atTheCeiling = new Promise<void>((resolve) => {
      ceilingAlarmed = resolve
    })
    const pastTheCeiling = async (params: SpawnSessionParams): Promise<number> => {
      await atTheCeiling
      writeFileSync(path.join(dir, `${params.sessionId}.verdict.json`), '{"verdict":"pass","findings":[]}')
      return 0
    }
    const review = await claudeReviewer(new ReviewTrees('/repo', dir, tools), pastTheCeiling, () => {}, 60_000, () => null, {
      gate: { start: async () => true, release: () => {} },
      keep: () => true,
      joinWorkers: () => 1,
      leaveWorkers: () => {},
      descendants: { ...osDescendants(new InMemoryProcessTable({})), end: (_pid, signal) => signals.push(signal) },
      verdictPollMs: 10,
      ceilingMs: 20,
      atCeiling: (leased, session) => {
        raiseCeilingAlarm(db, new Date().toISOString(), leased, session)
        ceilingAlarmed()
      },
    })(again, fullReview('plan'))

    expect(review.verdict).toBe('pass')
    expect(signals).toEqual([])
    expect(eventsOf(db, BOARD_ALARM).filter(payload => payload.reason === REVIEW_AT_CEILING)).toHaveLength(1)
    expect(eventsOf(db, SESSION_STALLED).filter(payload => String(payload.reason).includes('-minute ceiling with no verdict'))).toMatchObject([{ session: review.session, life: 'live' }])
  })
})
