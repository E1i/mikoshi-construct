import type { ProcessTable } from '../../bus/chain-process.js'
import type { CardStart, CardStarter, QueuedCard, StartedCard } from '../../bus/launch-executor.js'
import type { DetachedSpawn, SessionContinuer, StarterPorts } from '../../bus/launch-starter.js'
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
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { CARD_MOVED } from '../../../src/commands/intake/index.js'
import { CARD_FELL, DROPPED_CARD, DROPPED_LANE, GHOST_ROW, PR_OPENED, STOPPED_CARD } from '../../bus/card-automaton.js'
import { appendEvent } from '../../bus/db.js'
import { recordHeartbeat } from '../../bus/heartbeat.js'
import { CARD_STARTED, CARD_STOPPED } from '../../bus/inbox.js'
import { LadderCardStarter } from '../../bus/ladder-starter.js'
import { CARD_ADMITTED } from '../../bus/launch-candidates.js'
import { LaunchExecutor } from '../../bus/launch-executor.js'
import { ShiftCardStarter } from '../../bus/launch-starter.js'
import { CARD_CONTINUED, CARD_PULSE, CARD_SESSION_ENDED, CARD_WAITING, handoffLadderSteps, handoffWrittenSince, hasCommitsAhead, HEARTBEAT_SILENCE_MINUTES, LADDER_APPROVAL, LAUNCH_LIMIT_MINUTES, launchIsolationCommand, LaunchNode, launchPlaces, noPullRequestDetail, PULSE_MINUTES, realStarterPorts, reportResultLine, reportWrittenSince, SESSION_DEATH_CAP } from '../../bus/launch-worker.js'
import { leaseNext } from '../../bus/lease.js'
import { NODE_CURSORS, NODE_DETECTED, NODE_EQUIVALENCE } from '../../bus/node.js'
import { PR_CLOSED } from '../../bus/observations.js'
import { keyOf, launchTasks, queueTask, TASK_ENQUEUED } from '../../bus/queue.js'
import { reduce } from '../../bus/reducer.js'
import { approvalSha256, canonicalImplementText } from '../../ghosts/approval.js'
import { HANDOFF_FIELDS } from '../../ghosts/handoff-check.js'
import { recordGhostLine } from '../../ghosts/journal.js'
import { WORKTREE_HOME_VARIABLE } from '../../ghosts/worktree-home.js'
import { CONTINUE_PROMPT, MAX_RESTARTS } from '../../shift/continuation.js'
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

class ContinuingStarter extends FakeStarter implements SessionContinuer {
  continued: { card: QueuedCard, from: StartedCard }[] = []

  continueFrom(card: QueuedCard, from: StartedCard): CardStart {
    this.continued.push({ card, from })
    return { kind: 'started', card: { ...from, session: `s-${card.cardId}-c${this.continued.length}` } }
  }
}

