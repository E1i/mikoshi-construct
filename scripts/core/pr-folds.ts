import type { DatabaseSync } from 'node:sqlite'
import type { Fold, StoredEvent } from './stored.js'
import { MAIN_ADVANCED, PR_CLOSED, PR_OBSERVED, PR_OPENED } from './events.js'
import { payloadOf, reject } from './stored.js'

const MERGEABLE = new Set(['clean', 'behind', 'dirty', 'blocked'])
const CI = new Set(['pending', 'green', 'red'])

export interface PrRow {
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

export interface CardTransitions {
  linkObserved: (db: DatabaseSync, cardId: number, pr: number, refusal: string | null, eventId: number) => void
  prMerged: (db: DatabaseSync, cardId: number, eventId: number) => void
  prOpened: (db: DatabaseSync, cardId: number, pr: number, linkedBefore: number | null, refusal: string | null, eventId: number) => void
}

export interface PrFieldChecks {
  isFullSha: (value: unknown) => value is string
  prOf: (value: unknown) => number | null
}

export interface PrFoldParts {
  transitions: CardTransitions
  fields: PrFieldChecks
  cardOfBranch: (db: DatabaseSync, branch: unknown) => number | null
  closed: Fold
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

export function prRow(db: DatabaseSync, pr: number): PrRow | undefined {
  return db.prepare('SELECT * FROM prs WHERE pr = ?').get(pr) as PrRow | undefined
}

function cardRow(db: DatabaseSync, cardId: number): CardRow | undefined {
  return db.prepare('SELECT card_id, pr FROM cards WHERE card_id = ?').get(cardId) as CardRow | undefined
}

function cardOfPr(db: DatabaseSync, pr: number): number | null {
  return (db.prepare('SELECT card_id FROM cards WHERE pr = ?').get(pr) as { card_id: number } | undefined)?.card_id ?? null
}

function linkRefusal(db: DatabaseSync, cardId: number): string | null {
  const linkedPr = cardRow(db, cardId)?.pr ?? null
  if (linkedPr === null)
    return null
  const linked = prRow(db, linkedPr)
  if (linked === undefined || linked.state === 'open')
    return `card ${cardId} is linked to pr ${linkedPr}, which is still open`
  return linked.state === 'merged' ? `card ${cardId} is linked to pr ${linkedPr}, which is merged` : null
}

function linkableCardOfBranch(db: DatabaseSync, branch: unknown, parts: PrFoldParts): number | null {
  const only = parts.cardOfBranch(db, branch)
  return only !== null && linkRefusal(db, only) === null ? only : null
}

function prObserved(db: DatabaseSync, event: StoredEvent, parts: PrFoldParts): void {
  const pr = requiredPr(event)
  const payload = payloadOf(event)
  const base = typeof payload.base === 'string' && payload.base !== '' ? payload.base : reject('base is not a branch name')
  const head = parts.fields.isFullSha(payload.head) ? payload.head : reject('head is not a full sha')
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
  const cardId = event.card_id ?? known?.card_id ?? cardOfPr(db, pr) ?? (known === undefined ? linkableCardOfBranch(db, payload.branch, parts) : null)
  if (cardId !== null)
    parts.transitions.linkObserved(db, cardId, pr, linkRefusal(db, cardId), event.id)
  db.prepare(`
    INSERT INTO prs (pr, card_id, base, head, state, mergeable, ci, verdict_on_head, auto_merge, draft, event_id, body_sha)
    VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (pr) DO UPDATE SET card_id = excluded.card_id, base = excluded.base, head = excluded.head,
      state = 'open', mergeable = excluded.mergeable, ci = excluded.ci, verdict_on_head = excluded.verdict_on_head,
      auto_merge = excluded.auto_merge, draft = excluded.draft, event_id = excluded.event_id, body_sha = excluded.body_sha
  `).run(pr, cardId, base, head, mergeable, ci, verdict, autoMerge ? 1 : 0, draft ? 1 : 0, event.id, bodySha)
}

function prClosed(db: DatabaseSync, event: StoredEvent, parts: PrFoldParts): void {
  const pr = requiredPr(event)
  const merged = boolean(payloadOf(event), 'merged')
  const known = prRow(db, pr) ?? reject(`pr ${pr} was never observed`)
  if (known.state === 'merged')
    reject(`pr ${pr} is already merged`)
  db.prepare('UPDATE prs SET state = ?, event_id = ? WHERE pr = ?').run(merged ? 'merged' : 'closed', event.id, pr)
  if (merged && known.card_id !== null)
    parts.transitions.prMerged(db, known.card_id, event.id)
  parts.closed(db, event)
}

function mainAdvanced(db: DatabaseSync, event: StoredEvent, parts: PrFoldParts): void {
  const payload = payloadOf(event)
  if (!parts.fields.isFullSha(payload.sha))
    reject('sha is not a full sha')
  const touches = boolean(payload, 'touches_mechanics')
  db.prepare('INSERT INTO mains (sha, touches_mechanics, event_id) VALUES (?, ?, ?)').run(payload.sha, touches ? 1 : 0, event.id)
}

function prOpened(db: DatabaseSync, event: StoredEvent, parts: PrFoldParts): void {
  const pr = parts.fields.prOf(payloadOf(event).pr) ?? event.pr ?? reject(`${PR_OPENED} needs a pr`)
  const cardId = event.card_id ?? reject(`${PR_OPENED} needs a card_id`)
  const known = prRow(db, pr)
  if (known?.card_id != null && known.card_id !== cardId)
    reject(`pr ${pr} belongs to card ${known.card_id}, not ${cardId}`)
  const linkedBefore = cardRow(db, cardId)?.pr ?? null
  parts.transitions.prOpened(db, cardId, pr, linkedBefore, linkRefusal(db, cardId), event.id)
  if (known !== undefined)
    db.prepare('UPDATE prs SET card_id = ? WHERE pr = ?').run(cardId, pr)
}

export function prFolds(parts: PrFoldParts): Record<string, Fold> {
  return {
    [PR_OBSERVED]: (db, event) => prObserved(db, event, parts),
    [PR_CLOSED]: (db, event) => prClosed(db, event, parts),
    [MAIN_ADVANCED]: (db, event) => mainAdvanced(db, event, parts),
    [PR_OPENED]: (db, event) => prOpened(db, event, parts),
  }
}
