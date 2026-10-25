import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { CLOSED_CARD, DROPPED_CARD } from '../core/card-automaton.js'
import { CARD_BODIES, cardBodyText } from '../core/card-bodies.js'
import { BUSY_TIMEOUT_MS } from '../core/db.js'
import { openDatabase } from '../core/sqlite.js'

export type CardBodyReader = (cardId: number) => string | null

export interface CardBody { card: number, text: string }

const EVERY_BODY = `SELECT card_id, text FROM ${CARD_BODIES} ORDER BY card_id`

const PARKED_DEPENDS = `
  SELECT body.card_id, body.depends FROM ${CARD_BODIES} AS body LEFT JOIN cards ON cards.card_id = body.card_id
  WHERE cards.state IS NULL OR cards.state NOT IN ('${CLOSED_CARD}', '${DROPPED_CARD}')
  ORDER BY body.card_id
`

function fromBus<T>(busPath: string, absent: T, read: (db: DatabaseSync) => T): T {
  if (!existsSync(busPath))
    return absent
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    return read(db)
  }
  finally {
    db.close()
  }
}

export function busCardBodies(busPath: string): CardBodyReader {
  return cardId => fromBus(busPath, null, db => cardBodyText(db, cardId))
}

export function cardBodies(db: DatabaseSync): CardBody[] {
  return (db.prepare(EVERY_BODY).all() as { card_id: number, text: string }[]).map(row => ({ card: Number(row.card_id), text: row.text }))
}

function dependsOf(column: string | null): number[] {
  try {
    const depends = JSON.parse(column ?? '[]') as unknown
    return Array.isArray(depends) ? depends.filter((id): id is number => typeof id === 'number') : []
  }
  catch {
    return []
  }
}

export function parkedDepends(db: DatabaseSync): Map<number, number[]> {
  return new Map((db.prepare(PARKED_DEPENDS).all() as { card_id: number, depends: string | null }[]).map(row => [Number(row.card_id), dependsOf(row.depends)]))
}

export function busParkedDepends(busPath: string): Map<number, number[]> {
  return fromBus(busPath, new Map(), parkedDepends)
}
