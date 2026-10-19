import type { ProcessTable } from '../../bus/chain-process.js'
import type { CardStart, CardStarter, QueuedCard, StartedCard } from '../../bus/launch-executor.js'
import type { DetachedSpawn, StarterPorts } from '../../bus/launch-starter.js'
import type { LaunchNodeParts, LaunchStep } from '../../bus/launch-worker.js'
import type { Lease } from '../../bus/lease.js'
import type { DetectionMode } from '../../bus/node.js'
import type { QueuedTask } from '../../bus/queue.js'
import type { IsolationReader } from '../../ghosts/isolation.js'
import type { MergeBench } from './merge-bench.js'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { CARD_FELL, GHOST_ROW, PR_OPENED, STOPPED_CARD } from '../../bus/card-automaton.js'
import { appendEvent } from '../../bus/db.js'
import { CARD_STARTED, CARD_STOPPED } from '../../bus/inbox.js'
import { LadderCardStarter } from '../../bus/ladder-starter.js'
import { CARD_ADMITTED } from '../../bus/launch-candidates.js'
import { LaunchExecutor } from '../../bus/launch-executor.js'
import { CARD_PULSE, handoffLadderSteps, hasCommitsAhead, LAUNCH_LIMIT_MINUTES, launchIsolationCommand, LaunchNode, noPullRequestDetail, PULSE_MINUTES, reportResultLine, reportWrittenSince, SESSION_DEATH_CAP } from '../../bus/launch-worker.js'
import { leaseNext } from '../../bus/lease.js'
import { NODE_CURSORS, NODE_DETECTED, NODE_EQUIVALENCE } from '../../bus/node.js'
import { PR_CLOSED } from '../../bus/observations.js'
import { keyOf, launchTasks, queueTask, TASK_ENQUEUED } from '../../bus/queue.js'
import { reduce } from '../../bus/reducer.js'
import { approvalSha256, canonicalImplementText } from '../../ghosts/approval.js'
import { WORKTREE_HOME_VARIABLE } from '../../ghosts/worktree-home.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench, taskState } from './merge-bench.js'
import { detectReview } from './review-detection.js'

const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })

const benches: MergeBench[] = []
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

class FakeStarter implements CardStarter {
  starts: QueuedCard[] = []
  stops: StartedCard[] = []

  start(card: QueuedCard): CardStart {
    this.starts.push(card)
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }
  }

  stop(card: StartedCard): void {
    this.stops.push(card)
  }
}

class ProbedLaunchNode extends LaunchNode {
  failOnCall: number | null = null
  private calls = 0

  found(): string[] {
    return this.candidates().map(keyOf)
  }

  protected override candidates(): QueuedTask[] {
    this.calls += 1
    if (this.calls === this.failOnCall)
      throw new Error('injected in the middle of a batch')
    return super.candidates()
  }

  failOnNextCall(after: number): void {
    this.failOnCall = this.calls + after
  }
}

class DetectingLaunchNode extends ProbedLaunchNode {
  protected override handle(lease: Lease): LaunchStep {
    return { kind: 'fenced', taskKey: lease.taskKey }
  }
}

function bench(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  return made
}

function nodeOf(made: MergeBench, mode: DetectionMode = 'shadow', starter: CardStarter = new FakeStarter()): ProbedLaunchNode {
  const parts: LaunchNodeParts = { db: made.db, starter, clock: made.clock.now, session: 'node-1', mode, env: {}, isolation: sandboxed }
  return new DetectingLaunchNode(parts)
}

async function once(node: LaunchNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function launchKey(cardId: number): string {
  return keyOf({ queue: 'launch', cardId, generation: `admission-${cardId}` })
}

function admit(made: MergeBench, cardId: number, lane: string, depends: number[] = [], contour = 'cheap'): number {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane, decision: 'auto', contour, depends, admission: `admission-${cardId}` }, legacy: false })
  return lastEventOf(made, CARD_ADMITTED)
}

function stopped(made: MergeBench, cardId: number): number {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STOPPED, actor: 'worker:launch:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${cardId}`, payload: { reason: 'question.owner' }, legacy: false })
  return lastEventOf(made, CARD_STOPPED)
}

function startedEarlier(made: MergeBench, cardId: number): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:earlier-${cardId}`, payload: { session: 'earlier' }, legacy: false })
}

function mergedWithoutDerive(made: MergeBench, pr: number): number {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: PR_CLOSED, actor: 'netwatch', cardId: pr + 100, pr, head: null, dedupeKey: `${PR_CLOSED}:${pr}:merged`, payload: { merged: true }, legacy: false })
  reduce(made.db)
  return lastEventOf(made, PR_CLOSED)
}

function lastEventOf(made: MergeBench, type: string): number {
  const row = made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(type) as { id: number | null }
  return Number(row.id)
}

function byEvent(made: MergeBench): Record<string, unknown>[] {
  return eventsOf(made.db, NODE_DETECTED).filter(each => each.via === 'event')
}

function derivedKeys(made: MergeBench): string[] {
  return launchTasks(made.db).map(keyOf)
}

function launchRows(made: MergeBench, cardId: number): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'launch' AND card_id = ?`).get(cardId) as { n: number }).n)
}

