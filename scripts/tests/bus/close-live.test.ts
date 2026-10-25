import type { Scope } from '../../core/node.js'
import type { QueuedTask } from '../../core/queue.js'
import type { MergeBench } from './merge-bench.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CARD_CLOSED, NODE_DETECTED, TASK_ENQUEUED } from '../../core/events.js'
import { detectionMode } from '../../core/node.js'
import { keyOf } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { CloseNode } from '../../nodes/close/close-worker.js'
import { NetWatch, TICK_MS } from '../../ports/netwatch.js'
import { bgCommand, detectionCommand } from '../../supervisor/supervisor.js'
import { liveWorkers, switchDetection, switchWorker, wantedLaunches, WORKERS, WORKERS_FILE } from '../../supervisor/workers.js'
import { detectClose } from './close-detection.js'
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
  return new ProbedCloseNode({ db: made.db, reported: () => 'run', clock: made.clock.now, session: 'node-1', parking: path.join(made.root, 'parking'), mode: 'live', env: {}, trees: { remove: () => null } })
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

  it('a live close node and deriveQueues on one db write one task.enqueued and exactly one node.detected with outcome queued, whichever of them ticks first', async () => {
    for (const order of ['node first', 'deriveQueues first'] as const) {
      const made = bench()
      mergedAndVerified(made, 990)
      const node = liveNode(made)
      if (order === 'node first') {
        new NetWatch(made.db, made.gitHub.client, made.clock.now).poll()
        reduce(made.db)
        made.clock.advance(TICK_MS)
        await once(node)
        made.tick()
      }
      else {
        made.tick()
        await once(node)
      }
      await once(node)
      made.tick()
      await once(node)

      expect(enqueuedOf(made, 990), order).toBe(1)
      const key = keyOf({ queue: 'close', cardId: 1090, pr: 990, head: sha('a') })
      const detected = eventsOf(made.db, NODE_DETECTED).filter(payload => payload.key === key)
      expect(detected, order).toHaveLength(1)
      expect(detected[0]!.outcome, order).toBe('queued')
    }
  })

  it('deriveQueues alone enqueues no close task', () => {
    const made = bench()
    mergedAndVerified(made, 990)
    made.tick()
    made.tick()
    expect(closeTasks(made, 990)).toBe(0)
    expect(enqueuedOf(made, 990)).toBe(0)
    expect(count(made, `SELECT count(*) AS n FROM events WHERE type = ? AND json_extract(payload, '$.queue') = 'close'`, TASK_ENQUEUED)).toBe(0)

    detectClose(made.db, made.clock.now)
    expect(closeTasks(made, 990)).toBe(1)
    expect(enqueuedOf(made, 990)).toBe(1)

    detectClose(made.db, made.clock.now)
    expect(closeTasks(made, 990)).toBe(1)
    expect(enqueuedOf(made, 990)).toBe(1)
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
    node.failOnNextCall(1)
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

  it('workers.json holds exactly the on list and no live key after a worker is switched and detection goes back to shadow', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-close-file-'))
    try {
      const file = path.join(root, WORKERS_FILE)
      switchWorker(root, 'close', true)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ on: ['close'] })
      switchDetection(root, 'close', true)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ on: ['close'], live: ['close'] })
      switchDetection(root, 'close', false)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ on: ['close'] })
      switchWorker(root, 'close', false)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ on: [] })
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a worker listed live but switched off gets no launch, and the other on-workers stay without the live flag', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-close-off-'))
    try {
      switchWorker(root, 'merge', true)
      switchWorker(root, 'update', true)
      switchDetection(root, 'close', true)
      switchDetection(root, 'merge', true)
      switchWorker(root, 'merge', false)
      const launches = wantedLaunches(root, NO_PREFLIGHT).filter(launch => launch.script !== 'bus:run')
      expect(launches.map(launch => launch.script)).toEqual(['bus:update'])
      expect(launches.map(launch => launch.args)).toEqual([['--on']])
      expect(liveWorkers(root)).toEqual(['merge', 'close'])
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('detectionCommand refuses an unknown or empty worker with exit code 1 and answers a valid one with the live list and the restart note', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-close-command-'))
    try {
      for (const worker of ['deploy', '']) {
        const refused = detectionCommand(root, worker, true, [])
        expect(refused.exitCode).toBe(1)
        expect(refused.stdout).toEqual([])
        expect(refused.stderr.join('\n')).toContain(worker === '' ? 'no worker named' : `unknown worker ${worker}`)
        expect(refused.stderr.join('\n')).toContain(WORKERS.join(', '))
      }
      const accepted = detectionCommand(root, 'close', true, [{ decisionId: 1, text: '[owner] allow-live close', cards: [] }])
      expect(accepted.exitCode).toBe(0)
      expect(accepted.stderr).toEqual([])
      expect(accepted.stdout.join('\n')).toContain('detecting live: close')
      expect(accepted.stdout.join('\n')).toContain('a worker already running changes mode when it is switched off and on')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('liveWorkers throws on a live that is not an array and on a live with an unknown worker name', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-close-malformed-'))
    try {
      const file = path.join(root, WORKERS_FILE)
      writeFileSync(file, '{"on":[],"live":"close"}')
      expect(() => liveWorkers(root)).toThrow(WORKERS_FILE)
      writeFileSync(file, '{"on":[],"live":["deploy"]}')
      expect(() => liveWorkers(root)).toThrow(WORKERS_FILE)
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
