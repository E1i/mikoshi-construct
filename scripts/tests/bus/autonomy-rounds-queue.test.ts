import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ANSWERED, PR_OBSERVED, REVIEW_RECORDED, ROUND_EXTENDED, SHARD_ISSUED, SHARD_REVOKED, WITNESS_RECORDED } from '../../core/events.js'
import { changesRoundsOf, REVIEW_ROUNDS } from '../../core/queue.js'
import { DECISIONS_SCOPE } from '../../policy/shards.js'
import { sha } from './github-fake.js'

const PR = 1741
const CARD = PR + 100
const TS = '2026-11-10T10:00:00.000Z'
const UNTIL = '2026-11-10T16:00:00.000Z'
const HEADS = [sha('a'), sha('b'), sha('c')]
const LAST = HEADS.at(-1)!
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

function event(db: DatabaseSync, type: string, head: string | null, payload: Record<string, unknown>): void {
  serial += 1
  appendEvent(db, { ts: TS, type, actor: 'worker:test:1', cardId: CARD, pr: PR, head, dedupeKey: `${type}:${serial}`, payload, legacy: false })
}

function reviewed(db: DatabaseSync, head: string, verdict: 'changes' | 'pass', findings: string[] = []): void {
  event(db, REVIEW_RECORDED, head, { head, verdict, reviewer_session: 'reviewer-1', findings })
}

function observed(db: DatabaseSync, head: string, ci: 'green' | 'red'): void {
  event(db, PR_OBSERVED, head, { card_id: CARD, base: 'main', head, mergeable: 'clean', ci, auto_merge: false, draft: false })
}

function windowShard(db: DatabaseSync, id: string, scope = DECISIONS_SCOPE): void {
  appendEvent(db, { ts: TS, type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:${id}`, payload: { id, by: 'owner', scope, until: UNTIL, window: 1 }, legacy: false })
}

function extended(db: DatabaseSync, findings: string[], previous: string[]): void {
  event(db, ROUND_EXTENDED, LAST, { pr: PR, findings, previous })
}

interface Limit {
  shard: boolean
  ci: 'green' | 'red'
  findings: string[]
  revoked?: boolean
}

function atTheLimit({ shard, ci, findings, revoked = false }: Limit): DatabaseSync {
  const db = bus()
  if (shard)
    windowShard(db, 'ws-1')
  if (revoked)
    appendEvent(db, { ts: TS, type: SHARD_REVOKED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_REVOKED}:ws-1`, payload: { id: 'ws-1' }, legacy: false })
  for (const [at, head] of HEADS.entries()) {
    observed(db, head, at === HEADS.length - 1 ? ci : 'green')
    reviewed(db, head, 'changes', [`finding ${at}`])
  }
  extended(db, findings, ['finding 1'])
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
    const granted = atTheLimit({ shard: true, ci: 'green', findings: ['a new defect'] })

    expect(changesRoundsOf(granted, PR)).toBe(REVIEW_ROUNDS - 1)

    const refused: Record<string, DatabaseSync> = {
      'no shard': atTheLimit({ shard: false, ci: 'green', findings: ['a new defect'] }),
      'a revoked shard': atTheLimit({ shard: true, revoked: true, ci: 'green', findings: ['a new defect'] }),
      'red CI on the extended head': atTheLimit({ shard: true, ci: 'red', findings: ['a new defect'] }),
      'the previous findings again': atTheLimit({ shard: true, ci: 'green', findings: [' finding 1 '] }),
      'no findings': atTheLimit({ shard: true, ci: 'green', findings: [] }),
    }
    for (const [name, db] of Object.entries(refused))
      expect({ name, rounds: changesRoundsOf(db, PR) }).toEqual({ name, rounds: REVIEW_ROUNDS })
  })

  it('a merge-only window shard grants no round', () => {
    const db = bus()
    windowShard(db, 'ws-merge', 'merge')
    for (const [at, head] of HEADS.entries()) {
      observed(db, head, 'green')
      reviewed(db, head, 'changes', [`finding ${at}`])
    }
    extended(db, ['a new defect'], ['finding 1'])

    expect(changesRoundsOf(db, PR)).toBe(REVIEW_ROUNDS)
  })
})
