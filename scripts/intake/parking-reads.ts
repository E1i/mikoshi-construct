import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { CLOSED_CARD, DROPPED_CARD } from '../core/card-automaton.js'
import { cardBodyText } from '../core/card-bodies.js'
import { cardBodyLanes, cardStatesAmong } from '../core/card-readings.js'
import { BUSY_TIMEOUT_MS } from '../core/db.js'
import { openDatabase } from '../core/sqlite.js'

export type CardBodyReader = (cardId: number) => string | null

export interface CardBody { card: number, text: string }

const ENDED_STATES: readonly string[] = [CLOSED_CARD, DROPPED_CARD]

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
  return cardBodyLanes(db).flatMap((body) => {
    const text = cardBodyText(db, body.card_id)
    return text === null ? [] : [{ card: body.card_id, text }]
  })
}

export function parkedDepends(db: DatabaseSync): Map<number, number[]> {
  const bodies = cardBodyLanes(db)
  const states = cardStatesAmong(db, bodies.map(body => body.card_id))
  return new Map(bodies
    .filter((body) => {
      const state = states.get(body.card_id) ?? null
      return state === null || !ENDED_STATES.includes(state)
    })
    .map(body => [body.card_id, body.depends.filter((id): id is number => typeof id === 'number')]))
}

export function busParkedDepends(busPath: string): Map<number, number[]> {
  return fromBus(busPath, new Map(), parkedDepends)
}
