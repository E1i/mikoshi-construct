import type { BusCardStates } from '../../card/closed.js'
import type { Ui } from '../../ui/console.js'
import type { Lore } from '../../ui/lore.js'
import type { Confirmation } from './confirm.js'
import type { SlicedCard } from './slice.js'
import { Buffer } from 'node:buffer'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { closedTasks, mergedTasks } from '../../card/closed.js'
import { parseCard } from '../../card/grammar.js'
import { laneOf } from './admit.js'
import { checkDraft, correctionText, invalidTestPatterns, OWNER_MERGES, ownerPathsOf, PACKAGE_MANIFEST, publishedRootsOf } from './check.js'
import { awaitsConfirmation, bodySha, confirmationOf, confirmationToken, intakeJournalLine } from './confirm.js'
import { parseDraft } from './draft.js'
import { DirectoryFacts } from './facts.js'
import { admittedNumbers, nextFreeNumbers, parkedNumbers, parseTaken } from './numbers.js'
import { isDirectory, isWithin, parkingTree } from './parking-tree.js'
import { sliceCards } from './slice.js'

export const FROM_STDIN = '-'

const STDIN_FD = 0
const STDIN_CHUNK_BYTES = 65536
const NOTHING_YET_RETRY_MS = 10

export type ChunkSource = (buffer: Buffer) => number

