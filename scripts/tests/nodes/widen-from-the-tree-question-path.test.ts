import type { Lease } from '../../core/lease.js'
import type { Answered } from '../../nodes/answer/answerer.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, QUESTION_AGENT, QUESTION_OWNER, SHARD_ISSUED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { sha } from '../bus/github-fake.js'
import { eventsOf, mergeBench } from '../bus/merge-bench.js'

const CARD = 1881
const TOUCHED = 'scripts/nodes/answer/answer-executor.ts'
const CHANGED_OUTSIDE = 'scripts/core/card-bodies.ts'
const NOT_CHANGED = 'scripts/nodes/answer/answerer.ts'
const EVENT_NAME = 'scope.widened'
const QUESTION = `may the touches widen to ${CHANGED_OUTSIDE} and ${NOT_CHANGED}, so the answer records ${EVENT_NAME}?`
const benches: MergeBench[] = []
const roots: string[] = []

afterEach(() => {
  benches.splice(0).forEach(made => made.close())
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function eventOf(made: MergeBench, type: string, payload: Record<string, unknown>, key: string): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: key, payload, legacy: false })
}

async function ownersStopWith(changed: readonly string[]): Promise<Record<string, unknown> | undefined> {
  const made = mergeBench()
  benches.push(made)
  const trees = mkdtempSync(path.join(tmpdir(), 'widen-question-'))
  roots.push(trees)
  const text = `card: #${CARD} a-card [implement/construct/XS/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: ${TOUCHED}\ncontinue: auto\nwho: shift\n\nDo it.\n`
  eventOf(made, SHARD_ISSUED, { id: `shard-${CARD}`, under: null }, `${SHARD_ISSUED}:${CARD}`)
  eventOf(made, CARD_ADMITTED, { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, `${CARD_ADMITTED}:body:${CARD}`)
  eventOf(made, CARD_STARTED, { session: 'card-session-1', worktree: path.join(trees, `mc-${CARD}`), branch: `feat/card-${CARD}`, base: sha('1') }, `${CARD_STARTED}:${CARD}`)
  made.tick()
  eventOf(made, CARD_STOPPED, { reason: QUESTION_AGENT, detail: 'a question' }, `${CARD_STOPPED}:${CARD}`)
  made.tick()
  const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  queueTask(made.db, made.clock.now().toISOString(), { queue: 'answer', cardId: CARD, stop })
  made.tick()
  const asking: Answered = { session: 'answer-1', resumed: false, atContextWarn: false, before: sha('a'), after: sha('a'), owner: QUESTION, noViolationFreePath: true }
  const executor = new AnswerExecutor({
    db: made.db,
    answerer: async () => asking,
    ownerMerges: () => '',
    clock: made.clock.now,
    trees: { home: trees, exists: () => true, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} },
    dirty: () => false,
    liveSession: () => null,
    prepare: () => {},
    changedInTheTree: () => [...changed],
  })
  await executor.answer(leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1') as Lease)
  return eventsOf(made.db, CARD_STOPPED).at(-1)
}

describe('under a shard the widen a scope question asks for comes from the card tree', () => {
  it('a named path the tree changed outside the touches is widened, a named path the tree did not change is dropped', async () => {
    const stop = await ownersStopWith([TOUCHED, CHANGED_OUTSIDE])

    expect(stop).toEqual(expect.objectContaining({ reason: QUESTION_OWNER, widen: [CHANGED_OUTSIDE] }))
  })

  it('with no change outside the touches the scope question widens nothing', async () => {
    const stop = await ownersStopWith([TOUCHED])

    expect(stop).toEqual(expect.objectContaining({ reason: QUESTION_OWNER }))
    expect(stop).not.toHaveProperty('widen')
  })
})
