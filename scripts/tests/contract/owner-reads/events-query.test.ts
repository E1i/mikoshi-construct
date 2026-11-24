import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../../core/lease.js'
import { afterEach, describe, expect, it } from 'vitest'
import { bodyAdmittedAfter, waitClosedBefore } from '../../../core/card-readings.js'
import { appendEvent, openBus } from '../../../core/db.js'
import { all, byId, EITHER_JOURNAL, events, latest, latestOfCardWhere, ofCard, ofPr, perCard, unspentShardRows } from '../../../core/events-query.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_HELD, CARD_STARTED, CARD_STOPPED, DECISIONS_IMPORTED, DECISIONS_PROJECTED, PR_OBSERVED, QUESTION_AGENT, REVIEW_RECORDED, SHARD_ISSUED, TASK_COMPLETED, TASK_FAILED, TASK_RELEASED } from '../../../core/events.js'
import { TREE_CARRIER_QUEUE } from '../../../core/lease.js'
import { NETWATCH } from '../../../core/observations.js'
import * as prs from '../../../core/pr-readings.js'
import { reduce } from '../../../core/reducer.js'
import * as tasks from '../../../core/tasks-query.js'
import { lastEventId } from '../../../core/watermark.js'
import { answerSourceOf, cardSessionOf, carriedTreeOf, failedChecksOn, openPrOfCard, ownerHoldOf } from '../../../nodes/answer/answer-source.js'
import { decisionRows, recordDecision } from '../../../policy/decisions/index.js'
import { busProjections, DECISION_EVENT_READS } from '../../../supervisor/composition.js'

const TS = '2026-11-20T08:00:00.000Z'
const LATER = '2026-11-20T09:00:00.000Z'
const CARD = 7
const OTHER_CARD = 8
const PR = 41
const opened: DatabaseSync[] = []

afterEach(() => {
  for (const db of opened.splice(0))
    db.close()
})

function bus(): DatabaseSync {
  const db = openBus(':memory:')
  opened.push(db)
  return db
}

interface Seed {
  type: string
  card?: number | null
  pr?: number | null
  key: string
  payload?: Record<string, unknown> | string
  ts?: string
  actor?: string
  legacy?: boolean
}

function append(db: DatabaseSync, seed: Seed): number {
  appendEvent(db, { ts: seed.ts ?? TS, type: seed.type, actor: seed.actor ?? 'policy', cardId: seed.card ?? null, pr: seed.pr ?? null, head: null, dedupeKey: seed.key, payload: seed.payload ?? {}, legacy: seed.legacy ?? false })
  return lastEventId(db)
}

function seeded(): { db: DatabaseSync, ids: Record<string, number> } {
  const db = bus()
  const ids = {
    admitted: append(db, { type: CARD_ADMITTED, card: CARD, key: 'a1', payload: { text: 'body' } }),
    stopped: append(db, { type: CARD_STOPPED, card: CARD, key: 's1', payload: { reason: 'fault' } }),
    other: append(db, { type: CARD_STOPPED, card: OTHER_CARD, key: 's2', payload: { reason: 'review' } }),
    onPr: append(db, { type: CARD_STOPPED, card: CARD, pr: PR, key: 's3', payload: { reason: 'ci' } }),
    failed: append(db, { type: TASK_FAILED, card: CARD, key: 'f1', payload: { task_key: 'answer:7', reason: 'held_for_owner' }, ts: LATER, actor: 'worker:intake:one' }),
    unreadable: append(db, { type: CARD_HELD, card: CARD, key: 'h1', payload: 'not json' }),
    journal: append(db, { type: 'merge', card: CARD, key: 'm1', legacy: true }),
  }
  return { db, ids }
}

function idsOf(rows: readonly { id: number }[]): number[] {
  return rows.map(row => row.id)
}

function sqlIds(db: DatabaseSync, sql: string, ...values: (number | string)[]): number[] {
  return (db.prepare(sql).all(...values) as { id: number }[]).map(row => Number(row.id))
}

