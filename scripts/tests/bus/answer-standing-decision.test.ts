import type { Lease } from '../../core/lease.js'
import type { Answerer } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, OWNER_WAIT_OPENED, PR_OPENED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 1775
const SESSION = 'answer-session-1'
const OUTSIDE_TIMEOUT = 'prepush timed out under machine load in scripts/tests/supervisor/stalled-sessions.test.ts, outside the touches; the witnesses are green'
const INSIDE_TIMEOUT = 'prepush timed out under machine load in scripts/a.ts; the witnesses are green'

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

function tempDir(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function answerAsking(question: string): Promise<{ made: MergeBench, outcome: Awaited<ReturnType<AnswerExecutor['answer']>>, published: number }> {
  const made = mergeBench()
  benches.push(made)
  const trees = tempDir('bus-standing-')
  mkdirSync(path.join(trees, `mc-${CARD}`))
  const ts = made.clock.now().toISOString()
  const text = `card: #${CARD} card-${CARD} [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nAnswer it.\n`
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree: path.join(trees, `mc-${CARD}`), branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: 'question.agent', detail: `a question on card #${CARD}` }, legacy: false })
  made.tick()
  const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  queueTask(made.db, ts, { queue: 'answer', cardId: CARD, stop })
  const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
  const answerer: Answerer = async () => ({ session: SESSION, resumed: true, before: sha('a'), after: sha('a'), owner: question })
  let published = 0
  const publish = (): void => {
    published += 1
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: PR_OPENED, actor: 'worker:shift:1', cardId: CARD, pr: 9775, head: null, dedupeKey: `${PR_OPENED}:${CARD}:9775`, payload: { pr: 9775 }, legacy: false })
  }
  const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees, dirty: () => false, liveSession: () => null, publishing: { committed: () => true, publish } })
  const lease = leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1') as Lease
  return { made, outcome: await executor.answer(lease), published }
}

describe('a timeout under load in an answer round (D-441 (2))', () => {
  it('a timeout under load outside the touches with green witnesses is retried, not stopped', async () => {
    const { made, outcome, published } = await answerAsking(OUTSIDE_TIMEOUT)

    expect(outcome).toMatchObject({ kind: 'published', pr: 9775 })
    expect(published).toBe(1)
    expect(eventsOf(made.db, CARD_STOPPED)).toHaveLength(1)
    expect(eventsOf(made.db, OWNER_WAIT_OPENED)).toEqual([])
  })

  it('a timeout under load inside the touches is still asked, and nothing is pushed', async () => {
    const { outcome, published } = await answerAsking(INSIDE_TIMEOUT)

    expect(outcome.kind).not.toBe('published')
    expect(published).toBe(0)
  })
})
