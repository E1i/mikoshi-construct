import type { Scope } from '../../bus/node.js'
import type { QueuedTask } from '../../bus/queue.js'
import type { MergeBench } from './merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloseNode } from '../../bus/close-worker.js'
import { detectionMode } from '../../bus/node.js'
import { CARD_CLOSED, keyOf, TASK_ENQUEUED } from '../../bus/queue.js'
import { bgCommand } from '../../bus/supervisor.js'
import { liveWorkers, switchDetection, switchWorker, wantedLaunches, WORKERS } from '../../bus/workers.js'
import { sha } from './github-fake.js'
import { cardVerified, eventsOf, mergeBench } from './merge-bench.js'

interface Bench extends MergeBench {
  root: string
}

const benches: Bench[] = []
const NO_PREFLIGHT = (): string[] => []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0)) {
    made.close()
    rmSync(made.root, { recursive: true, force: true })
  }
})

class ProbedCloseNode extends CloseNode {
  private calls = 0
  private failOnCall: number | null = null

  failOnNextCall(after: number): void {
    this.failOnCall = this.calls + after
  }

  protected override candidates(scope?: Scope): QueuedTask[] {
    this.calls += 1
    if (this.calls === this.failOnCall)
      throw new Error('injected in the middle of a batch')
    return super.candidates(scope)
  }
}

function bench(): Bench {
  const made = { ...mergeBench(), root: mkdtempSync(path.join(tmpdir(), 'bus-close-live-')) }
  benches.push(made)
  return made
}

function liveNode(made: Bench): ProbedCloseNode {
  return new ProbedCloseNode({ db: made.db, reported: () => 'run', clock: made.clock.now, session: 'node-1', journal: path.join(made.root, 'ghosts.jsonl'), parking: path.join(made.root, 'parking'), mode: 'live', env: {}, trees: { remove: () => null } })
}

async function once(node: CloseNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function mergedAndVerified(made: Bench, pr: number): void {
  made.gitHub.open({ number: pr })
  made.tick()
  cardVerified(made.db, made.clock.now().toISOString(), pr + 100, pr)
  made.gitHub.close(pr, true)
}

function count(made: Bench, sql: string, ...args: (string | number)[]): number {
  return Number((made.db.prepare(sql).get(...args) as { n: number }).n)
}

function closeTasks(made: Bench, pr: number): number {
  return count(made, `SELECT count(*) AS n FROM tasks WHERE queue = 'close' AND pr = ?`, pr)
}

function enqueuedOf(made: Bench, pr: number): number {
  return count(made, `SELECT count(*) AS n FROM events WHERE type = ? AND json_extract(payload, '$.task_key') = ?`, TASK_ENQUEUED, keyOf({ queue: 'close', cardId: pr + 100, pr, head: sha('a') }))
}

type Order = 'node first' | 'deriveQueues first' | 'same tick'

const ORDERS: Order[] = ['node first', 'deriveQueues first', 'same tick']

describe('close live', () => {
  it('a live close node and deriveQueues on one db that detect one key leave exactly one tasks row, one task.enqueued and one card.closed, whether the node, deriveQueues or the same tick comes first', async () => {
    for (const order of ORDERS) {
      const made = bench()
      mergedAndVerified(made, 990)
      const node = liveNode(made)
      if (order === 'node first') {
        await once(node)
        made.tick()
      }
      else if (order === 'deriveQueues first') {
        made.tick()
        await once(node)
      }
      else {
        const pass = once(node)
        made.tick()
        await pass
      }
      await once(node)
      made.tick()
      await once(node)

      expect(closeTasks(made, 990), order).toBe(1)
      expect(enqueuedOf(made, 990), order).toBe(1)
      expect(eventsOf(made.db, CARD_CLOSED), order).toEqual([{ verification: 'run' }])
    }
  })

  it('a live close node restarted mid-batch writes no second task and no second card.closed', async () => {
    const made = bench()
    for (const pr of [988, 989])
      made.gitHub.open({ number: pr })
    made.tick()
    for (const pr of [988, 989])
      made.gitHub.close(pr, true)
    made.tick()
    const node = liveNode(made)
    await once(node)
    for (const pr of [988, 989])
      cardVerified(made.db, made.clock.now().toISOString(), pr + 100, pr)
    node.failOnNextCall(2)
    await expect(once(node)).rejects.toThrow('injected in the middle of a batch')

    const restarted = liveNode(made)
    await once(restarted)
    made.tick()
    await once(restarted)
    await once(liveNode(made))
    made.tick()
    await once(restarted)

    for (const pr of [988, 989]) {
      expect(closeTasks(made, pr)).toBe(1)
      expect(enqueuedOf(made, pr)).toBe(1)
    }
    expect(eventsOf(made.db, CARD_CLOSED)).toEqual([{ verification: 'run' }, { verification: 'run' }])
  })

  it('with no switch set every node starts in shadow, and the switch for one worker changes only that worker with no code edit', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-close-switch-'))
    try {
      for (const worker of WORKERS)
        switchWorker(root, worker, true)
      const modes = (): Record<string, string> => Object.fromEntries(wantedLaunches(root, NO_PREFLIGHT).filter(launch => launch.script !== 'bus:run').map(launch => [launch.script, detectionMode(launch.args)]))
      const shadowEverywhere = Object.fromEntries(WORKERS.map(worker => [`bus:${worker}`, 'shadow']).filter(([script]) => script !== 'bus:review'))
      expect(Object.keys(modes()).sort()).toEqual(expect.arrayContaining(Object.keys(shadowEverywhere)))
      expect(Object.values(modes()).every(mode => mode === 'shadow')).toBe(true)

      expect(bgCommand(['--live', 'close'])).toEqual({ kind: 'detection', worker: 'close', live: true })
      expect(bgCommand(['--shadow', 'close'])).toEqual({ kind: 'detection', worker: 'close', live: false })

      expect(switchDetection(root, 'close', true)).toEqual(['close'])
      expect(modes()).toEqual({ ...Object.fromEntries(Object.keys(modes()).map(script => [script, 'shadow'])), 'bus:close': 'live' })
      const closeArgs = wantedLaunches(root, NO_PREFLIGHT).find(launch => launch.script === 'bus:close')!.args
      expect(closeArgs).toEqual(['--on', '--live'])

      switchWorker(root, 'merge', false)
      expect(liveWorkers(root)).toEqual(['close'])
      expect(modes()['bus:close']).toBe('live')

      expect(switchDetection(root, 'close', false)).toEqual([])
      expect(Object.values(modes()).every(mode => mode === 'shadow')).toBe(true)
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
