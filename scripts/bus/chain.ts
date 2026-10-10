import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { Fold, StoredEvent } from './stored.js'
import { appendEvent } from './db.js'
import { isFullSha } from './identifiers.js'
import { payloadOf, reject } from './stored.js'

export const CHAIN_OBSERVED = 'chain.observed'
export const CHAIN_RESTARTED = 'chain.restarted'

export interface ChainObservation {
  dir: string
  parking: string
  cardId: number
  sha: string
  pid: number
  boundary: boolean
}

export interface ChainRow {
  dir: string
  card_id: number
  parking: string
  sha: string
  pid: number
  boundary: number
}

function text(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  return typeof value === 'string' && value !== '' ? value : reject(`${field} is not a non-empty string`)
}

function sha(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  return isFullSha(value) ? value : reject(`${field} is not a full sha`)
}

function pid(payload: Record<string, unknown>): number {
  const value = payload.pid
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : reject('pid is not a positive integer')
}

export function chainOfCard(db: DatabaseSync, cardId: number): ChainRow | undefined {
  return db.prepare('SELECT dir, card_id, parking, sha, pid, boundary FROM chains WHERE card_id = ? ORDER BY dir LIMIT 1').get(cardId) as ChainRow | undefined
}

function chainOfDir(db: DatabaseSync, dir: string): ChainRow | undefined {
  return db.prepare('SELECT dir, card_id, parking, sha, pid, boundary FROM chains WHERE dir = ?').get(dir) as ChainRow | undefined
}

function writeChain(db: DatabaseSync, row: ChainRow, eventId: number): void {
  db.prepare(`
    INSERT INTO chains (dir, card_id, parking, sha, pid, boundary, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (dir) DO UPDATE SET card_id = excluded.card_id, parking = excluded.parking, sha = excluded.sha,
      pid = excluded.pid, boundary = excluded.boundary, event_id = excluded.event_id
  `).run(row.dir, row.card_id, row.parking, row.sha, row.pid, row.boundary, eventId)
}

function foldObserved(db: DatabaseSync, event: StoredEvent): void {
  const payload = payloadOf(event)
  const boundary = payload.boundary
  if (typeof boundary !== 'boolean')
    reject('boundary is not a boolean')
  const cardId = event.card_id ?? reject(`${event.type} needs a card_id`)
  writeChain(db, { dir: text(payload, 'dir'), card_id: cardId, parking: text(payload, 'parking'), sha: sha(payload, 'sha'), pid: pid(payload), boundary: boundary ? 1 : 0 }, event.id)
}

function foldRestarted(db: DatabaseSync, event: StoredEvent): void {
  const payload = payloadOf(event)
  const from = sha(payload, 'from')
  const was = chainOfDir(db, text(payload, 'from_dir')) ?? reject(`no chain runs in ${String(payload.from_dir)}`)
  if (was.sha !== from)
    reject(`the chain in ${was.dir} runs on ${was.sha}, not ${from}`)
  db.prepare('DELETE FROM chains WHERE dir = ?').run(was.dir)
  writeChain(db, { dir: text(payload, 'dir'), card_id: was.card_id, parking: was.parking, sha: sha(payload, 'to'), pid: pid(payload), boundary: 0 }, event.id)
}

export const CHAIN_FOLDS: Record<string, Fold> = {
  [CHAIN_OBSERVED]: foldObserved,
  [CHAIN_RESTARTED]: foldRestarted,
}

export function observeChain(db: DatabaseSync, ts: string, actor: string, chain: ChainObservation): boolean {
  const event: BusEvent = { ts, type: CHAIN_OBSERVED, actor, cardId: chain.cardId, pr: null, head: chain.sha, dedupeKey: `${CHAIN_OBSERVED}:${chain.dir}:${ts}`, payload: { dir: chain.dir, parking: chain.parking, sha: chain.sha, pid: chain.pid, boundary: chain.boundary }, legacy: false }
  return appendEvent(db, event)
}
