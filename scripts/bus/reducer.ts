import type { DatabaseSync } from 'node:sqlite'
import type { Fold, StoredEvent } from './stored.js'
import type { IncrementalProjection } from './watermark.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CARD_ADMITTED, DECISION_RECORDED, DECISIONS_IMPORTED, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, PR_OPENED } from '../core/events.js'
import { CARD_FOLDS, cardLinkObserved, cardPrMerged, cardPrOpened, CARDS_PROJECTION } from './card-automaton.js'
import { CARD_BODIES, foldCardBody } from './card-bodies.js'
import { CHAINS_PROJECTION } from './chain.js'
import { CLOSED_WAIT, defaultBusPath, inTransaction, isOwnerWaitNeed, OPEN_WAIT, openBus, OWNER_WAIT_NEEDS, OWNER_WAITS, WAIT_ID } from './db.js'
import { DECISION_FOLDS } from './decisions.js'
import { isFullSha, prOf } from './identifiers.js'
import { TASKS_PROJECTION } from './queue.js'
import { appliedOrRejected } from './rejection.js'
import { ROLE_FOLDS, ROLES_PROJECTION } from './role.js'
import { payloadOf, reject, STORED_COLUMNS } from './stored.js'
import { markReduced } from './watermark.js'

export const PREFIX = '[bus:reduce] '
export const PROJECTION_KEYS: Readonly<Record<string, string>> = { prs: 'pr', cards: 'card_id', tasks: 'task_key', mains: 'sha', chains: 'dir', roles: 'role', decisions: 'decision_id', [CARD_BODIES]: 'card_id', [OWNER_WAITS]: 'id' }
export const INCREMENTAL_PROJECTIONS: readonly IncrementalProjection[] = [ROLES_PROJECTION, TASKS_PROJECTION, CHAINS_PROJECTION, CARDS_PROJECTION]

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
  body_sha: string | null
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

function cardOfPr(db: DatabaseSync, pr: number): number | null {
  return (db.prepare('SELECT card_id FROM cards WHERE pr = ?').get(pr) as { card_id: number } | undefined)?.card_id ?? null
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
  const bodySha = payload.body_sha ?? null
  if (bodySha !== null && typeof bodySha !== 'string')
    reject('body_sha is not a string')
  const known = prRow(db, pr)
  if (known?.state === 'merged')
    reject(`pr ${pr} is merged`)
  if (known?.card_id != null && event.card_id !== null && known.card_id !== event.card_id)
    reject(`pr ${pr} belongs to card ${known.card_id}, not ${event.card_id}`)
  const cardId = event.card_id ?? known?.card_id ?? cardOfPr(db, pr)
  if (cardId !== null) {
    linkCard(db, cardId, pr, event.id)
    cardLinkObserved(db, cardId, event.id)
  }
  db.prepare(`
    INSERT INTO prs (pr, card_id, base, head, state, mergeable, ci, verdict_on_head, auto_merge, draft, event_id, body_sha)
    VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (pr) DO UPDATE SET card_id = excluded.card_id, base = excluded.base, head = excluded.head,
      state = 'open', mergeable = excluded.mergeable, ci = excluded.ci, verdict_on_head = excluded.verdict_on_head,
      auto_merge = excluded.auto_merge, draft = excluded.draft, event_id = excluded.event_id, body_sha = excluded.body_sha
  `).run(pr, cardId, base, head, mergeable, ci, verdict, autoMerge ? 1 : 0, draft ? 1 : 0, event.id, bodySha)
}

function prClosed(db: DatabaseSync, event: StoredEvent): void {
  const pr = requiredPr(event)
  const merged = boolean(payloadOf(event), 'merged')
  const known = prRow(db, pr) ?? reject(`pr ${pr} was never observed`)
  if (known.state === 'merged')
    reject(`pr ${pr} is already merged`)
  db.prepare('UPDATE prs SET state = ?, event_id = ? WHERE pr = ?').run(merged ? 'merged' : 'closed', event.id, pr)
  if (merged && known.card_id !== null)
    cardPrMerged(db, known.card_id, event.id)
  db.prepare(`UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ? WHERE state = '${OPEN_WAIT}' AND need = 'merge' AND pr = ?`)
    .run(`PR #${pr} ${merged ? 'merged' : 'closed'}`, event.id, pr)
}

function mainAdvanced(db: DatabaseSync, event: StoredEvent): void {
  const payload = payloadOf(event)
  if (!isFullSha(payload.sha))
    reject('sha is not a full sha')
  const touches = boolean(payload, 'touches_mechanics')
  db.prepare('INSERT INTO mains (sha, touches_mechanics, event_id) VALUES (?, ?, ?)').run(payload.sha, touches ? 1 : 0, event.id)
}

function foldAdmittedWithBody(db: DatabaseSync, event: StoredEvent): void {
  CARD_FOLDS[CARD_ADMITTED]!(db, event)
  foldCardBody(db, event)
}

function prOpened(db: DatabaseSync, event: StoredEvent): void {
  const pr = prOf(payloadOf(event).pr) ?? event.pr ?? reject(`${PR_OPENED} needs a pr`)
  const cardId = event.card_id ?? reject(`${PR_OPENED} needs a card_id`)
  const known = prRow(db, pr)
  if (known?.card_id != null && known.card_id !== cardId)
    reject(`pr ${pr} belongs to card ${known.card_id}, not ${cardId}`)
  const linkedBefore = cardRow(db, cardId)?.pr ?? null
  linkCard(db, cardId, pr, event.id)
  cardPrOpened(db, cardId, pr, linkedBefore, event.id)
  if (known !== undefined)
    db.prepare('UPDATE prs SET card_id = ? WHERE pr = ?').run(cardId, pr)
}

