import type { CardStart, CardStarter, QueuedCard, StartedCard } from '../../nodes/launch/launch-executor.js'
import type { SessionContinuer } from '../../nodes/launch/launch-starter.js'
import type { SessionStart } from '../../nodes/launch/launch-worker.js'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_CONTINUED, CARD_SESSION_ENDED, CARD_STOPPED, CARD_WAITING, OWNER_WAIT_OPENED, PR_OPENED } from '../../core/events.js'
import { MACHINE_DIR_VARIABLE, MACHINE_POLL_MS, MachineSessions, setMachineLimit } from '../../core/machine-sessions.js'
import { MACHINE_OVERLOADED, MACHINE_OVERLOADED_MARK, timeoutUnderLoadOutside } from '../../core/observations.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { joinSession, LOCK_DIR_VARIABLE, LOG_FILE, OVERLOAD_WAIT_MS, sessionWorkers, withQualityLock } from '../../quality/lock.js'
import { nodeSupply } from '../../supervisor/composition.js'
import { eventsOf, mergeBench } from '../bus/merge-bench.js'

const CARD = 1768
const TOUCHES = ['scripts/nodes/launch/**']
const OUTSIDE_TIMEOUT = 'prepush timed out under machine load in scripts/tests/supervisor/stalled-sessions.test.ts, outside the touches; the witnesses are green'
const INSIDE_TIMEOUT = 'prepush timed out under machine load in scripts/nodes/launch/launch-worker.ts; the witnesses are green'

const benches: MergeBench[] = []
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

class RetryingStarter implements CardStarter, SessionContinuer {
  starts: QueuedCard[] = []
  continued: StartedCard[] = []

  start(card: QueuedCard): CardStart {
    this.starts.push(card)
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }
  }

  stop(): void {}

  continueFrom(card: QueuedCard, from: StartedCard): CardStart {
    this.continued.push(from)
    return { kind: 'started', card: { ...from, session: `s-${card.cardId}-c${this.continued.length}` } }
  }
}

interface LoadBench {
  made: MergeBench
  node: LaunchNode
  starter: RetryingStarter
  published: number[]
}

async function sessionThatAsked(question: string, publishes: boolean): Promise<LoadBench> {
  const made = mergeBench()
  benches.push(made)
  const machineDir = mkdtempSync(path.join(tmpdir(), 'machine-load-'))
  roots.push(machineDir)
  const text = parkingFileText({ card: `#${CARD} a-card [implement/construct/S/cheap/auto] · depends — · blocks —`, branch: `feat/card-${CARD}`, touches: TOUCHES, continue: 'auto', who: 'shift', body: 'the card' })
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${CARD}`, text, textSha: textSha(text) }, legacy: false })
  made.tick()
  const starter = new RetryingStarter()
  const exited: ProcessTable = { commandLine: () => null, signalGroup: () => {} }
  const published: number[] = []
  const publish = (_card: StartedCard, start: SessionStart): void => {
    published.push(start.cardId)
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: PR_OPENED, actor: 'worker:shift:1', cardId: start.cardId, pr: 9768, head: null, dedupeKey: `${PR_OPENED}:${start.cardId}:9768`, payload: { pr: 9768 }, legacy: false })
  }
  const node = new LaunchNode({
    db: made.db,
    starter,
    continuer: starter,
    clock: made.clock.now,
    session: 'node-1',
    mode: 'live',
    env: {},
    processes: exited,
    resulted: () => true,
    handedOff: () => false,
    reportOf: () => `#${CARD} a-card\nresult: stopped on a timeout\nquestion: ${question}\n`,
    committed: () => false,
    ...(publishes ? { publish } : {}),
    machine: new MachineSessions(machineDir, () => false, 16),
    lanes: () => 4,
    disk: () => ({ bavail: 1, bsize: 1024 ** 4 }),
    isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }),
  })
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal, supply: nodeSupply() })
  made.tick()
  return { made, node, starter, published }
}