function enqueuedOf(made: MergeBench, key: string): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM events WHERE type = ? AND json_extract(payload, '$.task_key') = ?`).get(TASK_ENQUEUED, key) as { n: number }).n)
}

function cursorOf(made: MergeBench): number {
  return Number((made.db.prepare(`SELECT event_id FROM ${NODE_CURSORS} WHERE kind = 'launch'`).get() as { event_id: number }).event_id)
}

describe('the launch node', () => {
  it('an admitted card with a free lane and a depends settled by a merge are each detected by their event and by a tick', async () => {
    const made = bench()
    const earlier = bench()
    admit(earlier, 912, 'lane-c')
    await once(nodeOf(earlier))
    expect(eventsOf(earlier.db, NODE_DETECTED)).toEqual([{ key: launchKey(912), via: 'tick', event_id: expect.any(Number) as unknown }])

    made.gitHub.open({ number: 990 })
    made.tick()
    const node = nodeOf(made)
    await once(node)
    const free = admit(made, 910, 'lane-a')
    admit(made, 911, 'lane-b', [1090])
    await once(node)
    expect(byEvent(made)).toEqual([{ key: launchKey(910), via: 'event', event_id: free }])

    const merge = mergedWithoutDerive(made, 990)
    await once(node)
    expect(byEvent(made)).toEqual([{ key: launchKey(910), via: 'event', event_id: free }, { key: launchKey(911), via: 'event', event_id: merge }])
  })

  it('an event of card A changes the candidate of card B in the same lane: the node recomputes the whole queue on every event', async () => {
    const made = bench()
    admit(made, 920, 'lane-a')
    admit(made, 921, 'lane-a')
    const node = nodeOf(made)
    await once(node)
    expect(node.found()).toEqual([launchKey(920)])

    const proof = stopped(made, 920)
    await once(node)
    expect(byEvent(made)).toEqual([{ key: launchKey(921), via: 'event', event_id: proof }])
    expect(node.found()).toEqual([launchKey(921)])
  })

  it('the node and launchTasks find one set on one snapshot, and shadow records node.equivalence with nothing on one side only', async () => {
    const made = bench()
    admit(made, 930, 'lane-a')
    admit(made, 931, 'lane-a')
    admit(made, 932, 'lane-b', [1090])
    admit(made, 933, 'lane-c')
    startedEarlier(made, 933)
    const node = nodeOf(made)
    const keys = [launchKey(930)]

    expect(node.found()).toEqual(keys)
    expect(node.found()).toEqual(derivedKeys(made))

    const enqueued = keys.map(key => enqueuedOf(made, key))
    await once(node)
    expect(eventsOf(made.db, NODE_EQUIVALENCE)).toEqual([{ same: keys, only_node: [], only_derive: [], event_id: expect.any(Number) as unknown }])
    expect(keys.map(key => enqueuedOf(made, key))).toEqual(enqueued)
  })

  it('i1: in live mode the node and deriveQueues detect one key, and there is one task row and one task.enqueued', async () => {
    const made = bench()
    const node = nodeOf(made, 'live')
    await once(node)

    admit(made, 940, 'lane-a')
    await once(node)
    expect(enqueuedOf(made, launchKey(940))).toBe(1)
    made.tick()
    await once(node)
    made.tick()

    expect(launchRows(made, 940)).toBe(1)
    expect(enqueuedOf(made, launchKey(940))).toBe(1)
  })

  it('i2: a failure in the middle of a batch rolls back the cursor with its records, and the restart detects each candidate once', async () => {
    const made = bench()
    const node = nodeOf(made)
    await once(node)
    const cursor = cursorOf(made)

    const first = admit(made, 950, 'lane-a')
    admit(made, 951, 'lane-b')
    node.failOnNextCall(2)
    await expect(once(node)).rejects.toThrow('injected in the middle of a batch')
    expect(byEvent(made)).toEqual([])
    expect(cursorOf(made)).toBe(cursor)

    await once(node)
    expect(byEvent(made)).toEqual([{ key: launchKey(950), via: 'event', event_id: first }, { key: launchKey(951), via: 'event', event_id: first }])
  })

  it('i3: a cursor reset to 0 gives no second detection and no second task', async () => {
    for (const mode of ['shadow', 'live'] as const) {
      const made = bench()
      const node = nodeOf(made, mode)
      await once(node)
      admit(made, 960, 'lane-a')
      await once(node)
      made.tick()
      const counts = (): object => ({ detected: eventsOf(made.db, NODE_DETECTED).length, enqueued: enqueuedOf(made, launchKey(960)), tasks: launchRows(made, 960) })
      await once(node)
      const before = counts()

      made.db.prepare(`UPDATE ${NODE_CURSORS} SET event_id = 0`).run()
      await once(node)
      made.tick()
      await once(node)
      expect(counts(), mode).toEqual(before)
    }
  })

  it('the launch node takes one task at a time in arrival order and starts it through the LaunchExecutor and its starter as the worker did', async () => {
    const made = bench()
    const starter = new FakeStarter()
    admit(made, 970, 'lane-a')
    admit(made, 971, 'lane-b')
    made.tick()
    const node = new ProbedLaunchNode({ db: made.db, starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, isolation: sandboxed })
    expect(node.slots).toBe(1)

    await once(node)
    expect(starter.starts.map(card => card.cardId)).toEqual([970])
    expect(taskState(made.db, launchKey(970))).toMatchObject({ state: 'completed' })
    expect(taskState(made.db, launchKey(971))).toMatchObject({ state: 'queued' })
    expect(eventsOf(made.db, CARD_STARTED)).toEqual([{ session: 's-970', worktree: '/trees/mc-970', branch: 'feat/card-970', base: 'f'.repeat(40), pid: 4242, pgid: 4242, contour: 'cheap', isolation: 'full', isolationGaps: [] }])

    await once(node)
    expect(starter.starts.map(card => card.cardId)).toEqual([970, 971])
  })

  it('the session input is rebuilt from card.started alone with no handoff directory', () => {
    const made = bench()
    const root = mkdtempSync(path.join(tmpdir(), 'bus-launch-input-'))
    roots.push(root)
    const prompt = 'Shift task 970\n\nthe card body'
    const starter: CardStarter = {
      start: card => ({ kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242, input: { prompt } } }),
      stop: () => {},
    }
    admit(made, 970, 'lane-a')
    made.tick()
    const ts = made.clock.now().toISOString()
    queueTask(made.db, ts, { queue: 'launch', cardId: 970, generation: 'admission-970' })
    const executor = new LaunchExecutor({ db: made.db, starter, clock: made.clock.now, isolation: sandboxed, prompts: path.join(root, 'prompts') })

    expect(executor.launch(leaseNext(made.db, ts, 'launch', 'worker:launch:t')!)).toMatchObject({ kind: 'started' })
    const [started] = eventsOf(made.db, CARD_STARTED) as { prompt_sha: string, prompt_path: string, input?: unknown }[]
    expect(existsSync(path.join(root, 'handoff'))).toBe(false)
    expect(started!.input).toBeUndefined()
    const rebuilt = readFileSync(started!.prompt_path, 'utf8')
    expect(rebuilt).toBe(prompt)
    expect(createHash('sha256').update(rebuilt).digest('hex')).toBe(started!.prompt_sha)
  })

  it('card.started is recorded with the prompt sha and the reason when the prompt cannot be stored', () => {
    const made = bench()
    const root = mkdtempSync(path.join(tmpdir(), 'bus-launch-input-'))
    roots.push(root)
    const blocker = path.join(root, 'a-file')
    writeFileSync(blocker, '')
    const starter: CardStarter = {
      start: card => ({ kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242, input: { prompt: 'the launch prompt' } } }),
      stop: () => {},
    }
    admit(made, 970, 'lane-a')
    made.tick()
    const ts = made.clock.now().toISOString()
    queueTask(made.db, ts, { queue: 'launch', cardId: 970, generation: 'admission-970' })
    const executor = new LaunchExecutor({ db: made.db, starter, clock: made.clock.now, isolation: sandboxed, prompts: path.join(blocker, 'prompts') })

    expect(executor.launch(leaseNext(made.db, ts, 'launch', 'worker:launch:t')!)).toMatchObject({ kind: 'started' })
    const [started] = eventsOf(made.db, CARD_STARTED)
    expect(started).toMatchObject({ prompt_sha: createHash('sha256').update('the launch prompt').digest('hex'), prompt_unstored: expect.any(String) as unknown })
    expect(started).not.toHaveProperty('prompt_path')
  })

  it('in shadow the launch node writes node.detected and starts no session', async () => {
    const made = bench()
    const starter = new FakeStarter()
    admit(made, 975, 'lane-a')
    made.tick()
    const node = new ProbedLaunchNode({ db: made.db, starter, clock: made.clock.now, session: 'node-1', mode: 'shadow', env: {}, isolation: sandboxed })

    await once(node)
    await once(node)
    expect(starter.starts).toEqual([])
    expect(eventsOf(made.db, CARD_STARTED)).toEqual([])
    expect(taskState(made.db, launchKey(975))).toMatchObject({ state: 'queued' })

    const detecting = bench()
    admit(detecting, 975, 'lane-a')
    const detectingStarter = new FakeStarter()
    await once(new ProbedLaunchNode({ db: detecting.db, starter: detectingStarter, clock: detecting.clock.now, session: 'node-1', mode: 'shadow', env: {}, isolation: sandboxed }))
    expect(detectingStarter.starts).toEqual([])
    expect(eventsOf(detecting.db, NODE_DETECTED)).toEqual([{ key: launchKey(975), via: 'tick', event_id: expect.any(Number) as unknown }])
  })

  it('a launched session that ends with no PR, commit or handoff gives card.stopped with a reason and the card is queued again', async () => {
    const made = bench()
    const starter = new FakeStarter()
    admit(made, 976, 'lane-a')
    made.tick()
    let alive = true
    const processes: ProcessTable = { commandLine: () => alive ? 'sh -c claude -p --session-id s-976' : null, signalGroup: () => {} }
    const node = new ProbedLaunchNode({ db: made.db, starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, isolation: sandboxed })

    await once(node)
    expect(starter.starts).toHaveLength(1)
    made.tick()
    expect(node.stopOverdue()).toEqual([])
    expect(node.found()).toEqual([])

    alive = false
    expect(node.stopOverdue()).toEqual([976])
    expect(node.stopOverdue()).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([{ reason: 'fault', detail: expect.stringContaining('session-end') as unknown }])

    made.tick()
    expect(launchRows(made, 976)).toBe(2)
    expect(taskState(made.db, keyOf({ queue: 'launch', cardId: 976, generation: 'session-end:card.started:launch:976:admission-976' }))).toMatchObject({ state: 'queued' })
  })

  it('the third session death of one card gives a final card.stopped naming D-104 and the card is not queued again', async () => {
    const made = bench()
    const starter = new FakeStarter()
    admit(made, 978, 'lane-a')
    made.tick()
    let alive = true
    const processes: ProcessTable = { commandLine: () => alive ? 'sh -c claude -p --session-id s-978' : null, signalGroup: () => {} }
    const node = new ProbedLaunchNode({ db: made.db, starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, isolation: sandboxed })

    for (let death = 1; death <= SESSION_DEATH_CAP; death++) {
      alive = true
      await once(node)
      made.tick()
      alive = false
      expect(node.stopOverdue()).toEqual([978])
      made.tick()
    }

    expect(starter.starts).toHaveLength(SESSION_DEATH_CAP)
    const stops = eventsOf(made.db, CARD_STOPPED) as { detail: string }[]
    expect(stops.map(stop => stop.detail.includes('D-104'))).toEqual([false, false, true])
    expect(made.db.prepare(`SELECT state FROM cards WHERE card_id = 978`).get()).toEqual({ state: STOPPED_CARD })
    expect(made.db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'launch' AND card_id = 978 AND state = 'queued'`).get()).toEqual({ n: 0 })
    await once(node)
    expect(starter.starts).toHaveLength(SESSION_DEATH_CAP)
  })

  it('a launched session that ends with a commit is not stopped', async () => {
    const made = bench()
    const starter = new FakeStarter()
    admit(made, 977, 'lane-a')
    made.tick()
    const processes: ProcessTable = { commandLine: () => null, signalGroup: () => {} }
    const node = new ProbedLaunchNode({ db: made.db, starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, resulted: () => true, isolation: sandboxed })

    await once(node)
    expect(node.stopOverdue()).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
  })

  it('in shadow stopOverdue neither stops a dead session nor signals an overdue one', async () => {
    const made = bench()
    admit(made, 979, 'lane-a')
    admit(made, 980, 'lane-b')
    made.tick()
    let alive979 = true
    const signalled: number[] = []
    const processes: ProcessTable = { commandLine: pid => pid === 979 ? (alive979 ? 'sh -c claude -p --session-id s-979' : null) : 'sh -c claude -p --session-id s-980', signalGroup: pgid => signalled.push(pgid) }
    const starter: CardStarter = { start: card => ({ kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: card.cardId, pgid: card.cardId } }), stop: card => signalled.push(card.pgid) }
    const live = new ProbedLaunchNode({ db: made.db, starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, isolation: sandboxed })
    await once(live)
    await once(live)
    expect(eventsOf(made.db, CARD_STARTED)).toHaveLength(2)
    made.tick()

    alive979 = false
    made.clock.advance(LAUNCH_LIMIT_MINUTES * 60_000 + 1)
    const shadow = new ProbedLaunchNode({ db: made.db, starter, clock: made.clock.now, session: 'node-2', mode: 'shadow', env: {}, processes, isolation: sandboxed })
    expect(shadow.stopOverdue()).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
    expect(signalled).toEqual([])
  })

  it('a launched session that left a Ghost row, or a result and a pull request, is not stopped', async () => {
    for (const left of ['pull-request', 'ghost-row'] as const) {
      const made = bench()
      admit(made, 981, 'lane-a')
      made.tick()
      const processes: ProcessTable = { commandLine: () => null, signalGroup: () => {} }
      const node = new ProbedLaunchNode({ db: made.db, starter: new FakeStarter(), clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, resulted: (_card, start) => left === 'pull-request' && start.cardId === 981, isolation: sandboxed })
      await once(node)
      made.tick()
      if (left === 'ghost-row')
        appendEvent(made.db, { ts: made.clock.now().toISOString(), type: GHOST_ROW, actor: 'policy', cardId: 981, pr: null, head: null, dedupeKey: `${GHOST_ROW}:981`, payload: { state: 'running' }, legacy: false })
      if (left === 'pull-request')
        appendEvent(made.db, { ts: made.clock.now().toISOString(), type: PR_OPENED, actor: 'worker:shift:1', cardId: 981, pr: 881, head: null, dedupeKey: `${PR_OPENED}:981:881`, payload: { pr: 881 }, legacy: false })

      expect(node.stopOverdue()).toEqual([])
      expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
    }
  })

  it('a launched session that ends with a pushed commit and no pull request gives card.stopped with its reason the #1077 case, session-end 17:46Z', async () => {
    const made = bench()
    admit(made, 1077, 'lane-a')
    made.tick()
    const result = 'result: stopped at the gate — witnesses green; quality red outside the touches'
    const processes: ProcessTable = { commandLine: () => null, signalGroup: () => {} }
    const node = new ProbedLaunchNode({ db: made.db, starter: new FakeStarter(), clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, resulted: () => true, endedWith: start => start.cardId === 1077 ? result : null, isolation: sandboxed })
    await once(node)
    made.tick()

    expect(node.stopOverdue()).toEqual([1077])
    expect(node.stopOverdue()).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([{ reason: 'fault', detail: noPullRequestDetail(1077, 's-1077', result) }])
    made.tick()
    expect(made.db.prepare(`SELECT state FROM cards WHERE card_id = 1077`).get()).toEqual({ state: STOPPED_CARD })
    expect(launchRows(made, 1077)).toBe(1)
  })

  it('a live launched session writes a pulse to the bus every N minutes', async () => {
    const made = bench()
    admit(made, 982, 'lane-a')
    made.tick()
    let alive = true
    const processes: ProcessTable = { commandLine: () => alive ? 'sh -c claude -p --session-id s-982' : null, signalGroup: () => {} }
    const node = new ProbedLaunchNode({ db: made.db, starter: new FakeStarter(), clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, isolation: sandboxed })
    await once(node)
    made.tick()
    const pulses = (): number => eventsOf(made.db, CARD_PULSE).length

    node.stopOverdue()
    expect(pulses()).toBe(0)
    made.clock.advance(PULSE_MINUTES * 60_000)
    node.stopOverdue()
    node.stopOverdue()
    expect(pulses()).toBe(1)
    made.clock.advance(PULSE_MINUTES * 60_000 - 1)
    node.stopOverdue()
    expect(pulses()).toBe(1)
    made.clock.advance(1)
    node.stopOverdue()
    expect(eventsOf(made.db, CARD_PULSE)).toEqual([
      { session: 's-982', pgid: 4242, since: expect.any(String) as unknown },
      { session: 's-982', pgid: 4242, since: expect.any(String) as unknown },
    ])

    alive = false
    made.clock.advance(PULSE_MINUTES * 60_000)
    node.stopOverdue()
    expect(pulses()).toBe(2)
  })

  it('a task of an old head is superseded by deriveQueues beside the launch node as before', async () => {
    const made = bench()
    const node = nodeOf(made)
    await once(node)

    made.gitHub.open({ number: 980 })
    made.tick()
    detectReview(made)
    made.gitHub.pulls.get(980)!.head = sha('b')
    made.tick()
    detectReview(made)
    await once(node)

    const rows = made.db.prepare(`SELECT head, state FROM tasks WHERE queue = 'review' AND pr = 980 ORDER BY id`).all()
    expect(rows).toEqual([{ head: sha('a'), state: 'superseded' }, { head: sha('b'), state: 'queued' }])
    expect(eventsOf(made.db, NODE_DETECTED).filter(detected => !String(detected.key).startsWith('review:'))).toEqual([])
  })
})

