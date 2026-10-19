import type { DatabaseSync } from 'node:sqlite'
import type { QueuedTask } from '../../bus/queue.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBus } from '../../bus/db.js'
import { LEGACY_REASON, withdrawLegacyLaunchTasks } from '../../bus/launch-withdraw.js'
import { runWithdrawLegacy } from '../../bus/launch-worker.js'
import { failTask, leaseQueued } from '../../bus/lease.js'
import { FAILURES_TO_STOP, keyOf, queueTask, queueTaskWithin, STOPPED, WITHDRAWN } from '../../bus/queue.js'
import { eventCount, eventsOf, taskState } from './merge-bench.js'

const TS = '2026-10-19T09:00:00.000Z'
const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function busFile(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'launch-withdraw-'))
  roots.push(root)
  return path.join(root, 'bus.db')
}

const launchTask = (cardId: number): QueuedTask => ({ queue: 'launch', cardId, generation: `admission-${cardId}` })

function stopped(db: DatabaseSync, task: QueuedTask): void {
  queueTask(db, TS, task)
  for (let failure = 0; failure < FAILURES_TO_STOP; failure++)
    failTask(db, TS, leaseQueued(db, TS, keyOf(task), 'worker:launch:test')!, { reason: 'fault', withdraw: false })
}

describe('bus:launch --withdraw-legacy', () => {
  it('every queued and stopped launch task is withdrawn with reason legacy and nothing is started', () => {
    const file = busFile()
    const db = openBus(file)
    const queued = [launchTask(80), launchTask(83)]
    for (const task of queued)
      queueTask(db, TS, task)
    const halted = launchTask(138)
    stopped(db, halted)
    const review: QueuedTask = { queue: 'review', cardId: 144, pr: 900, head: 'a'.repeat(40) }
    queueTask(db, TS, review)
    expect(taskState(db, keyOf(halted)).state).toBe(STOPPED)
    db.close()

    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line))
    expect(runWithdrawLegacy(file, () => new Date(TS))).toBe(0)

    const after = openBus(file)
    for (const task of [...queued, halted])
      expect(taskState(after, keyOf(task)).state).toBe(WITHDRAWN)
    expect(taskState(after, keyOf(review)).state).toBe('queued')
    expect(eventsOf(after, 'task.failed').filter(payload => payload.reason === LEGACY_REASON).map(payload => payload.task_key)).toEqual([...queued, halted].map(keyOf))
    expect(eventsOf(after, 'card.started')).toEqual([])
    expect(lines.at(-1)).toContain('3 withdrawn')
    after.close()
  })

  it('a second withdraw pass writes nothing', () => {
    const db = openBus(busFile())
    queueTask(db, TS, launchTask(80))
    stopped(db, launchTask(83))
    expect(withdrawLegacyLaunchTasks(db, TS)).toHaveLength(2)
    const events = eventCount(db)
    expect(withdrawLegacyLaunchTasks(db, TS)).toEqual([])
    expect(eventCount(db)).toBe(events)
    db.close()
  })

  it('a withdrawn launch task is not queued again by the launch node detection of the same candidate', () => {
    const db = openBus(busFile())
    const task = launchTask(80)
    queueTask(db, TS, task)
    withdrawLegacyLaunchTasks(db, TS)
    expect(queueTaskWithin(db, TS, task)).toBe(false)
    expect(taskState(db, keyOf(task)).state).toBe(WITHDRAWN)
    db.close()
  })
})
