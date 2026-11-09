import type { DatabaseSync } from 'node:sqlite'
import type { QueuedTask } from '../../core/queue.js'
import type { GitHubPost } from '../../ports/pr-status.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_SESSION_ENDED, SESSION_HEARTBEAT, SESSION_STALLED } from '../../core/events.js'
import { leaseQueued } from '../../core/lease.js'
import { keyOf, queueTask } from '../../core/queue.js'
import { composeBusTick } from '../../supervisor/run.js'
import { NO_PROGRESS_LINES, STALLED_ACTOR } from '../../supervisor/stalled-sessions.js'
import { Clock, FakeGitHub } from '../bus/github-fake.js'

const SILENT_SESSION = 'bus-tick-silent-session-no-process-carries-this-id'
const MINUTE_MS = 60_000
const roots: string[] = []
const opened: DatabaseSync[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of opened.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const noPost: GitHubPost = () => {
  throw new Error('a bus tick with no open PR posts no status')
}

describe('the bus tick and the silent sessions', () => {
  it('a bus tick built by composeBusTick closes or reports a silent session through StalledSessions', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-tick-stalled-'))
    roots.push(root)
    const busPath = path.join(root, 'bus.db')
    const db = openBus(busPath)
    opened.push(db)
    const clock = new Clock()
    const task: QueuedTask = { queue: 'launch', cardId: 1753, generation: 'g1' }
    queueTask(db, clock.now().toISOString(), task)
    const lease = leaseQueued(db, clock.now().toISOString(), keyOf(task), 'worker:launch:worker-1')!
    appendEvent(db, { ts: new Date(clock.ms + MINUTE_MS).toISOString(), type: SESSION_HEARTBEAT, actor: 'worker:launch:worker-1', cardId: lease.cardId, pr: null, head: null, dedupeKey: `${SESSION_HEARTBEAT}:${lease.taskKey}:silent`, payload: { task_key: lease.taskKey, lease_gen: lease.leaseGen, session: SILENT_SESSION, context: 1000 }, legacy: false })
    clock.advance(NO_PROGRESS_LINES.launch + 5 * MINUTE_MS)

    const { busTick } = composeBusTick(db, busPath, new FakeGitHub().client, noPost, clock.now, root)
    expect(busTick.run()).toMatchObject({ poll: { kind: 'ticked' } })

    const handled = db.prepare('SELECT type, payload FROM events WHERE type IN (?, ?) AND card_id = ? AND actor = ?').all(CARD_SESSION_ENDED, SESSION_STALLED, task.cardId, STALLED_ACTOR) as { type: string, payload: string }[]
    expect(handled.map(row => ({ type: row.type, ...JSON.parse(row.payload) as Record<string, unknown> }))).toMatchObject([{ session: SILENT_SESSION }])
  })
})