const LADDER_CARD = 9301
const APPROVED_BRIEF = `/implement ${LADDER_CARD} a-card\nthe approved body\n`
const EDITED_BRIEF = `/implement ${LADDER_CARD} a-card\nthe body edited after the approval\n`

interface LadderWorld {
  starter: LadderCardStarter
  spawned: DetachedSpawn[]
  handoff: string
  tree: string
  briefFile: string
}

function ladderWorld(handoffState: { brief: string, approved: string } | null): LadderWorld {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-ladder-node-'))
  roots.push(root)
  const parking = path.join(root, 'parking')
  const handoff = path.join(root, 'handoff')
  const tree = path.join(root, 'worktrees', `mc-${LADDER_CARD}`)
  mkdirSync(path.join(parking, 'lane-x'), { recursive: true })
  mkdirSync(handoff)
  writeFileSync(path.join(parking, 'lane-x', `${LADDER_CARD}.md`), parkingFileText({ card: `#${LADDER_CARD} a-card [implement/netwatch/M/ladder/auto] · depends — · blocks —`, branch: `feat/card-${LADDER_CARD}`, touches: ['scripts/bus/**'], continue: 'stop', who: 'shift', body: 'Do the card.' }))
  const briefFile = path.join(handoff, `brief-${LADDER_CARD}-a-card.md`)
  if (handoffState !== null) {
    mkdirSync(tree, { recursive: true })
    writeFileSync(briefFile, handoffState.brief)
    const sha256 = approvalSha256(canonicalImplementText(handoffState.approved)!)
    writeFileSync(path.join(handoff, 'ghosts.jsonl'), `${JSON.stringify({ event: 'approval', by: 'morse', card: LADDER_CARD, sha256 })}\n`)
  }
  const spawned: DetachedSpawn[] = []
  const ports: StarterPorts = {
    read: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
    cut: () => {
      mkdirSync(tree, { recursive: true })
      return tree
    },
    base: () => 'b'.repeat(40),
    spawnDetached: (run) => {
      spawned.push(run)
      return 4242
    },
    pgidOf: () => 4242,
    kill: () => {},
    uuid: () => `sess-${LADDER_CARD}`,
    envOf: () => ({}),
    prompt: task => task.body,
  }
  const steps = handoffLadderSteps(handoff, path.join(root, 'repo'), { [WORKTREE_HOME_VARIABLE]: path.join(root, 'worktrees') })
  const starter = new LadderCardStarter({ parking, launchDir: path.join(root, 'launch'), claude: 'claude', treePr: 'tree-pr', repo: path.join(root, 'repo') }, ports, steps)
  return { starter, spawned, handoff, tree, briefFile }
}