describe('events query', () => {
  it('events query returns the events of the named types for a card, a pr or past an id as values', () => {
    const { db, ids } = seeded()
    expect(idsOf(ofCard(db, CARD, { types: [CARD_STOPPED] }))).toEqual(sqlIds(db, 'SELECT id FROM events WHERE legacy = 0 AND type = ? AND card_id = ? ORDER BY id', CARD_STOPPED, CARD))
    expect(idsOf(ofPr(db, PR))).toEqual([ids.onPr])
    expect(idsOf(events(db, { types: [CARD_STOPPED], card: CARD, pr: null }))).toEqual([ids.stopped])
    expect(idsOf(all(db, [CARD_STOPPED], { since: ids.stopped }))).toEqual([ids.other, ids.onPr])
    expect(idsOf(events(db, { before: ids.other }))).toEqual([ids.admitted, ids.stopped])
    expect(idsOf(events(db, { ids: [ids.failed, ids.admitted, ids.journal] }))).toEqual([ids.admitted, ids.failed])
    expect(idsOf(events(db, { task: 'answer:7' }))).toEqual([ids.failed])
    expect(ofCard(db, CARD, { types: [CARD_STOPPED] })[0]!.data).toEqual({ reason: 'fault' })
  })

  it('returns the whole stored row, with the payload as stored and as values, and no data for a payload that is not an object', () => {
    const { db, ids } = seeded()
    const row = byId(db, ids.failed)!
    expect(row).toMatchObject({ id: ids.failed, ts: LATER, type: TASK_FAILED, actor: 'worker:intake:one', card_id: CARD, pr: null, head: null, dedupe_key: 'f1', legacy: false })
    expect(JSON.parse(row.payload)).toEqual(row.data)
    expect(byId(db, ids.unreadable)!.data).toBeNull()
    expect(byId(db, lastEventId(db) + 1)).toBeNull()
  })

  it('reads the live journal by default, the legacy one when asked, and both by either', () => {
    const { db, ids } = seeded()
    expect(idsOf(ofCard(db, CARD, { types: ['merge'] }))).toEqual([])
    expect(idsOf(ofCard(db, CARD, { types: ['merge'], legacy: true }))).toEqual([ids.journal])
    expect(idsOf(events(db, { keys: ['m1', 'a1'], legacy: EITHER_JOURNAL }))).toEqual([ids.admitted, ids.journal])
    expect(byId(db, ids.journal)!.legacy).toBe(true)
  })

  it('takes the latest first and limits, matching ORDER BY id DESC LIMIT 1', () => {
    const { db, ids } = seeded()
    expect(latest(db, { types: [CARD_STOPPED], card: CARD })!.id).toBe(sqlIds(db, 'SELECT id FROM events WHERE legacy = 0 AND type = ? AND card_id = ? ORDER BY id DESC LIMIT 1', CARD_STOPPED, CARD)[0])
    expect(latest(db, { types: [CARD_STOPPED], card: CARD, before: ids.onPr })!.id).toBe(ids.stopped)
    expect(latest(db, { types: ['card.unknown'] })).toBeNull()
  })

  it('matches by ts and by actor prefix as written, not as a LIKE pattern', () => {
    const { db, ids } = seeded()
    expect(idsOf(events(db, { card: CARD, ts: LATER, actorPrefix: 'worker:intake:' }))).toEqual([ids.failed])
    expect(idsOf(events(db, { card: CARD, actorPrefix: 'worker:%' }))).toEqual([])
  })

  it('groups per card in card order and leaves out an event that names no card', () => {
    const { db, ids } = seeded()
    append(db, { type: CARD_STOPPED, key: 'no-card', payload: { reason: 'fault' } })
    const grouped = perCard(db, { types: [CARD_STOPPED] })
    expect([...grouped.keys()]).toEqual([CARD, OTHER_CARD])
    expect(idsOf(grouped.get(CARD)!)).toEqual([ids.stopped, ids.onPr])
  })

  it('mentions matches the LIKE the inbox found the blockers of a card by', () => {
    const { db } = seeded()
    append(db, { type: CARD_ADMITTED, card: OTHER_CARD, key: 'm2', payload: { text: `#${OTHER_CARD} · blocks #${CARD}` } })
    append(db, { type: CARD_ADMITTED, key: 'm3', payload: { text: `#${CARD}` } })
    expect(idsOf(events(db, { mentions: `#${CARD}`, legacy: EITHER_JOURNAL }))).toEqual(sqlIds(db, 'SELECT id FROM events WHERE payload LIKE ? ORDER BY id', `%#${CARD}%`))
  })

  it('latestOfCardWhere reads the latest live event of a card that meets the condition', () => {
    const { db, ids } = seeded()
    const query = latestOfCardWhere('stop', `stop.type = '${CARD_STOPPED}'`)
    expect((db.prepare(query).get(CARD) as { id: number }).id).toBe(ids.onPr)
    expect(db.prepare(query).get(99)).toBeUndefined()
  })

  it('answers an empty list of types, ids or keys with no events', () => {
    const { db } = seeded()
    expect(events(db, { types: [] })).toEqual([])
    expect(events(db, { ids: [] })).toEqual([])
    expect(events(db, { keys: [] })).toEqual([])
  })
})

