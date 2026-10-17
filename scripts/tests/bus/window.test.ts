import type { DatabaseSync } from 'node:sqlite'
import type { Via } from '../../bus/node.js'
import type { WindowQueue } from '../../bus/window.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { NODE_DETECTED, NODE_EQUIVALENCE } from '../../bus/node.js'
import { keyOf, queueTask } from '../../bus/queue.js'
import { COMPLETION_OF, windowLines, windowOf } from '../../bus/window.js'

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

function complete(db: DatabaseSync, queue: WindowQueue, card: number, detection: Via | null): string {
  const task = { queue, cardId: card, pr: card + 1000, head: headOf(card) }
  queueTask(db, TS, task)
  const key = keyOf(task)
  if (detection !== null)
    appendEvent(db, { ts: TS, type: NODE_DETECTED, actor: `worker:${queue}:s1`, cardId: card, pr: task.pr, head: task.head, dedupeKey: `${NODE_DETECTED}:${queue}:${key}`, payload: { key, via: detection, event_id: 1, outcome: 'queued' }, legacy: false })
  appendEvent(db, { ts: TS, type: COMPLETION_OF[queue], actor: `worker:${queue}:s1`, cardId: card, pr: task.pr, head: task.head, dedupeKey: `${COMPLETION_OF[queue]}:${key}`, payload: {}, legacy: false })
  return key
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