function ladderNode(made: MergeBench, world: LadderWorld, cheap: CardStarter = new FakeStarter()): ProbedLaunchNode {
  return new ProbedLaunchNode({ db: made.db, starter: cheap, ladder: world.starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, isolation: sandboxed })
}

function scriptOf(run: DetachedSpawn): string {
  return run.args[1]!
}

function commandWordsOf(script: string): string[] {
  return script.split(/[|;&]+/).map(segment => segment.trim().split(/\s+/)[0]!)
}

function approvedWorld(): LadderWorld {
  return ladderWorld({ brief: APPROVED_BRIEF, approved: APPROVED_BRIEF })
}

describe('the launch node in ladder mode', () => {
  it('the ladder mode launches a Ghost on an approved brief', async () => {
    const made = bench()
    const world = approvedWorld()
    admit(made, LADDER_CARD, 'lane-x', [], 'ladder')
    made.tick()
    await once(ladderNode(made, world))

    expect(world.spawned).toHaveLength(1)
    const [run] = world.spawned
    expect(scriptOf(run!)).toContain(`'ghosts:launch' '--tasks' '${path.join(world.handoff, `tasks-${LADDER_CARD}-a-card.json`)}'`)
    expect(commandWordsOf(scriptOf(run!))).toEqual(['printf', 'pnpm'])
    expect(scriptOf(run!)).not.toContain('ghosts:hash')
    expect(run!.args.slice(2)).toEqual(['shift', '-p', '--session-id', `sess-${LADDER_CARD}`])
    expect(eventsOf(made.db, CARD_STARTED)).toEqual([{ session: `sess-${LADDER_CARD}`, worktree: world.tree, branch: `feat/card-${LADDER_CARD}`, base: 'b'.repeat(40), pid: 4242, pgid: 4242, step: 'launch', contour: 'ladder', isolation: 'full', isolationGaps: [] }])
  })

  it('a ladder session that ends with no result gives card.stopped and the card is queued again; the sessionless launch step does not', async () => {
    const processes: ProcessTable = { commandLine: () => null, signalGroup: () => {} }
    for (const [world, step, stops] of [[ladderWorld(null), 'brief', 1], [approvedWorld(), 'launch', 0]] as const) {
      const made = bench()
      admit(made, LADDER_CARD, 'lane-x', [], 'ladder')
      made.tick()
      const node = new ProbedLaunchNode({ db: made.db, starter: new FakeStarter(), ladder: world.starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, resulted: () => false, isolation: sandboxed })
      await once(node)
      expect(eventsOf(made.db, CARD_STARTED)).toMatchObject([{ step, contour: 'ladder' }])
      made.tick()

      expect(node.stopOverdue()).toEqual(stops === 1 ? [LADDER_CARD] : [])
      expect(eventsOf(made.db, CARD_STOPPED)).toHaveLength(stops)
      made.tick()
      expect(made.db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'launch' AND card_id = ? AND state = 'queued'`).get(LADDER_CARD)).toEqual({ n: stops })
    }
  })

  it('a ladder session that ends with a result and no pull request is not stopped: its brief step opens none', async () => {
    const made = bench()
    const world = ladderWorld(null)
    admit(made, LADDER_CARD, 'lane-x', [], 'ladder')
    made.tick()
    const processes: ProcessTable = { commandLine: () => null, signalGroup: () => {} }
    const node = new ProbedLaunchNode({ db: made.db, starter: new FakeStarter(), ladder: world.starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, resulted: () => true, isolation: sandboxed })
    await once(node)
    expect(eventsOf(made.db, CARD_STARTED)).toMatchObject([{ step: 'brief', contour: 'ladder' }])
    made.tick()

    expect(node.stopOverdue()).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
  })

  it('a launch with no runtime isolation is refused and writes no session', async () => {
    const unconfined: IsolationReader = () => ({ level: 'none', why: 'sandbox.enabled is not true' })
    for (const contour of ['cheap', 'ladder'] as const) {
      const made = bench()
      const world = approvedWorld()
      const cheap = new FakeStarter()
      const ladder = new FakeStarter()
      const card = contour === 'cheap' ? 970 : LADDER_CARD
      admit(made, card, 'lane-x', [], contour)
      made.tick()
      await once(new ProbedLaunchNode({ db: made.db, starter: cheap, ladder, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, isolation: unconfined }))

      expect(eventsOf(made.db, CARD_STARTED)).toEqual([])
      expect(cheap.starts).toEqual([])
      expect(ladder.starts).toEqual([])
      expect(world.spawned).toEqual([])
      expect(eventsOf(made.db, 'policy.denied')).toMatchObject([{ command: 'launch', kind: 'technical', reason: 'no_isolation' }])
      expect(taskState(made.db, launchKey(card))).toMatchObject({ state: 'queued', failures: 0 })
    }
  })

  it('the launch event names the isolation level', async () => {
    const gap = 'sandbox.allowUnsandboxedCommands is not false'
    const readings: [IsolationReader, string, string[]][] = [
      [() => ({ level: 'partial', mechanism: 'claude-code-sandbox', gaps: [gap] }), 'partial', [gap]],
      [sandboxed, 'full', []],
    ]
    for (const [isolation, level, gaps] of readings) {
      const made = bench()
      admit(made, 970, 'lane-a')
      made.tick()
      await once(new ProbedLaunchNode({ db: made.db, starter: new FakeStarter(), clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, isolation }))

      expect(eventsOf(made.db, CARD_STARTED)).toMatchObject([{ isolation: level, isolationGaps: gaps }])
    }
  })

  it('with no ghosts.jsonl and no status.md in the handoff, an admitted ladder card starts its brief step', async () => {
    const made = bench()
    const world = ladderWorld(null)
    admit(made, LADDER_CARD, 'lane-x', [], 'ladder')
    made.tick()
    await once(ladderNode(made, world))

    expect(world.spawned).toHaveLength(1)
    const script = scriptOf(world.spawned[0]!)
    expect(script).toContain('claude')
    expect(script.indexOf('ghosts:hash')).toBeGreaterThan(script.indexOf('claude'))
    expect(script.indexOf('ghosts:launch')).toBeGreaterThan(script.indexOf('ghosts:hash'))
    expect(world.spawned[0]!.input).toContain('Ladder route, step 1 of 3')
    expect(readdirSync(world.handoff)).toEqual([`tasks-${LADDER_CARD}-a-card.json`])
    expect(eventsOf(made.db, CARD_STARTED)).toMatchObject([{ step: 'brief', contour: 'ladder', worktree: world.tree }])
  })

  it('a ladder card with two card.fell in the bus gets no launch task and spawns nothing', async () => {
    const made = bench()
    const world = ladderWorld(null)
    admit(made, LADDER_CARD, 'lane-x', [], 'ladder')
    for (const fall of [1, 2])
      appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_FELL, actor: 'policy', cardId: LADDER_CARD, pr: null, head: null, dedupeKey: `${CARD_FELL}:${LADDER_CARD}:${fall}`, payload: { kind: 'fault' }, legacy: false })
    made.tick()
    await once(ladderNode(made, world))

    expect(launchRows(made, LADDER_CARD)).toBe(0)
    expect(world.spawned).toEqual([])
    expect(eventsOf(made.db, CARD_STARTED)).toEqual([])
  })

  it('a brief edited after its approval is not launched on it', async () => {
    const made = bench()
    const world = ladderWorld({ brief: EDITED_BRIEF, approved: APPROVED_BRIEF })
    admit(made, LADDER_CARD, 'lane-x', [], 'ladder')
    made.tick()
    await once(ladderNode(made, world))

    expect(world.spawned).toHaveLength(1)
    const script = scriptOf(world.spawned[0]!)
    expect(script).toContain('claude')
    expect(script).toContain(`'ghosts:hash' '${world.briefFile}' '--by' 'morse'`)
    expect(script.indexOf('ghosts:hash')).toBeLessThan(script.indexOf('ghosts:launch'))
    expect(eventsOf(made.db, CARD_STARTED)).toMatchObject([{ step: 'brief' }])
  })

  it('an admitted ladder card is started once, by the ladder starter, never by the cheap one', async () => {
    const made = bench()
    const world = approvedWorld()
    const cheap = new FakeStarter()
    admit(made, LADDER_CARD, 'lane-x', [], 'ladder')
    made.tick()
    const node = ladderNode(made, world, cheap)
    await once(node)
    made.tick()
    await once(node)

    expect(cheap.starts).toEqual([])
    expect(world.spawned).toHaveLength(1)
    expect(eventsOf(made.db, CARD_STARTED)).toHaveLength(1)
  })
})

describe('the launch isolation command', () => {
  it('is the command the card session is spawned with', () => {
    expect(launchIsolationCommand('/opt/claude --settings /tmp/s.json')).toEqual(['/opt/claude', '--settings', '/tmp/s.json', '--permission-mode', 'dontAsk'])
  })
})

describe('what a launched session left behind', () => {
  function scratch(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'launch-result-'))
    roots.push(root)
    return root
  }

  it('a commit ahead of the base is a result, none is not, and a tree git cannot read counts as a result', () => {
    const tree = scratch()
    const git = (...args: string[]): string => execFileSync('git', ['-C', tree, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
    git('init', '-q')
    git('commit', '-q', '--allow-empty', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    const card: StartedCard = { session: 's', worktree: tree, branch: 'b', base, pid: 1, pgid: 1, contour: 'cheap' }

    expect(hasCommitsAhead(card)).toBe(false)
    git('commit', '-q', '--allow-empty', '-m', 'work')
    expect(hasCommitsAhead(card)).toBe(true)
    expect(hasCommitsAhead({ ...card, worktree: path.join(tree, 'gone') })).toBe(true)
  })

  it('a shift report written since the session started is a result, an older one is not', () => {
    const launchDir = scratch()
    const start = { cardId: 982, ts: '2026-10-19T12:00:00.000Z' }
    expect(reportWrittenSince(launchDir, start)).toBe(false)

    for (const file of ['report-982.md', 'report-982-brief.md']) {
      const report = path.join(launchDir, file)
      writeFileSync(report, 'PR #1\n')
      utimesSync(report, new Date('2026-10-19T11:00:00.000Z'), new Date('2026-10-19T11:00:00.000Z'))
      expect(reportWrittenSince(launchDir, start)).toBe(false)
      utimesSync(report, new Date('2026-10-19T12:00:01.000Z'), new Date('2026-10-19T12:00:01.000Z'))
      expect(reportWrittenSince(launchDir, start)).toBe(true)
      rmSync(report)
    }
  })

  it('the reason a session ended with is the result line of its shift report written since the start', () => {
    const launchDir = scratch()
    const start = { cardId: 983, ts: '2026-10-19T12:00:00.000Z' }
    const endedWith = reportResultLine(launchDir)
    expect(endedWith(start)).toBeNull()

    const report = path.join(launchDir, 'report-983.md')
    writeFileSync(report, '#983 a-card\ncontract: c\nresult: stopped before PR — quality red\nno PR\n')
    utimesSync(report, new Date('2026-10-19T11:00:00.000Z'), new Date('2026-10-19T11:00:00.000Z'))
    expect(endedWith(start)).toBeNull()
    utimesSync(report, new Date('2026-10-19T12:00:01.000Z'), new Date('2026-10-19T12:00:01.000Z'))
    expect(endedWith(start)).toBe('result: stopped before PR — quality red')
  })
})