const HEAD = 'b'.repeat(40)

function aTask(db: DatabaseSync, row: { key: string, queue: string, card: number, state: string, gen: number, event: number }): void {
  db.prepare('INSERT INTO tasks (task_key, queue, card_id, pr, head, state, lease_gen, event_id) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)').run(row.key, row.queue, row.card, row.state, row.gen, row.event)
}

function aPr(db: DatabaseSync, pr: number, card: number | null, state: string, event: number): void {
  db.prepare('INSERT INTO prs (pr, card_id, base, head, state, event_id) VALUES (?, ?, \'main\', ?, ?, ?)').run(pr, card, HEAD, state, event)
}

function withTasks(): DatabaseSync {
  const db = bus()
  const ids = Array.from({ length: 6 }, (_, n) => append(db, { type: CARD_STOPPED, card: n % 2 === 0 ? CARD : OTHER_CARD, key: `t${n}` }))
  aTask(db, { key: 'answer:z', queue: 'answer', card: CARD, state: 'withdrawn', gen: 0, event: ids[0]! })
  aTask(db, { key: 'launch:1', queue: 'launch', card: CARD, state: 'done', gen: 1, event: ids[2]! })
  aTask(db, { key: 'answer:a', queue: 'answer', card: CARD, state: 'withdrawn', gen: 0, event: ids[4]! })
  aTask(db, { key: 'launch:2', queue: 'launch', card: OTHER_CARD, state: 'leased', gen: 7, event: ids[5]! })
  aTask(db, { key: 'launch:0', queue: 'launch', card: CARD, state: 'leased', gen: 3, event: ids[3]! })
  return db
}

function plain<T extends object>(rows: readonly T[]): T[] {
  return rows.map(row => ({ ...row }))
}

