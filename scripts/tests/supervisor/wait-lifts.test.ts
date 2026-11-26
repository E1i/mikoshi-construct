import type { DatabaseSync } from 'node:sqlite'
import type { WaitLift } from '../../core/db.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closedWaitIds, openOwnerWaits } from '../../core/card-readings.js'
import { appendEvent, isWaitLift, liftHeldAtOpen, openOwnerWait } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_STOPPED, CARD_WAITING, MERGE_DONE, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, PR_CLOSED, PR_OBSERVED, QUESTION_AGENT, REJECTED, REVIEW_RECORDED, UPDATE_DONE, WITNESS_DOWNGRADE, WITNESS_RECORDED } from '../../core/events.js'
import { reviewCandidates } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { answerCandidates } from '../../nodes/answer/answer-candidates.js'
import { faultedAnswerLift } from '../../nodes/answer/answer-executor.js'
import { EMPTY_ROUND_LIFTS } from '../../nodes/answer/duties/source.js'
import { GROWTH_LIFTS } from '../../nodes/update/update-executor.js'
import { recordDecision } from '../../policy/decisions/index.js'
import { answerParts, busProjections, candidateRules, deadEndParts, openComposedBus, waitLiftParts } from '../../supervisor/composition.js'
import { DEAD_END_ACTOR, DEAD_END_LIFTS, DeadEnds, UNMEASURED_ROUND_MINUTES } from '../../supervisor/dead-ends.js'
import { WAIT_LIFT_ACTOR, WaitLifts } from '../../supervisor/wait-lifts.js'
import { sha } from '../bus/github-fake.js'
import { liveBench } from '../bus/merge-bench.js'

const OPENED_AT = '2026-11-26T08:00:00.000Z'
const NOW = new Date(Date.parse(OPENED_AT) + (UNMEASURED_ROUND_MINUTES + 5) * 60_000)
const CARD = 2309
const PR = 1960
const DEPENDENCY = 2290
const HEAD = 'a'.repeat(40)
const NEW_HEAD = 'b'.repeat(40)

const buses: DatabaseSync[] = []
let sequence = 0

afterEach(() => {
  for (const db of buses.splice(0))
    db.close()
})

function bus(): DatabaseSync {
  const db = openComposedBus(':memory:')
  buses.push(db)
  return db
}

function put(db: DatabaseSync, type: string, fields: { card?: number, pr?: number, head?: string, payload?: Record<string, unknown> }): void {
  sequence += 1
  appendEvent(db, { ts: OPENED_AT, type, actor: 'netwatch', cardId: fields.card ?? null, pr: fields.pr ?? null, head: fields.head ?? null, dedupeKey: `fixture:${type}:${sequence}`, payload: fields.payload ?? {}, legacy: false })
}

function observed(db: DatabaseSync, head: string): void {
  put(db, PR_OBSERVED, { card: CARD, pr: PR, head, payload: { head, base: 'main', ci: 'green', mergeable: 'clean', auto_merge: false, draft: false } })
}

function witnessed(db: DatabaseSync, head: string, verdict: 'green' | 'red'): void {
  put(db, WITNESS_RECORDED, { card: CARD, pr: PR, head, payload: { head, verdict, detail: 'W1' } })
}

function reviewed(db: DatabaseSync, head: string, verdict: 'pass' | 'changes'): void {
  put(db, REVIEW_RECORDED, { card: CARD, pr: PR, head, payload: { head, verdict, findings: [] } })
}

function admitted(db: DatabaseSync, source: string | null, depends: readonly number[] = []): void {
  put(db, CARD_ADMITTED, { card: CARD, payload: { card: `#${CARD}`, lane: 'lane-1', text: `card: #${CARD}`, depends, ...(source === null ? {} : { source }) } })
}

function opened(db: DatabaseSync, lift: WaitLift, text = `card #${CARD} waits for the owner`): string {
  const id = openOwnerWait(db, OPENED_AT, 'worker:answer:worker-1', { need: 'decision', text, card: CARD, pr: PR, lift })
  reduce(db, 'pending', busProjections())
  return id
}

