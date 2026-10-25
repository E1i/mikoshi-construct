import type { DatabaseSync } from 'node:sqlite'
import type { Via } from '../../core/node.js'
import type { WindowQueue } from '../../window/window.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { keyOf, queueTask } from '../../core/queue.js'
import { COMPLETION_OF, main, USAGE, windowLines, windowOf } from '../../window/window.js'
import { NODE_DETECTED, NODE_EQUIVALENCE } from '../../core/events.js'

const TS = '2026-10-17T10:00:00.000Z'
const roots: string[] = []
let sequence = 0

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function newBus(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-window-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function headOf(card: number): string {
  return card.toString(16).padStart(40, 'a')
}

interface Detection {
  outcome?: string
  payloadKey?: string
  tasks?: number
}

function complete(db: DatabaseSync, queue: WindowQueue, card: number, detection: Via | null, { outcome = 'queued', payloadKey, tasks = 1 }: Detection = {}): string {
  const task = { queue, cardId: card, pr: card + 1000, head: headOf(card) }
  for (let input = 1; input < tasks; input += 1)
    queueTask(db, TS, { ...task, input: { prBody: input.toString(16).padStart(8, '0'), cardBody: null } })
  if (tasks > 0)
    queueTask(db, TS, task)
  const key = keyOf(task)
  if (detection !== null)
    appendEvent(db, { ts: TS, type: NODE_DETECTED, actor: `worker:${queue}:s1`, cardId: card, pr: task.pr, head: task.head, dedupeKey: `${NODE_DETECTED}:${queue}:${key}`, payload: { key: payloadKey ?? key, via: detection, event_id: 1, outcome }, legacy: false })
  appendEvent(db, { ts: TS, type: COMPLETION_OF[queue], actor: `worker:${queue}:s1`, cardId: card, pr: task.pr, head: task.head, dedupeKey: `${COMPLETION_OF[queue]}:${key}`, payload: {}, legacy: false })
  return key
}

function stopOf(detection: Detection, queue: WindowQueue = 'merge'): string | undefined {
  const db = newBus()
  complete(db, queue, 1, 'event')
  complete(db, queue, 2, 'event', detection)
  const count = windowOf(db, queue)
  db.close()
  expect(count.run).toEqual([])
  expect(count.stop?.cardId).toBe(2)
  return count.stop?.why
}

function tick(db: DatabaseSync, actor: string, onlyNode: string[], onlyDerive: string[]): number {
  sequence += 1
  appendEvent(db, { ts: TS, type: NODE_EQUIVALENCE, actor, cardId: null, pr: null, head: null, dedupeKey: `${NODE_EQUIVALENCE}:test-${sequence}`, payload: { same: [], only_node: onlyNode, only_derive: onlyDerive, event_id: sequence }, legacy: false })
  return Number((db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
}

describe('bus:window', () => {
  it('counts the completions in a row each detected by its own key and stops at the first without one', () => {
    const db = newBus()
    complete(db, 'update', 1, 'event')
    complete(db, 'update', 2, null)
    complete(db, 'update', 3, 'tick')
    const fourth = complete(db, 'update', 4, 'event')
    const fifth = complete(db, 'update', 5, 'event')
    complete(db, 'merge', 6, null)
    const count = windowOf(db, 'update')
    expect(count.run.map(entry => entry.key)).toEqual([fifth, fourth])
    expect(count.run.map(entry => entry.tasks)).toEqual([1, 1])
    expect(count.stop?.cardId).toBe(3)
    expect(count.stop?.why).toContain('via event')
    expect(windowLines(count)[0]).toBe('[bus:window] update: N 2')
    expect(windowOf(db, 'merge').run).toEqual([])
    db.close()
  })

  it('stops at a completion with two review tasks of one card, pr and head under two review inputs', () => {
    expect(stopOf({ tasks: 2 }, 'review')).toBe(`2 review tasks for card 2 pr 1002 head ${headOf(2)}, not one`)
  })

  it('stops at a completion with no task and says so', () => {
    expect(stopOf({ tasks: 0 })).toBe(`0 merge tasks for card 2 pr 1002 head ${headOf(2)}, not one`)
  })

  it('stops at a detection whose payload names another key than its dedupe key', () => {
    expect(stopOf({ payloadKey: 'merge:other' })).toContain('no live node.detected')
  })

  it('counts a detection with outcome already and stops at one with another outcome', () => {
    expect(stopOf({ outcome: 'skipped' })).toContain('via event before it')
    const db = newBus()
    complete(db, 'merge', 1, 'event', { outcome: 'already' })
    const count = windowOf(db, 'merge')
    expect(count.run).toHaveLength(1)
    expect(windowLines(count)[1]).toBe('[bus:window] stop: none, every completion is in the run')
    db.close()
  })

  it('reads no ticks without a run', () => {
    const db = newBus()
    expect(windowLines(windowOf(db, 'review'))).toEqual(['[bus:window] review: N 0', '[bus:window] stop: none, every completion is in the run', '[bus:window] equivalence: no run, no ticks read'])
    db.close()
  })

  it('prints the usage and exits 1 for a queue it does not know', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(main(['nope'])).toBe(1)
    expect(error).toHaveBeenCalledWith(`[bus:window] ${USAGE}`)
    error.mockRestore()
  })

  it('names the equivalence ticks with a key on one side only', () => {
    const db = newBus()
    tick(db, 'worker:close:s1', ['close:9'], [])
    complete(db, 'close', 7, 'event')
    const nodeSide = tick(db, 'worker:close:s1', ['close:7'], [])
    tick(db, 'worker:close:s1', [], [])
    const deriveSide = tick(db, 'worker:close:s2', [], ['close:8'])
    tick(db, 'worker:merge:s1', ['merge:7'], [])
    const count = windowOf(db, 'close')
    expect(count.ticks).toBe(3)
    expect(count.oneSided.map(entry => entry.id)).toEqual([nodeSide, deriveSide])
    expect(windowLines(count).at(-1)).toContain(`bus id ${nodeSide} (only node close:7), bus id ${deriveSide} (only derive close:8)`)
    db.close()
  })
})