describe('the card domain reads tasks and prs through their owners, not through SQL of its own', () => {
  it('tasks.ofCard gives the launch lease card-automaton read by its own SQL', () => {
    const db = withTasks()
    const before = { ...db.prepare('SELECT task_key, state, lease_gen FROM tasks WHERE queue = \'launch\' AND card_id = ? ORDER BY event_id DESC LIMIT 1').get(CARD) }
    const now = tasks.ofCard(db, CARD, { queue: 'launch' }).at(-1)!
    expect({ task_key: now.task_key, state: now.state, lease_gen: now.lease_gen }).toEqual(before)
    expect(before).toEqual({ task_key: 'launch:0', state: 'leased', lease_gen: 3 })
  })

  it('tasks.ofCard gives the withdrawn answers since an event that card-hold read by its own SQL', () => {
    const db = withTasks()
    const since = 1
    const before = plain(db.prepare('SELECT task_key, queue, card_id, pr, head, state, event_id FROM tasks WHERE card_id = ? AND queue = \'answer\' AND state = ? AND event_id > ? ORDER BY task_key').all(CARD, 'withdrawn', since) as Record<string, unknown>[])
    const now = tasks.ofCard(db, CARD, { queue: 'answer', state: 'withdrawn', after: since })
      .map(({ task_key, queue, card_id, pr, head, state, event_id }) => ({ task_key, queue, card_id, pr, head, state, event_id }))
      .sort((a, b) => a.task_key.localeCompare(b.task_key))
    expect(now).toEqual(before)
    expect(now.map(task => task.task_key)).toEqual(['answer:a'])
  })

  it('tasks.ofCard keeps the order of events and leaves out the tasks of other cards', () => {
    const db = withTasks()
    expect(tasks.ofCard(db, CARD).map(task => task.task_key)).toEqual(['answer:z', 'launch:1', 'launch:0', 'answer:a'])
    expect(tasks.ofCard(db, OTHER_CARD).map(task => task.task_key)).toEqual(['launch:2'])
    expect(tasks.ofCard(db, 1)).toEqual([])
  })

  it('tasks.byKey and tasks.ofQueue give the rows card-decisions read by its own SQL', () => {
    const db = withTasks()
    expect(tasks.byKey(db, 'launch:0')).toEqual(tasks.ofCard(db, CARD, { queue: 'launch' }).at(-1))
    expect(tasks.byKey(db, 'answer:none')).toBeNull()
    const before = (db.prepare('SELECT task_key FROM tasks WHERE queue = \'launch\' ORDER BY event_id, id').all() as { task_key: string }[]).map(row => row.task_key)
    expect(tasks.ofQueue(db, 'launch').map(task => task.task_key)).toEqual(before)
  })

  it('prs.ofPr and prs.ofCard give the rows of prs as values', () => {
    const db = bus()
    const event = append(db, { type: CARD_STOPPED, card: CARD, key: 'p0' })
    aPr(db, 52, CARD, 'merged', event)
    aPr(db, 51, CARD, 'open', event)
    aPr(db, 53, null, 'open', event)
    expect(prs.ofPr(db, 52)).toEqual({ ...db.prepare('SELECT * FROM prs WHERE pr = 52').get() })
    expect(prs.ofPr(db, 52)?.state).toBe('merged')
    expect(prs.ofPr(db, 99)).toBeNull()
    expect(prs.ofCard(db, CARD).map(row => row.pr)).toEqual([51, 52])
    expect(prs.ofCard(db, OTHER_CARD)).toEqual([])
    expect(prs.all(db)).toEqual(plain(db.prepare('SELECT * FROM prs ORDER BY pr').all() as Record<string, unknown>[]))
    expect(prs.all(db).map(row => row.pr)).toEqual([51, 52, 53])
  })
})

describe('the decisions domain reads owner_waits and card_bodies through card-record', () => {
  it('waitClosedBefore and bodyAdmittedAfter give what the inbox read by its own SQL', () => {
    const db = bus()
    const event = append(db, { type: CARD_STOPPED, card: CARD, key: 'w0' })
    db.prepare('INSERT INTO owner_waits (id, need, text, state, opened_at, event_id) VALUES (\'Q1\', \'decision\', \'which?\', \'closed\', ?, ?)').run(TS, event)
    expect(waitClosedBefore(db, 'Q1', event + 1)).toBe(true)
    expect(waitClosedBefore(db, 'Q1', event)).toBe(false)
    expect(waitClosedBefore(db, 'Q2', event + 1)).toBe(false)
    db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha, touches, creates) VALUES (?, ?, \'body\', \'sha\', \'["scripts/core/**"]\', \'["a.ts (new)"]\')').run(CARD, event)
    expect(bodyAdmittedAfter(db, CARD, event - 1)).toEqual({ admission_event_id: event, touches: ['scripts/core/**'], creates: ['a.ts (new)'] })
    expect(bodyAdmittedAfter(db, CARD, event)).toBeNull()
  })
})

