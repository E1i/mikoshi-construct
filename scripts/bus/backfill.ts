import type { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseParkingFile } from '../../src/card/parking.js'
import { textSha } from '../../src/card/text-sha.js'
import { isLaneName } from '../../src/commands/intake/admit.js'
import { bodySha, bodyShaWithoutTouches } from '../../src/commands/intake/confirm.js'
import { defaultParking } from '../../src/commands/intake/index.js'
import { CARD_ADMITTED } from '../core/events.js'
import { BACKFILL_SOURCE } from './backfill-source.js'
import { CLOSED_CARD, DROPPED_CARD, MERGED_CARD } from './card-automaton.js'
import { appendEvent, defaultBusPath, inTransaction, openBus } from './db.js'
import { versioned } from './intake.js'
import { cardBodyShaOfCard } from './queue.js'
import { reduce } from './reducer.js'

export const PREFIX = '[backfill] '
export const BACKFILL_ACTOR = 'worker:backfill:window'
export const USAGE = 'usage: pnpm bus:backfill --record <set.json> [--parking <dir>] | pnpm bus:backfill --set <set.json>'

const CARD_FILE = /^([1-9]\d*)\.md$/

const SETTLED_CARDS = `
  SELECT card_id FROM cards WHERE state IN ('${MERGED_CARD}', '${CLOSED_CARD}', '${DROPPED_CARD}')
  UNION SELECT card_id FROM prs WHERE state = 'merged' AND card_id IS NOT NULL
  UNION SELECT card_id FROM events WHERE legacy = 1 AND type = 'merge' AND card_id IS NOT NULL
`

export interface SetEntry { card: number, file: string, lane: string | null, textSha: string }

export interface BackfillSet { recordedAt: string, parking: string, cards: SetEntry[] }

export interface Recorded { set: BackfillSet, skipped: string[] }

export interface Backfilled { written: number, unchanged: number }

function parkedFiles(parking: string): { card: number, file: string, lane: string | null }[] {
  if (!existsSync(parking))
    return []
  const lanes = readdirSync(parking, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && isLaneName(entry.name))
    .map(entry => entry.name)
    .sort()
  return [null, ...lanes].flatMap((lane) => {
    const dir = lane === null ? parking : path.join(parking, lane)
    return readdirSync(dir)
      .map(name => CARD_FILE.exec(name))
      .filter(match => match !== null)
      .map(match => ({ card: Number(match[1]), file: path.join(dir, match[0]), lane }))
  })
}

function settledCards(db: DatabaseSync): Set<number> {
  return new Set((db.prepare(SETTLED_CARDS).all() as { card_id: number }[]).map(row => row.card_id))
}

export function recordSet(db: DatabaseSync, parking: string, now: Date): Recorded {
  const settled = settledCards(db)
  const skipped: string[] = []
  const cards: SetEntry[] = []
  for (const parked of parkedFiles(parking).sort((a, b) => a.card - b.card)) {
    if (settled.has(parked.card)) {
      skipped.push(`#${parked.card} ${parked.file}: settled in the bus`)
      continue
    }
    const text = readFileSync(parked.file, 'utf8')
    const parsed = parseParkingFile(path.basename(parked.file), text)
    if (parsed.kind === 'refused') {
      skipped.push(`#${parked.card} ${parked.file}: refused by the card grammar: ${parsed.reason}`)
      continue
    }
    cards.push({ ...parked, textSha: textSha(text) })
  }
  return { set: { recordedAt: now.toISOString(), parking, cards }, skipped }
}

function bodyMatchesAdmission(db: DatabaseSync, card: number, text: string): boolean {
  const recorded = cardBodyShaOfCard(db, card)
  return recorded !== null && (recorded === bodySha(text) || recorded === bodyShaWithoutTouches(text))
}

function changedSince(set: BackfillSet): string[] {
  return set.cards.flatMap((entry) => {
    if (!existsSync(entry.file))
      return [`#${entry.card} ${entry.file}: missing`]
    return textSha(readFileSync(entry.file, 'utf8')) === entry.textSha ? [] : [`#${entry.card} ${entry.file}: its sha is no longer the one the set recorded`]
  })
}

