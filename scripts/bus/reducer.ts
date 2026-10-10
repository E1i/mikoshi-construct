import type { DatabaseSync } from 'node:sqlite'
import type { Fold, StoredEvent } from './stored.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CHAIN_FOLDS } from './chain.js'
import { appendEvent, defaultBusPath, inTransaction, openBus } from './db.js'
import { DECISION_FOLDS } from './decisions.js'
import { isFullSha, prOf } from './identifiers.js'
import { LEASE_FOLDS } from './lease.js'
import { TASK_FOLDS } from './queue.js'
import { ROLE_FOLDS } from './role.js'
import { payloadOf, reject, Rejection, STORED_COLUMNS } from './stored.js'

export const PREFIX = '[bus:reduce] '
export const REJECTED = 'reducer.rejected'

const MERGEABLE = new Set(['clean', 'behind', 'dirty', 'blocked'])
const CI = new Set(['pending', 'green', 'red'])

interface PrRow {
  pr: number
  card_id: number | null
  base: string | null
  head: string | null
  state: string | null
  mergeable: string | null
  ci: string | null
  verdict_on_head: string | null
  auto_merge: number | null
  draft: number | null
  event_id: number
}

interface CardRow {
  card_id: number
  pr: number | null
}

export interface ReduceCount {
  applied: number
  rejected: number
}

function boolean(payload: Record<string, unknown>, field: string): boolean {
  const value = payload[field]
  return typeof value === 'boolean' ? value : reject(`${field} is not a boolean`)
}

function oneOf(payload: Record<string, unknown>, field: string, allowed: Set<string>): string {
  const value = payload[field]
  return typeof value === 'string' && allowed.has(value) ? value : reject(`${field} is not one of ${[...allowed].join(' | ')}`)
}

function requiredPr(event: StoredEvent): number {
  return event.pr ?? reject(`${event.type} needs a pr`)
}

function prRow(db: DatabaseSync, pr: number): PrRow | undefined {
  return db.prepare('SELECT * FROM prs WHERE pr = ?').get(pr) as PrRow | undefined
}

function cardRow(db: DatabaseSync, cardId: number): CardRow | undefined {
  return db.prepare('SELECT card_id, pr FROM cards WHERE card_id = ?').get(cardId) as CardRow | undefined
}

function linkCard(db: DatabaseSync, cardId: number, pr: number, eventId: number): void {
  const card = cardRow(db, cardId)
  if (card?.pr === pr)
    return
  if (card !== undefined && card.pr !== null) {
    const linked = prRow(db, card.pr)
    if (linked === undefined || linked.state === 'open')
      reject(`card ${cardId} is linked to pr ${card.pr}, which is still open`)
    if (linked.state === 'merged')
      reject(`card ${cardId} is linked to pr ${card.pr}, which is merged`)
  }
  db.prepare(`
    INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, NULL, ?, ?)
    ON CONFLICT (card_id) DO UPDATE SET pr = excluded.pr, event_id = excluded.event_id
  `).run(cardId, pr, eventId)
}

function prObserved(db: DatabaseSync, event: StoredEvent): void {
  const pr = requiredPr(event)
  const payload = payloadOf(event)
  const base = typeof payload.base === 'string' && payload.base !== '' ? payload.base : reject('base is not a branch name')
  const head = isFullSha(payload.head) ? payload.head : reject('head is not a full sha')
  if (event.head !== null && event.head !== head)
    reject(`the event head ${event.head} is not the payload head ${head}`)
  const mergeable = oneOf(payload, 'mergeable', MERGEABLE)
  const ci = oneOf(payload, 'ci', CI)
  const verdict = payload.verdict_on_head ?? null
  if (verdict !== null && typeof verdict !== 'string')
    reject('verdict_on_head is not a string')
  const autoMerge = boolean(payload, 'auto_merge')
  const draft = boolean(payload, 'draft')
  const known = prRow(db, pr)
  if (known?.state === 'merged')
    reject(`pr ${pr} is merged`)
  if (known?.card_id != null && event.card_id !== null && known.card_id !== event.card_id)
    reject(`pr ${pr} belongs to card ${known.card_id}, not ${event.card_id}`)
  const cardId = event.card_id ?? known?.card_id ?? null
  if (cardId !== null)
    linkCard(db, cardId, pr, event.id)
  db.prepare(`
    INSERT INTO prs (pr, card_id, base, head, state, mergeable, ci, verdict_on_head, auto_merge, draft, event_id)
    VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)
    ON CONFLICT (pr) DO UPDATE SET card_id = excluded.card_id, base = excluded.base, head = excluded.head,
      state = 'open', mergeable = excluded.mergeable, ci = excluded.ci, verdict_on_head = excluded.verdict_on_head,
      auto_merge = excluded.auto_merge, draft = excluded.draft, event_id = excluded.event_id
  `).run(pr, cardId, base, head, mergeable, ci, verdict, autoMerge ? 1 : 0, draft ? 1 : 0, event.id)
}

