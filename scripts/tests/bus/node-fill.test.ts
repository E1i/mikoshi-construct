import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../bus/lease.js'
import type { NodeStep, Scope } from '../../bus/node.js'
import type { QueuedTask } from '../../bus/queue.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openBus } from '../../bus/db.js'
import { releaseTask, TASK_LEASED } from '../../bus/lease.js'
import { Node } from '../../bus/node.js'
import { keyOf, queueTaskWithin } from '../../bus/queue.js'
import { slotsVariable } from '../../bus/scheduler.js'
import { Clock } from './github-fake.js'

const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function newBus(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-node-fill-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function task(pr: number): QueuedTask {
  return { queue: 'review', cardId: pr + 100 }
}

class ReleasingNode extends Node<NodeStep> {
  constructor(db: DatabaseSync, readonly clock: Clock, slots: number) {
    super('review', { db, clock: clock.now, session: 'fill', mode: 'live', env: { [slotsVariable('review')]: String(slots) } })
  }

  protected candidates(_scope?: Scope): QueuedTask[] {
    return []
  }

  private readonly handled = new Set<string>()

  protected handle(lease: Lease): NodeStep {
    if (this.handled.has(lease.taskKey))
      return { kind: 'retaken', taskKey: lease.taskKey }
    this.handled.add(lease.taskKey)
    releaseTask(this.db, this.clock.now().toISOString(), lease, 'released inside handle')
    return { kind: 'released', taskKey: lease.taskKey }
  }
}

async function onePass(node: Node<NodeStep>): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function leasedEvents(db: DatabaseSync, key: string): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ? AND dedupe_key LIKE ?').get(TASK_LEASED, `${TASK_LEASED}:${key}:%`) as { n: number }).n)
}

function leaseGen(db: DatabaseSync, key: string): number {
  return Number((db.prepare('SELECT lease_gen FROM tasks WHERE task_key = ?').get(key) as { lease_gen: number }).lease_gen)
}

describe('a fill pass', () => {
  it('a node whose handle releases its task synchronously takes each key once in one fill pass, lease_gen grows by exactly 1 and the lease is not fenced before its settle', async () => {
    const db = newBus()
    const clock = new Clock()
    const node = new ReleasingNode(db, clock, 3)
    queueTaskWithin(db, clock.now().toISOString(), task(970))
    const key = keyOf(task(970))
    await onePass(node)

    expect(leasedEvents(db, key)).toBe(1)
    expect(leaseGen(db, key)).toBe(1)
    expect(node.getState().lastStep).toEqual({ kind: 'released', taskKey: key })
  })

  it('with two tasks and two slots a node whose handle releases synchronously takes both keys once in one pass', async () => {
    const db = newBus()
    const clock = new Clock()
    const node = new ReleasingNode(db, clock, 2)
    queueTaskWithin(db, clock.now().toISOString(), task(970))
    queueTaskWithin(db, clock.now().toISOString(), task(971))
    await onePass(node)

    for (const each of [task(970), task(971)]) {
      expect(leasedEvents(db, keyOf(each))).toBe(1)
      expect(leaseGen(db, keyOf(each))).toBe(1)
    }
  })
})