const NEWER_PR = PR + 1
const LEASE_HEAD = 'a'.repeat(40)
const OTHER_HEAD = 'd'.repeat(40)
const UNOBSERVED_HEAD = 'c'.repeat(40)
const NOW = new Date(TS)
const REVIEWER = 'worker:review:session-1'
const LAUNCH = 'worker:launch:launch-1'

let keys = 0

interface TailEvent {
  type: string
  actor?: string | null
  cardId?: number | null
  pr?: number | null
  head?: string | null
  payload: Record<string, unknown>
  legacy?: boolean
}

function written(db: DatabaseSync, event: TailEvent): number {
  keys += 1
  appendEvent(db, { ts: TS, actor: LAUNCH, cardId: CARD, pr: null, head: null, legacy: false, ...event, dedupeKey: `${event.type}:tail-${keys}` })
  return lastEventId(db)
}

function observed(db: DatabaseSync, pr: number, fields: Record<string, unknown>): void {
  const head = typeof fields.head === 'string' ? fields.head : LEASE_HEAD
  written(db, { type: PR_OBSERVED, actor: NETWATCH, pr, head, payload: { base: 'main', mergeable: 'clean', ci: 'green', draft: false, auto_merge: false, ...fields, head } })
}

function reviewed(db: DatabaseSync, head: string, verdict: string, findings: string[]): void {
  written(db, { type: REVIEW_RECORDED, actor: REVIEWER, pr: PR, head, payload: { head, verdict, reviewer_session: 'session-1', findings } })
}

function leaseAt(head: string): Lease {
  return { taskKey: `answer:${CARD}`, cardId: CARD, pr: PR, head, leaseGen: 1, actor: 'worker:answer:worker-1' } as unknown as Lease
}

function cardLease(): Lease {
  return { taskKey: `answer:${CARD}`, cardId: CARD, pr: null, head: null, leaseGen: 1, actor: 'worker:answer:worker-1' } as unknown as Lease
}

function projected(db: DatabaseSync): void {
  reduce(db, 'pending', busProjections())
}