describe('a timeout under machine load', () => {
  it('a timeout under overload is retried as machine overloaded, not a stop or a question', async () => {
    const { made, node, starter, published } = await sessionThatAsked(OUTSIDE_TIMEOUT, false)

    expect(node.stopOverdue()).toEqual([])
    made.tick()

    expect(eventsOf(made.db, CARD_WAITING)).toEqual([expect.objectContaining({ reason: MACHINE_OVERLOADED, detail: expect.stringContaining(MACHINE_OVERLOADED_MARK) })])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
    expect(eventsOf(made.db, OWNER_WAIT_OPENED)).toEqual([])
    expect(eventsOf(made.db, BOARD_ALARM)).toEqual([])
    expect(starter.continued.map(card => card.session)).toEqual([`s-${CARD}`])
    expect(eventsOf(made.db, CARD_CONTINUED)).toHaveLength(1)
    expect(published).toEqual([])
  })

  it('a timeout under overload with a publisher is pushed for CI to judge, with no question', async () => {
    const { made, node, starter, published } = await sessionThatAsked(OUTSIDE_TIMEOUT, true)

    expect(node.stopOverdue()).toEqual([])
    made.tick()

    expect(published).toEqual([CARD])
    expect(eventsOf(made.db, CARD_SESSION_ENDED)).toEqual([expect.objectContaining({ published: true, detail: expect.stringContaining(MACHINE_OVERLOADED_MARK) })])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
    expect(eventsOf(made.db, OWNER_WAIT_OPENED)).toEqual([])
    expect(starter.continued).toEqual([])
  })

  it('a timeout on a path inside the touches stays a question for the owner', async () => {
    const { made, node, published } = await sessionThatAsked(INSIDE_TIMEOUT, true)

    expect(node.stopOverdue()).toEqual([CARD])
    made.tick()

    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([expect.objectContaining({ reason: 'question.agent' })])
    expect(eventsOf(made.db, CARD_WAITING)).toEqual([])
    expect(published).toEqual([])
  })

  it('names a timeout under load only when it says both, on paths all outside the touches', () => {
    const outside = (paths: readonly string[]): string[] => paths.filter(file => !file.startsWith('scripts/nodes/launch/'))
    expect(timeoutUnderLoadOutside(OUTSIDE_TIMEOUT, outside)).toBe(true)
    expect(timeoutUnderLoadOutside('таймаут под нагрузкой: scripts/tests/ci/select.test.ts', outside)).toBe(true)
    expect(timeoutUnderLoadOutside(INSIDE_TIMEOUT, outside)).toBe(false)
    expect(timeoutUnderLoadOutside('prepush timed out in scripts/tests/ci/select.test.ts', outside)).toBe(false)
    expect(timeoutUnderLoadOutside('the machine is under load; scripts/tests/ci/select.test.ts fails an assertion', outside)).toBe(false)
    expect(timeoutUnderLoadOutside('prepush timed out under machine load', outside)).toBe(false)
  })
})

const CORES = 16
const SESSIONS = 2
const BUSY_FROM_OUTSIDE = 12

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'machine-load-'))
  roots.push(root)
  return root
}

