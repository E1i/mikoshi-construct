import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { Fold, StoredEvent } from './stored.js'
import type { IncrementalProjection } from './watermark.js'
import { appendEvent, inTransaction } from './db.js'
import { CHAIN_OBSERVED, CHAIN_RESTARTED } from './events.js'
import { isFullSha } from './identifiers.js'
import { payloadOf, reject } from './stored.js'
import { markReduced, reduceProjection, watermarkOf } from './watermark.js'

export const CHAIN_STATES = ['running', 'waiting', 'stopped', 'fault'] as const

export type ChainState = typeof CHAIN_STATES[number]

export const WAITING: ChainState = 'waiting'

export interface ChainObservation {
  dir: string
  parking: string
  cardId: number
  sha: string
  pid: number
  leader: number | null
  boundary: boolean
  state: ChainState
  waitingOn?: number[]
}

export interface ChainRow {
  dir: string
  card_id: number
  parking: string
  sha: string
  pid: number
  leader: number | null
  boundary: number
  state: ChainState
}

const CHAIN_COLUMNS = 'dir, card_id, parking, sha, pid, leader, boundary, state'

function text(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  return typeof value === 'string' && value !== '' ? value : reject(`${field} is not a non-empty string`)
}

function sha(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  return isFullSha(value) ? value : reject(`${field} is not a full sha`)
}

function positive(value: unknown, field: string): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : reject(`${field} is not a positive integer`)
}

function pid(payload: Record<string, unknown>): number {
  return positive(payload.pid, 'pid')
}

function leader(payload: Record<string, unknown>): number | null {
  return payload.leader === null ? null : positive(payload.leader, 'leader')
}

function waitingOn(payload: Record<string, unknown>): number[] {
  const cards = payload.waitingOn
  return Array.isArray(cards) && cards.length > 0 ? cards.map(card => positive(card, 'waitingOn')) : reject(`a ${WAITING} chain names the cards it waits on in waitingOn`)
}

function chainState(payload: Record<string, unknown>): ChainState {
  const state = CHAIN_STATES.find(each => each === payload.state) ?? reject(`state is not one of ${CHAIN_STATES.join(' | ')}`)
  if (state === WAITING)
    waitingOn(payload)
  else if (payload.waitingOn !== undefined)
    reject(`only a ${WAITING} chain carries waitingOn`)
  return state
}

export function chainOfCard(db: DatabaseSync, cardId: number): ChainRow | undefined {
  return db.prepare(`SELECT ${CHAIN_COLUMNS} FROM chains WHERE card_id = ? ORDER BY state = 'stopped', event_id DESC LIMIT 1`).get(cardId) as ChainRow | undefined
}

export function chainOfDir(db: DatabaseSync, dir: string): ChainRow | undefined {
  return db.prepare(`SELECT ${CHAIN_COLUMNS} FROM chains WHERE dir = ?`).get(dir) as ChainRow | undefined
}

function writeChain(db: DatabaseSync, row: ChainRow, eventId: number): void {
  db.prepare(`
    INSERT INTO chains (${CHAIN_COLUMNS}, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (dir) DO UPDATE SET card_id = excluded.card_id, parking = excluded.parking, sha = excluded.sha,
      pid = excluded.pid, leader = excluded.leader, boundary = excluded.boundary, state = excluded.state, event_id = excluded.event_id
  `).run(row.dir, row.card_id, row.parking, row.sha, row.pid, row.leader, row.boundary, row.state, eventId)
}

function observedRow(payload: Record<string, unknown>, cardId: number | null): ChainRow {
  const boundary = payload.boundary
  if (typeof boundary !== 'boolean')
    reject('boundary is not a boolean')
  const card = cardId ?? reject(`${CHAIN_OBSERVED} needs a card_id`)
  return { dir: text(payload, 'dir'), card_id: card, parking: text(payload, 'parking'), sha: sha(payload, 'sha'), pid: pid(payload), leader: leader(payload), boundary: boundary ? 1 : 0, state: chainState(payload) }
}

function foldObserved(db: DatabaseSync, event: StoredEvent): void {
  writeChain(db, observedRow(payloadOf(event), event.card_id), event.id)
}

function foldRestarted(db: DatabaseSync, event: StoredEvent): void {
  const payload = payloadOf(event)
  const from = sha(payload, 'from')
  const was = chainOfDir(db, text(payload, 'from_dir')) ?? reject(`no chain runs in ${String(payload.from_dir)}`)
  if (was.sha !== from)
    reject(`the chain in ${was.dir} runs on ${was.sha}, not ${from}`)
  db.prepare('DELETE FROM chains WHERE dir = ?').run(was.dir)
  writeChain(db, { dir: text(payload, 'dir'), card_id: was.card_id, parking: was.parking, sha: sha(payload, 'to'), pid: pid(payload), leader: pid(payload), boundary: 0, state: 'running' }, event.id)
}

const CHAIN_FOLDS: Record<string, Fold> = {
  [CHAIN_OBSERVED]: foldObserved,
  [CHAIN_RESTARTED]: foldRestarted,
}

export const CHAINS_PROJECTION: IncrementalProjection = { table: 'chains', folds: CHAIN_FOLDS }

function lastEventId(db: DatabaseSync): number {
  return Number((db.prepare('SELECT coalesce(max(id), 0) AS id FROM events').get() as { id: number }).id)
}

export function observeChain(db: DatabaseSync, ts: string, actor: string, chain: ChainObservation): boolean {
  const payload = { dir: chain.dir, parking: chain.parking, sha: chain.sha, pid: chain.pid, leader: chain.leader, boundary: chain.boundary, state: chain.state, ...(chain.waitingOn === undefined ? {} : { waitingOn: chain.waitingOn }) }
  observedRow(payload, chain.cardId)
  const event: BusEvent = { ts, type: CHAIN_OBSERVED, actor, cardId: chain.cardId, pr: null, head: chain.sha, dedupeKey: `${CHAIN_OBSERVED}:${chain.dir}:${ts}:${chain.state}:${chain.boundary}`, payload, legacy: false }
  return inTransaction(db, () => {
    const current = lastEventId(db)
    const appended = appendEvent(db, event)
    if (watermarkOf(db, CHAINS_PROJECTION.table) === 0)
      markReduced(db, CHAINS_PROJECTION.table, current)
    reduceProjection(db, CHAINS_PROJECTION)
    return appended
  })
}