function prClosed(db: DatabaseSync, event: StoredEvent): void {
  const pr = requiredPr(event)
  const merged = boolean(payloadOf(event), 'merged')
  const known = prRow(db, pr) ?? reject(`pr ${pr} was never observed`)
  if (known.state === 'merged')
    reject(`pr ${pr} is already merged`)
  db.prepare('UPDATE prs SET state = ?, event_id = ? WHERE pr = ?').run(merged ? 'merged' : 'closed', event.id, pr)
}

function mainAdvanced(db: DatabaseSync, event: StoredEvent): void {
  const payload = payloadOf(event)
  if (!isFullSha(payload.sha))
    reject('sha is not a full sha')
  const touches = boolean(payload, 'touches_mechanics')
  db.prepare('INSERT INTO mains (sha, touches_mechanics, event_id) VALUES (?, ?, ?)').run(payload.sha, touches ? 1 : 0, event.id)
  db.prepare(`UPDATE prs SET mergeable = NULL, event_id = ? WHERE state = 'open' AND base = 'main'`).run(event.id)
}

function prOpened(db: DatabaseSync, event: StoredEvent): void {
  const pr = prOf(payloadOf(event).pr) ?? event.pr ?? reject('pr.opened needs a pr')
  const cardId = event.card_id ?? reject('pr.opened needs a card_id')
  const known = prRow(db, pr)
  if (known?.card_id != null && known.card_id !== cardId)
    reject(`pr ${pr} belongs to card ${known.card_id}, not ${cardId}`)
  linkCard(db, cardId, pr, event.id)
  if (known !== undefined)
    db.prepare('UPDATE prs SET card_id = ? WHERE pr = ?').run(cardId, pr)
}

const REDUCERS: Record<string, Fold> = {
  'pr.observed': prObserved,
  'pr.closed': prClosed,
  'main.advanced': mainAdvanced,
  'pr.opened': prOpened,
  ...TASK_FOLDS,
  ...LEASE_FOLDS,
  ...CHAIN_FOLDS,
  ...ROLE_FOLDS,
  ...DECISION_FOLDS,
}

function recordRejection(db: DatabaseSync, event: StoredEvent, reason: string): void {
  appendEvent(db, {
    ts: event.ts,
    type: REJECTED,
    actor: 'reducer',
    cardId: event.card_id,
    pr: event.pr,
    head: event.head,
    dedupeKey: `${REJECTED}:${event.dedupe_key}`,
    payload: { event_id: event.id, type: event.type, reason },
    legacy: false,
  })
}

function applied(db: DatabaseSync, event: StoredEvent, apply: Fold): boolean {
  db.exec('SAVEPOINT reducer_event')
  try {
    apply(db, event)
    db.exec('RELEASE reducer_event')
    return true
  }
  catch (error) {
    db.exec('ROLLBACK TO reducer_event')
    db.exec('RELEASE reducer_event')
    if (!(error instanceof Rejection))
      throw error
    recordRejection(db, event, error.message)
    return false
  }
}

export function reduce(db: DatabaseSync): ReduceCount {
  return inTransaction(db, () => {
    db.exec(`DELETE FROM cards; DELETE FROM prs; DELETE FROM tasks; DELETE FROM mains; DELETE FROM chains; DELETE FROM roles; DELETE FROM decisions; DELETE FROM sqlite_sequence WHERE name = 'tasks';`)
    const events = db.prepare(`SELECT ${STORED_COLUMNS} FROM events WHERE legacy = 0 ORDER BY id`).all() as unknown as StoredEvent[]
    const count: ReduceCount = { applied: 0, rejected: 0 }
    for (const event of events) {
      const apply = REDUCERS[event.type]
      if (apply === undefined)
        continue
      if (applied(db, event, apply))
        count.applied += 1
      else
        count.rejected += 1
    }
    return count
  })
}

export function projectionDump(db: DatabaseSync): string {
  return JSON.stringify({
    prs: db.prepare('SELECT * FROM prs ORDER BY pr').all(),
    cards: db.prepare('SELECT * FROM cards ORDER BY card_id').all(),
    tasks: db.prepare('SELECT * FROM tasks ORDER BY task_key').all(),
    mains: db.prepare('SELECT * FROM mains ORDER BY sha').all(),
    chains: db.prepare('SELECT * FROM chains ORDER BY dir').all(),
    roles: db.prepare('SELECT * FROM roles ORDER BY role').all(),
    decisions: db.prepare('SELECT * FROM decisions ORDER BY decision_id').all(),
  })
}

function main(): number {
  const busPath = defaultBusPath()
  const db = openBus(busPath)
  try {
    const count = reduce(db)
    console.log(`${PREFIX}${busPath}: applied ${count.applied}, rejected ${count.rejected}`)
    return 0
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main()