describe('the worker budget and the starts read the load of the machine', () => {
  it('cores busy from outside shrink sessionWorkers below cores over sessions', () => {
    vi.spyOn(os, 'availableParallelism').mockReturnValue(CORES)
    vi.stubEnv(LOCK_DIR_VARIABLE, scratch())
    const machineDir = scratch()
    setMachineLimit(machineDir, SESSIONS)
    vi.stubEnv(MACHINE_DIR_VARIABLE, machineDir)

    const workers = sessionWorkers(`/tree/loaded-${process.pid}`, { read: () => ({ busy: BUSY_FROM_OUTSIDE, cores: CORES }) })

    expect(workers).toBeLessThan(CORES / SESSIONS)
    expect(workers).toBe(CORES - 1 - BUSY_FROM_OUTSIDE)
  })

  it('launch does not start a session while the load is over the threshold', async () => {
    const made = mergeBench()
    benches.push(made)
    const text = parkingFileText({ card: `#${CARD} a-card [implement/construct/S/cheap/auto] · depends — · blocks —`, branch: `feat/card-${CARD}`, touches: TOUCHES, continue: 'auto', who: 'shift', body: 'the card' })
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${CARD}`, text, textSha: textSha(text) }, legacy: false })
    made.tick()
    let busy = CORES * 2
    const machine = new MachineSessions(scratch(), () => false, CORES, made.clock.now, { read: () => ({ busy, cores: CORES }) })
    const starter = new RetryingStarter()
    const node = new LaunchNode({
      db: made.db,
      starter,
      continuer: starter,
      clock: made.clock.now,
      session: 'node-1',
      mode: 'live',
      env: {},
      processes: { commandLine: () => null, signalGroup: () => {} },
      machine,
      lanes: () => 4,
      disk: () => ({ bavail: 1, bsize: 1024 ** 4 }),
      isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }),
    })
    const once = async (): Promise<void> => {
      const controller = new AbortController()
      await node.run({ pause: async () => controller.abort(), signal: controller.signal, supply: nodeSupply() })
      made.tick()
    }

    await once()
    expect(starter.starts).toEqual([])
    expect(machine.held()).toEqual(expect.objectContaining({ load: { busy, cores: CORES } }))

    busy = 1
    made.clock.advance(MACHINE_POLL_MS + 1)
    await once()
    expect(starter.starts.map(card => card.cardId)).toEqual([CARD])
  })
})

describe('the edges of the load gate', () => {
  const machineAt = (busy: number): MachineSessions => new MachineSessions(scratch(), () => true, CORES, () => new Date(), { read: () => ({ busy, cores: CORES }) })

  it('a load exactly at the cores is overload, and just below it is not', () => {
    expect(machineAt(CORES).overload()).toEqual({ busy: CORES, cores: CORES })
    expect(machineAt(CORES).claim({ bus: 'b', role: 'review', cardId: 1 }).kind).toBe('refused')
    expect(machineAt(CORES - 0.01).overload()).toBeNull()
    expect(machineAt(CORES - 0.01).free()).toBeGreaterThan(0)
  })

  it('the workers other runs hold count when they exceed the measured load', () => {
    const dir = scratch()
    const run = { dir, sessionLimit: 1, cores: CORES, isAlive: () => true }
    expect(joinSession({ ...run, tree: '/tree/a', pid: 101, busy: 0 })).toBe(CORES - 1)
    expect(joinSession({ ...run, tree: '/tree/b', pid: 102, busy: 2 })).toBe(1)
  })
})

describe('a test run under overload', () => {
  function lockedRun(overload: () => { busy: number, cores: number } | null): { result: Promise<number>, started: () => number, dir: string, said: string[] } {
    const dir = scratch()
    let now = 0
    let startedAt = -1
    const said: string[] = []
    const result = withQualityLock({
      dir,
      pid: process.pid,
      cwd: '/tree/a',
      now: () => new Date(now),
      isAlive: () => true,
      sleep: async (ms) => {
        now += ms
      },
      say: line => said.push(line),
      run: async () => {
        startedAt = now
        return 0
      },
      overload,
    })
    return { result, started: () => startedAt, dir, said }
  }

  it('waits in the queue while the load is over the threshold and starts once it falls', async () => {
    const readings = [{ busy: 40, cores: CORES }, { busy: 30, cores: CORES }, null]
    const run = lockedRun(() => readings.shift() ?? null)
    expect(await run.result).toBe(0)
    expect(run.started()).toBeGreaterThan(0)
    const events = readFileSync(path.join(run.dir, LOG_FILE), 'utf8').trim().split('\n').map(line => (JSON.parse(line) as { event: string }).event)
    expect(events).toEqual(['overload', 'start', 'end'])
  })

  it('starts after the longest wait when the load never falls', async () => {
    const run = lockedRun(() => ({ busy: 40, cores: CORES }))
    expect(await run.result).toBe(0)
    expect(run.started()).toBe(OVERLOAD_WAIT_MS)
    expect(run.said.at(-1)).toContain('still overloaded')
  })

  it('starts at once on a machine under the threshold', async () => {
    const run = lockedRun(() => null)
    expect(await run.result).toBe(0)
    expect(run.started()).toBe(0)
  })
})