export function runBackfill(db: DatabaseSync, set: BackfillSet, now: Date): Backfilled | string[] {
  const changed = changedSince(set)
  if (changed.length > 0)
    return changed
  return inTransaction(db, () => {
    let written = 0
    for (const entry of set.cards) {
      const text = readFileSync(entry.file, 'utf8')
      const parsed = parseParkingFile(path.basename(entry.file), text)
      const card = parsed.kind === 'parked' ? parsed.parked.task.card.line : null
      const event = versioned(db, {
        type: CARD_ADMITTED,
        cardId: entry.card,
        ts: now.toISOString(),
        dedupeKey: `${CARD_ADMITTED}:${BACKFILL_SOURCE}:${entry.card}:${entry.textSha}`,
        payload: { card, lane: entry.lane, source: BACKFILL_SOURCE, text, textSha: entry.textSha, bodyMatchesAdmission: bodyMatchesAdmission(db, entry.card, text), textVerified: false },
      })
      if (appendEvent(db, { ts: event.ts, type: event.type, actor: BACKFILL_ACTOR, cardId: event.cardId, pr: null, head: null, dedupeKey: event.dedupeKey, payload: event.payload, legacy: false }))
        written += 1
    }
    return { written, unchanged: set.cards.length - written }
  })
}

export interface BackfillDeps {
  bus: string
  parking: string
  now: () => Date
  out: (line: string) => void
  err: (line: string) => void
}

type Request = { kind: 'record', file: string, parking: string | null } | { kind: 'run', file: string }

function requestOf(args: string[]): Request | null {
  const [flag, file, ...rest] = args
  if (file === undefined)
    return null
  if (flag === '--set' && rest.length === 0)
    return { kind: 'run', file }
  if (flag !== '--record')
    return null
  if (rest.length === 0)
    return { kind: 'record', file, parking: null }
  return rest.length === 2 && rest[0] === '--parking' ? { kind: 'record', file, parking: rest[1]! } : null
}

function withBus<T>(bus: string, work: (db: DatabaseSync) => T): T {
  const db = openBus(bus)
  try {
    return work(db)
  }
  finally {
    db.close()
  }
}

function record(request: Extract<Request, { kind: 'record' }>, deps: BackfillDeps): number {
  if (existsSync(request.file)) {
    deps.err(`${PREFIX}${request.file} exists; a recorded set is never overwritten`)
    return 1
  }
  const { set, skipped } = withBus(deps.bus, db => recordSet(db, request.parking ?? deps.parking, deps.now()))
  writeFileSync(request.file, `${JSON.stringify(set, null, 2)}\n`)
  for (const line of skipped)
    deps.out(`${PREFIX}skipped ${line}`)
  deps.out(`${PREFIX}recorded ${set.cards.length} cards in ${request.file}`)
  return 0
}

function run(request: Extract<Request, { kind: 'run' }>, deps: BackfillDeps): number {
  const set = JSON.parse(readFileSync(request.file, 'utf8')) as BackfillSet
  const result = withBus(deps.bus, (db) => {
    const backfilled = runBackfill(db, set, deps.now())
    if (!Array.isArray(backfilled))
      reduce(db)
    return backfilled
  })
  if (Array.isArray(result)) {
    for (const line of result)
      deps.err(`${PREFIX}${line}`)
    deps.err(`${PREFIX}nothing written; record a new set`)
    return 1
  }
  deps.out(`${PREFIX}${result.written} written, ${result.unchanged} already backfilled, ${set.cards.length} in the set`)
  return 0
}

export function runBackfillCommand(args: string[], deps: BackfillDeps): number {
  const request = requestOf(args)
  if (request === null) {
    deps.err(`${PREFIX}${USAGE}`)
    return 2
  }
  return request.kind === 'record' ? record(request, deps) : run(request, deps)
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runBackfillCommand(process.argv.slice(2), {
    bus: defaultBusPath(),
    parking: defaultParking(),
    now: () => new Date(),
    out: line => console.log(line),
    err: line => console.error(line),
  })
}
