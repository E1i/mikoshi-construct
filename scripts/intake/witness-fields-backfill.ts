import type { DatabaseSync } from 'node:sqlite'
import type { WitnessExpectation, WitnessField } from '../../src/card/witness-fields.js'
import type { CardWitnesses } from '../policy/policy.js'
import type { CardFields } from './card-contract.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { RUNS_PREFIX, runsOf } from '../../src/card/covering-tests.js'
import { textSha } from '../../src/card/text-sha.js'
import { parseWitnessList, runsFieldLine, witnessFieldRefusals, witnessFieldsOf } from '../../src/card/witness-fields.js'
import { witnessesOf } from '../../src/commands/intake/admit.js'
import { withoutWitnessKind } from '../../src/commands/intake/draft.js'
import { WITNESSES_HEADING } from '../../src/commands/intake/slice.js'
import { CARD_BODIES } from '../core/card-bodies.js'
import { appendEvent, defaultBusPath, openBus } from '../core/db.js'
import { WITNESS_FIELDS_BACKFILLED, WITNESS_RECORDED } from '../core/events.js'
import { cardWitnessesOf } from '../policy/policy.js'

export const PREFIX = '[bus:witness-backfill] '

const BACKFILL_ACTOR = 'worker:witness-backfill:by-hand'
const CARD_TEXTS = `SELECT card_id, text FROM ${CARD_BODIES} ORDER BY card_id`
const RECORDED_BACKFILL = `SELECT payload FROM events WHERE legacy = 0 AND type = '${WITNESS_FIELDS_BACKFILLED}' ORDER BY id LIMIT 1`
const LAST_WITNESS_ON_HEAD = `
  SELECT json_extract(payload, '$.verdict') AS verdict, json_extract(payload, '$.detail') AS detail FROM events
  WHERE legacy = 0 AND type = '${WITNESS_RECORDED}' AND pr = ? AND head = (SELECT head FROM prs WHERE pr = ?)
  ORDER BY id DESC LIMIT 1
`
const NAMED_TEST = /^(.*\bvitest\b.*) -t '([^']+)'$/
const BACKTICKED = /`[^`]*`/g
const WHITESPACE_RUN = /\s+/g
const RUNS_SEPARATOR = ','

export interface CardWitnessFields {
  witnesses: WitnessField[]
  runs: string[]
}

export interface WitnessRecordOnHead {
  verdict: string
  detail: string
}

export interface WitnessTable extends CardWitnessFields {
  record: WitnessRecordOnHead | null
}

export interface BackfilledCard extends CardWitnessFields {
  source: string
}

export interface UnparsedLine {
  card: number
  line: string
}

export interface WitnessFieldsBackfill {
  cards: Record<string, BackfilledCard>
  unparsed: UnparsedLine[]
}

type JudgedWitness = CardWitnesses['acceptance'][number]

function proseSource(text: string): string {
  return textSha(JSON.stringify([witnessesOf(text), runsOf(text)]))
}

function provesOf(criterion: string): string {
  const wording = withoutWitnessKind(criterion)
  const withoutCommand = wording.replace(BACKTICKED, ' ').replace(WHITESPACE_RUN, ' ').trim()
  return withoutCommand === '' ? wording : withoutCommand
}

function fieldOf(witness: JudgedWitness, index: number, base: WitnessExpectation): WitnessField {
  const named = NAMED_TEST.exec(witness.command)
  return { id: `W${index + 1}`, run: named?.[1] ?? witness.command, test: named?.[2] ?? null, head: 'pass', base, proves: provesOf(witness.criterion) }
}

function fieldsOf(judged: CardWitnesses): { witness: JudgedWitness, field: WitnessField }[] {
  const expected: [JudgedWitness, WitnessExpectation][] = [
    ...judged.acceptance.map((witness): [JudgedWitness, WitnessExpectation] => [witness, 'fail']),
    ...judged.invariants.map((witness): [JudgedWitness, WitnessExpectation] => [witness, 'pass']),
  ]
  return expected.map(([witness, base], index) => ({ witness, field: fieldOf(witness, index, base) }))
}

function isRunsLine(line: string): boolean {
  return line.startsWith(RUNS_PREFIX)
}

function entriesOfRunsLine(line: string): string[] {
  return line.slice(RUNS_PREFIX.length).split(RUNS_SEPARATOR).map(entry => entry.trim()).filter(entry => entry !== '')
}

function unparsedRuns(text: string, runs: readonly string[]): string[] {
  return text.split('\n').map(line => line.trim()).filter(isRunsLine).filter(line =>
    entriesOfRunsLine(line).some(entry => !runs.includes(entry) || witnessFieldRefusals(runsFieldLine([entry])).length > 0),
  )
}

function holdsProseWitnesses(text: string): boolean {
  return witnessFieldsOf(text) === null && text.split('\n').some(line => line.trim() === WITNESSES_HEADING)
}

function unparsedLinesOf(text: string, parts: { witness: JudgedWitness, field: WitnessField }[], runs: readonly string[]): string[] {
  const items = witnessesOf(text)
  if (items.length === 0)
    return [WITNESSES_HEADING]
  const judged = new Set(parts.map(part => part.witness.criterion))
  const refused = parts.filter(part => parseWitnessList([part.field]).kind === 'refused').map(part => part.witness.criterion)
  return [...new Set([...items.filter(item => !judged.has(item)), ...refused, ...unparsedRuns(text, runs)])]
}

export function witnessFieldsBackfillOf(rows: readonly { card: number, text: string }[]): WitnessFieldsBackfill {
  const backfill: WitnessFieldsBackfill = { cards: {}, unparsed: [] }
  for (const { card, text } of rows.filter(row => holdsProseWitnesses(row.text))) {
    const parts = fieldsOf(cardWitnessesOf(text))
    const runs = runsOf(text)
    const unparsed = unparsedLinesOf(text, parts, runs)
    if (unparsed.length > 0)
      backfill.unparsed.push(...unparsed.map(line => ({ card, line })))
    else
      backfill.cards[String(card)] = { source: proseSource(text), witnesses: parts.map(part => part.field), runs }
  }
  return backfill
}

export function recordedWitnessFieldsBackfill(db: DatabaseSync): WitnessFieldsBackfill | null {
  const row = db.prepare(RECORDED_BACKFILL).get() as { payload: string } | undefined
  return row === undefined ? null : JSON.parse(row.payload) as WitnessFieldsBackfill
}

export function backfillWitnessFields(db: DatabaseSync, ts: string): { recorded: boolean, backfill: WitnessFieldsBackfill } {
  const recorded = recordedWitnessFieldsBackfill(db)
  if (recorded !== null)
    return { recorded: false, backfill: recorded }
  const rows = db.prepare(CARD_TEXTS).all() as { card_id: number, text: string }[]
  const backfill = witnessFieldsBackfillOf(rows.map(row => ({ card: Number(row.card_id), text: row.text })))
  appendEvent(db, { ts, type: WITNESS_FIELDS_BACKFILLED, actor: BACKFILL_ACTOR, cardId: null, pr: null, head: null, dedupeKey: WITNESS_FIELDS_BACKFILLED, payload: { ...backfill }, legacy: false })
  return { recorded: true, backfill }
}

export function witnessFieldsOfCard(card: Pick<CardFields, 'id' | 'witnessFields' | 'runs' | 'text'>, backfill: WitnessFieldsBackfill | null): CardWitnessFields | null {
  if (card.witnessFields.length > 0)
    return { witnesses: card.witnessFields, runs: card.runs }
  const entry = backfill?.cards[String(card.id)]
  return entry?.source === proseSource(card.text) ? entry : null
}

function witnessRecordOnHead(db: DatabaseSync, pr: number | null): WitnessRecordOnHead | null {
  return pr === null ? null : db.prepare(LAST_WITNESS_ON_HEAD).get(pr, pr) as WitnessRecordOnHead | undefined ?? null
}

export function witnessTableOf(db: DatabaseSync, card: CardFields | null, pr: number | null, backfill: WitnessFieldsBackfill | null): WitnessTable | null {
  const fields = card === null ? null : witnessFieldsOfCard(card, backfill)
  return fields === null ? null : { ...fields, record: witnessRecordOnHead(db, pr) }
}

function main(): number {
  const db = openBus(defaultBusPath())
  try {
    const { recorded, backfill } = backfillWitnessFields(db, new Date().toISOString())
    console.log(`${PREFIX}${recorded ? 'recorded' : 'already recorded'}: ${Object.keys(backfill.cards).length} cards with fields, ${backfill.unparsed.length} lines did not parse and stay on the prose path`)
    for (const { card, line } of backfill.unparsed)
      console.log(`${PREFIX}#${card}: ${line}`)
    return 0
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main()