function swept(db: DatabaseSync): string[] {
  const lines = new WaitLifts(db, () => NOW, waitLiftParts(db, () => NOW)).step()
  reduce(db, 'pending', busProjections())
  return lines
}

function stillOpen(db: DatabaseSync, id: string): boolean {
  return openOwnerWaits(db).some(wait => wait.id === id)
}

function reducedAnswerOf(db: DatabaseSync, id: string): unknown {
  return { ...db.prepare('SELECT state, answer FROM owner_waits WHERE id = ?').get(id) as object }
}

function closesOf(db: DatabaseSync, id: string): string[] {
  return (db.prepare(`SELECT json_extract(payload, '$.answer') AS answer FROM events WHERE type = '${OWNER_WAIT_CLOSED}' AND json_extract(payload, '$.id') = ? AND actor = '${WAIT_LIFT_ACTOR}'`).all(id) as { answer: string }[]).map(row => row.answer)
}

describe('one sweep closes an owner wait once its lift holds on the current state', () => {
  it('a wait opened by a faulted answer closes once the current head has green witnesses and a review pass', () => {
    const db = bus()
    observed(db, HEAD)
    const id = opened(db, faultedAnswerLift(HEAD))
    expect(swept(db)).toEqual([])
    witnessed(db, HEAD, 'green')
    reviewed(db, HEAD, 'pass')

    expect(swept(db)).toEqual([`${id} #${CARD} lifted: green witnesses and a review pass on ${HEAD} of pull request #${PR}`])
    expect(closesOf(db, id)).toEqual([`lifted: green witnesses and a review pass on ${HEAD} of pull request #${PR}`])
    expect(stillOpen(db, id)).toBe(false)
  })

  const OPENERS: Record<string, { lift: WaitLift, condition: (db: DatabaseSync) => void, answer: string }> = {
    'faulted answer on a new head': { lift: faultedAnswerLift(HEAD), condition: db => observed(db, NEW_HEAD), answer: `lifted: a new head ${NEW_HEAD} on pull request #${PR}` },
    'dead end on an amend': { lift: { on: DEAD_END_LIFTS, head: HEAD }, condition: db => admitted(db, 'amend'), answer: `card #${CARD} amended` },
    'empty round on a decision bound to the card': { lift: { on: EMPTY_ROUND_LIFTS, head: HEAD }, condition: db => recordDecision(db, { ts: OPENED_AT, decisionId: 2333, text: `[owner] #${CARD}: go on`, cards: [CARD] }), answer: `lifted: a decision bound to card #${CARD} was recorded` },
    'hold-until on its dependency merged': { lift: { on: [...EMPTY_ROUND_LIFTS, 'dependency-merged'], head: HEAD }, condition: db => put(db, MERGE_DONE, { card: DEPENDENCY, payload: {} }), answer: `lifted: every dependency of card #${CARD} is merged` },
    'growth on the pull request merged': { lift: { on: GROWTH_LIFTS, head: HEAD }, condition: db => put(db, PR_CLOSED, { card: CARD, pr: PR, payload: { merged: true } }), answer: `card #${CARD} merged` },
  }

  it('each opener has a lift that closes its wait on the current state', () => {
    for (const [name, opener] of Object.entries(OPENERS)) {
      const db = bus()
      observed(db, HEAD)
      admitted(db, null, [DEPENDENCY])
      const id = opened(db, opener.lift)
      expect(swept(db), name).toEqual([])

      opener.condition(db)
      reduce(db, 'pending', busProjections())
      swept(db)

      expect(reducedAnswerOf(db, id), name).toEqual({ state: 'closed', answer: opener.answer })
      expect(stillOpen(db, id), name).toBe(false)
      expect(swept(db), name).toEqual([])
    }
  })

  it('a wait whose lift has not happened stays open', () => {
    const db = bus()
    observed(db, HEAD)
    const red = opened(db, faultedAnswerLift(HEAD), 'red witness')
    witnessed(db, HEAD, 'red')
    reviewed(db, HEAD, 'pass')
    expect(swept(db)).toEqual([])

    witnessed(db, HEAD, 'green')
    reviewed(db, HEAD, 'changes')
    expect(swept(db)).toEqual([])
    const ownerOnly = opened(db, { on: ['owner-answer'] }, 'only the owner answers this')
    put(db, PR_CLOSED, { card: CARD, pr: PR, payload: { merged: false } })
    expect(swept(db)).toEqual([])

    expect([stillOpen(db, red), stillOpen(db, ownerOnly)]).toEqual([true, true])
  })
})

