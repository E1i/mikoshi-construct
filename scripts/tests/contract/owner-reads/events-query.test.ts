import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../../core/lease.js'
import { DatabaseSync as Sqlite } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { bodyAdmittedAfter, cardBodyLanes, cardsAmong, cardsWithAState, openCardWaits, openWaitEventsByCard, waitClosedBefore, waitStatesAmong } from '../../../core/card-readings.js'
import { appendEvent, openBus } from '../../../core/db.js'
import { all, byId, countOf, EITHER_JOURNAL, eventLog, events, lastTsPerActor, latest, latestOfCardWhere, latestTs, ofCard, ofPr, perCard, unspentShardRows } from '../../../core/events-query.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_HELD, CARD_STARTED, CARD_STOPPED, DECISIONS_IMPORTED, DECISIONS_PROJECTED, OWNER_WAIT_CLOSED, PR_OBSERVED, QUESTION_AGENT, REVIEW_RECORDED, SHARD_ISSUED, TASK_COMPLETED, TASK_FAILED, TASK_RELEASED } from '../../../core/events.js'
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

const READING_TABLES = `
  CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, task_key TEXT NOT NULL UNIQUE, queue TEXT NOT NULL, card_id INTEGER NOT NULL, pr INTEGER, head TEXT, state TEXT NOT NULL, lease_gen INTEGER NOT NULL DEFAULT 0, lease_until TEXT, failures INTEGER NOT NULL DEFAULT 0, event_id INTEGER NOT NULL);
  CREATE TABLE cards (card_id INTEGER PRIMARY KEY, state TEXT, pr INTEGER);
  CREATE TABLE owner_waits (id TEXT PRIMARY KEY, card_id INTEGER, state TEXT NOT NULL, event_id INTEGER NOT NULL);
`

function readingTables(): DatabaseSync {
  const db = new Sqlite(':memory:')
  opened.push(db)
  db.exec(READING_TABLES)
  return db
}

describe('the readings derive-queues takes from bus and card-record', () => {
  it('bus answers every task, as the keyed reads do', () => {
    const db = readingTables()
    expect(tasks.all(db)).toEqual([])
    db.prepare(`INSERT INTO tasks (task_key, queue, card_id, pr, head, state, event_id) VALUES ('answer:7', 'answer', ?, 7, 'abc', 'queued', 2), ('merge:8', 'merge', ?, NULL, NULL, 'leased', 1)`).run(CARD, OTHER_CARD)
    expect(tasks.all(db).map(task => task.task_key)).toEqual(['merge:8', 'answer:7'])
    expect(tasks.all(db)).toEqual([...tasks.ofQueue(db, 'merge'), ...tasks.ofQueue(db, 'answer')])
  })

  it('card-record answers cards, wait states and the openings of open waits by key', () => {
    const db = readingTables()
    db.prepare(`INSERT INTO cards (card_id, state, pr) VALUES (?, 'closed', 7), (?, NULL, NULL)`).run(CARD, OTHER_CARD)
    db.prepare(`INSERT INTO owner_waits (id, card_id, state, event_id) VALUES ('Q1', ?, 'open', 5), ('Q2', ?, 'closed', 6), ('Q3', ?, 'open', 4), ('Q4', NULL, 'open', 8)`).run(CARD, CARD, OTHER_CARD)
    expect(cardsAmong(db, [CARD, OTHER_CARD, 1])).toEqual(new Map([[CARD, { state: 'closed', pr: 7 }], [OTHER_CARD, { state: null, pr: null }]]))
    expect(waitStatesAmong(db, ['Q1', 'Q2', 'Q9'])).toEqual(new Map([['Q1', 'open'], ['Q2', 'closed']]))
    expect(openWaitEventsByCard(db)).toEqual(new Map([[OTHER_CARD, [4]], [CARD, [5]]]))
  })
})

const REPORT_TS = '2026-11-24T08:00:00.000Z'
const REPORT_LATER = '2026-11-24T09:00:00.000Z'

function tick(db: DatabaseSync, ts: string, key: string, legacy = false): void {
  appendEvent(db, { ts, type: 'netwatch.tick', actor: 'netwatch', cardId: null, pr: null, head: null, dedupeKey: key, payload: { written: 1 }, legacy })
}