const HANDOFF_REPORT = `#1123 a-card\n${HANDOFF_FIELDS.map(field => `${field.label}: ${field.id === 'queue' ? '#1123' : `the ${field.id} of the card`}`).join('\n')}\nboundary: eddies warn\n`

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

  it('a card.started from launch with a dead pid and no pull request gives card.stopped on the next tick and a card with overlapping touches becomes a launch candidate', async () => {
    const made = bench()
    const admitTouching = (cardId: number, lane: string, touches: string[]): void => {
      const text = parkingFileText({ card: `#${cardId} card-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —`, branch: `feat/card-${cardId}`, touches, continue: 'stop', who: 'shift', body: 'Do the card.' })
      appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane, decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}`, text }, legacy: false })
    }
    admitTouching(1102, 'lane-a', ['tests/**', 'src/atlas/**', 'src/ui/lore.ts', 'CONTRIBUTING.md', '.changeset/**'])
    made.tick()
    let alive = true
    const processes: ProcessTable = { commandLine: () => alive ? 'sh -c claude -p --session-id s-1102' : null, signalGroup: () => {} }
    const node = new ProbedLaunchNode({ db: made.db, starter: new FakeStarter(), clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, resulted: () => true, isolation: sandboxed })
    await once(node)
    admitTouching(1103, 'lane-b', ['src/ui/lore.ts', 'tests/lore.test.ts'])
    made.tick()
    expect(node.stopOverdue()).toEqual([])
    expect(node.found()).toEqual([])
    expect(launchRows(made, 1103)).toBe(0)

    alive = false
    expect(node.found()).toEqual([])
    expect(node.stopOverdue()).toEqual([1102])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([{ reason: 'fault', detail: noPullRequestDetail(1102, 's-1102', null) }])
    expect(node.found()).toEqual([launchKey(1103)])
    made.tick()
    expect(taskState(made.db, launchKey(1103))).toMatchObject({ state: 'queued' })
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
    made.clock.advance(PULSE_MINUTES * 60_000 - 1)
    node.stopOverdue()
    expect(pulses()).toBe(2)
    made.clock.advance(1)
    node.stopOverdue()
    expect(pulses()).toBe(3)

    alive = false
    made.clock.advance(PULSE_MINUTES * 60_000)
    node.stopOverdue()
    expect(pulses()).toBe(3)
  })

  it('a pid reused by a process that does not name the session writes no pulse', async () => {
    const made = bench()
    admit(made, 985, 'lane-a')
    made.tick()
    const processes: ProcessTable = { commandLine: () => 'sh -c claude -p --session-id someone-else', signalGroup: () => {} }
    const node = new ProbedLaunchNode({ db: made.db, starter: new FakeStarter(), clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, isolation: sandboxed })
    await once(node)
    made.tick()

    made.clock.advance(PULSE_MINUTES * 60_000)
    node.stopOverdue()
    expect(eventsOf(made.db, CARD_PULSE)).toEqual([])
  })

  function boundarySession(made: MergeBench, cardId: number): { node: ProbedLaunchNode, starter: ContinuingStarter } {
    admit(made, cardId, 'lane-a')
    made.tick()
    const starter = new ContinuingStarter()
    const exited: ProcessTable = { commandLine: () => null, signalGroup: () => {} }
    const node = new ProbedLaunchNode({ db: made.db, starter, continuer: starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes: exited, resulted: () => true, handedOff: start => start.cardId === cardId, isolation: sandboxed })
    return { node, starter }
  }

  it('a session that exits at the Eddies boundary with a handoff is relaunched from it', async () => {
    const made = bench()
    const { node, starter } = boundarySession(made, 1123)
    await once(node)
    made.tick()

    expect(node.stopOverdue()).toEqual([])
    expect(starter.continued).toEqual([{ card: { cardId: 1123, lane: 'lane-a' }, from: { session: 's-1123', worktree: '/trees/mc-1123', branch: 'feat/card-1123', base: 'f'.repeat(40), pid: 4242, pgid: 4242, contour: 'cheap' } }])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
    expect(eventsOf(made.db, CARD_CONTINUED)).toEqual([{ session: 's-1123-c1', worktree: '/trees/mc-1123', branch: 'feat/card-1123', base: 'f'.repeat(40), pid: 4242, pgid: 4242, contour: 'cheap', continuation: 1, from: 's-1123' }])
    made.tick()
    expect(made.db.prepare(`SELECT state FROM cards WHERE card_id = 1123`).get()).toEqual({ state: 'running' })
    expect(launchRows(made, 1123)).toBe(1)
    expect(starter.starts).toHaveLength(1)
  })

  it('a fourth Eddies exit of one card stops it at the D-104 limit', async () => {
    const made = bench()
    const { node, starter } = boundarySession(made, 1124)
    await once(node)
    made.tick()

    for (let exit = 1; exit <= MAX_RESTARTS; exit++) {
      expect(node.stopOverdue()).toEqual([])
      made.tick()
    }
    expect(starter.continued.map(each => each.from.session)).toEqual(['s-1124', 's-1124-c1', 's-1124-c2'])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])

    expect(node.stopOverdue()).toEqual([1124])
    expect(node.stopOverdue()).toEqual([])
    expect(starter.continued).toHaveLength(MAX_RESTARTS)
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([{ reason: 'fault', detail: `continuation-limit: card #1124 session s-1124-c3 exited at a boundary with its handoff written; ${MAX_RESTARTS} of ${MAX_RESTARTS} continuations used (D-104), the card is not continued again` }])
    made.tick()
    expect(made.db.prepare(`SELECT state FROM cards WHERE card_id = 1124`).get()).toEqual({ state: STOPPED_CARD })
    expect(launchRows(made, 1124)).toBe(1)
  })

  it('a session that exits with no handoff is stopped as before and not continued', async () => {
    const made = bench()
    admit(made, 1125, 'lane-a')
    made.tick()
    const starter = new ContinuingStarter()
    const processes: ProcessTable = { commandLine: () => null, signalGroup: () => {} }
    const node = new ProbedLaunchNode({ db: made.db, starter, continuer: starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, resulted: () => true, handedOff: () => false, isolation: sandboxed })
    await once(node)
    made.tick()

    expect(node.stopOverdue()).toEqual([1125])
    expect(starter.continued).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([{ reason: 'fault', detail: noPullRequestDetail(1125, 's-1125', null) }])
  })

  it('a launch whose pgid names another session is stopped as gone', async () => {
    const made = bench()
    admit(made, 1126, 'lane-a')
    made.tick()
    const signalled: number[] = []
    const processes: ProcessTable = { commandLine: () => 'sh -c claude -p --session-id someone-else', signalGroup: pgid => signalled.push(pgid) }
    const starter = new FakeStarter()
    const node = new ProbedLaunchNode({ db: made.db, starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, isolation: sandboxed })
    await once(node)
    made.tick()

    expect(node.stopOverdue()).toEqual([1126])
    expect(node.stopOverdue()).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([{ reason: 'fault', detail: expect.stringMatching(/^session-end: card #1126 session s-1126 ended/) as unknown }])
    expect(starter.stops).toEqual([])
    expect(signalled).toEqual([])
  })

  function silentSession(made: MergeBench, cardId: number): { node: ProbedLaunchNode, starter: FakeStarter } {
    admit(made, cardId, 'lane-a')
    made.tick()
    let alive = true
    const starter = new FakeStarter()
    const stopping: CardStarter = { start: card => starter.start(card), stop: (card) => {
      starter.stop(card)
      alive = false
    } }
    const processes: ProcessTable = { commandLine: () => alive ? `sh -c claude -p --session-id s-${cardId}` : null, signalGroup: () => {} }
    return { node: new ProbedLaunchNode({ db: made.db, starter: stopping, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, isolation: sandboxed }), starter }
  }

  function beat(made: MergeBench, cardId: number): void {
    recordHeartbeat(made.db, made.clock.now().toISOString(), { card: cardId, pr: null, head: null, step: 'PostToolUse', session: `s-${cardId}`, lease: null })
  }

  it('a card.started with no pull request and no heartbeat for 20 minutes gives card.stopped', async () => {
    const made = bench()
    const { node, starter } = silentSession(made, 983)
    await once(node)
    made.tick()

    made.clock.advance((HEARTBEAT_SILENCE_MINUTES - 1) * 60_000)
    beat(made, 983)
    made.clock.advance((HEARTBEAT_SILENCE_MINUTES - 1) * 60_000)
    expect(node.stopOverdue()).toEqual([])

    made.clock.advance(2 * 60_000)
    expect(node.stopOverdue()).toEqual([983])
    expect(node.stopOverdue()).toEqual([])
    expect(starter.stops).toHaveLength(1)
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([{ reason: 'fault', detail: expect.stringMatching(/^no-heartbeat: card #983 session s-983 has no pull request and no heartbeat for 20 minutes since /) as unknown }])
  })

  function drop(made: MergeBench, cardId: number): void {
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_MOVED, actor: 'worker:intake:by-hand', cardId, pr: null, head: null, dedupeKey: `${CARD_MOVED}:${cardId}`, payload: { lane: DROPPED_LANE }, legacy: false })
    made.tick()
  }

  it('the live session of a dropped card is stopped and its end is an event', async () => {
    const made = bench()
    const { node, starter } = silentSession(made, 986)
    await once(node)
    made.tick()
    admit(made, 987, 'lane-b')
    made.tick()
    await once(node)
    made.tick()
    expect(made.db.prepare(`SELECT count(*) AS n FROM cards WHERE card_id IN (986, 987) AND state = 'running'`).get()).toEqual({ n: 2 })

    drop(made, 986)
    drop(made, 987)
    expect(node.stopOverdue()).toEqual([986, 987])
    expect(node.stopOverdue()).toEqual([])
    expect(starter.stops.map(each => each.session)).toEqual(['s-986'])
    expect(eventsOf(made.db, CARD_SESSION_ENDED)).toEqual([
      { session: 's-986', pgid: 4242, stopped: true, detail: 'card #986 is dropped; its session s-986 was stopped at the drop' },
      { session: 's-987', pgid: 4242, stopped: false, detail: 'card #987 is dropped; its session s-987 ended on its own' },
    ])
    made.tick()
    expect(made.db.prepare(`SELECT card_id, state FROM cards WHERE card_id IN (986, 987) ORDER BY card_id`).all()).toEqual([{ card_id: 986, state: DROPPED_CARD }, { card_id: 987, state: DROPPED_CARD }])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
  })

  it('a silent session whose card has a pull request is not stopped by the heartbeat watchdog', async () => {
    const made = bench()
    const { node, starter } = silentSession(made, 984)
    await once(node)
    made.tick()
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: PR_OPENED, actor: 'worker:shift:1', cardId: 984, pr: 9840, head: null, dedupeKey: `${PR_OPENED}:984:9840`, payload: { pr: 9840 }, legacy: false })

    made.clock.advance((HEARTBEAT_SILENCE_MINUTES + 1) * 60_000)
    expect(node.stopOverdue()).toEqual([])
    expect(starter.stops).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
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

function ladderWorld(made: MergeBench, handoffState: { brief: string, approved: string } | null): LadderWorld {
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
    recordGhostLine('test', { event: 'approval', by: 'morse', card: LADDER_CARD, sha256 }, made.busPath)
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
  const steps = handoffLadderSteps(handoff, path.join(root, 'repo'), { [WORKTREE_HOME_VARIABLE]: path.join(root, 'worktrees') }, made.busPath)
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

function approvedWorld(made: MergeBench): LadderWorld {
  return ladderWorld(made, { brief: APPROVED_BRIEF, approved: APPROVED_BRIEF })
}

describe('the launch node in ladder mode', () => {
  it('the ladder mode launches a Ghost on an approved brief', async () => {
    const made = bench()
    const world = approvedWorld(made)
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
    for (const [approved, step, stops] of [[false, 'brief', 1], [true, 'launch', 0]] as const) {
      const made = bench()
      const world = approved ? approvedWorld(made) : ladderWorld(made, null)
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
    const world = ladderWorld(made, null)
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

  it('a ladder session gone with a brief and no ghost row writes card.waiting', async () => {
    const made = bench()
    const world = ladderWorld(made, null)
    admit(made, LADDER_CARD, 'lane-x', [], 'ladder')
    made.tick()
    const processes: ProcessTable = { commandLine: () => null, signalGroup: () => {} }
    const node = new ProbedLaunchNode({ db: made.db, starter: new FakeStarter(), ladder: world.starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, resulted: () => true, isolation: sandboxed })
    await once(node)
    made.tick()

    expect(node.stopOverdue()).toEqual([])
    expect(node.stopOverdue()).toEqual([])
    expect(eventsOf(made.db, CARD_WAITING)).toEqual([{ reason: LADDER_APPROVAL, step: 'brief', session: `sess-${LADDER_CARD}`, detail: `card #${LADDER_CARD} ladder step brief of session sess-${LADDER_CARD} ended with a result and no ghost row; its next step waits for the approval of its brief` }])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
  })

  it('a launch with no runtime isolation is refused and writes no session', async () => {
    const unconfined: IsolationReader = () => ({ level: 'none', why: 'sandbox.enabled is not true' })
    for (const contour of ['cheap', 'ladder'] as const) {
      const made = bench()
      const world = approvedWorld(made)
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
    const world = ladderWorld(made, null)
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

  it('with no journal a card whose bus history shows the brief done starts its launch step', async () => {
    const made = bench()
    const world = approvedWorld(made)
    admit(made, LADDER_CARD, 'lane-x', [], 'ladder')
    made.tick()
    await once(ladderNode(made, world))

    expect(existsSync(path.join(world.handoff, 'ghosts.jsonl'))).toBe(false)
    expect(world.spawned).toHaveLength(1)
    expect(eventsOf(made.db, CARD_STARTED)).toMatchObject([{ step: 'launch', contour: 'ladder' }])
  })

  it('an approval only in the legacy ghosts.jsonl does not start the launch step: the ladder step reads the bus alone', async () => {
    const made = bench()
    const world = ladderWorld(made, null)
    mkdirSync(world.tree, { recursive: true })
    writeFileSync(world.briefFile, APPROVED_BRIEF)
    const sha256 = approvalSha256(canonicalImplementText(APPROVED_BRIEF)!)
    writeFileSync(path.join(world.handoff, 'ghosts.jsonl'), `${JSON.stringify({ event: 'approval', by: 'morse', card: LADDER_CARD, sha256 })}\n`)
    admit(made, LADDER_CARD, 'lane-x', [], 'ladder')
    made.tick()
    await once(ladderNode(made, world))

    expect(eventsOf(made.db, CARD_STARTED)).toMatchObject([{ step: 'brief', contour: 'ladder' }])
  })

  it('a ladder card with two card.fell in the bus gets no launch task and spawns nothing', async () => {
    const made = bench()
    const world = ladderWorld(made, null)
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
    const world = ladderWorld(made, { brief: EDITED_BRIEF, approved: APPROVED_BRIEF })
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
    const world = approvedWorld(made)
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

describe('where a launched session works', () => {
  it('a launched tree fetches and pushes over https, not ssh', () => {
    const tree = mkdtempSync(path.join(tmpdir(), 'launch-origin-'))
    roots.push(tree)
    execFileSync('git', ['-C', tree, 'init', '-q'])
    execFileSync('git', ['-C', tree, 'remote', 'add', 'origin', 'git@github.com:o/r.git'])
    execFileSync('git', ['-C', tree, 'remote', 'add', 'upstream', 'ssh://git@github.com/o/u.git'])
    const env = { ...process.env, ...realStarterPorts(tree, {}, '', () => 'u').envOf(1114) }
    const url = (remote: string, ...args: string[]): string => execFileSync('git', ['-C', tree, 'remote', 'get-url', ...args, remote], { encoding: 'utf8', env }).trim()

    expect({ fetch: url('origin'), push: url('origin', '--push') }).toEqual({ fetch: 'https://github.com/o/r.git', push: 'https://github.com/o/r.git' })
    expect({ fetch: url('upstream'), push: url('upstream', '--push') }).toEqual({ fetch: 'https://github.com/o/u.git', push: 'https://github.com/o/u.git' })
  })

  it('the launch session report is written under an allowed path', () => {
    const { launchDir } = launchPlaces('/home/x', '/repo')
    expect(path.relative('/home/x/.construct/shift', launchDir)).toBe('launch')
    expect(launchDir.startsWith(path.join('/home/x', '.construct', 'bus'))).toBe(false)
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

  it('a shift report written since the start that carries every handoff field is a handoff, a plain or older one is not', () => {
    const launchDir = scratch()
    const start = { cardId: 1123, ts: '2026-10-19T12:00:00.000Z' }
    const handedOff = handoffWrittenSince(launchDir)
    expect(handedOff(start)).toBe(false)

    const report = path.join(launchDir, 'report-1123.md')
    writeFileSync(report, '#1123 a-card\nresult: stopped before PR — quality red\nno PR\n')
    utimesSync(report, new Date('2026-10-19T12:00:01.000Z'), new Date('2026-10-19T12:00:01.000Z'))
    expect(handedOff(start)).toBe(false)
    writeFileSync(report, HANDOFF_REPORT)
    utimesSync(report, new Date('2026-10-19T11:00:00.000Z'), new Date('2026-10-19T11:00:00.000Z'))
    expect(handedOff(start)).toBe(false)
    utimesSync(report, new Date('2026-10-19T12:00:01.000Z'), new Date('2026-10-19T12:00:01.000Z'))
    expect(handedOff(start)).toBe(true)
  })

  it('a continued session is spawned in the tree it left, on its base, with the continuation prompt and no new cut', () => {
    const root = scratch()
    const parking = path.join(root, 'parking')
    mkdirSync(path.join(parking, 'lane-a'), { recursive: true })
    writeFileSync(path.join(parking, 'lane-a', '1123.md'), parkingFileText({ card: '#1123 a-card [implement/netwatch/S/cheap/auto] · depends — · blocks —', branch: 'feat/a-card', touches: ['scripts/bus/**'], continue: 'auto', who: 'shift', body: 'Do the card.' }))
    const spawned: DetachedSpawn[] = []
    const cuts: string[] = []
    const ports: StarterPorts = {
      read: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
      cut: (task) => {
        cuts.push(task.branch)
        return '/trees/new'
      },
      base: () => 'n'.repeat(40),
      spawnDetached: (run) => {
        spawned.push(run)
        return 5151
      },
      pgidOf: () => 5151,
      kill: () => {},
      uuid: () => 'sess-next',
      envOf: () => ({}),
      prompt: task => task.body,
    }
    const starter = new ShiftCardStarter({ parking, launchDir: path.join(root, 'launch'), claude: 'claude', treePr: 'tree-pr' }, ports)
    const from: StartedCard = { session: 'sess-first', worktree: '/trees/mc-1123', branch: 'feat/a-card', base: 'b'.repeat(40), pid: 4242, pgid: 4242, contour: 'cheap' }

    const begun = starter.continueFrom({ cardId: 1123, lane: 'lane-a' }, from)
    expect(begun).toMatchObject({ kind: 'started', card: { session: 'sess-next', worktree: '/trees/mc-1123', branch: 'feat/a-card', base: 'b'.repeat(40), pid: 5151, pgid: 5151 } })
    expect(cuts).toEqual([])
    expect(spawned.map(run => run.cwd)).toEqual(['/trees/mc-1123'])
    expect(spawned[0]!.input).toContain(CONTINUE_PROMPT)
    expect(spawned[0]!.input).toContain(path.join(root, 'launch', 'report-1123.md'))
    expect(spawned[0]!.input).not.toContain('Do the card.')
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
