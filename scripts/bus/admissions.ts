import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { parseCard } from '../../src/card/grammar.js'
import { ADMIT_SOURCE } from '../../src/commands/intake/admit.js'
import { INTAKE_EVENT } from '../../src/commands/intake/confirm.js'
import { INTAKE_MOVE_EVENT } from '../../src/commands/intake/move.js'
import { appendEvent } from './db.js'
import { cardIdOf } from './identifiers.js'
import { CARD_ADMITTED } from './launch-candidates.js'

export const ADMISSION_ACTOR = 'reducer'

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

const INTAKE_LINES = `
  SELECT ts, card_id, dedupe_key, payload FROM events
  WHERE legacy = 1 AND type IN ('${INTAKE_EVENT}', '${INTAKE_MOVE_EVENT}')
  ORDER BY id
`

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

const LANE_NAME = /^(?:(?:lane|night)(?:-[\w.-]+)?|\d{4}-\d{2}-\d{2}-[a-z]+)$/

export function isLaneName(name: string): boolean {
  return LANE_NAME.test(name)
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
  for (const row of db.prepare(INTAKE_LINES).all() as unknown as IntakeRow[]) {
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
    const known = db.prepare('SELECT 1 FROM events WHERE dedupe_key = ?').get(`${CARD_ADMITTED}:${row.dedupe_key}`)
    if (known !== undefined)
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
