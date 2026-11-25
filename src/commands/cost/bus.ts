import type { CardEnd, CardTurn } from '../../../scripts/core/card-readings.js'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { cardEnds, cardTurnsOf, legacyLinePayloads } from '../../../scripts/core/card-readings.js'
import { CARD_ANSWERED, CARD_STARTED, PR_CLOSED } from '../../../scripts/core/events.js'
import { prsByCard } from '../../../scripts/core/merge-event.js'
import { parseCard } from '../../card/grammar.js'
import { projectKey } from './source.js'

const CHEAP_CONTOUR = 'cheap'
const MS_PER_MINUTE = 60_000

interface BusSession {
  id: string
  project: string
}

interface BusTask {
  task: string
  taskClass: string
  sessions: BusSession[]
  minutes: number
}

const SPEND_TURNS = [CARD_STARTED, CARD_ANSWERED]
const NO_PRS: ReadonlySet<number> = new Set()

function payloadOf(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

function sessionsOf(spend: readonly CardTurn[]): BusSession[] {
  const sessions = new Map<string, BusSession>()
  let worktree: string | undefined
  for (const row of spend) {
    const payload = payloadOf(row.payload)
    if (row.type === CARD_STARTED && typeof payload.worktree === 'string')
      worktree = payload.worktree
    const tree = typeof payload.worktree === 'string' ? payload.worktree : worktree
    if (typeof payload.session === 'string' && payload.session !== '' && tree !== undefined && !sessions.has(payload.session))
      sessions.set(payload.session, { id: payload.session, project: projectKey(tree) })
  }
  return [...sessions.values()]
}

function taskOf(row: CardEnd, spend: readonly CardTurn[]): BusTask | null {
  if (row.card_line === null)
    return null
  const parsed = parseCard(row.card_line)
  if (parsed.kind !== 'card' || parsed.card.contour !== CHEAP_CONTOUR)
    return null
  if (row.end_type !== PR_CLOSED && typeof payloadOf(row.end_payload).verification !== 'string')
    return null
  const started = spend.find(event => event.type === CARD_STARTED)
  const sessions = sessionsOf(spend)
  if (started === undefined || sessions.length === 0)
    return null
  const minutes = (Date.parse(row.ended) - Date.parse(started.ts)) / MS_PER_MINUTE
  if (!Number.isFinite(minutes) || minutes < 0)
    return null
  return {
    task: String(row.card_id),
    taskClass: `${parsed.card.kind}/${parsed.card.size}`,
    sessions,
    minutes,
  }
}

function spendByCard(rows: readonly CardTurn[]): Map<number, CardTurn[]> {
  const byCard = new Map<number, CardTurn[]>()
  for (const row of rows)
    byCard.set(row.card_id, [...byCard.get(row.card_id) ?? [], row])
  return byCard
}

export function endedCards(db: DatabaseSync): CardEnd[] {
  const prsOf = prsByCard(db)
  return cardEnds(db, card => prsOf.get(card) ?? NO_PRS)
}

export function readBusTasks(busPath: string): BusTask[] {
  if (!existsSync(busPath))
    return []
  try {
    return withReadOnlyBus(busPath, (db) => {
      const spend = spendByCard(cardTurnsOf(db, SPEND_TURNS))
      return endedCards(db).flatMap((row) => {
        const task = taskOf(row, spend.get(row.card_id) ?? [])
        return task === null ? [] : [task]
      })
    })
  }
  catch {
    return []
  }
}

export function readLegacyLines<Line>(busPath: string): Line[] {
  if (!existsSync(busPath))
    return []
  try {
    return withReadOnlyBus(busPath, db => legacyLinePayloads(db).flatMap((text) => {
      const payload = payloadOf(text)
      return Object.keys(payload).length === 0 ? [] : [payload as Line]
    }))
  }
  catch {
    return []
  }
}

export type BusDb = DatabaseSync

export function withReadOnlyBus<T>(busPath: string, read: (db: BusDb) => T): T {
  const db = new DatabaseSync(busPath, { readOnly: true })
  try {
    return read(db)
  }
  finally {
    db.close()
  }
}
