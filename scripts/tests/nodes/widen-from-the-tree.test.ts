import type { Lease } from '../../core/lease.js'
import type { Answered } from '../../nodes/answer/answerer.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, OUTSIDE_TOUCHES, QUESTION_AGENT } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor, changedInTheTreeOf } from '../../nodes/answer/answer-executor.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { sha } from '../bus/github-fake.js'
import { eventsOf, mergeBench } from '../bus/merge-bench.js'

const CARD = 1870
const TOUCHED = 'scripts/nodes/answer/answer-executor.ts'
const FOREIGN = 'scripts/core/card-bodies.ts'
const EVENT_NAME = 'scope.widened'
const QUESTION_1870 = `the answer records ${EVENT_NAME} the way ${FOREIGN} does; may the touches widen to it?`
const NEXT_QUESTION = 'which of the two readers holds the admission?'
const benches: MergeBench[] = []
const roots: string[] = []

afterEach(() => {
  benches.splice(0).forEach(made => made.close())
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Bench {
  made: MergeBench
  executor: AnswerExecutor
  sessions: () => number
}

function stopOnTheCard(made: MergeBench): void {
  const ts = made.clock.now().toISOString()
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}:${ts}`, payload: { reason: QUESTION_AGENT, detail: 'a question' }, legacy: false })
  made.tick()
}

function queueAnswerOnTheLatestStop(made: MergeBench): void {
  const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  queueTask(made.db, made.clock.now().toISOString(), { queue: 'answer', cardId: CARD, stop })
  made.tick()
}

function bench(changed: readonly string[], replies: readonly Answered[]): Bench {
  const made = mergeBench()
  benches.push(made)
  const trees = mkdtempSync(path.join(tmpdir(), 'widen-tree-'))
  roots.push(trees)
  const ts = made.clock.now().toISOString()
  const text = `card: #${CARD} a-card [implement/construct/M/cheap/owner] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: ${TOUCHED}\ncontinue: auto\nwho: shift\n\nDo it.\n`
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree: path.join(trees, `mc-${CARD}`), branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  made.tick()
  stopOnTheCard(made)
  queueAnswerOnTheLatestStop(made)
  let sessions = 0
  const executor = new AnswerExecutor({ silentMs: SILENT_MS, db: made.db, answerer: async () => {
    sessions += 1
    return replies[Math.min(sessions, replies.length) - 1]!
  }, ownerMerges: () => '', clock: made.clock.now, trees: { home: trees, exists: () => true, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }, dirty: () => false, liveSession: () => null, prepare: () => {}, changedInTheTree: () => [...changed] })
  return { made, executor, sessions: () => sessions }
}

async function answerOnce(run: Bench): Promise<void> {
  await run.executor.answer(leaseNext(run.made.db, run.made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1') as Lease)
  run.made.tick()
}

function contextWarnAsking(question: string): Answered {
  return { session: 'answer-1', resumed: false, atContextWarn: true, before: sha('a'), after: sha('a'), owner: question }
}

const ASKS_AGAIN: Answered = { session: 'answer-2', resumed: false, atContextWarn: false, before: sha('a'), after: sha('a'), owner: NEXT_QUESTION }

describe('the widen list of an answer stop comes from the card tree', () => {
  it('a question naming an event name and a file of another route opens no widening wait', async () => {
    const run = bench([TOUCHED], [contextWarnAsking(QUESTION_1870), ASKS_AGAIN])

    await answerOnce(run)

    const stops = eventsOf(run.made.db, CARD_STOPPED)
    expect(stops.at(-1)).not.toHaveProperty('widen')
    expect(stops.at(-1)).not.toMatchObject({ code: OUTSIDE_TOUCHES })

    queueAnswerOnTheLatestStop(run.made)
    await answerOnce(run)

    expect(run.sessions()).toBe(2)
  })

  it('a real file outside the touches changed in the card tree opens the widening wait', async () => {
    const run = bench([TOUCHED, FOREIGN], [contextWarnAsking(QUESTION_1870), ASKS_AGAIN])

    await answerOnce(run)

    expect(eventsOf(run.made.db, CARD_STOPPED).at(-1)).toEqual(expect.objectContaining({ reason: QUESTION_AGENT, code: OUTSIDE_TOUCHES, paths: expect.arrayContaining([FOREIGN]), widen: expect.arrayContaining([FOREIGN]) }))

    queueAnswerOnTheLatestStop(run.made)
    await answerOnce(run)

    expect(run.sessions()).toBe(1)
    expect(eventsOf(run.made.db, CARD_STOPPED).at(-1)).toEqual(expect.objectContaining({ widen: expect.arrayContaining([FOREIGN]) }))
  })

  it('a named path counts only when the tree changed it', () => {
    expect(changedInTheTreeOf([EVENT_NAME, FOREIGN, TOUCHED], new Set([TOUCHED]))).toEqual([TOUCHED])
    expect(changedInTheTreeOf([EVENT_NAME, FOREIGN], new Set())).toEqual([])
  })
})