function deadEndCard(db: DatabaseSync): void {
  put(db, CARD_STOPPED, { card: CARD, pr: PR, payload: { reason: QUESTION_AGENT } })
  db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, ?, (SELECT max(id) FROM events))').run(CARD, 'stopped', PR)
}

function deadEndWaits(db: DatabaseSync): unknown[] {
  return db.prepare(`SELECT id FROM events WHERE type = '${OWNER_WAIT_OPENED}' AND actor = '${DEAD_END_ACTOR}'`).all()
}

describe('a wait is never opened when its lift already holds, nor twice for one reason', () => {
  it('an opener whose lift already holds opens no wait', () => {
    const db = bus()
    observed(db, HEAD)
    witnessed(db, HEAD, 'green')
    reviewed(db, HEAD, 'pass')
    deadEndCard(db)

    expect(liftHeldAtOpen(db, { pr: PR, lift: faultedAnswerLift(HEAD) })).toBe('passed-on-head')
    expect(new DeadEnds(db, () => NOW, deadEndParts(db)).step()).toEqual([expect.not.stringMatching(/; owner wait Q\d+$/)])
    expect(db.prepare(`SELECT count(*) AS n FROM events WHERE type = '${BOARD_ALARM}'`).get()).toEqual({ n: 1 })
    expect(deadEndWaits(db)).toEqual([])
    put(db, PR_CLOSED, { card: CARD, pr: PR, payload: { merged: true } })
    expect(liftHeldAtOpen(db, { pr: PR, lift: { on: GROWTH_LIFTS } })).toBe('pr-merged')
    expect(liftHeldAtOpen(db, { pr: PR, lift: { on: ['decision', 'amend'] } })).toBeNull()
  })

  it('an opener never opens a second wait for a reason already open on the card', () => {
    const db = bus()
    observed(db, HEAD)
    const first = opened(db, faultedAnswerLift(HEAD), 'the tree cannot be read')
    const ask = { need: 'decision' as const, text: 'the tree cannot be read', card: CARD, pr: PR, lift: faultedAnswerLift(HEAD) }
    expect(openOwnerWait(db, OPENED_AT, 'worker:answer:worker-1', ask, closedWaitIds(db))).toBe(first)
    expect(db.prepare(`SELECT count(*) AS n FROM events WHERE type = '${OWNER_WAIT_OPENED}'`).get()).toEqual({ n: 1 })
    const blind = opened(db, faultedAnswerLift(HEAD), 'the tree cannot be read')
    expect([stillOpen(db, first), stillOpen(db, blind)]).toEqual([true, false])
    expect(swept(db)).toEqual([expect.stringContaining(`${blind} #${CARD} refused by the reducer: ${blind} is refused: the same reason is already open on card #${CARD} as ${first}`)])
    expect(opened(db, faultedAnswerLift(HEAD), 'another question')).not.toBe(first)

    const actions = [`allow the downgrade of W1 on #${CARD}`]
    put(db, CARD_WAITING, { card: CARD, payload: { reason: WITNESS_DOWNGRADE, witnesses: ['W1'], actions, bodySha: 'first' } })
    put(db, CARD_WAITING, { card: CARD, payload: { reason: WITNESS_DOWNGRADE, witnesses: ['W1'], actions, bodySha: 'readmitted' } })
    reduce(db, 'pending', busProjections())

    const downgrades = openOwnerWaits(db).filter(wait => wait.id.startsWith('W'))
    expect(downgrades).toHaveLength(1)
    const refused = db.prepare(`SELECT json_extract(payload, '$.reason') AS reason FROM events WHERE type = '${REJECTED}'`).all() as { reason: string }[]
    expect(refused).toContainEqual({ reason: expect.stringContaining(`the same reason is already open on card #${CARD} as ${downgrades[0]!.id}`) })
  })
})