describe('the readings report and tasks take from bus and card-record', () => {
  it('events-query answers the events from a moment on, as the report period reads them', () => {
    const db = bus()
    tick(db, REPORT_TS, 'early')
    tick(db, REPORT_LATER, 'late')
    tick(db, REPORT_LATER, 'legacy', true)
    expect(events(db, { types: ['netwatch.tick'], from: REPORT_LATER }).map(row => row.dedupe_key)).toEqual(['late'])
    expect(events(db, { types: ['netwatch.tick'], from: '' }).map(row => row.dedupe_key)).toEqual(['early', 'late'])
    expect(events(db, { types: ['netwatch.tick'], since: 1, before: 3, legacy: EITHER_JOURNAL })).toHaveLength(1)
  })

  it('events-query answers the whole log as stored, legacy rows included, for the replay snapshot', () => {
    const db = bus()
    tick(db, REPORT_TS, 'early')
    tick(db, REPORT_LATER, 'legacy', true)
    expect(eventLog(db).map(row => [row.dedupe_key, row.legacy, typeof row.payload])).toEqual([['early', 0, 'string'], ['legacy', 1, 'string']])
  })

  it('card-record answers the cards that hold a state', () => {
    const db = bus()
    tick(db, REPORT_TS, 'first')
    tick(db, REPORT_TS, 'second')
    db.prepare(`INSERT INTO cards (card_id, state, pr, event_id) VALUES (7, 'closed', NULL, 1), (8, NULL, NULL, 2)`).run()
    expect(cardsWithAState(db)).toEqual(new Map([[7, 'closed']]))
  })
})

describe('the readings the window board takes from bus and card-record', () => {
  it('bus counts and dates the events a query names, the live journal unless asked for either', () => {
    const db = bus()
    append(db, { type: REVIEW_RECORDED, card: CARD, key: 'r1', ts: TS })
    append(db, { type: REVIEW_RECORDED, card: OTHER_CARD, key: 'r2', ts: LATER })
    append(db, { type: REVIEW_RECORDED, card: CARD, key: 'r3', ts: '2026-11-20T10:00:00.000Z', legacy: true })
    expect(countOf(db, { types: [REVIEW_RECORDED] })).toBe(2)
    expect(countOf(db, { types: [REVIEW_RECORDED], legacy: EITHER_JOURNAL })).toBe(3)
    expect(countOf(db, { types: [] })).toBe(0)
    expect(latestTs(db, { types: [REVIEW_RECORDED], card: CARD })).toBe(TS)
    expect(latestTs(db, { types: [REVIEW_RECORDED] })).toBe(LATER)
    expect(latestTs(db, { types: ['nothing.recorded'] })).toBeNull()
    expect(latestTs(db, { types: [] })).toBeNull()
  })

  it('bus keeps the newest live sign of each actor', () => {
    const db = bus()
    append(db, { type: REVIEW_RECORDED, key: 'a1', actor: 'worker:review:1', ts: TS })
    append(db, { type: REVIEW_RECORDED, key: 'a2', actor: 'worker:review:1', ts: LATER })
    append(db, { type: REVIEW_RECORDED, key: 'a3', actor: 'worker:review:1', ts: '2026-11-20T10:00:00.000Z', legacy: true })
    append(db, { type: REVIEW_RECORDED, key: 'a4', actor: 'worker:merge:1', ts: TS })
    expect(Object.fromEntries(lastTsPerActor(db))).toEqual({ 'worker:review:1': LATER, 'worker:merge:1': TS })
  })

  it('card-record answers each body with its lane, who, priority and depends', () => {
    const db = bus()
    const event = append(db, { type: CARD_ADMITTED, card: CARD, key: 'b1' })
    db.prepare(`INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha, lane, who, priority, depends) VALUES (?, ?, 't', 's', 'lane-1', 'shift', 'p0', '[1, 2]'), (?, ?, 't', 's', NULL, NULL, NULL, NULL)`).run(OTHER_CARD, event, CARD, event)
    expect(cardBodyLanes(db)).toEqual([
      { card_id: CARD, lane: null, who: null, priority: null, depends: [] },
      { card_id: OTHER_CARD, lane: 'lane-1', who: 'shift', priority: 'p0', depends: [1, 2] },
    ])
  })

  it('card-record answers the open waits of cards in the order they opened, none an event closed', () => {
    const db = bus()
    const ids = [1, 2, 3, 4].map(at => append(db, { type: CARD_ADMITTED, key: `w${at}` }))
    db.prepare(`INSERT INTO owner_waits (id, need, text, card_id, state, opened_at, event_id) VALUES
      ('Q2', 'decision', 't', ?, 'open', ?, ?),
      ('Q1', 'merge', 't', ?, 'open', ?, ?),
      ('Q3', 'decision', 't', ?, 'closed', ?, ?),
      ('Q4', 'decision', 't', NULL, 'open', ?, ?),
      ('Q5', 'decision', 't', ?, 'open', ?, ?)`).run(CARD, LATER, ids[1]!, OTHER_CARD, TS, ids[0]!, CARD, TS, ids[2]!, TS, ids[3]!, CARD, TS, ids[3]!)
    append(db, { type: OWNER_WAIT_CLOSED, key: 'closed-Q5', payload: { id: 'Q5' } })
    expect(openCardWaits(db)).toEqual([
      { id: 'Q1', need: 'merge', card: OTHER_CARD, since: TS, event_id: ids[0] },
      { id: 'Q2', need: 'decision', card: CARD, since: LATER, event_id: ids[1] },
    ])
  })
})
