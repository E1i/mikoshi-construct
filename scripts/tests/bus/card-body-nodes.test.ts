import type { Lease } from '../../core/lease.js'
import type { Answerer } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { HOLD_RECHECK_MS } from '../../core/card-hold.js'
import { appendEvent, openOwnerWait } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, OWNER_WAIT_OPENED, QUESTION_OWNER, SCOPE_WIDENED } from '../../core/events.js'
import { OPEN_OWNER_STOP_OF_CARD } from '../../core/inbox.js'
import { leaseNext } from '../../core/lease.js'
import { openDecisionWaitsOf } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { cardContract } from '../../intake/card-contract.js'
import { AnswerExecutor, closeWaitOfAWidenStopTheAmendLifted } from '../../nodes/answer/answer-executor.js'
import { AnswerOutsideTouches } from '../../nodes/answer/answerer.js'
import { HEAD_OUTSIDE_TOUCHES } from '../../nodes/merge/merge-executor.js'
import { sha } from './github-fake.js'
import { eventsOf, liveBench, mergeBench } from './merge-bench.js'

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

const MERGE_CARD = 1495
const MERGE_PR = MERGE_CARD - 100
const ACTOR = 'worker:answer:worker-1'

function bodyTouching(touches: string, card = CARD, extra = ''): string {
  return `card: #${card} bodynodes [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/bodynodes\ntouches: ${touches}\n${extra}continue: stop\nwho: shift\n\nDo it.\n`
}

function admit(made: MergeBench, text: string, generation: string, card = CARD): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId: card, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${card}:${generation}`, payload: { card: `#${card}`, lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${generation}`, text, textSha: textSha(text), bodySha: generation }, legacy: false })
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

async function refusedOutsideTouches(admitted = 'src/a.ts') {
  const made = mergeBench()
  const root = mkdtempSync(path.join(tmpdir(), 'card-body-nodes-'))
  rooms.push({ made, root })
  const worktree = path.join(root, `mc-${CARD}`)
  mkdirSync(worktree)
  admit(made, bodyTouching(admitted), 'body-1')
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

describe('the guards that keep the owner wait of an outside-touches stop open', () => {
  it('an amend that covers only some of the refused paths closes no wait', async () => {
    const run = await refusedOutsideTouches()
    admit(run.made, bodyTouching(`src/a.ts, ${REFUSED[0]}`), 'body-2')

    expect(closeWaitOfAWidenStopTheAmendLifted(run.made.db, () => run.made.clock.now().toISOString(), ACTOR, CARD)).toEqual([])
    expect(openDecisionWaits(run.made)).toHaveLength(1)
  })

  it('an admission no newer than the stop closes no wait, even when its touches cover the refused paths', async () => {
    const run = await refusedOutsideTouches(`src/a.ts, ${REFUSED.join(', ')}`)
    expect(eventsOf(run.made.db, CARD_STOPPED).at(-1)!.widen).toEqual(REFUSED)

    expect(closeWaitOfAWidenStopTheAmendLifted(run.made.db, () => run.made.clock.now().toISOString(), ACTOR, CARD)).toEqual([])
    expect(openDecisionWaits(run.made)).toHaveLength(1)
  })

  it('a covering amend closes the wait the stop opened and leaves another wait of the card open', async () => {
    const run = await refusedOutsideTouches()
    const [stopWait] = openDecisionWaits(run.made)
    const other = openOwnerWait(run.made.db, run.made.clock.now().toISOString(), 'policy', { need: 'decision', text: `card #${CARD} asks: another question`, card: CARD, pr: CARD_PR })
    expect(openDecisionWaits(run.made)).toEqual([stopWait, other])
    admit(run.made, bodyTouching(`src/a.ts, ${REFUSED.join(', ')}`), 'body-2')
    expect(openDecisionWaits(run.made)).toEqual([stopWait, other])

    expect(closeWaitOfAWidenStopTheAmendLifted(run.made.db, () => run.made.clock.now().toISOString(), ACTOR, CARD)).toEqual([stopWait])
    expect(openDecisionWaits(run.made)).toEqual([other])
  })
})

interface MergeCase {
  touches: string
  extra?: string
  files: string[]
  added?: string[]
  widen?: 'current' | 'older'
}

function mergeRoom(made: MergeBench, scope: MergeCase): void {
  admit(made, bodyTouching(scope.touches, MERGE_CARD, scope.extra), 'merge-1', MERGE_CARD)
  if (scope.widen !== undefined) {
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: SCOPE_WIDENED, actor: ACTOR, cardId: MERGE_CARD, pr: MERGE_PR, head: null, dedupeKey: `${SCOPE_WIDENED}:${MERGE_CARD}`, payload: { paths: ['package.json'], admission: cardContract(made.db, MERGE_CARD)!.admissionEventId, detail: 'in the concept of the card' }, legacy: false })
    if (scope.widen === 'older')
      admit(made, bodyTouching(scope.touches, MERGE_CARD, `${scope.extra ?? ''}release: none\n`), 'merge-2', MERGE_CARD)
  }
  const added = new Set(scope.added ?? [])
  const fake = made.gitHub as unknown as { answer: (endpoint: string) => unknown }
  const answer = fake.answer.bind(made.gitHub)
  fake.answer = (endpoint) => {
    const body = answer(endpoint)
    return endpoint.includes('/files?') && Array.isArray(body) ? body.map((file: { filename: string }) => added.has(file.filename) ? { ...file, status: 'added' } : file) : body
  }
  made.gitHub.open({ number: MERGE_PR, review: 'success', files: scope.files })
  made.tick()
}

