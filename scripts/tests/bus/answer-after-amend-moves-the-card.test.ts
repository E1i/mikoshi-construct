import type { BusEvent } from '../../core/db.js'
import type { Lease } from '../../core/lease.js'
import type { Answerer } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, OWNER_WAIT_OPENED, QUESTION_OWNER, REJECTED } from '../../core/events.js'
import { OPEN_OWNER_STOP_OF_CARD } from '../../core/inbox.js'
import { leaseNext } from '../../core/lease.js'
import { all as pullRequests } from '../../core/pr-readings.js'
import { reduce } from '../../core/reducer.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { AnswerOutsideTouches } from '../../nodes/answer/answerer.js'
import { busProjections, cardTransitions } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 1843
const PR = 1601
const OLD_HEAD = '0123456789abcdef0123456789abcdef01234567'
const NEW_HEAD = '89abcdef0123456789abcdef0123456789abcdef'
const roots: string[] = []
let sequence = 0

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

type Bus = ReturnType<typeof openBus>

function newBus(): Bus {
  const root = mkdtempSync(path.join(tmpdir(), 'answer-after-amend-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function event(type: string, fields: Partial<BusEvent>): BusEvent {
  sequence += 1
  return { ts: '2026-11-12T14:25:50.000Z', type, actor: 'netwatch', cardId: CARD, pr: null, head: null, dedupeKey: `${type}:${sequence}`, payload: {}, legacy: false, ...fields }
}

const admitted = (): BusEvent => event('card.admitted', { actor: 'reducer', payload: { lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [] } })
const started = (): BusEvent => event('card.started', { actor: 'worker:launch:s1', payload: { session: 's1' } })
const opened = (): BusEvent => event('pr.opened', { actor: 'worker:launch:s1', payload: { pr: PR } })
const observed = (head: string): BusEvent => event('pr.observed', { pr: PR, head, payload: { base: 'main', head, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false } })
const reviewed = (head: string, verdict: string): BusEvent => event('review.recorded', { actor: 'worker:review:r1', pr: PR, head, payload: { head, verdict, reviewer_session: 'r1' } })
const stopped = (): BusEvent => event('card.stopped', { actor: 'worker:answer:a1', payload: { reason: 'review', detail: 'changes' } })
const answered = (): BusEvent => event('card.answered', { actor: 'worker:answer:a2', payload: { session: 'a2' } })

function stepThrough(db: Bus, steps: BusEvent[]): unknown[] {
  return steps.map((next) => {
    appendEvent(db, next)
    reduce(db, 'pending', busProjections())
    return stateOf(db)
  })
}

function stateOf(db: Bus): unknown {
  return (db.prepare('SELECT state FROM cards WHERE card_id = ?').get(CARD) as { state: unknown } | undefined)?.state
}

function rejectionReasons(db: Bus): string[] {
  return (db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(REJECTED) as { payload: string }[])
    .map(row => (JSON.parse(row.payload) as { reason: string }).reason)
}

function stoppedThenAmendedWithItsPullRequestOpen(db: Bus): void {
  stepThrough(db, [admitted(), started(), opened(), observed(OLD_HEAD), reviewed(OLD_HEAD, 'changes'), stopped(), admitted()])
}

describe('an answer after an amend', () => {
  it('an answer on a card re-admitted with an open PR is accepted and moves the card to review', () => {
    const db = newBus()
    stoppedThenAmendedWithItsPullRequestOpen(db)
    expect(stateOf(db)).toBe('queued')
    expect(stepThrough(db, [answered()])).toEqual(['in_review'])
    expect(rejectionReasons(db)).toEqual([])
    db.close()
  })

  it('an answer on a queued card with no open PR is still rejected', () => {
    const db = newBus()
    expect(stepThrough(db, [admitted(), answered()])).toEqual(['queued', 'queued'])
    expect(rejectionReasons(db)).toEqual([`card ${CARD} is queued, and card.answered moves only a card that is stopped | changes | in_review`])
    db.close()
  })

  it('after an amend the pushed answer ends the round with no empty answer on the old head', () => {
    const db = newBus()
    stoppedThenAmendedWithItsPullRequestOpen(db)
    expect(stepThrough(db, [answered(), observed(NEW_HEAD), reviewed(NEW_HEAD, 'pass')])).toEqual(['in_review', 'in_review', 'ready'])
    expect(db.prepare('SELECT head FROM prs WHERE pr = ?').get(PR)).toEqual({ head: NEW_HEAD })
    expect(db.prepare(`SELECT count(*) AS n FROM events WHERE type = 'card.stopped' AND json_extract(payload, '$.reason') = 'fault'`).get()).toEqual({ n: 0 })
    expect(rejectionReasons(db)).toEqual([])
    db.close()
  })
})

const STOPPED_CARD = 2259
const STOPPED_PR = STOPPED_CARD - 100
const RATCHET = 'contract/ratchet.json'
const AMEND = 'amend'

const benches: { made: MergeBench, root: string }[] = []

afterEach(() => {
  for (const { made, root } of benches.splice(0)) {
    made.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function bodyTouching(touches: string, note = 'Do it.'): string {
  return `card: #${STOPPED_CARD} amend-lifts [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: feat/amend-lifts\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\n${note}\n`
}

function admit(made: MergeBench, text: string, generation: string, source?: string): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId: STOPPED_CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${STOPPED_CARD}:${generation}`, payload: { card: `#${STOPPED_CARD}`, lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${generation}`, text, textSha: textSha(text), bodySha: generation, ...(source === undefined ? {} : { source }) }, legacy: false })
  reduce(made.db, 'pending', busProjections())
}

async function stoppedOutsideTheTouches(refused: readonly string[]) {
  const made = mergeBench()
  const root = mkdtempSync(path.join(tmpdir(), 'amend-lifts-'))
  benches.push({ made, root })
  const worktree = path.join(root, `mc-${STOPPED_CARD}`)
  mkdirSync(worktree)
  admit(made, bodyTouching('src/a.ts'), 'body-1')
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: STOPPED_CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${STOPPED_CARD}`, payload: { session: 'card-session-1', worktree, branch: 'feat/amend-lifts', base: sha('1') }, legacy: false })
  made.gitHub.open({ number: STOPPED_PR, required: 'failure', failed: ['lint'] })
  made.tick()
  made.tick()
  const rounds: string[] = []
  const answerer: Answerer = async (request) => {
    if (rounds.push(request.lease.taskKey) === 1)
      throw new AnswerOutsideTouches(request.lease, refused)
    return { session: 'card-session-1', resumed: true, before: sha('a'), after: sha('e'), owner: null }
  }
  const trees: CardTreeTools = { home: root, exists: existsSync, branchOf: () => 'feat/amend-lifts', recreate: () => {}, bringTo: () => {} }
  const executor = new AnswerExecutor({ cards: cardTransitions(), silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees, liveSession: () => null })
  const lease = (): Lease | null => leaseNext(made.db, pullRequests(made.db), made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')
  const outcome = await executor.answer(lease()!)
  made.tick()
  const stop = made.db.prepare('SELECT id, payload FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').get(CARD_STOPPED) as { id: number, payload: string }
  return { made, executor, lease, outcome, rounds, stop: { id: Number(stop.id), widen: (JSON.parse(stop.payload) as { widen?: string[] }).widen } }
}

function openStopOn(made: MergeBench): number | null {
  reduce(made.db, 'pending', busProjections())
  return (made.db.prepare(OPEN_OWNER_STOP_OF_CARD).get(STOPPED_CARD) as { id: number } | undefined)?.id ?? null
}

function waitStatesOf(made: MergeBench): string[] {
  reduce(made.db, 'pending', busProjections())
  return (made.db.prepare('SELECT state FROM owner_waits WHERE card_id = ? ORDER BY id').all(STOPPED_CARD) as { state: string }[]).map(row => row.state)
}

describe('an amend that answers a question.owner stop lifts it', () => {
  it('an amend that widens the refused paths lifts the outside-touches stop and queues the answer', async () => {
    const run = await stoppedOutsideTheTouches(['package.json', 'scripts/b.ts', RATCHET])
    expect(run.outcome).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER })
    expect(run.stop.widen).toEqual(['package.json', 'scripts/b.ts'])
    expect(openStopOn(run.made)).toBe(run.stop.id)
    expect(run.lease()).toBeNull()

    admit(run.made, bodyTouching('src/a.ts, package.json'), 'body-2', AMEND)
    run.made.tick()
    expect(openStopOn(run.made)).toBe(run.stop.id)
    expect(waitStatesOf(run.made)).toEqual(['open'])
    expect(run.lease()).toBeNull()

    admit(run.made, bodyTouching('src/a.ts, package.json, scripts/b.ts'), 'body-3', AMEND)
    run.made.tick()
    run.made.tick()

    expect(openStopOn(run.made)).toBeNull()
    expect(waitStatesOf(run.made)).toEqual(['closed'])
    const again = run.lease()
    expect(again).toMatchObject({ queue: 'answer', cardId: STOPPED_CARD, pr: STOPPED_PR })
    expect(await run.executor.answer(again!)).toMatchObject({ kind: 'answered', head: sha('e') })
    expect(run.rounds).toHaveLength(2)
  })

  it('an amend that closes the wait of a stop answers the stop without naming it', async () => {
    const run = await stoppedOutsideTheTouches([RATCHET])
    expect(run.outcome).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER })
    expect(run.stop.widen).toBeUndefined()
    expect(openStopOn(run.made)).toBe(run.stop.id)
    expect(run.lease()).toBeNull()
    const waitsAtTheStop = eventsOf(run.made.db, OWNER_WAIT_OPENED).length

    admit(run.made, bodyTouching('src/a.ts', 'Do it; the ratchet stays as it is.'), 'body-2', AMEND)
    run.made.tick()
    run.made.tick()

    expect(waitStatesOf(run.made)).toEqual(['closed'])
    expect(openStopOn(run.made)).toBeNull()
    expect(eventsOf(run.made.db, OWNER_WAIT_OPENED)).toHaveLength(waitsAtTheStop)
    const again = run.lease()
    expect(again).toMatchObject({ queue: 'answer', cardId: STOPPED_CARD, pr: STOPPED_PR })
    expect(await run.executor.answer(again!)).toMatchObject({ kind: 'answered', head: sha('e') })
  })

  it('a stop whose refused paths an amend does not cover still holds the card', async () => {
    const run = await stoppedOutsideTheTouches(['package.json', 'scripts/b.ts'])

    admit(run.made, bodyTouching('src/a.ts, package.json'), 'body-2', AMEND)
    run.made.tick()
    run.made.tick()

    expect(openStopOn(run.made)).toBe(run.stop.id)
    expect(run.lease()).toBeNull()
  })
})
