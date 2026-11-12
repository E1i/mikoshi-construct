import type { Lease } from '../../core/lease.js'
import type { CardStart, CardStarter, QueuedCard, StartedCard } from '../../nodes/launch/launch-executor.js'
import type { SessionContinuer } from '../../nodes/launch/launch-starter.js'
import type { MergeBench } from './merge-bench.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, closeOwnerWait } from '../../core/db.js'
import { CARD_ADMITTED, CARD_CONTINUED, CARD_STARTED, CARD_STOPPED, OPEN_QUESTION, OUTSIDE_TOUCHES, OWNER_WAIT_OPENED, QUESTION_AGENT, TASK_RELEASED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { MachineSessions } from '../../core/machine-sessions.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 1791
const TOUCHED = 'scripts/a.ts'
const READER = 'scripts/core/layer-map.ts'
const OUTSIDE_QUESTION = `the touches do not cover ${READER}, which reads contract/factory.json; widen them`
const OPEN_OWNER_QUESTION = 'the allowlist decides whether the session may run the gate; which list holds?'
const HANDOFF = ['current card: #1791', 'queue: #1791', 'done: x', 'not done: x', 'delegation: none', 'next task: x', 'local decisions: none', 'owner waits: none', 'decisions: none', 'intake tokens: none', 'stop reason: context warn at the third step', 'continue when: now'].join('\n')
const roots: string[] = []
const benches: MergeBench[] = []

afterEach(() => {
  benches.splice(0).forEach(made => made.close())
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

class CountingStarter implements CardStarter, SessionContinuer {
  started = 0
  continued = 0

  constructor(private readonly worktree: string) {}

  start(card: QueuedCard): CardStart {
    this.started += 1
    return { kind: 'started', card: { session: `s-${card.cardId}-${this.started}`, worktree: this.worktree, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }
  }

  stop(): void {}

  continueFrom(card: QueuedCard, from: StartedCard): CardStart {
    this.continued += 1
    return { kind: 'started', card: { ...from, session: `s-${card.cardId}-c${this.continued}` } }
  }
}

function body(touches: readonly string[]): string {
  return `card: #${CARD} a-card [implement/construct/L/cheap/owner] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: ${touches.join(', ')}\ncontinue: auto\nwho: shift\n\nDo it.\n`
}

function admit(made: MergeBench, key: string, touches: readonly string[]): void {
  const text = body(touches)
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${key}`, payload: { card: `#${CARD}`, lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [], admission: key, text, textSha: textSha(text) }, legacy: false })
  made.tick()
}

interface Launching {
  made: MergeBench
  starter: CountingStarter
  node: LaunchNode
  report: { text: string | null }
}

function launching(): Launching {
  const made = mergeBench()
  benches.push(made)
  const worktree = scratch('z8-tree-')
  mkdirSync(path.join(worktree, path.dirname(READER)), { recursive: true })
  writeFileSync(path.join(worktree, READER), 'export const map = {}\n')
  const starter = new CountingStarter(worktree)
  const report = { text: null as string | null }
  const node = new LaunchNode({ db: made.db, starter, continuer: starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes: { commandLine: () => null, signalGroup: () => {} }, pidAlive: () => false, collected: () => null, atContextLine: () => true, handedOff: () => report.text !== null, reportOf: () => report.text, machine: new MachineSessions(scratch('z8-machine-'), () => false, 16), lanes: () => 4, disk: () => ({ bavail: 1, bsize: 1024 ** 4 }), isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }) })
  return { made, starter, node, report }
}

async function round(node: LaunchNode, made: MergeBench): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
  made.tick()
}

async function stoppedOn(question: string): Promise<Launching> {
  const run = launching()
  admit(run.made, 'admission-1', [TOUCHED])
  await round(run.node, run.made)
  run.report.text = `${HANDOFF}\nquestion: ${question}\n`
  run.node.stopOverdue()
  run.made.tick()
  return run
}

function relaunched(run: Launching, key: string, touches: readonly string[]): Promise<void> {
  admit(run.made, key, touches)
  return round(run.node, run.made)
}

function waitReasons(run: Launching): string[] {
  return (run.made.db.prepare(`SELECT json_extract(payload, '$.reason') AS reason FROM events WHERE type = ? AND card_id = ?`).all(TASK_RELEASED, CARD) as { reason: string }[]).map(row => row.reason)
}

describe('z8: a session stop is recorded in the bus and decides the continuation', () => {
  it('a session that stops on paths outside the touches spends no continuation and the card waits for intake', async () => {
    const run = await stoppedOn(OUTSIDE_QUESTION)

    expect(run.starter.continued).toBe(0)
    expect(eventsOf(run.made.db, CARD_CONTINUED)).toEqual([])
    expect(eventsOf(run.made.db, CARD_STOPPED)).toEqual([expect.objectContaining({ reason: QUESTION_AGENT, code: OUTSIDE_TOUCHES, paths: [READER], widen: [READER] })])
    expect(eventsOf(run.made.db, OWNER_WAIT_OPENED)).toEqual([expect.objectContaining({ need: 'command', command: expect.stringContaining('pnpm intake') })])
  })

  it('a relaunch whose touches still miss the named paths is refused with the same reason', async () => {
    const run = await stoppedOn(OUTSIDE_QUESTION)

    await relaunched(run, 'admission-2', [TOUCHED])

    expect(run.starter.started).toBe(1)
    expect(waitReasons(run)).toContain(OUTSIDE_TOUCHES)

    run.made.clock.advance(3_600_000)
    await relaunched(run, 'admission-3', [TOUCHED, READER])

    expect(run.starter.started).toBe(2)
  })

  it('the stop reason a session reports is in the bus event of its exit', async () => {
    const outside = await stoppedOn(OUTSIDE_QUESTION)

    expect(eventsOf(outside.made.db, CARD_STOPPED)).toEqual([expect.objectContaining({ blocker: OUTSIDE_QUESTION, stop_reason: 'context warn at the third step' })])

    const run = launching()
    admit(run.made, 'admission-1', [TOUCHED])
    await round(run.node, run.made)
    run.report.text = `${HANDOFF}\n`
    run.node.stopOverdue()

    expect(run.starter.continued).toBe(1)
    expect(eventsOf(run.made.db, CARD_CONTINUED)).toEqual([expect.objectContaining({ continuation: 1, stop_reason: 'context warn at the third step' })])
  })

  it('a session that stops on an open question spends no continuation and is not relaunched until the question closes', async () => {
    const run = await stoppedOn(OPEN_OWNER_QUESTION)

    expect(run.starter.continued).toBe(0)
    expect(eventsOf(run.made.db, CARD_CONTINUED)).toEqual([])
    expect(eventsOf(run.made.db, CARD_STOPPED)).toEqual([expect.objectContaining({ code: OPEN_QUESTION, blocker: OPEN_OWNER_QUESTION, paths: [] })])
    const waits = eventsOf(run.made.db, OWNER_WAIT_OPENED)
    expect(waits).toHaveLength(1)

    await relaunched(run, 'admission-2', [TOUCHED])

    expect(run.starter.started).toBe(1)
    expect(waitReasons(run)).toContain(OPEN_QUESTION)

    closeOwnerWait(run.made.db, run.made.clock.now().toISOString(), 'owner', String(waits[0]!.id), 'the shift list holds', 1)
    run.made.clock.advance(3_600_000)
    await relaunched(run, 'admission-3', [TOUCHED])

    expect(run.starter.started).toBe(2)
  })

  it('an answer session that stops on paths outside the touches spends no answer restart', async () => {
    const made = mergeBench()
    benches.push(made)
    const trees = scratch('z8-answer-')
    const ts = made.clock.now().toISOString()
    const text = body([TOUCHED])
    appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
    appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree: path.join(trees, `mc-${CARD}`), branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
    appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: QUESTION_AGENT, detail: 'a question' }, legacy: false })
    made.tick()
    const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
    queueTask(made.db, ts, { queue: 'answer', cardId: CARD, stop })
    let sessions = 0
    const executor = new AnswerExecutor({
      db: made.db,
      answerer: async () => {
        sessions += 1
        return { session: `answer-${sessions}`, resumed: false, atContextWarn: true, before: sha('a'), after: sha('a'), owner: OUTSIDE_QUESTION }
      },
      ownerMerges: () => '',
      clock: made.clock.now,
      trees: { home: trees, exists: () => true, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} },
      dirty: () => false,
      liveSession: () => null,
      prepare: () => {},
      changedInTheTree: () => [TOUCHED, READER],
    })

    const outcome = await executor.answer(leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1') as Lease)

    expect(sessions).toBe(1)
    expect(outcome).toMatchObject({ kind: 'stopped', reason: QUESTION_AGENT })
    expect(eventsOf(made.db, CARD_STOPPED).at(-1)).toEqual(expect.objectContaining({ code: OUTSIDE_TOUCHES, blocker: OUTSIDE_QUESTION, paths: expect.arrayContaining([READER]) }))
    expect(eventsOf(made.db, OWNER_WAIT_OPENED)).toEqual([])
  })
})