function mergeOf(scope: MergeCase): ReturnType<MergeBench['merge']> {
  const made = liveBench()
  try {
    mergeRoom(made, scope)
    return made.merge(made.lease()!)
  }
  finally {
    made.close()
  }
}

const REFUSED_AT_MERGE = { kind: 'denied', denial: { kind: 'technical', reason: HEAD_OUTSIDE_TOUCHES } }

describe('the merge node keeps a head inside the touches of its card', () => {
  it('a path the answer node widened on the current admission merges, one widened on an older admission does not', () => {
    expect(mergeOf({ touches: 'scripts/a.ts', files: ['scripts/a.ts', 'package.json'], widen: 'current' })).toMatchObject({ kind: 'merged' })
    expect(mergeOf({ touches: 'scripts/a.ts', files: ['scripts/a.ts', 'package.json'], widen: 'older' })).toMatchObject(REFUSED_AT_MERGE)
  })

  it('a path the card creates merges, the same path not created is refused', () => {
    expect(mergeOf({ touches: 'scripts/a.ts', extra: 'creates: scripts/new.ts\n', files: ['scripts/a.ts', 'scripts/new.ts'] })).toMatchObject({ kind: 'merged' })
    expect(mergeOf({ touches: 'scripts/a.ts', files: ['scripts/a.ts', 'scripts/new.ts'] })).toMatchObject(REFUSED_AT_MERGE)
  })

  it('a changeset the head adds follows the touches, a changeset it modifies does not', () => {
    expect(mergeOf({ touches: 'scripts/a.ts', files: ['scripts/a.ts', '.changeset/x.md'], added: ['.changeset/x.md'] })).toMatchObject({ kind: 'merged' })
    expect(mergeOf({ touches: 'scripts/a.ts', files: ['scripts/a.ts', '.changeset/x.md'] })).toMatchObject(REFUSED_AT_MERGE)
  })

  it('a refused head waits the hold recheck before the merge node takes it again', () => {
    const made = liveBench()
    try {
      mergeRoom(made, { touches: 'scripts/a.ts', files: ['scripts/a.ts', 'package.json'] })
      expect(made.merge(made.lease()!)).toMatchObject(REFUSED_AT_MERGE)
      made.tick()
      expect(made.lease()).toBeNull()
      made.clock.advance(HOLD_RECHECK_MS)
      made.tick()
      expect(made.lease()).toMatchObject({ queue: 'merge', pr: MERGE_PR })
    }
    finally {
      made.close()
    }
  })
})