function nothingYet(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EAGAIN'
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function readStdinToEnd(source: ChunkSource = buffer => readSync(STDIN_FD, buffer)): string {
  const chunks: Buffer[] = []
  const buffer = Buffer.alloc(STDIN_CHUNK_BYTES)
  for (;;) {
    let size: number
    try {
      size = source(buffer)
    }
    catch (error) {
      if (!nothingYet(error))
        throw error
      pause(NOTHING_YET_RETRY_MS)
      continue
    }
    if (size === 0)
      return Buffer.concat(chunks).toString('utf8')
    chunks.push(Buffer.from(buffer.subarray(0, size)))
  }
}

export function defaultParking(): string {
  return path.join(os.homedir(), '.construct', 'parking')
}

export const INTAKE_EXIT = {
  written: 0,
  dryRun: 0,
  refused: 1,
  awaiting: 2,
  admitted: 0,
  alreadyAdmitted: 0,
} as const

export const CARD_ADMITTED = 'card.admitted'
export const CARD_MOVED = 'card.moved'

export interface CardEvent {
  type: typeof CARD_ADMITTED | typeof CARD_MOVED
  cardId: number
  ts: string
  dedupeKey: string
  payload: Record<string, unknown>
}

export type CardEventPort = (event: CardEvent) => void

export type CardStatesPort = () => BusCardStates

export interface IntakeRecord {
  journalLine: string
  event: CardEvent
}

export function recordIntake(journal: string, records: readonly IntakeRecord[], events: CardEventPort | undefined): void {
  mkdirSync(path.dirname(journal), { recursive: true })
  appendFileSync(journal, records.map(record => `${record.journalLine}\n`).join(''))
  for (const record of records)
    events?.(record.event)
}

function admissionOf(line: string): { depends: number[], decision: string | null, contour: string | null } {
  const parsed = parseCard(line)
  return parsed.kind === 'card' ? { depends: parsed.card.depends, decision: parsed.card.decision, contour: parsed.card.contour } : { depends: [], decision: null, contour: null }
}

export function admittedRecord(card: SlicedCard, confirmation: Confirmation, at: Date, lane: string | null, source?: string): IntakeRecord {
  const ts = at.toISOString()
  const sha = bodySha(card.text)
  return {
    journalLine: intakeJournalLine(card, confirmation, at, source),
    event: {
      type: CARD_ADMITTED,
      cardId: card.id,
      ts,
      dedupeKey: `${CARD_ADMITTED}:${card.id}:${sha}:${ts}`,
      payload: {
        card: card.line,
        lane,
        ...admissionOf(card.line),
        confirmation,
        corrections: card.corrections.map(correctionText),
        bodySha: sha,
        ...(source === undefined ? {} : { source }),
      },
    },
  }
}

export interface IntakeOptions {
  admit?: string
  draft: string | undefined
  taken: string | undefined
  parking: string
  parkingRoot?: string
  dir: string
  journal: string
  dryRun: boolean
  confirm?: string
  autoConfirm: boolean
  readStdin: () => string
  events?: CardEventPort
  cardStates?: CardStatesPort
}

type Refusal = 'admitWithDraft' | 'noDraft' | 'noTaken' | 'bothFromStdin' | 'unreadable' | 'invalid' | 'invalidTestPattern'

export type IntakeResult
  = | { status: 'refused', refusal: Refusal, detail: string[] }
    | { status: 'written', parking: string, cards: SlicedCard[], autoConfirm: boolean }
    | { status: 'dryRun', parking: string, cards: SlicedCard[] }
    | { status: 'awaiting', parking: string, cards: SlicedCard[], token: string, stale: boolean }

const REFUSAL_LINE: Record<Refusal, (lore: Lore, detail: string[]) => string> = {
  admitWithDraft: lore => lore.intakeRefusedAdmitWithDraft,
  noDraft: lore => lore.intakeRefusedNoDraft,
  noTaken: lore => lore.intakeRefusedNoTaken,
  bothFromStdin: lore => lore.intakeRefusedBothFromStdin,
  unreadable: (lore, detail) => lore.intakeRefusedUnreadable(detail.join('; ')),
  invalid: lore => lore.intakeRefusedInvalid,
  invalidTestPattern: lore => lore.intakeRefusedInvalidTestPattern,
}

function refused(refusal: Refusal, detail: string[] = []): IntakeResult {
  return { status: 'refused', refusal, detail }
}

function readJournal(journal: string): string | null {
  return existsSync(journal) ? readFileSync(journal, 'utf8') : null
}

function readInput(source: string, readStdin: () => string): string {
  return source === FROM_STDIN ? readStdin() : readFileSync(source, 'utf8')
}

function parkedFiles(parking: string): string[] {
  return existsSync(parking) ? readdirSync(parking) : []
}

function parkingsSharingNumbers(parking: string, root: string): string[] {
  return isWithin(root, parking) ? [...new Set([parking, ...parkingTree(root)])] : [parking]
}

export function runIntake(options: IntakeOptions): IntakeResult {
  if (options.admit !== undefined)
    return refused('admitWithDraft')
  if (options.draft === undefined)
    return refused('noDraft')
  if (options.taken === undefined)
    return refused('noTaken')
  if (options.draft === FROM_STDIN && options.taken === FROM_STDIN)
    return refused('bothFromStdin')
  let draftText: string
  let takenText: string
  let journalText: string | null
  let ownerMerges: string | null
  let published: string[] | undefined
  if (!isDirectory(options.dir))
    return refused('unreadable', [`${options.dir} is not a directory`])
  try {
    draftText = readInput(options.draft, options.readStdin)
    takenText = readInput(options.taken, options.readStdin)
    journalText = readJournal(options.journal)
    const ownerMergesFile = path.join(options.dir, OWNER_MERGES)
    ownerMerges = existsSync(ownerMergesFile) ? readFileSync(ownerMergesFile, 'utf8') : null
    const packageManifestFile = path.join(options.dir, PACKAGE_MANIFEST)
    published = existsSync(packageManifestFile) ? publishedRootsOf(readFileSync(packageManifestFile, 'utf8')) : undefined
  }
  catch (error) {
    return refused('unreadable', [error instanceof Error ? error.message : String(error)])
  }
  const draft = parseDraft(draftText)
  if (draft.kind === 'refused')
    return refused('invalid', draft.reasons)
  const invalidPatterns = invalidTestPatterns(draft.cards)
  if (invalidPatterns.length > 0)
    return refused('invalidTestPattern', invalidPatterns)
  const taken = parseTaken(takenText)
  if (taken.kind === 'refused')
    return refused('invalid', [taken.reason])
  const parked = parkingsSharingNumbers(options.parking, options.parkingRoot ?? defaultParking()).flatMap(dir => parkedNumbers(parkedFiles(dir)))
  const numbers = nextFreeNumbers([...taken.numbers, ...parked, ...admittedNumbers(journalText)], draft.cards.length)
  const cards = options.cardStates?.()
  const checked = checkDraft(draft.cards, numbers, {
    taken: new Set(taken.numbers),
    parked: new Set(parked),
    done: new Set(closedTasks(journalText, cards).keys()),
    merged: mergedTasks(journalText, cards),
    repository: new DirectoryFacts(options.dir, process.env.PATH ?? ''),
    ...(ownerMerges === null ? {} : { ownerMerges: ownerPathsOf(ownerMerges) }),
    ...(published === undefined ? {} : { published }),
  })
  const slice = sliceCards(checked, numbers)
  if (slice.kind === 'refused')
    return refused('invalid', slice.reasons)
  if (options.dryRun)
    return { status: 'dryRun', parking: options.parking, cards: slice.cards }
  const token = confirmationToken(slice.cards)
  if (!options.autoConfirm && awaitsConfirmation(slice.cards) && options.confirm !== token)
    return { status: 'awaiting', parking: options.parking, cards: slice.cards, token, stale: options.confirm !== undefined }
  mkdirSync(options.parking, { recursive: true })
  for (const card of slice.cards)
    writeFileSync(path.join(options.parking, card.file), card.text, { flag: 'wx' })
  const at = new Date()
  recordIntake(options.journal, slice.cards.map(card => admittedRecord(card, confirmationOf(card, options.autoConfirm), at, laneOf(options.parkingRoot ?? defaultParking(), options.parking))), options.events)
  return { status: 'written', parking: options.parking, cards: slice.cards, autoConfirm: options.autoConfirm }
}

export function printIntake(ui: Ui, result: IntakeResult): number {
  if (result.status === 'refused') {
    ui.flatline(REFUSAL_LINE[result.refusal](ui.lore, result.detail))
    if (result.refusal === 'invalid' || result.refusal === 'invalidTestPattern') {
      for (const reason of result.detail)
        ui.line(`  - ${reason}`)
    }
    return INTAKE_EXIT.refused
  }
  if (result.status === 'awaiting' && result.stale)
    ui.flatline(ui.lore.intakeConfirmStale)
  for (const card of result.cards) {
    if (result.status === 'dryRun')
      ui.line(card.text)
    else if (result.status === 'awaiting')
      ui.line(ui.lore.intakeAwaitingCard(card.line))
    else
      ui.ok(ui.lore.intakeWritten(path.join(result.parking, card.file), card.line))
    if (result.status !== 'dryRun') {
      for (const correction of card.corrections)
        ui.line(ui.theme.dim(`  ${ui.lore.intakeCorrected(correctionText(correction))}`))
    }
    if (card.corrections.length > 0 && result.status === 'written')
      ui.line(ui.theme.dim(`  ${ui.lore.intakeConfirmed(card.corrections.length, result.autoConfirm)}`))
    else if (card.corrections.length > 0)
      ui.line(ui.theme.dim(`  ${ui.lore.intakeCorrections(card.corrections.length)}`))
    if (card.unclear.length > 0)
      ui.line(ui.theme.dim(`  ${ui.lore.intakeUnclear(card.unclear.length, card.who)}`))
    if (result.status !== 'dryRun') {
      for (const line of [...card.seam, ...card.risk])
        ui.line(ui.theme.dim(`  ${line}`))
    }
  }
  if (result.status === 'dryRun')
    ui.line(ui.lore.intakeDryRun(result.parking))
  if (result.status === 'awaiting')
    ui.line(ui.lore.intakeAwaiting(result.parking, result.token))
  return INTAKE_EXIT[result.status]
}
