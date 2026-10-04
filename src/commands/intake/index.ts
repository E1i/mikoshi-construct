import type { Ui } from '../../ui/console.js'
import type { Lore } from '../../ui/lore.js'
import type { SlicedCard } from './slice.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseDraft } from './draft.js'
import { nextFreeNumbers, parkedNumbers, parseTaken } from './numbers.js'
import { sliceCards } from './slice.js'

export const FROM_STDIN = '-'

export function defaultParking(): string {
  return path.join(os.homedir(), '.construct', 'parking')
}

export const INTAKE_EXIT = {
  written: 0,
  dryRun: 0,
  refused: 1,
} as const

export interface IntakeOptions {
  draft: string | undefined
  taken: string | undefined
  parking: string
  dryRun: boolean
  readStdin: () => string
}

type Refusal = 'noDraft' | 'noTaken' | 'bothFromStdin' | 'unreadable' | 'invalid'

export type IntakeResult
  = | { status: 'refused', refusal: Refusal, detail: string[] }
    | { status: 'written' | 'dryRun', parking: string, cards: SlicedCard[] }

const REFUSAL_LINE: Record<Refusal, (lore: Lore, detail: string[]) => string> = {
  noDraft: lore => lore.intakeRefusedNoDraft,
  noTaken: lore => lore.intakeRefusedNoTaken,
  bothFromStdin: lore => lore.intakeRefusedBothFromStdin,
  unreadable: (lore, detail) => lore.intakeRefusedUnreadable(detail.join('; ')),
  invalid: lore => lore.intakeRefusedInvalid,
}

function refused(refusal: Refusal, detail: string[] = []): IntakeResult {
  return { status: 'refused', refusal, detail }
}

function readInput(source: string, readStdin: () => string): string {
  return source === FROM_STDIN ? readStdin() : readFileSync(source, 'utf8')
}

function parkedFiles(parking: string): string[] {
  return existsSync(parking) ? readdirSync(parking) : []
}

export function runIntake(options: IntakeOptions): IntakeResult {
  if (options.draft === undefined)
    return refused('noDraft')
  if (options.taken === undefined)
    return refused('noTaken')
  if (options.draft === FROM_STDIN && options.taken === FROM_STDIN)
    return refused('bothFromStdin')
  let draftText: string
  let takenText: string
  try {
    draftText = readInput(options.draft, options.readStdin)
    takenText = readInput(options.taken, options.readStdin)
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
  const numbers = nextFreeNumbers([...taken.numbers, ...parkedNumbers(parkedFiles(options.parking))], draft.cards.length)
  const slice = sliceCards(draft.cards, numbers)
  if (slice.kind === 'refused')
    return refused('invalid', slice.reasons)
  if (options.dryRun)
    return { status: 'dryRun', parking: options.parking, cards: slice.cards }
  mkdirSync(options.parking, { recursive: true })
  for (const card of slice.cards)
    writeFileSync(path.join(options.parking, card.file), card.text, { flag: 'wx' })
  return { status: 'written', parking: options.parking, cards: slice.cards }
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
  for (const card of result.cards) {
    if (result.status === 'dryRun')
      ui.line(card.text)
    else
      ui.ok(ui.lore.intakeWritten(path.join(result.parking, card.file), card.line))
    if (card.unclear.length > 0)
      ui.line(ui.theme.dim(`  ${ui.lore.intakeUnclear(card.unclear.length, card.who)}`))
  }
  if (result.status === 'dryRun')
    ui.line(ui.lore.intakeDryRun(result.parking))
  return INTAKE_EXIT[result.status]
}
