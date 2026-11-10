import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ANSWERED, PR_OBSERVED, REVIEW_RECORDED, ROUND_EXTENDED, SHARD_EXPIRED, SHARD_ISSUED, SHARD_REVOKED, WITNESS_RECORDED } from '../../core/events.js'
import { changesRoundsOf, REVIEW_ROUNDS } from '../../core/queue.js'
import { DECISIONS_SCOPE } from '../../policy/shards.js'
import { sha } from './github-fake.js'

const PR = 1741
const CARD = PR + 100
const TS = '2026-11-10T10:00:00.000Z'
const UNTIL = '2026-11-10T16:00:00.000Z'
const PAST_UNTIL = '2026-11-10T17:00:00.000Z'
const HEADS = [sha('a'), sha('b'), sha('c')]
const LAST = HEADS.at(-1)!
const SHARD = 'ws-1'
const dbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of dbs.splice(0))
    db.close()
})

function bus(): DatabaseSync {
  const db = openBus(':memory:')
  dbs.push(db)
  return db
}

let serial = 0

function event(db: DatabaseSync, type: string, head: string | null, payload: Record<string, unknown>, ts = TS): void {
  serial += 1
  appendEvent(db, { ts, type, actor: 'worker:test:1', cardId: CARD, pr: PR, head, dedupeKey: `${type}:${serial}`, payload, legacy: false })
}

function reviewed(db: DatabaseSync, head: string, verdict: 'changes' | 'pass', findings: string[] = []): void {
  event(db, REVIEW_RECORDED, head, { head, verdict, reviewer_session: 'reviewer-1', findings })
}

function observed(db: DatabaseSync, head: string, ci: 'green' | 'red'): void {
  event(db, PR_OBSERVED, head, { card_id: CARD, base: 'main', head, mergeable: 'clean', ci, auto_merge: false, draft: false })
}

type Shard = 'window' | 'none' | 'not-window' | 'merge'

function issued(db: DatabaseSync, shard: Shard): void {
  if (shard === 'none')
    return
  const scope = shard === 'merge' ? 'merge' : DECISIONS_SCOPE
  const window = shard === 'not-window' ? 0 : 1
  appendEvent(db, { ts: TS, type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:${SHARD}`, payload: { id: SHARD, by: 'owner', scope, until: UNTIL, window }, legacy: false })
}

type Ending = typeof SHARD_REVOKED | typeof SHARD_EXPIRED

function ended(db: DatabaseSync, type: Ending): void {
  appendEvent(db, { ts: TS, type, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${type}:${SHARD}`, payload: { id: SHARD }, legacy: false })
}

interface Limit {
  shard?: Shard
  ci?: 'green' | 'red'
  findings?: string[]
  endedBefore?: Ending
  endedAfter?: Ending
  extendedAt?: string
  laterGreenHead?: boolean
  redAfter?: boolean
}

function atTheLimit({ shard = 'window', ci = 'green', findings = ['a new defect'], endedBefore, endedAfter, extendedAt = TS, laterGreenHead = false, redAfter = false }: Limit = {}): DatabaseSync {
  const db = bus()
  issued(db, shard)
  if (endedBefore !== undefined)
    ended(db, endedBefore)
  for (const [at, head] of HEADS.entries()) {
    observed(db, head, at === HEADS.length - 1 ? ci : 'green')
    reviewed(db, head, 'changes', [`finding ${at}`])
  }
  if (laterGreenHead)
    observed(db, sha('e'), 'green')
  event(db, ROUND_EXTENDED, LAST, { pr: PR, findings, previous: ['finding 1'] }, extendedAt)
  if (endedAfter !== undefined)
    ended(db, endedAfter)
  if (redAfter)
    observed(db, LAST, 'red')
  return db
}

describe('autonomy rounds in the queue', () => {
  it('only a review changes verdict counts as a round', () => {
    const db = bus()
    reviewed(db, HEADS[0]!, 'changes', ['one'])
    reviewed(db, HEADS[1]!, 'pass')
    for (const [at, from] of [sha('d'), sha('e'), sha('f')].entries())
      event(db, CARD_ANSWERED, from, { session: 's', worktree: '/tree', resumed: true, source: 'ci', from, to: sha(String(at + 1)), reentry: true })
    event(db, WITNESS_RECORDED, sha('f'), { head: sha('f'), base: sha('1'), cardBody: 'x', verdict: 'red', detail: 'W1 exited 1' })
    observed(db, sha('f'), 'red')

    expect(changesRoundsOf(db, PR)).toBe(1)

    reviewed(db, HEADS[2]!, 'changes', ['two'])

    expect(changesRoundsOf(db, PR)).toBe(2)
  })

  it('under a shard the window grants one more round on green CI with new findings', () => {
    const cases: Record<string, { limit: Limit, rounds: number }> = {
      'a live window decisions shard, green CI, new findings': { limit: {}, rounds: REVIEW_ROUNDS - 1 },
      'a shard revoked after the extension': { limit: { endedAfter: SHARD_REVOKED }, rounds: REVIEW_ROUNDS - 1 },
      'a shard expired after the extension': { limit: { endedAfter: SHARD_EXPIRED }, rounds: REVIEW_ROUNDS - 1 },
      'red CI observed after the extension': { limit: { redAfter: true }, rounds: REVIEW_ROUNDS - 1 },
      'no shard': { limit: { shard: 'none' }, rounds: REVIEW_ROUNDS },
      'a decisions shard outside the window': { limit: { shard: 'not-window' }, rounds: REVIEW_ROUNDS },
      'a merge-only window shard': { limit: { shard: 'merge' }, rounds: REVIEW_ROUNDS },
      'a shard revoked before the extension': { limit: { endedBefore: SHARD_REVOKED }, rounds: REVIEW_ROUNDS },
      'a shard expired before the extension': { limit: { endedBefore: SHARD_EXPIRED }, rounds: REVIEW_ROUNDS },
      'an extension past the shard\'s until': { limit: { extendedAt: PAST_UNTIL }, rounds: REVIEW_ROUNDS },
      'red CI on the extended head': { limit: { ci: 'red' }, rounds: REVIEW_ROUNDS },
      'a later green observation of another head': { limit: { laterGreenHead: true }, rounds: REVIEW_ROUNDS },
      'the previous findings again': { limit: { findings: [' finding 1 '] }, rounds: REVIEW_ROUNDS },
      'no findings': { limit: { findings: [] }, rounds: REVIEW_ROUNDS },
    }
    for (const [name, { limit, rounds }] of Object.entries(cases))
      expect({ name, rounds: changesRoundsOf(atTheLimit(limit), PR) }).toEqual({ name, rounds })
  })
})
