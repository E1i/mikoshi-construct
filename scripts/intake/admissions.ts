import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../core/db.js'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { parseCard } from '../../src/card/grammar.js'
import { ADMIT_SOURCE, isLaneName } from '../../src/commands/intake/admit.js'
import { appendEvent } from '../core/db.js'
import { EITHER_JOURNAL, events } from '../core/events-query.js'
import { CARD_ADMITTED, INTAKE_EVENT, INTAKE_MOVE_EVENT } from '../core/events.js'
import { cardIdOf } from '../ports/identifier-shapes.js'

export const ADMISSION_ACTOR = 'reducer'
export const INTAKE_ACTOR_PREFIX = 'worker:intake:'

export type LaneOnDisk = (cardId: number) => string | null

interface IntakeRow {
  ts: string | null
  card_id: number | null
  dedupe_key: string
  payload: string
}

interface Admission {
  lane: string | null
  depends: number[]
  decision: string | null
  contour: string | null
}

const INTAKE_LINES = [INTAKE_EVENT, INTAKE_MOVE_EVENT]

function admittedAlready(db: DatabaseSync, row: IntakeRow): boolean {
  return events(db, { keys: [`${CARD_ADMITTED}:${row.dedupe_key}`], legacy: EITHER_JOURNAL, limit: 1 }).length > 0
}

function recordedByThePort(db: DatabaseSync, cardId: number, ts: string | null): boolean {
  return ts !== null && events(db, { card: cardId, ts, actorPrefix: INTAKE_ACTOR_PREFIX, limit: 1 }).length > 0
}

function lineOf(row: IntakeRow): Record<string, unknown> {
  try {
    const line = JSON.parse(row.payload) as unknown
    return line !== null && typeof line === 'object' && !Array.isArray(line) ? line as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

function laneName(to: unknown): string | null {
  return typeof to === 'string' && to.trim() !== '' ? path.basename(to.trim()) : null
}

function cardOf(line: Record<string, unknown>): Omit<Admission, 'lane'> | null {
  if (typeof line.card !== 'string')
    return null
  const parsed = parseCard(line.card)
  return parsed.kind === 'card' ? { depends: parsed.card.depends, decision: parsed.card.decision, contour: parsed.card.contour } : null
}

export function parkingLane(parking: string): LaneOnDisk {
  return (cardId) => {
    if (!existsSync(parking))
      return null
    const lane = readdirSync(parking, { withFileTypes: true }).find(entry => entry.isDirectory() && existsSync(path.join(parking, entry.name, `${cardId}.md`)))
    return lane?.name ?? null
  }
}

function admittedEvent(row: IntakeRow, cardId: number, admission: Admission, ts: string): BusEvent {
  return { ts: row.ts ?? ts, type: CARD_ADMITTED, actor: ADMISSION_ACTOR, cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${row.dedupe_key}`, payload: { ...admission, admission: row.dedupe_key }, legacy: false }
}

export function admitFromJournal(db: DatabaseSync, ts: string, laneOnDisk: LaneOnDisk): number {
  const movedTo = new Map<number, string>()
  const cards = new Map<number, Omit<Admission, 'lane'>>()
  let admitted = 0
  for (const row of events(db, { types: INTAKE_LINES, legacy: true }) as IntakeRow[]) {
    const line = lineOf(row)
    const cardId = row.card_id ?? cardIdOf(line.task)
    if (cardId === null)
      continue
    const card = cardOf(line) ?? cards.get(cardId) ?? { depends: [], decision: null, contour: null }
    cards.set(cardId, card)
    const isMove = line.event === INTAKE_MOVE_EVENT
    if (!isMove && line.source !== ADMIT_SOURCE)
      continue
    const moved = laneName(line.to)
    if (isMove && moved !== null)
      movedTo.set(cardId, moved)
    if (isMove && moved === null)
      continue
    if (admittedAlready(db, row) || recordedByThePort(db, cardId, row.ts))
      continue
    const present = laneOnDisk(cardId)
    if (present === null || !isLaneName(present))
      continue
    const lane = isMove ? moved : movedTo.get(cardId) ?? present
    if (lane === null || !isLaneName(lane))
      continue
    if (appendEvent(db, admittedEvent(row, cardId, { lane, ...card }, ts)))
      admitted += 1
  }
  return admitted
}
