import type { Ui } from '../../ui/console.js'
import type { Lore } from '../../ui/lore.js'
import type { SlicedCard } from './slice.js'
import { Buffer } from 'node:buffer'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { closedTasks, mergedTasks } from '../../card/closed.js'
import { checkDraft, correctionText } from './check.js'
import { awaitsConfirmation, confirmationOf, confirmationToken, intakeJournalLine } from './confirm.js'
import { parseDraft } from './draft.js'
import { DirectoryFacts } from './facts.js'
import { nextFreeNumbers, parkedNumbers, parseTaken } from './numbers.js'
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

export interface IntakeOptions {
  admit?: string
  draft: string | undefined
  taken: string | undefined
  parking: string
  dir?: string
  journal: string
  dryRun: boolean
  confirm?: string
  autoConfirm: boolean
  readStdin: () => string
}

type Refusal = 'admitWithDraft' | 'noDraft' | 'noTaken' | 'bothFromStdin' | 'unreadable' | 'invalid'

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
}

function refused(refusal: Refusal, detail: string[] = []): IntakeResult {
  return { status: 'refused', refusal, detail }
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  }
  catch {
    return false
  }
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
  if (options.dir !== undefined && !isDirectory(options.dir))
    return refused('unreadable', [`${options.dir} is not a directory`])
  try {
    draftText = readInput(options.draft, options.readStdin)
    takenText = readInput(options.taken, options.readStdin)
    journalText = readJournal(options.journal)
  }
  catch (error) {
    return refused('unreadable', [error instanceof Error ? error.message : String(error)])
  }
  const draft = parseDraft(draftText)
  if (draft.kind === 'refused')
    return refused('invalid', draft.reasons)
  const taken = parseTaken(takenText)
  if (taken.kind === 'refused')
    return refused('invalid', [taken.reason])
  const parked = parkedNumbers(parkedFiles(options.parking))
  const numbers = nextFreeNumbers([...taken.numbers, ...parked], draft.cards.length)
  const checked = checkDraft(draft.cards, numbers, {
    taken: new Set(taken.numbers),
    parked: new Set(parked),
    done: new Set(closedTasks(journalText).keys()),
    merged: mergedTasks(journalText),
    repository: options.dir === undefined ? null : new DirectoryFacts(options.dir, process.env.PATH ?? ''),
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
  mkdirSync(path.dirname(options.journal), { recursive: true })
  appendFileSync(options.journal, slice.cards.map(card => `${intakeJournalLine(card, confirmationOf(card, options.autoConfirm), at)}\n`).join(''))
  return { status: 'written', parking: options.parking, cards: slice.cards, autoConfirm: options.autoConfirm }
}

export function printIntake(ui: Ui, result: IntakeResult): number {
  if (result.status === 'refused') {
    ui.flatline(REFUSAL_LINE[result.refusal](ui.lore, result.detail))
    if (result.refusal === 'invalid') {
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
      for (const line of card.seam)
        ui.line(ui.theme.dim(`  ${line}`))
    }
  }
  if (result.status === 'dryRun')
    ui.line(ui.lore.intakeDryRun(result.parking))
  if (result.status === 'awaiting')
    ui.line(ui.lore.intakeAwaiting(result.parking, result.token))
  return INTAKE_EXIT[result.status]
}