export function decisionsAddCommand(text: string): string {
  return `pnpm decisions:add "${text}"`
}

function filled(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function optional<T>(payload: Record<string, unknown>, field: string, read: (value: unknown) => T | null): T | null {
  const value = payload[field]
  return value === undefined || value === null ? null : read(value) ?? reject(`${field} is not valid: ${JSON.stringify(value)}`)
}

function busNamesTheAction(need: string, command: string | null, pr: number | null): boolean {
  return need === 'merge' ? pr !== null : command !== null
}

function foldOwnerWaitOpened(db: DatabaseSync, event: StoredEvent): void {
  const payload = payloadOf(event)
  const id = typeof payload.id === 'string' && WAIT_ID.test(payload.id) ? payload.id : reject('id is not Q<N>')
  const need = isOwnerWaitNeed(payload.need) ? payload.need : reject(`need is not one of ${OWNER_WAIT_NEEDS.join(' | ')}`)
  const text = filled(payload.text) ?? reject('text is empty')
  const command = optional(payload, 'command', filled)
  const card = optional(payload, 'card', prOf)
  const pr = optional(payload, 'pr', prOf)
  if (need === 'command' && command === null)
    reject('a command wait names no command')
  if (optional(payload, 'request', prOf) === null && !busNamesTheAction(need, command, pr))
    reject(`the bus names no owner action for this ${need}: a finding for the backlog, not an owner wait`)
  if (db.prepare('SELECT 1 FROM owner_waits WHERE id = ?').get(id) !== undefined)
    reject(`${id} is already opened`)
  db.prepare(`INSERT INTO owner_waits (id, need, text, command, card_id, pr, state, answer, opened_at, event_id) VALUES (?, ?, ?, ?, ?, ?, '${OPEN_WAIT}', NULL, ?, ?)`)
    .run(id, need, text, command, card, pr, event.ts, event.id)
}

function foldOwnerWaitClosed(db: DatabaseSync, event: StoredEvent): void {
  const payload = payloadOf(event)
  const id = typeof payload.id === 'string' && WAIT_ID.test(payload.id) ? payload.id : reject('id is not Q<N>')
  const answer = filled(payload.answer) ?? reject('answer is empty')
  const wait = db.prepare('SELECT state FROM owner_waits WHERE id = ?').get(id) as { state: string } | undefined
  if (wait === undefined)
    reject(`${id} was never opened`)
  if (wait.state !== OPEN_WAIT)
    reject(`${id} is already closed`)
  db.prepare(`UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ? WHERE id = ?`).run(answer, event.id, id)
}

function closeWaitsTheDecisionsAnswer(db: DatabaseSync, event: StoredEvent): void {
  const decisions = db.prepare('SELECT decision_id, text, scope FROM decisions WHERE event_id = ?').all(event.id) as { decision_id: number, text: string, scope: string | null }[]
  for (const decision of decisions) {
    db.prepare(`
      UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ?
      WHERE state = '${OPEN_WAIT}' AND (command = ? OR (need = 'decision' AND card_id IN (SELECT value FROM json_each(?))))
    `).run(`D-${decision.decision_id}`, event.id, decisionsAddCommand(decision.text), decision.scope ?? '[]')
  }
}

function decisionClosingWaits(type: string): Fold {
  return (db, event) => {
    DECISION_FOLDS[type]!(db, event)
    closeWaitsTheDecisionsAnswer(db, event)
  }
}

export const OWNER_WAIT_FOLDS: Record<string, Fold> = {
  [OWNER_WAIT_OPENED]: foldOwnerWaitOpened,
  [OWNER_WAIT_CLOSED]: foldOwnerWaitClosed,
  [DECISION_RECORDED]: decisionClosingWaits(DECISION_RECORDED),
  [DECISIONS_IMPORTED]: decisionClosingWaits(DECISIONS_IMPORTED),
}

const REDUCERS: Record<string, Fold> = {
  'pr.observed': prObserved,
  'pr.closed': prClosed,
  'main.advanced': mainAdvanced,
  [PR_OPENED]: prOpened,
  ...TASKS_PROJECTION.folds,
  ...CHAINS_PROJECTION.folds,
  ...ROLE_FOLDS,
  ...DECISION_FOLDS,
  ...CARD_FOLDS,
  ...OWNER_WAIT_FOLDS,
  [CARD_ADMITTED]: foldAdmittedWithBody,
}

export function reducedThrough(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
}

export function reduce(db: DatabaseSync): ReduceCount {
  return inTransaction(db, () => {
    db.exec(`${Object.keys(PROJECTION_KEYS).map(table => `DELETE FROM ${table};`).join(' ')} DELETE FROM sqlite_sequence WHERE name = 'tasks';`)
    const through = Number((db.prepare('SELECT coalesce(max(id), 0) AS id FROM events').get() as { id: number }).id)
    db.exec(`PRAGMA user_version = ${through}`)
    const events = db.prepare(`SELECT ${STORED_COLUMNS} FROM events WHERE legacy = 0 ORDER BY id`).all() as unknown as StoredEvent[]
    const count: ReduceCount = { applied: 0, rejected: 0 }
    for (const event of events) {
      const apply = REDUCERS[event.type]
      if (apply === undefined)
        continue
      if (appliedOrRejected(db, event, apply))
        count.applied += 1
      else
        count.rejected += 1
    }
    for (const projection of INCREMENTAL_PROJECTIONS)
      markReduced(db, projection.table, through)
    return count
  })
}

export function projectionDump(db: DatabaseSync): string {
  return JSON.stringify(Object.fromEntries(Object.entries(PROJECTION_KEYS).map(([table, key]) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all()])))
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