describe('the gate refuses a lift that names no condition', () => {
  it('an owner wait whose lift is empty or unknown is refused and a named lift is written as data', () => {
    const db = bus()
    expect(() => openOwnerWait(db, OPENED_AT, 'policy', { need: 'decision', text: 'which path?', card: CARD, lift: { on: [] } })).toThrow(/names a lift/)
    expect(() => openOwnerWait(db, OPENED_AT, 'policy', { need: 'decision', text: 'which path?', card: CARD, lift: { on: ['someday' as never] } })).toThrow(/names a lift/)
    openOwnerWait(db, OPENED_AT, 'policy', { need: 'decision', text: 'which path?', card: CARD, pr: PR, lift: { on: ['new-head'], head: HEAD } })
    const written = db.prepare(`SELECT json_extract(payload, '$.lift') AS lift FROM events WHERE type = '${OWNER_WAIT_OPENED}'`).get() as { lift: string }
    expect(isWaitLift(JSON.parse(written.lift))).toBe(true)
  })
})

describe('a clean update moves the card past its question stop', () => {
  const UPDATED_PR = 2198
  const UPDATED_CARD = UPDATED_PR + 100
  const OLD = sha('a')
  const UPDATED = sha('d')
  const benches: MergeBench[] = []

  afterEach(() => {
    for (const made of benches.splice(0))
      made.close()
    vi.restoreAllMocks()
  })

  function settled(bench: MergeBench): void {
    bench.tick()
    bench.tick()
  }

  function appended(bench: MergeBench, type: string, head: string, payload: Record<string, unknown>): void {
    sequence += 1
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type, actor: 'worker:update:worker-1', cardId: UPDATED_CARD, pr: UPDATED_PR, head, dedupeKey: `fixture:${type}:${sequence}`, payload, legacy: false })
  }

  function candidatesOf(bench: MergeBench): { answer: (string | undefined)[], review: (string | undefined)[] } {
    const ts = bench.clock.now().toISOString()
    return {
      answer: answerCandidates(bench.db, ts, answerParts()).filter(task => task.cardId === UPDATED_CARD).map(task => task.head),
      review: reviewCandidates(bench.db, ts, candidateRules()).filter(task => task.cardId === UPDATED_CARD).map(task => task.head),
    }
  }

  it('after a clean update to a new head with no open question no changes verdict and no red check the card routes to review and no answer round is queued', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const bench = liveBench()
    benches.push(bench)
    bench.gitHub.open({ number: UPDATED_PR, head: OLD, mergeable_state: 'blocked' })
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: UPDATED_CARD, pr: null, head: null, dedupeKey: `fixture:${UPDATED_CARD}:admitted`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: 'admission-1' }, legacy: false })
    settled(bench)
    appended(bench, CARD_STOPPED, OLD, { reason: QUESTION_AGENT, detail: 'which path?' })
    settled(bench)
    expect(candidatesOf(bench).answer).toEqual([OLD])

    appended(bench, UPDATE_DONE, OLD, { from: OLD, to: UPDATED, carried: null, why: 'main moved under the layers', clean: true })
    bench.gitHub.open({ number: UPDATED_PR, head: UPDATED, mergeable_state: 'clean' })
    settled(bench)

    expect(candidatesOf(bench)).toEqual({ answer: [], review: [UPDATED] })
  })
})
