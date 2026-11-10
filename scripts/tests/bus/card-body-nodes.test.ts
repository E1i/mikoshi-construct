import type { Lease } from '../../core/lease.js'
import type { Answerer } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, OWNER_WAIT_OPENED, QUESTION_OWNER } from '../../core/events.js'
import { OPEN_OWNER_STOP_OF_CARD } from '../../core/inbox.js'
import { leaseNext } from '../../core/lease.js'
import { openDecisionWaitsOf } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { AnswerOutsideTouches } from '../../nodes/answer/answerer.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 1494
const CARD_PR = CARD - 100
const REFUSED = ['package.json', 'scripts/b.ts']

const rooms: { made: MergeBench, root: string }[] = []

afterEach(() => {
  for (const { made, root } of rooms.splice(0)) {
    made.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function bodyTouching(touches: string): string {
  return `card: #${CARD} bodynodes [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/bodynodes\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nDo it.\n`
}

function admit(made: MergeBench, text: string, generation: string): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}:${generation}`, payload: { card: `#${CARD}`, lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${generation}`, text, textSha: textSha(text), bodySha: generation }, legacy: false })
  reduce(made.db)
}

function openStopOf(made: MergeBench): number | null {
  reduce(made.db)
  return (made.db.prepare(OPEN_OWNER_STOP_OF_CARD).get(CARD) as { id: number } | undefined)?.id ?? null
}

function openDecisionWaits(made: MergeBench): string[] {
  reduce(made.db)
  return (made.db.prepare(openDecisionWaitsOf('?')).all(CARD) as { id: string }[]).map(wait => wait.id)
}

async function refusedOutsideTouches() {
  const made = mergeBench()
  const root = mkdtempSync(path.join(tmpdir(), 'card-body-nodes-'))
  rooms.push({ made, root })
  const worktree = path.join(root, `mc-${CARD}`)
  mkdirSync(worktree)
  admit(made, bodyTouching('src/a.ts'), 'body-1')
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree, branch: 'feat/bodynodes', base: sha('1') }, legacy: false })
  made.gitHub.open({ number: CARD_PR, required: 'failure', failed: ['lint'] })
  made.tick()
  made.tick()
  const rounds: string[] = []
  const answerer: Answerer = async (request) => {
    if (rounds.push(request.lease.taskKey) === 1)
      throw new AnswerOutsideTouches(request.lease, REFUSED)
    return { session: 'card-session-1', resumed: true, before: sha('a'), after: sha('e'), owner: null }
  }
  const trees: CardTreeTools = { home: root, exists: existsSync, branchOf: () => 'feat/bodynodes', recreate: () => {}, bringTo: () => {} }
  const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees, liveSession: () => null })
  const lease = (): Lease | null => leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')
  const outcome = await executor.answer(lease()!)
  made.tick()
  return { made, executor, lease, outcome, rounds }
}

describe('the outside-touches stop of the answer node on the card body', () => {
  it('an amend widening the refused paths lifts the outside touches stop', async () => {
    const run = await refusedOutsideTouches()
    expect(run.outcome).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER })
    const stop = eventsOf(run.made.db, CARD_STOPPED).at(-1)!
    expect(stop.widen).toEqual(REFUSED)
    expect(openStopOf(run.made)).not.toBeNull()
    expect(openDecisionWaits(run.made)).toHaveLength(1)
    const waitsAtTheStop = eventsOf(run.made.db, OWNER_WAIT_OPENED).length

    admit(run.made, bodyTouching(`src/a.ts, ${REFUSED.join(', ')}`), 'body-2')
    run.made.tick()
    run.made.tick()

    expect(openStopOf(run.made)).toBeNull()
    const again = run.lease()
    expect(again).toMatchObject({ queue: 'answer', cardId: CARD, pr: CARD_PR })
    expect(await run.executor.answer(again!)).toMatchObject({ kind: 'answered', head: sha('e') })
    expect(run.rounds).toHaveLength(2)
    expect(openDecisionWaits(run.made)).toEqual([])
    expect(eventsOf(run.made.db, OWNER_WAIT_OPENED)).toHaveLength(waitsAtTheStop)
  })
})