describe('the answer source reads the newest of what stands on the card and its head', () => {
  it('names the newest of two open draft pull requests a bus holds for one card', () => {
    const db = bus()
    const event = written(db, { type: CARD_STARTED, payload: { session: 's', worktree: '/trees/a', branch: 'feat/a' } })
    for (const pr of [PR, NEWER_PR])
      db.prepare(`INSERT INTO prs (pr, card_id, base, head, state, ci, draft, event_id) VALUES (?, ?, 'main', ?, 'open', 'green', 1, ?)`).run(pr, CARD, LEASE_HEAD, event)
    expect(openPrOfCard(db, CARD)).toBe(NEWER_PR)
    expect(ownerHoldOf(db, CARD)).toContain(`#${NEWER_PR},`)
  })

  it('takes the findings of the newest changes review at the lease head, past a later pass and a review of another head', () => {
    const db = bus()
    observed(db, PR, { verdict_on_head: 'changes' })
    projected(db)
    reviewed(db, LEASE_HEAD, 'changes', ['the older finding'])
    reviewed(db, LEASE_HEAD, 'changes', ['the newer finding'])
    reviewed(db, LEASE_HEAD, 'pass', ['a pass is no finding'])
    reviewed(db, OTHER_HEAD, 'changes', ['a finding of another head'])
    expect(answerSourceOf(db, leaseAt(LEASE_HEAD), NOW)).toMatchObject({ kind: 'changes', findings: ['the newer finding'] })
  })

  it('takes the failed checks of the newest red observation at the lease head', () => {
    const db = bus()
    observed(db, PR, { ci: 'red', failed_checks: ['the older check'] })
    observed(db, PR, { ci: 'red', failed_checks: ['the newer check'] })
    projected(db)
    expect(failedChecksOn(db, leaseAt(LEASE_HEAD))).toEqual(['the newer check'])
  })

  it('reads nothing for a lease whose head is not the head the pull request stands at', () => {
    const db = bus()
    observed(db, PR, { ci: 'red', verdict_on_head: 'changes', failed_checks: ['a check'] })
    projected(db)
    expect(answerSourceOf(db, leaseAt(UNOBSERVED_HEAD), NOW)).toBeNull()
  })

  it('hands the latest events of the card oldest first', () => {
    const db = bus()
    written(db, { type: CARD_STARTED, payload: { session: 's', worktree: '/trees/a', branch: 'feat/a' } })
    written(db, { type: CARD_STOPPED, payload: { reason: QUESTION_AGENT, detail: 'which?' } })
    const ids = answerSourceOf(db, cardLease(), NOW)!.events.map(event => event.id)
    expect(ids).toHaveLength(2)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
  })

  it('an answered stop is no longer the standing question', () => {
    const db = bus()
    written(db, { type: CARD_STOPPED, payload: { reason: QUESTION_AGENT, detail: 'which?' } })
    expect(answerSourceOf(db, cardLease(), NOW)).toMatchObject({ kind: 'question' })
    written(db, { type: CARD_ANSWERED, actor: 'worker:answer:worker-1', payload: { session: 's' } })
    expect(answerSourceOf(db, cardLease(), NOW)).toBeNull()
  })

  it('a release that carries no tree does not hide the tree an older end carried', () => {
    const db = bus()
    const tree = { path: '/trees/a', head: LEASE_HEAD, localCommits: [], dirty: false }
    written(db, { type: TASK_COMPLETED, actor: 'worker:answer:worker-1', payload: { queue: TREE_CARRIER_QUEUE, task_key: `answer:${CARD}`, lease_gen: 1, tree } })
    written(db, { type: TASK_RELEASED, actor: 'worker:answer:worker-1', payload: { queue: TREE_CARRIER_QUEUE, task_key: `answer:${CARD}`, lease_gen: 2, reason: 'released' } })
    expect(carriedTreeOf(db, CARD)).toEqual(tree)
  })

  it('a legacy path line naming no tree does not hide an older one that names it', () => {
    const db = bus()
    written(db, { type: 'path', actor: null, legacy: true, payload: { worktree: '/trees/a', branch: 'feat/a' } })
    written(db, { type: 'path', actor: null, legacy: true, payload: { path: 'cheap' } })
    expect(cardSessionOf(db, CARD)).toMatchObject({ worktree: '/trees/a', branch: 'feat/a' })
  })
})

describe('the decision and shard readings keep their order and their drops', () => {
  it('an import is projected before only by a projection that precedes it', () => {
    const db = bus()
    const imported = written(db, { type: DECISIONS_IMPORTED, actor: NETWATCH, cardId: null, payload: { decisions: [] } })
    const projection = written(db, { type: DECISIONS_PROJECTED, actor: NETWATCH, cardId: null, payload: {} })
    expect(DECISION_EVENT_READS.projectedBefore(db, imported)).toBe(false)
    expect(DECISION_EVENT_READS.projectedBefore(db, projection + 1)).toBe(true)
  })

  it('two unspent shards of one card come oldest first', () => {
    const db = bus()
    written(db, { type: SHARD_ISSUED, actor: 'owner', payload: { id: 'shard-old', under: 'D-1' } })
    written(db, { type: SHARD_ISSUED, actor: 'owner', payload: { id: 'shard-new', under: 'D-2' } })
    expect(unspentShardRows(db, CARD, null).map(row => row.id)).toEqual(['shard-old', 'shard-new'])
  })

  it('a decision row whose event cannot be read is dropped', () => {
    const db = bus()
    recordDecision(db, { ts: TS, decisionId: 9001, text: 'a decision', cards: [CARD] })
    projected(db)
    expect(decisionRows(db, DECISION_EVENT_READS)).toHaveLength(1)
    expect(decisionRows(db, { ...DECISION_EVENT_READS, tsOf: () => new Map() })).toEqual([])
  })
})
